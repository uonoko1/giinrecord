import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #513: `deploy/test/*.test.sh` は **glob で実行されるだけ**で、誰も数えていなかった。
// `.github/workflows/ci.yml` の
//     for t in scripts/ci/test/*.test.sh deploy/test/*.test.sh; do echo "== $t"; bash "$t"; done
// は、**ファイルを丸ごと消すと走るテストが1本減るだけ**で、CI は完全に無言で緑になる
// （PR #508 のレビュアーが `nginx-headers.test.sh` を削除して実測: 残り13本すべて exit 0）。
//
// **なぜ deploy/test/ の中に置けないか**（この PBI の核心）:
//   #500 Z2 / #507 は「入口と出口」＝ **同一プロセス内で経路が2本**あり、片方だけ釘打っていた形で、
//   「同じテストの中で出口も数える」ことで塞げた。
//   **検査コードの削除は、経路が2本あるのではなく経路が0本になる。**
//   同じディレクトリに置いた見張りは、そのファイルごと消せる。**原理的に自己防衛できない。**
//   だから**レイヤを1つ上げる**——別のパッケージ・別のテストランナー（node:test）・別の言語で見る。
//   `pnpm test`（= `pnpm -r test`）が etl を回すので、CI の別ステップから落ちる。
//
// **なぜ「本数を数える」だけでは足りないか**:
//   #504 の「**名前を固定した は 値を固定した ではない**」がそのまま効く。
//   - 本数（14）だけを固定 → **消したぶん空ファイルを1本足せば 14 のまま**通る。
//   - 名前の集合だけを固定 → **中身を空にしても・assertion を全部抜いて `exit 0` にしても**通る。
//   だからこのテストは、**ファイルごとに「そのテストが何を守っているか」を名指しする文字列**
//   （ANCHORS）と、**失敗を exit status に変える出口（GATE）**を固定する。
//   期待値は**ハードコードする**——検査対象から生成すると自己参照になり、
//   **対象が痩せれば期待値も一緒に痩せる**（#499 の教訓）。
//
// **#507 の教訓（検査が指示する手順が、検査を黙らせないか）への備え**:
//   このテストが落ちたときの指示は「INVENTORY を更新してください」だが、
//   **削除も同じ手順で通せてしまう**——行を消せば黙る。そこで
//   `INVENTORY.length` を**別のリテラル**（EXPECTED_COUNT）として持ち、
//   **行を消すと必ずもう1件落ちる**ようにしてある（テーブルの外側にもう1つ釘を打つ）。
//   さらに削除の意図を書かせるため、**失敗メッセージで「消すな」と「足すならこう」を区別**する。

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const testDir = resolve(root, "deploy/test");

/**
 * deploy/test/*.test.sh の台帳。
 *
 * - `file`     : ファイル名（このリストがそのままファイル集合の期待値）
 * - `subjects` : そのテストが叩く**本番側のファイル**。テストが空になれば消える参照。
 * - `anchors`  : そのテストが**現に検査していること**を名指しする、ファイル中の逐語文字列。
 *                #513 の Issue が「nginx-headers.test.sh が消えると失われる」と挙げたものを含む。
 *                assertion を抜いて `exit 0` にすると、ここが消える。
 *
 * **anchors は「落ちる理由」を人間に返すためのものでもある**（#481: 失敗メッセージは
 * 「何件」ではなく「どれが」で出す）。
 */
const INVENTORY: { file: string; subjects: string[]; anchors: string[] }[] = [
  {
    file: "apply-all.test.sh",
    subjects: ["deploy/apply-all.sh"],
    anchors: ["apply-all.sh", "allowlist", "8083"],
  },
  {
    file: "cloudflare-allowlist.test.sh",
    subjects: ["deploy/cloudflare-allowlist.sh"],
    anchors: ["cloudflare-allowlist.sh", "nginx -t failed"],
  },
  {
    file: "go-live.test.sh",
    subjects: ["deploy/go-live.sh"],
    anchors: ["go-live.sh"],
  },
  {
    file: "logrotate.test.sh",
    subjects: ["deploy/monitor/logrotate.conf", "deploy/monitor/setup.sh"],
    anchors: ["logrotate.conf", "monitor/setup.sh"],
  },
  {
    file: "monitor-health.test.sh",
    subjects: ["deploy/monitor/health.sh"],
    anchors: ["monitor/health.sh"],
  },
  {
    file: "monitor-probe.test.sh",
    subjects: ["deploy/monitor/probe.sh"],
    anchors: ["probe.sh"],
  },
  {
    file: "monitor-setup.test.sh",
    subjects: ["deploy/monitor/setup.sh"],
    anchors: ["monitor/setup.sh"],
  },
  {
    file: "nginx-404.test.sh",
    // #325: 実物の nginx を起動して**ステータスコード**を見る係。
    subjects: ["deploy/nginx/site.conf"],
    anchors: ["nginx/site.conf", "__spa-fallback.html", "docker"],
  },
  {
    file: "nginx-headers.test.sh",
    // #513 の Issue が名指しした「これが消えると失われるもの」を、そのまま釘にする。
    subjects: ["deploy/nginx/site.conf"],
    anchors: [
      "nginx/site.conf",
      "docker",
      // location の網羅（#499: allowlist をやめ site.conf から全 location を拾う）
      "LOCATIONS",
      // その数え上げ自身の検査（独立な数え方との突き合わせ）
      "WANT_LOCS",
      // add_header の継承の罠（内側に1つあると外側が全部消える）
      "add_header",
      // Permissions-Policy 17 機能
      "Permissions-Policy",
      // SECURITY_HEADERS の中身（#504: 個数ではなく要素そのものを順序込みで固定）
      "SECURITY_HEADERS",
      "REQUIRED_SECURITY_HEADERS",
    ],
  },
  {
    file: "nginx-reload.test.sh",
    subjects: ["deploy/vps-setup.sh"],
    anchors: ["vps-setup.sh", "nginx -t failed"],
  },
  {
    file: "ops-user-setup.test.sh",
    subjects: ["deploy/ops-user-setup.sh"],
    anchors: ["ops-user-setup.sh", "NOPASSWD", "visudo"],
  },
  {
    file: "run-remote.test.sh",
    subjects: ["deploy/run-remote.sh"],
    anchors: ["run-remote.sh"],
  },
  {
    file: "staging-setup.test.sh",
    subjects: ["deploy/staging-setup.sh"],
    anchors: ["staging-setup.sh"],
  },
  {
    file: "vps-setup.test.sh",
    subjects: ["deploy/vps-setup.sh"],
    anchors: ["vps-setup.sh"],
  },
];

/**
 * **台帳の行数を、台帳の外にもう一度書く。**
 * これが無いと、このテストの失敗メッセージ（「INVENTORY を更新してください」）に従って
 * **行を1つ消すだけで削除が通る**——#507 の「検査が指示する手順が、検査を黙らせる」形。
 * 行を消せば必ずここが落ちるので、**消す側は数字も書き換える**ことになり、意図が diff に残る。
 */
const EXPECTED_COUNT = 14;

/** `deploy/test/` に実在する *.test.sh（render-host-proxy.sh のような補助スクリプトは対象外） */
function actualFiles(): string[] {
  return readdirSync(testDir)
    .filter((n) => n.endsWith(".test.sh"))
    .sort();
}

const read = (name: string) => readFileSync(resolve(testDir, name), "utf8");

/**
 * 失敗を exit status に変える「出口」。これが無いと、どれだけ assertion があっても
 * **スクリプトは 0 で終わる**（CI の `bash "$t"` は exit status しか見ない）。
 * 14 本が使っている3つの書き方を、**逐語で**列挙する（正規表現で緩めない）。
 */
const GATES = ['[ "$FAIL" = 0 ]', "[[ $FAIL == 0 ]]", '[ "$FAIL" -eq 0 ]'];

test("#513: deploy/test/*.test.sh の台帳は、実在するファイル集合と一致する（消しても足しても落ちる）", () => {
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

追加したとき: INVENTORY に { file, subjects, anchors } を足し、EXPECTED_COUNT を +1 する。
削除するとき: **まず本当に消してよいか**。deploy/test/ の1本は本番の設定・スクリプトを守る唯一の検査であることが多い
（例: nginx-headers.test.sh は location の網羅・add_header の継承・Permissions-Policy・SECURITY_HEADERS の中身を1本で守る）。
消すなら台帳の行と EXPECTED_COUNT の両方を書き換えること。**行だけ消して黙らせない。**`,
  );
});

test("#513: 台帳の行数は、台帳の外に書いた本数と一致する（行を消すだけでは黙らない）", () => {
  assert.equal(
    INVENTORY.length,
    EXPECTED_COUNT,
    `INVENTORY の行数が ${INVENTORY.length}、EXPECTED_COUNT が ${EXPECTED_COUNT}。
このテストは「台帳の行を消して検査を黙らせる」ことを防ぐためだけにある（#507）。
増減させたなら、両方を書き換えて diff に意図を残すこと。`,
  );
});

test("#513: 各 *.test.sh は、失敗を exit status に変える出口を持つ（assertion を抜いて exit 0 にすると落ちる）", () => {
  const offenders: string[] = [];
  const audited: string[] = [];
  for (const { file } of INVENTORY) {
    const src = read(file);
    audited.push(file);
    if (!GATES.some((g) => src.includes(g))) offenders.push(file);
  }
  // #507: 「何件通ったか」ではなく「無罪と判定したものを検査器に掛け直す」。
  // 監査は judge の申告ではなく**対象集合そのもの**を起点に回す（ループごと飛ばされた1件を拾うため）。
  // そして監査の結果を**検出そのものに合流させる**——脇に置くと「監査だけ消す」で黙る。
  const skipped = INVENTORY.map((e) => e.file).filter((f) => !audited.includes(f));
  assert.deepEqual(
    { offenders, skipped },
    { offenders: [], skipped: [] },
    `失敗が exit status に出ないテストがある（CI の \`bash "$t"\` は exit status しか見ない）。
  出口が無い: ${offenders.join(", ") || "なし"}
  検査を飛ばした（ループが1件も見ていない）: ${skipped.join(", ") || "なし"}
出口の書き方（逐語）: ${GATES.join(" / ")}`,
  );
});

test("#513: 各 *.test.sh は、自分が守る本番ファイルと検査項目を名指ししている（空にしても中身を抜いても落ちる）", () => {
  const findings: string[] = [];
  const audited: string[] = [];
  for (const { file, subjects, anchors } of INVENTORY) {
    const src = read(file);
    audited.push(file);
    // subjects: 本番側のどのファイルを叩くか。ファイル名の basename が本文に出ていること。
    for (const s of subjects) {
      const needle = s.replace(/^deploy\//, "");
      if (!src.includes(needle)) findings.push(`${file}: 守る対象 [${s}] への参照が無い`);
    }
    // anchors: そのテストが現に検査していることの逐語証拠。
    for (const a of anchors) {
      if (!src.includes(a)) findings.push(`${file}: 検査項目 [${a}] が消えている`);
    }
  }
  const skipped = INVENTORY.map((e) => e.file).filter((f) => !audited.includes(f));
  assert.deepEqual(
    { findings, skipped },
    { findings: [], skipped: [] },
    `deploy/test の中身が痩せている（ファイルはあるが、検査が消えている）。
${findings.map((f) => `  - ${f}`).join("\n") || "  （検出なし）"}
  検査を飛ばした（ループが1件も見ていない）: ${skipped.join(", ") || "なし"}

anchors は「そのテストが何を守っているか」の逐語証拠。**消えたなら、その守りが消えている。**
本気で書き換えたなら台帳の anchors も更新すること（ただし **anchors を空にすれば黙る** ので、
空にするのは「そのテストが何も守っていない」と宣言することに等しい）。`,
  );
});

test("#513: anchors を空にした台帳の行は許さない（台帳を骨抜きにする道を塞ぐ）", () => {
  const empty = INVENTORY.filter((e) => e.anchors.length === 0 || e.subjects.length === 0).map(
    (e) => e.file,
  );
  assert.deepEqual(
    empty,
    [],
    `台帳の行が subjects / anchors を持っていない: ${empty.join(", ")}
行を残したまま anchors を空にすると、そのファイルは「存在するだけ」で通ってしまう。`,
  );
});

test("#513: ci.yml は deploy/test/*.test.sh を今も走らせている（走らせるのをやめても落ちる）", () => {
  const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.ok(
    ci.includes("deploy/test/*.test.sh"),
    "ci.yml が deploy/test/*.test.sh を走らせていない。台帳を守っても、走らなければ意味がない。",
  );
});
