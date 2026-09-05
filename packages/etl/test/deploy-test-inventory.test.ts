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
//   経路1（台帳）  : 名前の集合・出口・逐語アンカー。ハードコード。編集で縮む。
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

/** deploy/test/*.test.sh の本文（名前 → 中身）。**実在するもの**から作る。 */
function sources(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of actualFiles()) m.set(f, read(`deploy/test/${f}`));
  return m;
}

// ---------------------------------------------------------------------------------------------
// 経路1: 台帳（ハードコード）
// ---------------------------------------------------------------------------------------------

/**
 * - `file`    : ファイル名（この一覧がファイル集合の期待値）
 * - `anchors` : そのテストが**現に検査していること**を名指しする、ファイル中の逐語文字列。
 *               assertion を抜くと消える。#481: 失敗は「何件」ではなく「どれが」で出す。
 */
const INVENTORY: { file: string; anchors: string[] }[] = [
  { file: "apply-all.test.sh", anchors: ["apply-all.sh", "allowlist", "8083"] },
  {
    file: "cloudflare-allowlist.test.sh",
    anchors: ["cloudflare-allowlist.sh", "nginx -t failed"],
  },
  { file: "go-live.test.sh", anchors: ["go-live.sh"] },
  { file: "logrotate.test.sh", anchors: ["logrotate.conf", "monitor/setup.sh"] },
  { file: "monitor-health.test.sh", anchors: ["monitor/health.sh"] },
  { file: "monitor-probe.test.sh", anchors: ["probe.sh"] },
  { file: "monitor-setup.test.sh", anchors: ["monitor/setup.sh"] },
  { file: "nginx-404.test.sh", anchors: ["nginx/site.conf", "__spa-fallback.html", "docker"] },
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
  },
  { file: "nginx-reload.test.sh", anchors: ["vps-setup.sh", "nginx -t failed"] },
  { file: "ops-user-setup.test.sh", anchors: ["ops-user-setup.sh", "NOPASSWD", "visudo"] },
  { file: "run-remote.test.sh", anchors: ["run-remote.sh"] },
  { file: "staging-setup.test.sh", anchors: ["staging-setup.sh"] },
  { file: "vps-setup.test.sh", anchors: ["vps-setup.sh"] },
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
    if (!GATES.some((g) => s.includes(g))) offenders.push(`${file}: 出口が無い`);
  }
  // #507: 「何件通ったか」ではなく「無罪と判定したものを検査器に掛け直す」。
  // 監査は judge の申告ではなく**対象集合そのもの**を起点に回す（ループごと飛ばされた1件を拾うため）。
  // 監査の結果は脇に置かず、**検出そのものに合流させる**（脇に置くと「監査だけ消す」で黙る）。
  const skipped = INVENTORY.map((e) => e.file).filter((f) => !audited.includes(f));
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
  for (const { file, anchors } of INVENTORY) {
    const s = src.get(file);
    audited.push(file);
    if (s === undefined) {
      findings.push(`${file}: ファイルが無い`);
      continue;
    }
    if (anchors.length === 0) findings.push(`${file}: anchors が空（何も守っていない宣言に等しい）`);
    for (const a of anchors) if (!s.includes(a)) findings.push(`${file}: 検査項目 [${a}] が消えている`);
  }
  const skipped = INVENTORY.map((e) => e.file).filter((f) => !audited.includes(f));
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
  "deploy/nginx-host-proxy.conf": "文字列の検査は deploy-docker.test.ts が持つ（実配信の対象外）",
  // アクセスログの集計。本番の配信にも設定にも触らない後処理。
  "deploy/analytics/aggregate.sh": "配信・設定に触らない後処理（#288 の集計）",
  "deploy/analytics/nginx-noip-log.conf": "log_format の断片。vps-analytics-setup.sh 経由で入る",
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
  assert.deepEqual(noReason, [], `理由の無い例外（場所取りだけ）: ${noReason.join(", ")}`);
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
    const covered = [...src.values()].some((t) => t.includes(base) || t.includes(name));
    if (!covered) findings.push(`${s}: これを名指しする deploy テストが1本も無い`);
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
  for (const m of conf.matchAll(/add_header\s+([A-Za-z][A-Za-z0-9-]*)/g)) names.add(m[1]);
  return [...names].sort();
}

/**
 * **本物の nginx を起動して実際のレスポンスを見る** deploy テスト。
 * 「site.conf を文字列として読む」だけのテストはここに数えない——
 * add_header の**継承の罠**（内側に1つあれば外側は全部無効）は、文字列では絶対に見つからないから
 * （#482 以前の本番が実際にそうだった）。
 */
function liveNginxTests(): string[] {
  const out: string[] = [];
  for (const [name, s] of sources()) {
    if (s.includes("docker run") && s.includes("curl") && s.includes("site.conf")) out.push(name);
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
  "Cache-Control": "pnpm --filter web smoke -- --url http://127.0.0.1:8081",
};

/**
 * **例外集合そのものを固定する**（#484）。実測: ELSEWHERE に 5 ヘッダ押し込むだけで、
 * 経路3 は nginx-headers.test.sh の削除に**一言も言わなくなった**。
 * 期待値はハードコードする（ELSEWHERE から生成すると自己参照になる。#499）。
 */
const ELSEWHERE_KEYS = ["Cache-Control", "X-Robots-Tag"];

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

test("#513 経路3: site.conf が送るヘッダは、実物の nginx を叩く deploy テストに1つ残らず現れる", () => {
  const live = liveNginxTests();
  const headers = headersInSiteConf();
  const src = sources();
  const findings: string[] = [];
  const audited: string[] = [];

  if (live.length === 0) findings.push("実物の nginx を起動して叩く deploy テストが1本も無い");

  const ci = read(".github/workflows/ci.yml");
  for (const h of headers) {
    audited.push(h);
    const elsewhere = ELSEWHERE[h];
    if (elsewhere !== undefined) {
      // **例外そのものを検査する**（#484: 通す側の集合も固定する）。
      // 「docker-web が見ているから」で外したものは、docker-web が本当に見ていることを確かめる。
      // ci.yml からその行が消えれば、例外は例外でなくなり、ここが落ちる。
      if (!ci.includes(elsewhere))
        findings.push(`${h}: deploy テストの対象外にした根拠 [${elsewhere}] が ci.yml から消えている`);
      continue;
    }
    const covered = live.some((t) => (src.get(t) ?? "").includes(h));
    if (!covered) findings.push(`${h}: 実配信で確かめる deploy テストが無い（site.conf は送っている）`);
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

test("#513: ci.yml は deploy/test/*.test.sh を今も走らせている（走らせるのをやめても落ちる）", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(
    ci.includes("deploy/test/*.test.sh"),
    "ci.yml が deploy/test/*.test.sh を走らせていない。台帳を守っても、走らなければ意味がない。",
  );
});
