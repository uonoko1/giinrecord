import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1286 受け入れ条件 1 — **鳴り止んだのに `[monitor]` の Issue が閉じなかった。**
 *
 * ## 何が起きていたか（実測。2026-10-11T11:40Z に `gh` で数えた）
 *
 * `#1221`（`[monitor] production: data`）は **111.2 時間 OPEN のまま**だった。
 * `createdAt 2026-10-06T20:33:20Z` / 最後の報告 `2026-10-11T07:19:56Z`（その時点で 106.8h）。
 *
 * **「閉じるコードが無い」のではない。** 実測で確かめた:
 *   - `gh issue list --label monitor --state open --search '"[monitor] production: data" in:title'`
 *     → **`#1221` を返す**（題が `— 9h 継続` に改題されていても引ける）
 *   - `report.sh` の `open_issue` の `--jq` をそのまま流すと
 *     `1221<TAB>2026-10-06T20:33:20Z<TAB>monitor,escalated<TAB>26` が出る
 *   - `bash deploy/monitor/probe.sh https://giinrecord.jp` は **ok http / ok data / ok tls**
 *     （`fetchedAt` は 35h で 48h 以内）
 *
 * **閉じない理由は「閉じる判定をする run が来ない」ことだった。**
 *
 * ```
 * monitor.yml の run 200 本（2026-09-21T05:32Z〜2026-10-11T08:40Z、窓 483.1h）
 *   → 0.41 run/h。10 分ごと（every-10-minutes cron）の宣言は 6 run/h なので **実行率は約 1/15**
 *   → 連続 run の間隔 p50 126.5 分 / p90 322.6 分 / max 496.1 分
 *
 * さらに **1 run = 1 job**（10 分ごとの cron は production、毎時 7 分は staging を選んでいた）ので
 *   production の job が実際に走ったのは 156.4h で 31 回 = **0.20 回/h**
 *   → 間隔 p50 321.1 分 / p90 412.7 分 / max 520.4 分
 *
 * **#1221 の最後の報告 07:19:56Z から 4.4 時間、production の job は 1 度も走っていなかった。**
 * ```
 *
 * これは docs/ops/monitoring.md が #1185 で測った「実行率 8.2%」と同じ現象で、
 * **GitHub 側の都合なので cron の宣言を細かくしても増えない。**
 *
 * ## だから何を固定するか
 *
 * **「走る回数を増やす」のではなく「走る機会を取りこぼさない」方向の 2 つ**を固定する:
 *
 *   1. **production の job が cron を選り分けないこと。** 10 分ごとの cron だけに紐づけていたので、
 *      `7 * * * *` の firing では production を 1 度も見ていなかった
 *      （実測: 60 run 中 29 run が staging 専用の firing）。
 *      **実測での効果**: 同じ 60 run を母数に、production の間隔は
 *      **p50 321.1 → 143.0 分 / max 520.4 → 496.1 分**（31 回 → 60 回）。
 *      **max がほとんど動かない**ので、**これ単体では「鳴り止んだらすぐ閉じる」にならない。**
 *   2. **`deploy-data.yml` の完了で 1 周すること**（`workflow_run`）。
 *      **`data` が ok に戻る原因はほぼこれ**なので、**原因の側から 1 周を起こす。**
 *      schedule を待たないので、**「復旧したのに 5 時間 Issue が開いたまま」が構造的に無くなる。**
 *
 * **1 と 2 は別の失敗に効く**（1 は「firing を捨てていた」、2 は「firing が来ない」）ので、
 * **両方を独立に固定する。** 片方だけでは測った max 496 分が残る。
 *
 * ## このテストが**証明していないこと**（明示する）
 *
 * **「閉じる」の実物は、この枝が main に入って `workflow_run` が 1 度発火するまで観測できない。**
 * `workflow_run` は**既定ブランチの workflow 定義で走る**ので、枝では発火しない。
 * **だから #1286 は `Closes` ではなく `Refs` で参照する**——コードのマージは受け入れ条件
 * 「鳴り止んだら閉じることを両側で示す」を満たさない。
 * ここで固定できるのは**配線**であって、**発火の実物ではない。**
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const monitorYml = readFileSync(resolve(repo, ".github/workflows/monitor.yml"), "utf8");

/** `jobs:` 直下の job を、その本文ごと切り出す（`#` の落としはしない——#1239 の教訓） */
function jobBlocks(yml: string): Map<string, string> {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  assert.ok(start >= 0, "monitor.yml に `jobs:` が無い");
  const out = new Map<string, string>();
  let name: string | null = null;
  let buf: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      if (name) out.set(name, buf.join("\n"));
      name = m[1];
      buf = [];
    } else if (name) {
      buf.push(line);
    }
  }
  if (name) out.set(name, buf.join("\n"));
  return out;
}

const jobs = jobBlocks(monitorYml);

test("#1286-1a: production の job は cron を選り分けない（firing を捨てない）", () => {
  const prod = jobs.get("production");
  assert.ok(prod, `monitor.yml に production の job が無い（在るのは ${[...jobs.keys()].join(", ")}）`);

  // **`if:` が無いこと**を見る。**「特定の式でないこと」ではなく「条件そのものが無いこと」**を
  // 固定するのが要点——`if: github.event.schedule == '*/10 * * * *'` に戻すと
  // **`7 * * * *` の firing で production を見なくなり、実測の 29/60 をまた捨てる。**
  const ifLines = prod
    .split("\n")
    .filter((l) => /^ {4}if:/.test(l))
    .map((l) => l.trim());
  assert.deepEqual(
    ifLines,
    [],
    `production の job に \`if:\` が付いている。**どの firing でも production を見ること**が #1286 の\n` +
      `受け入れ条件 1 の片側である（実測: \`*/10\` だけに紐づけていたので 60 run 中 29 run の\n` +
      `firing で production を 1 度も見ておらず、間隔の p50 が 321.1 分だった）。\n` +
      `付いていた条件: ${JSON.stringify(ifLines)}`,
  );
});

test("#1286-1b: staging は workflow_run では走らない（原因に関係しない環境を巻き込まない）", () => {
  const staging = jobs.get("staging");
  assert.ok(staging, "monitor.yml に staging の job が無い");

  const ifLine = staging.split("\n").find((l) => /^ {4}if:/.test(l));
  assert.ok(ifLine, "staging の job に `if:` が無い。`workflow_run` でも staging を probe してしまう");

  // **`github.event_name != 'schedule'` の形に戻っていないこと。** その形だと
  // **`workflow_run` が「schedule ではない」に当たって staging も走る**
  // ——Cloudflare Access のトークンが無い firing で走れば `::warning::` で抜けるが、
  // **`deploy-data.yml` が終わるたびに無関係な環境を外から叩くことになる。**
  assert.ok(
    !/event_name\s*!=\s*'schedule'/.test(ifLine),
    `staging の \`if:\` が \`event_name != 'schedule'\` の形に戻っている。` +
      `**\`workflow_run\` がこれに当たるので staging も走る。** 発火の種類を名指しすること。\n` +
      `いまの行: ${ifLine.trim()}`,
  );
  // 残す発火は「該当する cron」と「手で起動したとき」だけ。
  assert.match(ifLine, /7 \* \* \* \*/, "staging は自分の cron では走ること");
  assert.match(ifLine, /workflow_dispatch/, "staging は手で起動できること");
});

test("#1286-1c: deploy-data.yml の完了で 1 周する（復旧の原因の側から起こす）", () => {
  // `on:` から `permissions:` までを見る（`jobs:` の中の語に当たらないように範囲を絞る）
  const onStart = monitorYml.indexOf("\non:\n");
  assert.ok(onStart >= 0, "monitor.yml に `on:` が無い");
  const onEnd = monitorYml.indexOf("\npermissions:", onStart);
  assert.ok(onEnd > onStart, "monitor.yml に `permissions:` が無い");
  const onBlock = monitorYml.slice(onStart, onEnd);

  assert.match(
    onBlock,
    /^ {2}workflow_run:$/m,
    "monitor.yml の `on:` に `workflow_run` が無い。**schedule だけに頼ると、実測で max 496 分 " +
      "（production の job では 520 分）復旧に気づかない。**",
  );
  // **名前で紐づく**ので、`deploy-data.yml` の `name:` と一致していること（下のテストで突き合わせる）。
  assert.match(onBlock, /workflows:\s*\["Deploy data"\]/, "`workflow_run` が Deploy data を見ていない");
  // **`completed`**: 成功でも失敗でも 1 周する。**失敗したときこそ見たい**
  // （失敗なら `data` は古いままなので、鳴り続けるのが正しい）。
  assert.match(onBlock, /types:\s*\[completed\]/, "`types: [completed]` でないと発火の形が変わる");
});

test("#1286-1d: workflow_run の名前が deploy-data.yml の name と実際に一致する（綴りだけで繋がっている）", () => {
  // **`workflow_run` は workflow の `name:` で紐づく。** ファイル名ではない。
  // **綴りを間違えても YAML は妥当なので、actionlint も通り、永久に発火しない。**
  // **だから両側を突き合わせる**（この repo の「2 つの数が同じ制約を分担すると矛盾する」の形）。
  const deployData = readFileSync(resolve(repo, ".github/workflows/deploy-data.yml"), "utf8");
  const nameLine = deployData.split("\n").find((l) => /^name:/.test(l));
  assert.ok(nameLine, "deploy-data.yml に `name:` が無い");
  const actual = nameLine.replace(/^name:\s*/, "").trim();

  const m = /workflows:\s*\["([^"]+)"\]/.exec(monitorYml);
  assert.ok(m, "monitor.yml の `workflow_run.workflows` を読めない");
  assert.equal(
    m[1],
    actual,
    `monitor.yml の \`workflow_run.workflows\` が deploy-data.yml の \`name:\` と食い違う。\n` +
      `**綴りが違っても YAML としては妥当なので、何も赤くならないまま永久に発火しない。**\n` +
      `monitor.yml: ${JSON.stringify(m[1])} / deploy-data.yml: ${JSON.stringify(actual)}`,
  );
});

test("#1286-2: etl check は production だけで有効（staging と手元を変えない）", () => {
  const prod = jobs.get("production") ?? "";
  const staging = jobs.get("staging") ?? "";
  assert.match(
    prod,
    /MONITOR_ETL_STREAK:\s*"1"/,
    "production で `etl` check が有効になっていない（#1286 受け入れ条件 2 の配線）",
  );
  assert.ok(
    !/MONITOR_ETL_STREAK/.test(staging),
    "staging でも `etl` check を有効にしている。**ETL は環境ごとに在るものではない**ので、" +
      "両方で有効にすると同じ機構に 2 本の Issue が立つ",
  );
});

test("#1286-2: N のしきい値は etl-streak.sh の 1 行だけが持つ（#1264 の型を繰り返さない）", () => {
  // **この repo は「2 つの数が同じ制約を分担すると矛盾する」を 2 度踏んでいる。**
  // **既定値を持つ行がただ 1 本であること**を、`deploy/monitor/` と `.github/workflows/` で見る。
  const script = readFileSync(resolve(repo, "deploy/monitor/etl-streak.sh"), "utf8");
  const decl = script.split("\n").filter((l) => /^STREAK_N=\$\{PROBE_ETL_FAIL_STREAK:-\d+\}$/.test(l));
  assert.equal(
    decl.length,
    1,
    `N の既定値を宣言する行が ${decl.length} 本在る（1 本であること）。見つけた行: ${JSON.stringify(decl)}`,
  );
  const n = /:-(\d+)\}/.exec(decl[0])![1];

  // workflow 側がこの数を**書き写していない**こと（書き写すと、どちらが正しいか機械に分からない）。
  assert.ok(
    !new RegExp(`PROBE_ETL_FAIL_STREAK:\\s*"?${n}"?`).test(monitorYml),
    `monitor.yml が N の既定値（${n}）を書き写している。**しきい値は実装の 1 行だけが持つこと。**`,
  );

  // **実測の関係式**（2026-10-11 に `gh run list --workflow etl.yml --limit 300` の 103 run のうち
  // `event=schedule` の 50 run で数えた。**これは履歴であって、N を動かすためのつまみではない**）:
  //   自力で success に戻った streak の最長 = 2（08-25 / 09-19 が 1、10-02〜10-03 が 2）
  //   step `Run ETL` が続いた本物の故障の最短 = 3（09-24〜09-26）
  // → **2 < N <= 3 を満たす整数は 3 だけ。**
  const longestSelfHealed = 2;
  const shortestRealOutage = 3;
  assert.ok(
    Number(n) > longestSelfHealed,
    `N=${n} は自力で直った最長 ${longestSelfHealed} 以下なので、次の晩に直るものを鳴らす`,
  );
  assert.ok(
    Number(n) <= shortestRealOutage,
    `N=${n} は本物の故障の最短 ${shortestRealOutage} より大きいので、3 晩の本物を取り逃がす`,
  );
});
