import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Issue #58 レビュー指摘: deploy 鍵ユーザー ubuntu を adm グループに入れると VPS 上の他サイトのログや
// auth.log まで読めてしまう。cron は root で動かし、集計 TSV だけを ubuntu 所有 mode 600 で渡す。
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const setup = readFileSync(resolve(root, "deploy/analytics/vps-analytics-setup.sh"), "utf8");
const daily = resolve(root, "deploy/analytics/daily.sh");
const fixture = resolve(here, "fixtures/analytics-access.log.txt");

function runDaily(day: string, owner: string) {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = join(dir, "access.log");
  copyFileSync(fixture, log);
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, day], {
    encoding: "utf8",
    env: { ...process.env, ANALYTICS_LOG: log, ANALYTICS_OUT: out, ANALYTICS_OWNER: owner },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out, stdout: r.stdout };
}

test("setup は ubuntu を adm グループに入れない", () => {
  const code = setup
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /usermod/);
  assert.doesNotMatch(code, /\badm\b/);
});

test("cron は root で daily.sh を実行する（ubuntu には /var/log/nginx の読み取り権限を与えない）", () => {
  const cronLine = setup.split("\n").find((l) => /^10 0 \* \* \* /.test(l));
  assert.ok(cronLine, "cron.d の行が無い");
  assert.match(cronLine, /^10 0 \* \* \* root /);
});

test("daily.sh は TSV を mode 600、出力ディレクトリを 700 で書き、tmp ファイルを残さない", () => {
  // root でない環境では chown は効かないが、mode と tmp の後始末は同じ経路で検証できる
  const { out } = runDaily("2026-08-22", "nobody");
  const tsv = join(out, "2026-08-22.tsv");
  assert.equal(statSync(tsv).mode & 0o777, 0o600);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(readFileSync(tsv, "utf8").split("\n")[0], "date\tpage\treferrer\tpv");
  assert.throws(() => statSync(`${tsv}.tmp`));
});

test("daily.sh は ANALYTICS_OWNER が無くても（ubuntu の手動実行）動く", () => {
  const { stdout } = runDaily("2026-08-23", "");
  assert.match(stdout, /2026-08-23 -> /);
});

// ---------------------------------------------------------------------------------------------
// Issue #1184: 計器が 39 日間、無言で壊れていた。
//
// VPS に設置済みの daily.sh が改名前のログ名（存在しないファイル）を読み、**0 行の TSV を書いて
// exit 0 で「成功」を報告していた**。cron は毎日発火し、TSV も毎日生成されていたので、
// どの計器も赤くならなかった。
//
// 原因は 2 つの「不在が成功になる」形が重なったこと:
//   1. daily.sh が `[ -f "$LOG" ] && cat "$LOG"` の形で、**読む先が無いことをエラーにしない**
//   2. aggregate.sh が先にヘッダを printf するので、**0 行でも TSV は必ず 1 行**になる
// 結果「0 rows」と報告して exit 0。**「0 件」と「測れなかった」が区別されていなかった**（#757・#1158 と同じ型）。
//
// ここで固定するのは「読む先が無い」と「1 行も数えられなかった」の両方が**非 0 で落ちる**こと。
// **「0 件」と「測れなかった」を区別する**のがこの PBI の軸なので、両者は別のメッセージで落ちる。
// ---------------------------------------------------------------------------------------------

/** runDaily と同じ経路だが、終了コードを呼び出し側に返す（失敗を期待するテスト用） */
function tryDaily(
  day: string,
  opts: { log?: string; writeLog?: string; owner?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = opts.log ?? join(dir, "access.log");
  if (opts.writeLog !== undefined) writeFileSync(log, opts.writeLog);
  else if (opts.log === undefined) copyFileSync(fixture, log);
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, day], {
    encoding: "utf8",
    env: {
      ...process.env,
      ANALYTICS_LOG: log,
      ANALYTICS_OUT: out,
      ANALYTICS_OWNER: opts.owner ?? "",
    },
  });
  return { out, dir, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("daily.sh: 読む先のログが 1 つも無ければ非 0 で落ちる（#1184 の本命。改名後 39 日これが 0 だった）", () => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const r = tryDaily("2026-08-22", { log: join(dir, "renamed-away.access.log") });
  assert.notEqual(r.status, 0, `不在のログで成功してはいけない: ${r.stdout}`);
  // **3 であること（4 ではない）まで見る。** 「測れなかった」と「測れて 0 件」は別の事実で、
  // 別の終了コードにしてある（docs/ops/analytics.md の表）。`notEqual(0)` だけだと
  // 両者の区別が消える——実測: `-s` を `-f` に変えると空ログが 3 ではなく 4 になるのに、
  // notEqual(0) しか見ていなかったので**変異が 1 件も落ちなかった**（等価変異ではない）。
  assert.equal(r.status, 3, `3 = 読む先が無い。got ${r.status}: ${r.stderr}`);
  // 「どのファイルも無い」とだけ言う。ログの中身や行は出さない。
  assert.match(r.stderr, /no such log/i);
});

test("daily.sh: ログが不在のときは 0 行の TSV を置かない（空の計測値を記録に残さない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const r = tryDaily("2026-08-22", { log: join(dir, "renamed-away.access.log") });
  assert.throws(
    () => statSync(join(r.out, "2026-08-22.tsv")),
    "不在のログから TSV を作ってはいけない",
  );
});

test("daily.sh: ログは在るが指定日の PV が 1 行も無ければ非 0 で落ち、TSV は置く（cron が走ったことは残す）", () => {
  // ログは実在し中身も在るが、求めた日のアクセスが 0 行。
  const r = tryDaily("2026-01-01");
  assert.equal(r.status, 4, `4 = 測れて 0 件（3 = 読む先が無い とは別）: ${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /0 rows/);
  // 「ログが無い」と「ログは在るが 0 行」は別物。TSV が在るかどうかで区別できるようにする。
  const tsv = join(r.out, "2026-01-01.tsv");
  assert.equal(statSync(tsv).mode & 0o777, 0o600);
  assert.match(readFileSync(tsv, "utf8"), /pv=0\tpages=0/);
});

test("daily.sh: 空のログファイル（0 バイト）は exit 3（「0 件」ではなく「測れなかった」）", () => {
  const r = tryDaily("2026-08-22", { writeLog: "" });
  // **3 であること。** 0 バイトの access log は「静かな日」ではなく「nginx がそこに書いていない」で、
  // 計器が壊れている側。`-s` を `-f` にすると 4（測れて 0 件）に化けるので、そこを釘で打つ。
  assert.equal(r.status, 3, `空ログは 3。got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /no such log/i);
});

test("daily.sh: ローテーション後（.log が無く .log.1 だけ在る）は成功する", () => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = join(dir, "access.log");
  copyFileSync(fixture, `${log}.1`); // .log 自体は作らない
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, "2026-08-22"], {
    encoding: "utf8",
    env: { ...process.env, ANALYTICS_LOG: log, ANALYTICS_OUT: out, ANALYTICS_OWNER: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pv=/);
});

test("daily.sh: stdout に pv と pages を両方出す（cron ログに残る唯一の形）", () => {
  const { stdout } = runDaily("2026-08-22", "");
  assert.match(stdout, /pv=8\b/);
  assert.match(stdout, /pages=4\b/);
});

// ---------------------------------------------------------------------------------------------
// Issue #1184 受け入れ条件 7: 設置物とリポジトリの差分を検出する。
//
// **39 日の本当の原因は daily.sh の中身ではなく、設置し直していないことだった。**
// go-live.sh の migrate_legacy() は `/usr/local/lib/<旧名>-analytics` を **mv** するので、
// ディレクトリ名は新しくなるが**中に入っているスクリプトは改名前のまま**になる。
// その中の daily.sh が読むログ名は改名前のもので、ログだけが新名に mv されていた。
//
// VPS に在る「リポジトリのスクリプトの root 所有コピー」を全部数えた（母数 3）:
//
//   | コピー                                  | setup がスクリプト自体を install するか |
//   |-----------------------------------------|------------------------------------------|
//   | monitor/health.sh                       | する（setup.sh の `install … "$HERE/health.sh"`） |
//   | cloudflare-allowlist.sh                 | する（install_cron の `install -m 755 "$self" "$LIB"`） |
//   | analytics/{aggregate,daily}.sh          | **しない**（echo で手順を印字するだけ）  |
//
// **3 本のうち 1 本だけが穴だった。** 0 件ではなく 1 件（母数 3）。
// 他の 2 本は setup を再実行すればコピーが更新されるので、同じ事故は起きない。
// 直し方も他の 2 本に倣う: setup が自分の隣のスクリプトを install する。
// そうすると go-live.sh の step 8/8（`vps-analytics-setup.sh` を走らせる）が、
// step 2/8 で git pull した checkout から**設置し直す**ので、改名のたびに自動で揃う。
// ---------------------------------------------------------------------------------------------

test("#1184: setup はスクリプト自体を root 所有で設置する（印字するだけにしない）", () => {
  const code = setup
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  // 「echo で手順を出す」ではなく、実際に install を実行する行が在ること
  assert.match(
    code,
    /^\s*install\s+-o\s+root\s+-g\s+root\s+-m\s+755\s+.*aggregate\.sh/m,
    "aggregate.sh を install する行が無い",
  );
  assert.match(
    code,
    /^\s*install\s+-o\s+root\s+-g\s+root\s+-m\s+755\s+.*daily\.sh/m,
    "daily.sh を install する行が無い",
  );
});

test("#1184: setup が install するのは自分の隣のスクリプト（checkout の現物）", () => {
  // $HERE を使っていること。固定パスや /tmp 経由では「いま checkout に在るもの」にならない。
  assert.match(setup, /HERE=/, "$HERE を決めていない");
  const installLines = setup
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /install .*(aggregate|daily)\.sh/.test(l));
  assert.ok(installLines.length > 0, "install 行が無い");
  for (const l of installLines)
    assert.match(l, /\$HERE/, `checkout の現物を指していない: ${l}`);
});

test("#1184: go-live.sh が mv する root 所有コピーは、どれかの setup が設置し直す（母数 3）", () => {
  const goLive = readFileSync(resolve(root, "deploy/go-live.sh"), "utf8");
  // go-live.sh が /usr/local/lib 配下を mv している対象を**実装から拾う**（手で数えない）
  const moved = [
    ...goLive.matchAll(/move_if_legacy "\$PREFIX\/usr\/local\/lib\/\$OLD([^"]*)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    moved.sort(),
    ["-analytics", "-cloudflare-allowlist.sh", "-monitor"],
    "go-live.sh が mv する /usr/local/lib の対象が変わった。設置し直す経路も数え直すこと",
  );
  // その 3 つすべてに「中身を設置し直す」実装が在ること
  const installers: Record<string, { file: string; re: RegExp }> = {
    // **`echo` の中の install は install ではない。** これを書いている途中に実測した:
    // 最初の版の `/install .*daily\.sh/` は、設置しておらず手順を**印字していただけ**の
    // `echo "  scp … sudo install -o root … /tmp/daily.sh …"` に当たって**緑になった**。
    // #1184 の原因そのもの（印字を設置と取り違える）を、検査器が自分で踏んでいた。
    // 行頭の install に限ることで、echo/printf の引数の中の綴りは当たらなくなる。
    "-analytics": {
      file: "deploy/analytics/vps-analytics-setup.sh",
      re: /^\s*install\s.*daily\.sh/m,
    },
    "-monitor": {
      file: "deploy/monitor/setup.sh",
      re: /^\s*install\s.*health\.sh/m,
    },
    "-cloudflare-allowlist.sh": {
      file: "deploy/cloudflare-allowlist.sh",
      re: /^\s*install -m 755 "\$self" "\$LIB"/m,
    },
  };
  for (const key of moved) {
    const spec = installers[key];
    assert.ok(spec, `${key} を設置し直す経路が台帳に無い`);
    const src = readFileSync(resolve(root, spec.file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.match(src, spec.re, `${key}: ${spec.file} が中身を設置し直していない`);
  }
});
