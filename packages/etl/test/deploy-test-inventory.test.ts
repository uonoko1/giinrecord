import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #513: `deploy/test/*.test.sh` は **glob で実行されるだけ**で、誰も数えていなかった。
// `.github/workflows/ci.yml` の
//     for t in scripts/ci/test/*.test.sh deploy/test/*.test.sh; do echo "== $t"; bash "$t"; done
// は、**ファイルを丸ごと消すと走るテストが1本減るだけ**で CI は完全に無言で緑になる。
// 実測（origin/main、このテストを入れる前）:
//   nginx-headers.test.sh を削除 → deploy ループ ran=14→13 / loop_exit=0、etl は 931 pass / 0 fail。
//
// **なぜ deploy/test/ の中に置けないか**（この PBI の核心）:
//   #500 Z2 / #507 は「入口と出口」＝ **同一プロセス内で経路が2本**あり、片方だけ釘打っていた形で、
//   「同じテストの中で出口も数える」ことで塞げた。
//   **検査コードの削除は、経路が2本あるのではなく経路が0本になる。**
//   同じディレクトリに置いた見張りは、そのファイルごと消せる。**原理的に自己防衛できない。**
//   だから**レイヤを1つ上げる**——別パッケージ・別ランナー（node:test）・別言語で見る。
//   `pnpm test`（= `pnpm -r test`）が etl を回すので、CI の別ステップから落ちる。
//
// **なぜ「本数を数える」「名前を並べる」だけでは足りないか**:
//   #504「**名前を固定した は 値を固定した ではない**」がそのまま効く。
//   - 本数（14）だけ固定 → **消したぶん空ファイルを1本足せば 14 のまま**通る。
//   - 名前の集合だけ固定 → **中身を空にしても・assertion を全部抜いて `exit 0` にしても**通る。
//
// **そして「台帳をハードコードする」だけでも足りない**（このテストを書く途中で**実測した**）:
//   #507 の「検査が指示する手順が、検査を黙らせないか」。最初の版は
//   「INVENTORY を更新してください」と指示し、行数を EXPECTED_COUNT で二重化していた。
//   実測: **削除 + 台帳の行を削除 + EXPECTED_COUNT を 13 に**（＝全部指示どおり）で **6 pass / 0 fail**。
//   **指示に従うだけで守りが完全に外れた。**
//   → だから台帳（ハードコード）に加えて、**台帳を編集しても縮まない経路**を2本足す。
//      どちらも**期待値を deploy/ の本番ファイルから導く**ので、
//      黙らせるには**本番の設定・スクリプトのほうを消す**しかない（それは diff で見える）。
//
//   経路1（台帳）  : 名前の集合・出口・アンカー・assertion の下限。ハードコード。編集で縮む。
//   経路4（横断）  : 1 本の本番ファイルに紐づかない守り（`reload_nginx` など）。
//                    期待値の出どころは **その性質を使っている本番スクリプト**。台帳を消しても縮まない。
//
// **判定はすべて「コメントを落とした本文」に対して行う**（`sources()` が既にそうしている）。
// PR #526 のレビューが `sed 's/^/# /'` で全 14 本を「コメント + exit 0」に潰し、**9 pass / 0 fail** を出した。
// 逐語一致はコメントと実行される本文を区別できない。**それに加えて、実際に走る assertion の数に下限を置く。**
//
// **「どこかにあれば良い」もやめた。担当を名指しする。**
// 文字列一致である限り、その文字列を書けば偽装できる（実測 W1c: 実配信の形
// `Permissions-Policy:` を別ファイルの本文に書くだけで経路3 が黙った）。追いかけっこは終わらない。
// `HEADER_OWNERS` / `SUBJECT_OWNERS` で「誰が守る係か」を固定し、**その係が消えたら落ちる**ようにした。
//   経路2（被覆）  : deploy/ の本番スクリプト／設定は、**どれか**の deploy テストから名指しされていること。
//                    期待値の出どころは **deploy/ の実ファイル**。台帳を消しても縮まない。
//   経路3（能力）  : site.conf が送る**セキュリティヘッダ1つ1つ**について、
//                    **本物の nginx を起動して実際のレスポンスを見る** deploy テストが存在すること。
//                    期待値の出どころは **site.conf の add_header**。台帳を消しても縮まない。
//                    #513 が「nginx-headers.test.sh が消えると失われる」と挙げたものは、ここで死ぬ。
//   #485「経路が2つ以上あるものは、それぞれ別々に釘打つ」。

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const testDir = resolve(root, "deploy/test");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** `deploy/test/` に実在する *.test.sh（render-host-proxy.sh のような補助スクリプトは対象外） */
const actualFiles = (): string[] =>
  readdirSync(testDir)
    .filter((n) => n.endsWith(".test.sh"))
    .sort();

/**
 * シェルスクリプトから**コメント行を落とす**。
 *
 * **レビュー（PR #526）で破られた点**: ここが無かったとき、逐語一致（`String.includes`）は
 * **コメントと実行される本文を区別できなかった**。実測——14 本すべてを
 * ```
 * { echo '#!/usr/bin/env bash'; sed 's/^/# /' "$f"; echo 'exit 0'; } > "$f"
 * ```
 * で「全部コメント + exit 0」に潰しても、**9 pass / 0 fail**（assertion は 1 つも残っていない）。
 * `nginx-headers.test.sh` は 238 行 → 10 行のスタブになってなお緑だった。
 *
 * **同じファイルの中で扱いが非対称だった**のが原因: `headersInSiteConf()` は
 * `^\s*#` を除いていたのに、`.sh` 側だけ素の全文を見ていた。
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** deploy/test/*.test.sh の**実行される本文**（コメントを落としたもの）。判定はすべてこちらで行う。 */
function sources(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of actualFiles())
    m.set(f, stripComments(read(`deploy/test/${f}`)));
  return m;
}

/**
 * **実際に走る assertion の呼び出し**を数える。
 * コメントに逃がした本文は `stripComments` で消えているので、ここには残らない。
 * ヘルパの**定義行**（`ok() { ... }`）は呼び出しではないので除く。
 *
 * 数え方（機械で列挙している。目視で数えていない）:
 *   - 判定ヘルパの呼び出し: `test_case` / `assert_*` / `ok` / `bad` / `fail`（行頭・`;` `&&` `||` `then` `else` `do` の直後）
 *   - 数え上げ直書き: `PASS=$((PASS+1))`
 */
function assertionSites(body: string): number {
  const withoutDefs = body
    .split("\n")
    .filter(
      (l) => !/^\s*(ok|bad|fail|skip|test_case|assert_[a-z_]+)\s*\(\)/.test(l),
    )
    .join("\n");
  const re =
    /(?:^|[;&|(]|\bthen\b|\belse\b|\bdo\b)\s*(?:test_case|assert_[a-z_]+|ok|bad|fail)\s+["$\w]|PASS=\$\(\(PASS\+1\)\)/g;
  return [...withoutDefs.matchAll(re)].length;
}

// ---------------------------------------------------------------------------------------------
// 経路1: 台帳（ハードコード）
// ---------------------------------------------------------------------------------------------

/**
 * - `file`    : ファイル名（この一覧がファイル集合の期待値）
 * - `anchors` : そのテストが**現に検査していること**を名指しする、ファイル中の逐語文字列。
 *               assertion を抜くと消える。#481: 失敗は「何件」ではなく「どれが」で出す。
 */
const INVENTORY: { file: string; anchors: string[]; minAssertions: number }[] =
  [
    {
      file: "apply-all.test.sh",
      anchors: ["apply-all.sh", "allowlist", "8083"],
      minAssertions: 64,
    },
    {
      file: "cloudflare-allowlist.test.sh",
      anchors: ["cloudflare-allowlist.sh", "nginx -t failed"],
      minAssertions: 26,
    },
    { file: "go-live.test.sh", anchors: ["go-live.sh"], minAssertions: 20 },
    {
      file: "logrotate.test.sh",
      anchors: ["logrotate.conf", "monitor/setup.sh"],
      minAssertions: 8,
    },
    {
      file: "monitor-health.test.sh",
      anchors: ["monitor/health.sh"],
      minAssertions: 13,
    },
    { file: "monitor-probe.test.sh", anchors: ["probe.sh"], minAssertions: 49 },
    {
      file: "monitor-setup.test.sh",
      anchors: ["monitor/setup.sh"],
      minAssertions: 8,
    },
    {
      file: "nginx-404.test.sh",
      anchors: ["nginx/site.conf", "__spa-fallback.html", "docker"],
      minAssertions: 4,
    },
    {
      file: "nginx-headers.test.sh",
      // #513 が「これが消えると失われる」と名指ししたものを、そのまま釘にする。
      anchors: [
        "nginx/site.conf",
        "docker",
        "LOCATIONS", // location の網羅（#499: allowlist をやめ site.conf から全 location を拾う）
        "WANT_LOCS", // その数え上げ自身の検査（独立な数え方との突き合わせ）
        "add_header", // add_header の継承の罠（内側に1つあると外側が全部消える）
        "Permissions-Policy", // 17 機能
        "SECURITY_HEADERS", // #504: 個数ではなく要素そのものを順序込みで固定
        "REQUIRED_SECURITY_HEADERS",
      ],
      minAssertions: 8,
    },
    {
      file: "nginx-reload.test.sh",
      anchors: ["vps-setup.sh", "nginx -t failed"],
      minAssertions: 2,
    },
    {
      file: "ops-user-setup.test.sh",
      anchors: ["ops-user-setup.sh", "NOPASSWD", "visudo"],
      minAssertions: 69,
    },
    {
      file: "run-remote.test.sh",
      anchors: ["run-remote.sh"],
      minAssertions: 22,
    },
    {
      file: "staging-setup.test.sh",
      anchors: ["staging-setup.sh"],
      minAssertions: 15,
    },
    { file: "vps-setup.test.sh", anchors: ["vps-setup.sh"], minAssertions: 30 },
  ];

/**
 * **台帳の行数を、台帳の外にもう一度書く。**
 * これだけでは削除を止められない（実測済み: 行と数字を両方直せば通る）が、
 * **「行をそっと消す」を「数字も書き換える」に変える**——意図が diff に残る。
 * 止めるのは経路2・経路3のほう。
 */
const EXPECTED_COUNT = 14;

/**
 * 失敗を exit status に変える「出口」。これが無いと assertion がいくつあっても
 * **スクリプトは 0 で終わる**（CI の `bash "$t"` は exit status しか見ない）。
 * 14 本が使う3つの書き方を**逐語で**列挙する（正規表現で緩めない）。
 */
const GATES = ['[ "$FAIL" = 0 ]', "[[ $FAIL == 0 ]]", '[ "$FAIL" -eq 0 ]'];

/**
 * **検査器自身が持つ allowlist を固定する**（#484）。
 * `UNCOVERED_KEYS` / `ELSEWHERE_KEYS` は固定したのに、**`GATES` と `anchors` は未固定だった**——
 * レビュー（PR #526）の実測:
 *   - `GATES` に `"exit"` を 1 語足すだけで、全 14 本の出口を `exit 0` にしても **9 pass / 0 fail**
 *   - `anchors` を全部 `["bash"]` に差し替えるだけで **9 pass / 0 fail**
 * **allowlist が 3 つあって、2 つしか釘打っていなかった。**
 */
const GATES_PINNED = [
  '[ "$FAIL" = 0 ]',
  "[[ $FAIL == 0 ]]",
  '[ "$FAIL" -eq 0 ]',
];

/** 台帳の anchors・下限を、台帳の外にもう一度書く（同上）。 */
const INVENTORY_PINNED: Record<
  string,
  { anchors: string[]; minAssertions: number }
> = {
  "apply-all.test.sh": {
    anchors: ["apply-all.sh", "allowlist", "8083"],
    minAssertions: 64,
  },
  "cloudflare-allowlist.test.sh": {
    anchors: ["cloudflare-allowlist.sh", "nginx -t failed"],
    minAssertions: 26,
  },
  "go-live.test.sh": { anchors: ["go-live.sh"], minAssertions: 20 },
  "logrotate.test.sh": {
    anchors: ["logrotate.conf", "monitor/setup.sh"],
    minAssertions: 8,
  },
  "monitor-health.test.sh": {
    anchors: ["monitor/health.sh"],
    minAssertions: 13,
  },
  "monitor-probe.test.sh": { anchors: ["probe.sh"], minAssertions: 49 },
  "monitor-setup.test.sh": { anchors: ["monitor/setup.sh"], minAssertions: 8 },
  "nginx-404.test.sh": {
    anchors: ["nginx/site.conf", "__spa-fallback.html", "docker"],
    minAssertions: 4,
  },
  "nginx-headers.test.sh": {
    anchors: [
      "nginx/site.conf",
      "docker",
      "LOCATIONS",
      "WANT_LOCS",
      "add_header",
      "Permissions-Policy",
      "SECURITY_HEADERS",
      "REQUIRED_SECURITY_HEADERS",
    ],
    minAssertions: 8,
  },
  "nginx-reload.test.sh": {
    anchors: ["vps-setup.sh", "nginx -t failed"],
    minAssertions: 2,
  },
  "ops-user-setup.test.sh": {
    anchors: ["ops-user-setup.sh", "NOPASSWD", "visudo"],
    minAssertions: 69,
  },
  "run-remote.test.sh": { anchors: ["run-remote.sh"], minAssertions: 22 },
  "staging-setup.test.sh": { anchors: ["staging-setup.sh"], minAssertions: 15 },
  "vps-setup.test.sh": { anchors: ["vps-setup.sh"], minAssertions: 30 },
};

test("#513 経路1: 検査器の allowlist（GATES・anchors・assertion の下限）そのものを固定する", () => {
  assert.deepEqual(
    GATES,
    GATES_PINNED,
    `GATES が変わっている（出口として認める書き方の集合）。
  いま: ${GATES.join(" / ")}
  固定: ${GATES_PINNED.join(" / ")}
ここに 1 語（例えば "exit"）足すだけで、全 14 本を exit 0 に差し替えても検査は黙る（実測）。`,
  );

  const table = Object.fromEntries(
    INVENTORY.map((e) => [
      e.file,
      { anchors: e.anchors, minAssertions: e.minAssertions },
    ]),
  );
  assert.deepEqual(
    table,
    INVENTORY_PINNED,
    `台帳の anchors / assertion 下限が変わっている。
台帳（INVENTORY）と固定値（INVENTORY_PINNED）の両方を書き換えないと通らない。
片方だけ緩めて検査を黙らせる道を塞ぐためにある（#484）。`,
  );
});

test("#513 経路1: 台帳は実在するファイル集合と一致する（消しても足しても落ちる）", () => {
  const expected = INVENTORY.map((e) => e.file).sort();
  const actual = actualFiles();
  const missing = expected.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !expected.includes(f));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `deploy/test/*.test.sh が台帳と食い違う。
  台帳にあるのに存在しない（= 削除された）: ${missing.join(", ") || "なし"}
  存在するのに台帳に無い（= 追加された）  : ${extra.join(", ") || "なし"}

足したとき: INVENTORY に { file, anchors } を足し、EXPECTED_COUNT を +1 する。
消すとき  : **この行を消せば黙る。だから消す前に読むこと。**
  deploy/test/ の1本は本番の設定・スクリプトを守る唯一の検査であることが多い。
  ただし本当に必要なものは経路2（deploy/ の被覆）と経路3（site.conf のヘッダ）が
  **台帳と無関係に**要求するので、そちらが落ちたなら消してはいけない。`,
  );
});

test("#513 経路1: 台帳の行数は台帳の外に書いた本数と一致する（行を消すだけでは黙らない）", () => {
  assert.equal(
    INVENTORY.length,
    EXPECTED_COUNT,
    `INVENTORY の行数 ${INVENTORY.length} と EXPECTED_COUNT ${EXPECTED_COUNT} が食い違う。
増減させたなら両方を書き換えて、diff に意図を残すこと（#507）。`,
  );
});

test("#513 経路1: 各 *.test.sh は失敗を exit status に変える出口を持つ（exit 0 に差し替えると落ちる）", () => {
  const src = sources();
  const offenders: string[] = [];
  const audited: string[] = [];
  for (const { file } of INVENTORY) {
    const s = src.get(file);
    audited.push(file);
    if (s === undefined) {
      offenders.push(`${file}: ファイルが無い`);
      continue;
    }
    if (!GATES.some((g) => s.includes(g)))
      offenders.push(`${file}: 出口が無い`);
  }
  // #507: 「何件通ったか」ではなく「無罪と判定したものを検査器に掛け直す」。
  // 監査は judge の申告ではなく**対象集合そのもの**を起点に回す（ループごと飛ばされた1件を拾うため）。
  // 監査の結果は脇に置かず、**検出そのものに合流させる**（脇に置くと「監査だけ消す」で黙る）。
  const skipped = INVENTORY.map((e) => e.file).filter(
    (f) => !audited.includes(f),
  );
  assert.deepEqual(
    { offenders, skipped },
    { offenders: [], skipped: [] },
    `失敗が exit status に出ないテストがある（CI の \`bash "$t"\` は exit status しか見ない）。
${offenders.map((o) => `  - ${o}`).join("\n") || "  （検出なし）"}
  検査を飛ばした（ループが1件も見ていない）: ${skipped.join(", ") || "なし"}
出口の書き方（逐語）: ${GATES.join(" / ")}`,
  );
});

test("#513 経路1: 各 *.test.sh は検査項目を名指ししている（空にしても中身を抜いても落ちる）", () => {
  const src = sources();
  const findings: string[] = [];
  const audited: string[] = [];
  for (const { file, anchors, minAssertions: min } of INVENTORY) {
    const s = src.get(file);
    audited.push(file);
    if (s === undefined) {
      findings.push(`${file}: ファイルが無い`);
      continue;
    }
    if (anchors.length === 0)
      findings.push(`${file}: anchors が空（何も守っていない宣言に等しい）`);
    for (const a of anchors)
      if (!s.includes(a))
        findings.push(`${file}: 検査項目 [${a}] が消えている`);
    // **逐語一致だけでは、本文をコメントにして exit 0 を足すだけで通った**（PR #526 のレビュー、14/14）。
    // 実際に走る assertion の数に下限を置く。コメントに逃がした本文はここで 0 になる。
    const n = assertionSites(s);
    if (n < min)
      findings.push(
        `${file}: 実際に走る assertion が ${n} 個（最低 ${min} 個。減らすなら台帳も直すこと）`,
      );
  }
  const skipped = INVENTORY.map((e) => e.file).filter(
    (f) => !audited.includes(f),
  );
  assert.deepEqual(
    { findings, skipped },
    { findings: [], skipped: [] },
    `deploy/test の中身が痩せている（ファイルはあるが、検査が消えている）。
${findings.map((f) => `  - ${f}`).join("\n") || "  （検出なし）"}
  検査を飛ばした（ループが1件も見ていない）: ${skipped.join(", ") || "なし"}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 経路2: 被覆（期待値は deploy/ の実ファイルから導く。台帳を編集しても縮まない）
// ---------------------------------------------------------------------------------------------

/**
 * `deploy/` に置かれた**本番で動くスクリプト・設定**を、ディレクトリから数え上げる。
 * deploy/test/ 自身と、テスト用の補助（render-host-proxy.sh）は除く。
 */
function deploySubjects(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(resolve(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (p === "deploy/test" || e.name === "node_modules") continue;
        walk(p);
      } else if (e.name.endsWith(".sh") || e.name.endsWith(".conf")) {
        out.push(p);
      }
    }
  };
  walk("deploy");
  return out.sort();
}

/**
 * 被覆の**例外**。ここに書けるのは「deploy テストが触らない」ことに理由があるものだけ。
 * **例外を増やせば被覆は骨抜きになる**ので、増やすときは理由を書くこと（#484: 通す側の集合も固定する）。
 */
const UNCOVERED: Record<string, string> = {
  // ホスト側 nginx の proxy_pass 断片。値は packages/etl/test/deploy-docker.test.ts が固定する係。
  "deploy/nginx-host-proxy.conf":
    "文字列の検査は deploy-docker.test.ts が持つ（実配信の対象外）",
  // アクセスログの集計。本番の配信にも設定にも触らない後処理。
  "deploy/analytics/aggregate.sh": "配信・設定に触らない後処理（#288 の集計）",
  "deploy/analytics/nginx-noip-log.conf":
    "log_format の断片。vps-analytics-setup.sh 経由で入る",
};

/**
 * **例外集合そのものを固定する**（#484: allowlist を持つ検査は allowlist をテストしないと、
 * 緩めても気づけない）。実測（Z5）: UNCOVERED に 3 件押し込むだけで、経路2 は
 * monitor-probe.test.sh の削除に**一言も言わなくなった**。
 * 期待値はハードコードする——UNCOVERED から生成すると自己参照になる（#499）。
 */
const UNCOVERED_KEYS = [
  "deploy/analytics/aggregate.sh",
  "deploy/analytics/nginx-noip-log.conf",
  "deploy/nginx-host-proxy.conf",
];

/**
 * **母集団そのものを固定する。**
 *
 * **レビュー（PR #526）で破られた点**: 経路2 は「期待値の出どころが `deploy/` の実ファイル」を
 * 売りにしていたが、**その実ファイル集合が痩せれば期待値も一緒に痩せる**（#499 の形）。実測:
 *   - **W3**: `git mv deploy/monitor infra/monitor`（テストは一切触らない）+ monitor 系 3 本を削除 → **9 pass / 0 fail**
 *   - **W4**: `deploy/monitor/probe.sh` → `probe`（拡張子を外す）→ 数え上げから外れて黙る
 * **例外側（UNCOVERED_KEYS）だけ固定して、母集団を固定していなかった。**
 */
const DEPLOY_SUBJECTS_PINNED = [
  "deploy/analytics/aggregate.sh",
  "deploy/analytics/daily.sh",
  "deploy/analytics/logrotate.conf",
  "deploy/analytics/nginx-noip-log.conf",
  "deploy/analytics/vps-analytics-setup.sh",
  "deploy/apply-all.sh",
  "deploy/cloudflare-allowlist.sh",
  "deploy/go-live.sh",
  "deploy/monitor/health.sh",
  "deploy/monitor/logrotate.conf",
  "deploy/monitor/probe.sh",
  "deploy/monitor/report.sh",
  "deploy/monitor/run.sh",
  "deploy/monitor/setup.sh",
  "deploy/nginx-host-proxy.conf",
  "deploy/nginx/site.conf",
  "deploy/ops-user-setup.sh",
  "deploy/run-remote.sh",
  "deploy/staging-setup.sh",
  "deploy/vps-setup.sh",
];

test("#513 経路2: 被覆の母集団そのものを固定する（deploy/ を移動・改名して痩せさせられない）", () => {
  const actual = deploySubjects();
  const gone = DEPLOY_SUBJECTS_PINNED.filter((f) => !actual.includes(f));
  const added = actual.filter((f) => !DEPLOY_SUBJECTS_PINNED.includes(f));
  assert.deepEqual(
    { gone, added },
    { gone: [], added: [] },
    `deploy/ の本番ファイル集合（被覆の母集団）が変わっている。
  消えた/移動した/改名された: ${gone.join(", ") || "なし"}
  増えた                    : ${added.join(", ") || "なし"}

**母集団が痩せると、被覆の期待値も一緒に痩せる。**
deploy/ の外に出した／拡張子を外したなら、それは「deploy テストの守備範囲から外した」ということ。
本当にそうするなら DEPLOY_SUBJECTS_PINNED も書き換えて、diff に意図を残すこと。`,
  );
});

test("#513 経路2: 被覆の例外集合そのものを固定する（例外を増やして骨抜きにできない）", () => {
  assert.deepEqual(
    Object.keys(UNCOVERED).sort(),
    [...UNCOVERED_KEYS].sort(),
    `被覆の例外（UNCOVERED）が変わっている。
  いま        : ${Object.keys(UNCOVERED).sort().join(", ")}
  固定した中身: ${[...UNCOVERED_KEYS].sort().join(", ")}
例外を1つ足すたびに「deploy テストが1本も触らないもの」が1つ増える。
本当に足すなら UNCOVERED と UNCOVERED_KEYS の両方を書き換え、理由を残すこと。`,
  );
  const noReason = Object.entries(UNCOVERED)
    .filter(([, why]) => why.trim().length === 0)
    .map(([k]) => k);
  assert.deepEqual(
    noReason,
    [],
    `理由の無い例外（場所取りだけ）: ${noReason.join(", ")}`,
  );
});

/**
 * **どの deploy テストが、その本番ファイルの主担当か**を名指しで固定する。
 *
 * **なぜ「どれかが名指ししていれば良い」では足りないか**（PR #526 のレビュー + 自分で全 14 本を測り直した）:
 *   「削除 + 台帳を指示どおり全部更新」を **14 本すべて**に当てたところ、**7 本が 12 pass / 0 fail**
 *   （`cloudflare-allowlist` / `monitor-health` / `monitor-setup` / `nginx-reload` /
 *    `ops-user-setup` / `staging-setup` / `vps-setup`）。
 *   **他のテストが同じ subject をたまたま名指ししている**ので、被覆が満たされたままだった。
 *   これは #504「名前を固定した は 値を固定した ではない」の被覆版——
 *   **「誰かが触っている」は「その検査が生きている」ではない。**
 *
 * 主担当は「そのファイルを検査するために書かれたテスト」。付随的な言及とは区別する。
 */
const SUBJECT_OWNERS: Record<string, string> = {
  "deploy/analytics/daily.sh": "go-live.test.sh",
  "deploy/analytics/logrotate.conf": "logrotate.test.sh",
  "deploy/analytics/vps-analytics-setup.sh": "logrotate.test.sh",
  "deploy/apply-all.sh": "apply-all.test.sh",
  "deploy/cloudflare-allowlist.sh": "cloudflare-allowlist.test.sh",
  "deploy/go-live.sh": "go-live.test.sh",
  "deploy/monitor/health.sh": "monitor-health.test.sh",
  "deploy/monitor/logrotate.conf": "logrotate.test.sh",
  "deploy/monitor/probe.sh": "monitor-probe.test.sh",
  "deploy/monitor/report.sh": "monitor-probe.test.sh",
  "deploy/monitor/run.sh": "monitor-probe.test.sh",
  "deploy/monitor/setup.sh": "monitor-setup.test.sh",
  "deploy/nginx/site.conf": "nginx-headers.test.sh",
  "deploy/ops-user-setup.sh": "ops-user-setup.test.sh",
  "deploy/run-remote.sh": "run-remote.test.sh",
  "deploy/staging-setup.sh": "staging-setup.test.sh",
  "deploy/vps-setup.sh": "vps-setup.test.sh",
};

/**
 * 担当表を表の外にもう一度書く（#484）。
 * **`{ ...SUBJECT_OWNERS }` にしてはいけない**——自己参照になって、片方を書き換えれば両方変わる
 * （#499「期待値はハードコードする。検査対象から生成すると、対象が痩せれば期待値も一緒に痩せる」）。
 */
const SUBJECT_OWNERS_PINNED: Record<string, string> = {
  "deploy/analytics/daily.sh": "go-live.test.sh",
  "deploy/analytics/logrotate.conf": "logrotate.test.sh",
  "deploy/analytics/vps-analytics-setup.sh": "logrotate.test.sh",
  "deploy/apply-all.sh": "apply-all.test.sh",
  "deploy/cloudflare-allowlist.sh": "cloudflare-allowlist.test.sh",
  "deploy/go-live.sh": "go-live.test.sh",
  "deploy/monitor/health.sh": "monitor-health.test.sh",
  "deploy/monitor/logrotate.conf": "logrotate.test.sh",
  "deploy/monitor/probe.sh": "monitor-probe.test.sh",
  "deploy/monitor/report.sh": "monitor-probe.test.sh",
  "deploy/monitor/run.sh": "monitor-probe.test.sh",
  "deploy/monitor/setup.sh": "monitor-setup.test.sh",
  "deploy/nginx/site.conf": "nginx-headers.test.sh",
  "deploy/ops-user-setup.sh": "ops-user-setup.test.sh",
  "deploy/run-remote.sh": "run-remote.test.sh",
  "deploy/staging-setup.sh": "staging-setup.test.sh",
  "deploy/vps-setup.sh": "vps-setup.test.sh",
};

test("#513 経路2: 本番ファイルの主担当表そのものを固定する（担当を付け替えて骨抜きにできない）", () => {
  // 母集団 = 例外 + 主担当。漏れも重複も許さない。
  const covered = [
    ...Object.keys(SUBJECT_OWNERS),
    ...Object.keys(UNCOVERED),
  ].sort();
  assert.deepEqual(
    covered,
    DEPLOY_SUBJECTS_PINNED,
    `deploy/ の本番ファイルと、担当表（SUBJECT_OWNERS + UNCOVERED）が食い違う。
  母集団  : ${DEPLOY_SUBJECTS_PINNED.join(", ")}
  担当表  : ${covered.join(", ")}
本番ファイルを足したら主担当を決めること。`,
  );
  assert.deepEqual(
    SUBJECT_OWNERS,
    SUBJECT_OWNERS_PINNED,
    "主担当表が変わっている。両方を書き換えること。",
  );
});

test("#513 経路2: 名指しした主担当が、生きたテストとしてその本番ファイルを見ている", () => {
  const src = sources();
  const live = new Map(INVENTORY.map((e) => [e.file, e.minAssertions]));
  const findings: string[] = [];
  const audited: string[] = [];
  for (const [subject, owner] of Object.entries(SUBJECT_OWNERS)) {
    audited.push(subject);
    const body = src.get(owner);
    if (body === undefined) {
      findings.push(`${subject}: 主担当の ${owner} が存在しない（削除された）`);
      continue;
    }
    if (assertionSites(body) < (live.get(owner) ?? 1))
      findings.push(
        `${subject}: 主担当の ${owner} が骨抜きになっている（走る assertion が足りない）`,
      );
    const base = subject.slice("deploy/".length);
    const name = base.slice(base.lastIndexOf("/") + 1);
    if (!body.includes(base) && !body.includes(name))
      findings.push(
        `${subject}: 主担当の ${owner} が実行される本文でこれを名指ししていない`,
      );
  }
  const skipped = Object.keys(SUBJECT_OWNERS).filter(
    (k) => !audited.includes(k),
  );
  assert.deepEqual(
    { findings, skipped },
    { findings: [], skipped: [] },
    `本番ファイルの主担当が、生きたテストとして機能していない。
${findings.map((f) => `  - ${f}`).join("\n") || "  （検出なし）"}
  数え上げから飛ばした: ${skipped.join(", ") || "なし"}

**「他のテストがたまたま名指ししている」では守りにならない**（実測: 7 本がそれで素通りしていた）。`,
  );
});

test("#513 経路2: deploy/ の本番スクリプト・設定は、どれかの deploy テストから名指しされている", () => {
  const src = sources();
  const subjects = deploySubjects();
  const findings: string[] = [];
  const audited: string[] = [];
  for (const s of subjects) {
    audited.push(s);
    if (s in UNCOVERED) continue;
    const base = s.slice("deploy/".length);
    const name = base.slice(base.lastIndexOf("/") + 1);
    const covered = [...src.values()].some(
      (t) => t.includes(base) || t.includes(name),
    );
    if (!covered)
      findings.push(`${s}: これを名指しする deploy テストが1本も無い`);
  }
  // 監査: 数え上げた対象を1件も飛ばしていないこと。検出と同じ assertion に合流させる（#507）。
  const skipped = subjects.filter((s) => !audited.includes(s));
  assert.deepEqual(
    { findings, skipped },
    { findings: [], skipped: [] },
    `deploy/ にあるのに、どの deploy テストからも触られていないものがある。
${findings.map((f) => `  - ${f}`).join("\n") || "  （検出なし）"}
  数え上げから飛ばした: ${skipped.join(", ") || "なし"}

**この期待値は台帳ではなく deploy/ の実ファイルから来る。**
テストを消して黙らせることはできない（黙らせるには本番のファイルのほうを消すことになる）。
意図して対象外にするなら UNCOVERED に**理由つきで**足すこと。`,
  );
});

// ---------------------------------------------------------------------------------------------
// 経路3: 能力（期待値は site.conf の add_header から導く。台帳を編集しても縮まない）
// ---------------------------------------------------------------------------------------------

/** site.conf が実際に送るヘッダ名を、設定から数え上げる（コメント行は除く）。 */
function headersInSiteConf(): string[] {
  const conf = read("deploy/nginx/site.conf")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const names = new Set<string>();
  for (const m of conf.matchAll(/add_header\s+([A-Za-z][A-Za-z0-9-]*)/g))
    names.add(m[1]);
  return [...names].sort();
}

/**
 * **本物の nginx を起動して実際のレスポンスを見る** deploy テスト。
 * 「site.conf を文字列として読む」だけのテストはここに数えない——
 * add_header の**継承の罠**（内側に1つあれば外側は全部無効）は、文字列では絶対に見つからないから
 * （#482 以前の本番が実際にそうだった）。
 */
function liveNginxTests(): string[] {
  const floor = new Map(INVENTORY.map((e) => [e.file, e.minAssertions]));
  const out: string[] = [];
  for (const [name, s] of sources()) {
    // 判定は**コメントを落とした本文**に対して行う（sources() が既にそうなっている）。
    if (
      !s.includes("docker run") ||
      !s.includes("curl") ||
      !s.includes("site.conf")
    )
      continue;
    // **抜け殻を「実配信のテスト」と数えない**: 台帳の下限を満たす assertion が実際に走ること。
    // これが無いと、骨抜きにしたファイルが供給側として数えられてしまう。
    if (assertionSites(s) < (floor.get(name) ?? 1)) continue;
    out.push(name);
  }
  return out.sort();
}

/**
 * deploy テストではなく **ci.yml の docker-web ジョブ**が実配信で見ているヘッダ。
 * 値はその根拠になる ci.yml の逐語行——**根拠が消えれば例外も消える**（下で検査する）。
 * ここに足すのは「別のどこかが実際に叩いている」ものだけ。理由を書くこと。
 */
const ELSEWHERE: Record<string, string> = {
  // Host ヘッダで切り替わるので、単一コンテナを叩く deploy テストでは形が合わない（#127）。
  "X-Robots-Tag": "grep -i '^x-robots-tag: noindex, nofollow$'",
  // キャッシュ方針。apps/web の smoke（URL モード）が 8081 / 8083 の両方で見ている。
  "Cache-Control": "pnpm --filter web smoke -- --url",
};

/**
 * **例外集合そのものを固定する**（#484）。実測: ELSEWHERE に 5 ヘッダ押し込むだけで、
 * 経路3 は nginx-headers.test.sh の削除に**一言も言わなくなった**。
 * 期待値はハードコードする（ELSEWHERE から生成すると自己参照になる。#499）。
 */
const ELSEWHERE_KEYS = ["Cache-Control", "X-Robots-Tag"];

/**
 * **どのファイルがそのヘッダの実配信検査を持つか**を名指しで固定する。
 *
 * **なぜ「どこかにあること」では足りないか**（PR #526 のレビュー + 自分で追加検証）:
 *   - **W1**: `nginx-headers.test.sh` を消し、`nginx-404.test.sh` に**コメント1行**足すだけで黙った
 *   - **W1b**: コメント除去を入れたら、`: Permissions-Policy ...` と**本文1行**にすれば黙った
 *   - **W1c**: 実配信の形（`Permissions-Policy:`）を要求したら、**その文字列を本文に書く**だけで黙った
 * **文字列一致である限り、その文字列を書けば偽装できる。** 追いかけっこは終わらない。
 *
 * 止め方は「**担当を名指しする**」こと。`Permissions-Policy` を実配信で見る係は
 * `nginx-headers.test.sh` だと固定する。**その係が消えたら、他のファイルに何を書いても通らない。**
 * 係を変えるには、ここを書き換える——それは「誰が守るかを変えた」と diff に残る。
 */
const HEADER_OWNERS: Record<string, string[]> = {
  "Content-Security-Policy": ["nginx-404.test.sh", "nginx-headers.test.sh"],
  "Permissions-Policy": ["nginx-headers.test.sh"],
  "Referrer-Policy": ["nginx-headers.test.sh"],
  "X-Content-Type-Options": ["nginx-404.test.sh", "nginx-headers.test.sh"],
  "X-Frame-Options": ["nginx-404.test.sh", "nginx-headers.test.sh"],
};

test("#513 経路3: 実配信検査の例外集合そのものを固定する（例外を増やして骨抜きにできない）", () => {
  assert.deepEqual(
    Object.keys(ELSEWHERE).sort(),
    [...ELSEWHERE_KEYS].sort(),
    `実配信検査の例外（ELSEWHERE）が変わっている。
  いま        : ${Object.keys(ELSEWHERE).sort().join(", ")}
  固定した中身: ${[...ELSEWHERE_KEYS].sort().join(", ")}
ここに1つ足すたびに「deploy テストが実配信で見ないセキュリティヘッダ」が1つ増える。
足すなら ELSEWHERE と ELSEWHERE_KEYS の両方を書き換え、**別のどこかが実際に叩いている**根拠を
ci.yml の逐語行として書くこと（その行が消えれば下のテストが落ちる）。`,
  );
});

/** 担当表を、表の外にもう一度書く（#484）。 */
const HEADER_OWNERS_PINNED: Record<string, string[]> = {
  "Content-Security-Policy": ["nginx-404.test.sh", "nginx-headers.test.sh"],
  "Permissions-Policy": ["nginx-headers.test.sh"],
  "Referrer-Policy": ["nginx-headers.test.sh"],
  "X-Content-Type-Options": ["nginx-404.test.sh", "nginx-headers.test.sh"],
  "X-Frame-Options": ["nginx-404.test.sh", "nginx-headers.test.sh"],
};

test("#513 経路3: ヘッダの担当表そのものを固定する（担当を書き換えて骨抜きにできない）", () => {
  // ELSEWHERE と HEADER_OWNERS を合わせて、site.conf の全ヘッダが**漏れなく1度ずつ**割り当たること。
  const assigned = [
    ...Object.keys(HEADER_OWNERS),
    ...Object.keys(ELSEWHERE),
  ].sort();
  assert.deepEqual(
    assigned,
    headersInSiteConf(),
    `site.conf のヘッダと、担当表（HEADER_OWNERS + ELSEWHERE）が食い違う。
  site.conf : ${headersInSiteConf().join(", ")}
  担当表    : ${assigned.join(", ")}
ヘッダを足したら担当を決めること。担当表から外すのは「誰も実配信で見ない」と決めること。`,
  );
  assert.deepEqual(
    HEADER_OWNERS,
    HEADER_OWNERS_PINNED,
    `ヘッダの担当表が変わっている。担当を別ファイルに移すと、そのファイルに
文字列を書くだけで元の担当を消せてしまう（W1c で実測）。両方を書き換えること。`,
  );
});

test("#513 経路3: site.conf が送るヘッダは、名指しした担当が実配信で1つ残らず見ている", () => {
  const live = liveNginxTests();
  const headers = headersInSiteConf();
  const src = sources();
  const findings: string[] = [];
  const audited: string[] = [];

  if (live.length === 0)
    findings.push("実物の nginx を起動して叩く deploy テストが1本も無い");

  const ci = read(".github/workflows/ci.yml");
  for (const h of headers) {
    audited.push(h);
    const elsewhere = ELSEWHERE[h];
    if (elsewhere !== undefined) {
      // **例外そのものを検査する**（#484: 通す側の集合も固定する）。
      // 「docker-web が見ているから」で外したものは、docker-web が本当に見ていることを確かめる。
      // ci.yml からその行が消えれば、例外は例外でなくなり、ここが落ちる。
      if (!ci.includes(elsewhere))
        findings.push(
          `${h}: deploy テストの対象外にした根拠 [${elsewhere}] が ci.yml から消えている`,
        );
      continue;
    }
    // **ヘッダ名がどこかに出てくる**では足りない（PR #526 のレビュー実測 W1: 別ファイルに
    // 1 行足すだけで経路3 が黙った）。要求するのは **HTTP の実配信の形**——
    // `Header:` というレスポンス行の形で、しかも**実際に走る本文**（コメント除去済み）に
    // あること。ヘッダ名を裸で書き散らしても、この形にはならない。
    // **担当を名指しで要求する**（文字列一致だけだと、その文字列を書けば偽装できる。W1c で実測）。
    const owners = HEADER_OWNERS[h];
    if (owners === undefined) {
      findings.push(
        `${h}: 実配信検査の担当が HEADER_OWNERS に無い（site.conf は送っている）`,
      );
      continue;
    }
    const wire = new RegExp(`${h}:`, "i");
    for (const o of owners) {
      if (!live.includes(o))
        findings.push(
          `${h}: 担当の ${o} が「実配信を叩く生きたテスト」として数えられない（削除/骨抜き）`,
        );
      else if (!wire.test(src.get(o) ?? ""))
        findings.push(`${h}: 担当の ${o} が \`${h}:\` を実配信で見ていない`);
    }
  }
  const skipped = headers.filter((h) => !audited.includes(h));
  assert.deepEqual(
    { findings, skipped },
    { findings: [], skipped: [] },
    `site.conf が送るヘッダのうち、**実際に配信して出るか**を誰も見ていないものがある。
${findings.map((f) => `  - ${f}`).join("\n") || "  （検出なし）"}
  実物の nginx を叩く deploy テスト: ${live.join(", ") || "なし"}
  site.conf の add_header: ${headers.join(", ")}
  数え上げから飛ばした: ${skipped.join(", ") || "なし"}

**この期待値は台帳ではなく deploy/nginx/site.conf から来る。**
nginx-headers.test.sh を消しても台帳を消しても、site.conf が Permissions-Policy を送る限りここは落ちる。
nginx の add_header は**継承されない**ので、文字列を読むだけの検査では継承の罠を見つけられない（#482）。`,
  );
});

// ---------------------------------------------------------------------------------------------
// 経路4: 横断する性質（1つの本番ファイルに紐づかない守り）
// ---------------------------------------------------------------------------------------------

/**
 * **1 本の本番ファイルに紐づかない守り**は、経路2（主担当）では拾えない。
 * 実測（レビュー対応で全 14 本を測り直したとき）: 「削除 + 台帳を指示どおり全部更新」で
 * **`nginx-reload.test.sh` だけが 14 pass / 0 fail** で通った。
 * このテストが守るのは特定のファイルではなく、**deploy 全体に横断する性質**:
 *
 *   `set -e` のもとで `nginx -t && systemctl reload nginx` と書くと、
 *   **設定が壊れていても reload が黙って飛ばされ、スクリプトは成功したように進む**
 *   （失敗したコマンドが `&&` リストの最後ではないので errexit が無視する。#133）。
 *   だから nginx を reload するスクリプトは `reload_nginx()` を通さなければならない。
 *
 * 期待値の出どころは **deploy/ の本番スクリプト**（`reload_nginx` を使っているファイル）なので、
 * 台帳を編集しても縮まない。
 */
const CROSSCUTTING: {
  property: string;
  owner: string;
  usedBy: string[];
  why: string;
}[] = [
  {
    property: "reload_nginx",
    owner: "nginx-reload.test.sh",
    usedBy: ["deploy/vps-setup.sh", "deploy/analytics/vps-analytics-setup.sh"],
    why: "set -e のもとで `nginx -t && systemctl reload` は壊れた設定でも黙って進む（#133）",
  },
];

test("#513 経路4: 横断する性質を使う本番スクリプトには、それを見る生きたテストがある", () => {
  const src = sources();
  const floor = new Map(INVENTORY.map((e) => [e.file, e.minAssertions]));
  const findings: string[] = [];
  const audited: string[] = [];
  for (const { property, owner, usedBy, why } of CROSSCUTTING) {
    audited.push(property);
    // 母集団: その性質を実際に使っている本番スクリプトを、deploy/ から数え上げる。
    const actualUsers = deploySubjects()
      .filter((f) => f.endsWith(".sh"))
      .filter((f) => stripComments(read(f)).includes(property))
      .sort();
    assert.deepEqual(
      actualUsers,
      [...usedBy].sort(),
      `${property} を使う本番スクリプトの集合が変わっている（${why}）。
  いま: ${actualUsers.join(", ") || "なし"}
  固定: ${[...usedBy].sort().join(", ")}`,
    );
    if (actualUsers.length === 0) continue; // 誰も使っていないなら守る対象も無い
    const body = src.get(owner);
    if (body === undefined) {
      findings.push(`${property}: これを見る ${owner} が存在しない（${why}）`);
      continue;
    }
    if (assertionSites(body) < (floor.get(owner) ?? 1))
      findings.push(
        `${property}: ${owner} が骨抜きになっている（走る assertion が足りない）`,
      );
    if (!body.includes(property))
      findings.push(
        `${property}: ${owner} が実行される本文で ${property} を見ていない`,
      );
  }
  const skipped = CROSSCUTTING.map((c) => c.property).filter(
    (c) => !audited.includes(c),
  );
  assert.deepEqual(
    { findings, skipped },
    { findings: [], skipped: [] },
    `横断する性質を守るテストが失われている。
${findings.map((f) => `  - ${f}`).join("\n") || "  （検出なし）"}
  数え上げから飛ばした: ${skipped.join(", ") || "なし"}`,
  );
});

test("#513: ci.yml は deploy/test/*.test.sh を今も走らせている（走らせるのをやめても落ちる）", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(
    ci.includes("deploy/test/*.test.sh"),
    "ci.yml が deploy/test/*.test.sh を走らせていない。台帳を守っても、走らなければ意味がない。",
  );
});
