import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #308: deploy 鍵は authorized_keys の command= で `rrsync /var/www/giinrecord` に固定されており、
// rrsync は制限ルート全体に flock(LOCK_EX|LOCK_NB) を掛ける。site/ と staging/ は同じロックを奪い合うので、
// concurrency group を target_dir ごとに分けると（deploy-site.yml が3つのワークフローから呼ばれるため）
// すり抜けて `Another instance of rrsync is already accessing this directory.` で落ちる。
//
// このテストは group がロックの単位（ホスト単位）から外れることを防ぐ。
// 前身のテストは行末コメントを含む生文字列に正規表現を当てていたため、
// `group: deploy-${{ inputs.target_dir }}  # deploy-vps` のような書き方を素通しした（#244 の再演）。
// ここでは**コメントを除去してから**値を取り出す。
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const deploySite = readFileSync(resolve(wfDir, "deploy-site.yml"), "utf8");

/** 行末コメントを落とす（クォート内の # は扱わない。この用途では出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

/** `key:` の値をコメント除去して返す。見つからなければ undefined */
function scalar(yaml: string, key: string): string | undefined {
  for (const raw of yaml.split("\n")) {
    const line = stripComment(raw);
    const m = line.match(new RegExp(`^\\s*${key}:\\s*(.+)$`));
    if (m) return m[1].trim();
  }
  return undefined;
}

test("deploy の concurrency group は rrsync のロック単位（ホスト単位）である（#308）", () => {
  const group = scalar(deploySite, "group");
  assert.equal(
    group,
    "deploy-vps",
    "concurrency group が deploy-vps ではない。target_dir を含めると rrsync のロック競合を素通しする（#308）",
  );
  // target_dir が式として混ざっていないこと（`deploy-${{ inputs.target_dir }}` の形を明示的に排除）
  assert.doesNotMatch(
    group ?? "",
    /inputs\.target_dir/,
    "group に target_dir が入っている。rrsync のロックは制限ルート全体に掛かるので dir ごとでは足りない",
  );
});

test("走行中の deploy をキャンセルしない（途中で切れた本番を残さない）", () => {
  assert.equal(scalar(deploySite, "cancel-in-progress"), "false");
});

test("deploy-site.yml を呼ぶワークフローは、すべてこの group で直列化される（#308）", () => {
  // 呼び出し元が増えても、group を共有している限り自動的に直列化される。
  // 逆に deploy-site.yml を経由しない rsync が生えると穴になるので、それを検出する。
  const callers: string[] = [];
  for (const f of readdirSync(wfDir)) {
    if (!f.endsWith(".yml") || f === "deploy-site.yml") continue;
    const s = readFileSync(resolve(wfDir, f), "utf8");
    if (s.includes("deploy-site.yml")) callers.push(f);
    // deploy-site.yml を通さずに VPS へ rsync するワークフローがあれば、それはロックを共有しない
    const ownRsync = s.split("\n").map(stripComment).some((l) => /^\s*rsync\s/.test(l));
    assert.ok(!ownRsync, `${f} が deploy-site.yml を経由せず rsync している（#308 の直列化から外れる）`);
  }
  assert.ok(callers.length >= 3, `deploy-site.yml の呼び出し元が想定より少ない: ${callers.join(", ")}`);
});

test("rsync は無応答のまま固まらない（#308 の診断）", () => {
  const line = deploySite.split("\n").map(stripComment).find((l) => /^\s*rsync\s/.test(l)) ?? "";
  const timeout = line.match(/--timeout=(\d+)/)?.[1];
  assert.ok(timeout, "rsync に --timeout が無い");
  const n = Number(timeout);
  // 実測は 7.7〜9.8 秒（成功 run 5本、rsync ステップの前後のログ行から）。
  // 短すぎれば正常な転送を落とし、長すぎれば固まったまま待ち続ける。
  assert.ok(n >= 60 && n <= 600, `--timeout=${n} が想定の範囲外（60〜600 秒）`);
  assert.match(line, /--stats/, "rsync に --stats が無い（成功時の転送量が残らない）");
});

test("失敗を隠すリトライを足していない（#308）", () => {
  const step = deploySite.slice(deploySite.indexOf("- name: rsync static site to VPS"));
  const body = step.slice(0, step.indexOf("- name: Summary"));
  assert.doesNotMatch(body, /\bretry\b|\buntil\b|for\s+i\s+in/i, "rsync にリトライが入っている");
});
