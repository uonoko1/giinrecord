import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * **数字 ID 付きの noreply は「形」では守れない。** **中身（その数字が誰か）を逐語で押さえる。**
 *
 * ── **なぜ要るか: 2026-09-28 に、形が正しい誤帰属が実際に main に入った**（#1101）──────
 *
 * ```
 * Co-authored-by: seiji-kiroku-dev <219112946+seiji-kiroku-dev@users.noreply.github.com>
 *                                   ^^^^^^^^^ = github.com/MLehnus（無関係の実在の個人）
 * ```
 *
 * **`_sidebar` の Contributors が 5 人 → 6 人になり、`MLehnus` が出た。**
 *
 * **既存の検査は 2 つとも、これを通す**（どちらも「形」しか要求していないため）:
 *
 * ```
 * workflow-commit-identity.test.ts (#1043) の OK = /^\d+\+[^@]+@users\.noreply\.github\.com$/
 * commit-trailer-identity.test.ts  (#1075) の OK = 同じ形
 *   → 219112946+seiji-kiroku-dev@users.noreply.github.com  は true（通る）
 * ```
 *
 * **#1043 のレビューが既に指摘していた限界である**——
 * **「正規表現では『その数字が本人の ID か』を言えない」。**
 * **#1075 はそれを docblock に明記したうえで「どちらを採るかは別 PBI」と範囲外にした。**
 * **この PBI（#1101）がその別 PBI である。**
 *
 * ── **どこから来たか（実測 2026-09-28）** ──────────────────────────────────────────
 *
 * ```
 * git grep 219112946 origin/main        → 0 件（追跡ファイルに無い）
 * grep -rn 219112946 .claude/           → 0 件（設定にも無い）
 * git config --show-origin user.email   → .git/config に
 *                                          120390190+uonoko1@users.noreply.github.com
 *                                          （= 正しい番号。worktree でも既定で効く）
 * ```
 *
 * **リポジトリのどこにも書かれていない数字を、担当者エージェントが作った。**
 * **正しい値は `git config` に在って、既定で効いていた**——**上書きしなければ正しく刻まれた。**
 *
 * ── **母数（履歴に在る数字 ID 付きアドレスを全部逆引きした。2026-09-28、基点 `4696f048`）**──
 *
 * **全 ref の author / committer / メッセージ本文を合わせて、数字 ID 付きの綴りは 4 種類だけ:**
 *
 * ```
 * 出現  綴り                                              gh api user/<id>      判定
 * ────  ────────────────────────────────────────────────  ────────────────────  ────
 *  745  120390190+uonoko1@users.noreply.github.com        uonoko1 / User        OK
 *  196  41898282+github-actions[bot]@users.noreply…       github-actions[bot]   OK
 *                                                          / type=Bot
 *    5  219112946+seiji-kiroku-dev@users.noreply…         MLehnus / User        ★誤り
 *                                                          / created=2025-07-03
 *    1  999+dev@users.noreply.github.com                  maxthelion / User     ★別人
 * ```
 *
 * **4 つ目は #1043 のレビューが「形は通る」を示すために使った架空のつもりの綴りで、
 * `22222a6c` のコミットメッセージ本文に散文として残っている**（trailer 行ではないので
 * Contributors には出ない）。**だが `id=999` は `github.com/maxthelion` という実在の個人である。**
 * **「他人の数字 ID の例」を書くこと自体が、他人の ID を書くことだった。**
 * **だからこのファイルは、落とす側の例に実在しうる数字を書かない**（下の `BAD` 参照）。
 *
 * ── **直近 20 本のマージ済み PR で数え直した（2026-09-28。PBI の母数より多い）** ──────
 *
 * **PBI は「誤りは `219112946` の 1 件だけ」としていたが、`origin/main` の trailer 行を
 * 数え直すと 3 種類在った**（`git log origin/main --pretty=format:%B` の
 * `Co-authored-by:` 行を数えた。**この 3 つは全部、枝の author が起点である**）:
 *
 * ```
 * 1708  noreply@anthropic.com                     → github.com/claude   （#1074。別 PBI）
 *  519  120390190+uonoko1@…                       → uonoko1             OK
 *   68  41898282+github-actions[bot]@…            → github-actions[bot] OK
 *    2  （利用者本人の個人アドレス）                                       本人なので誤帰属ではない
 *    1  seiji-kiroku-dev@users.noreply.github.com → 404（PR #1070）      ★ 数字 ID が無い形
 *    1  etl@users.noreply.github.com              → github.com/etl      ★（#1074、PR #1059）
 *    1  219112946+seiji-kiroku-dev@…              → MLehnus（PR #1064）  ★ 数字 ID が他人
 * ```
 *
 * **直近 20 本のマージ済み PR の枝を直接読むと、138 個の author / committer のうち
 * 10 個（7.2%）が allowlist の外だった**（3 本の PR に固まっている。
 * `gh api repos/…/pulls/<n>/commits` で実測）:
 *
 * ```
 * 124  120390190+uonoko1@…              OK
 *   6  219112946+seiji-kiroku-dev@…     ★ PR #1064
 *   4  41898282+github-actions[bot]@…   OK
 *   2  seiji-kiroku-dev@…               ★ PR #1070
 *   2  etl@users.noreply.github.com     ★ PR #1059
 * ```
 *
 * **「1 件の事故」ではなく、直近 20 本に 3 本の割合で起きている。**
 * **形の検査は 3 つのうち 2 つを落とせるが、`219112946` だけは落とせない**（実測）:
 *
 * ```
 *                                       形(#1043/#1075)  逐語(この検査)
 * 219112946+seiji-kiroku-dev@…          通す ★           落とす
 * seiji-kiroku-dev@…                    落とす           落とす
 * etl@users.noreply.github.com          落とす           落とす
 * ```
 *
 * ── **この検査が守るもの / 守らないもの** ───────────────────────────────────────────
 *
 * **守る**: **この枝が足すコミットに、逐語 allowlist に無いアドレスが刻まれていないこと。**
 * **「形が正しい他人の数字 ID」も落ちる**——**それが #1075 の `OK` との唯一かつ全部の差である。**
 *
 * **守らない**（明記する）:
 * - **既に main に在るものは見ない。** **`219112946` は `a72611ee` の trailer に在る**が、
 *   **消すには履歴書き換えが要る**ので別（#1084 の手順に相乗りする）。
 * - **マージコミットは対象外**（`--no-merges`）。**理由は #1075 が測ってある**——
 *   **本人が手元で `git merge main` するたびに赤くなり、8 件中 5 件が落ちる。**
 *   **squash merge が trailer を合成する元は「squash 対象のコミット」なので、
 *   実害の経路は `--no-merges` の側に入っている。**
 * - **trailer 本文は見ない。** **そこは #1075 が受け持つ**（衝突を避けるため、
 *   このファイルは author / committer だけを見る。下の「#1075 との関係」を参照）。
 * - **履歴が読めない浅い checkout では 1 件も見ない。**
 *   **CI（`CI` が立っている）では落とす。手元では skip する**（#1233。到達条件は
 *   `failClosedOnUnreadableHistory` の docblock に実測で在る）。
 *   **初版はここに「skip する。緑にはしない」と書いていたが、`t.skip()` は
 *   `skipped 1 / fail 0` で終了コード 0 なので、成り立っていなかった。**
 *
 * ── **#1075（`commit-trailer-identity.test.ts`）との関係** ──────────────────────────
 *
 * **#1075 はレビュー中なので、そのファイルは 1 行も触らない。** **別ファイルに置いた。**
 * **役割が重ならないように切ってある:**
 *
 * ```
 * commit-trailer-identity.test.ts (#1075)  メッセージ本文の trailer + author/committer を「形」で見る
 * commit-identity-allowlist.test.ts (この)  author/committer を「逐語」で見る
 * ```
 *
 * **author / committer は両方が見るが、要求が違う**（形 ⊃ 逐語）ので、
 * **どちらが先にマージされても、もう片方が緩むことはない。**
 * **#1075 がマージされた後に、この逐語 allowlist を `OK` の隣に併用する形へ寄せるかは、
 * そのときに測って決める**（いまそれをすると、レビュー中の 1580 行と衝突する）。
 */

/**
 * **本人確認した逐語のアドレスだけを許す。**
 *
 * **2 件とも `gh api user/<id>` で逆引きして一致を確かめた**（上の母数の表。2026-09-28 実測）。
 * **番号 → login と login → 番号 の両方向で一致する。**
 *
 * **ここに足すのは「誰の名前でコミットするか」を変えることである。**
 * **黙って増えてよい集合ではない**ので、逐語で持ち、増やすときは逆引きの結果を docblock に書く。
 *
 * **公開の noreply アドレスなので OSS のソースに書いてよい**——
 * **利用者本人の個人アドレスはここに書かない**（#1043 / #1075 と同じ方針）。
 * **「書かない」と言うために逐語で書くと、それ自体が 1 件目になる**——
 * **初版はここに本人の個人アドレスを逐語で書いており、レビューで消した。**
 * **`main` には 0 件だったので、この PR が最初の 1 件になるところだった。**
 * **架空の綴り（`person@example.com`）で完全に言える。**
 *
 * ── **同じ綴りが `scripts/po/merge-when-green.sh` にも在る**（言語が違うので共有できない）──
 *
 * **片方にだけ身元を足すと、もう片方は知らないまま通してしまう**——
 * **それはまさに #1101（誰かが身元を増やした事故）の形である。**
 * **だから `merge-when-green.test.sh` の「2 か所で完全に一致する」が、
 * 両方向の一致（集合として同じ）を要求している。**
 * **片側だけに足す変異は、どちらの側から当てても `passed 56 / failed 1` で落ちる**（実測）。
 *
 * **ここに足すときは、必ず `merge-when-green.sh` の `ALLOWED_IDENTITIES` にも足すこと。**
 */
export const ALLOWED_IDENTITIES: readonly string[] = [
  "120390190+uonoko1@users.noreply.github.com",
  "41898282+github-actions[bot]@users.noreply.github.com",
];

const ALLOWED = new Set(ALLOWED_IDENTITIES.map((e) => e.toLowerCase()));

/**
 * **1 つのアドレスが許されるか。** **小文字化して逐語で照合する**
 * （git のアドレスは大文字で書かれうるが、GitHub の紐づけは大小を区別しない）。
 */
export const identityAllowed = (email: string): boolean => ALLOWED.has(email.trim().toLowerCase());

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const gitOrUndefined = (...args: string[]): string | undefined => {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
};

/** **履歴が読めないときだけ走らせない。** **理由は 2 つしか無い**（#1075 と同じ形）。 */
const NO_BASE = "refs/remotes/origin/main が無い";
const NO_MERGE_BASE = "origin/main と HEAD の merge-base が取れない（浅い checkout）";

/**
 * **「履歴が読めない」を CI では赤にする。手元では skip のままにする**（#1233）。
 *
 * ── **到達条件は実測した。両方とも到達する**（2026-10-08、基点 `272cb286`）────────────
 *
 * **`git clone --depth 1` では到達しない**（PBI 本文の PO の実測。`clone` は
 * `refs/remotes/origin/main` を作り、HEAD = main の先端なので merge-base も取れる）。
 * **だが `actions/checkout` は `clone` を使わない**——**`git init` + 単一 ref の
 * `fetch` なので、`refs/remotes/origin/main` はそもそも作られない:**
 *
 * ```
 * git init . ; git remote add origin <url>
 * git fetch --no-tags --depth=1 origin '+<sha>:refs/remotes/origin/<branch>'
 * git for-each-ref 'refs/remotes/**'  →  refs/remotes/origin/<branch> だけ
 * git rev-parse --verify --quiet refs/remotes/origin/main  →  exit 1   ← NO_BASE に到達
 * node --test commit-identity-allowlist.test.ts            →  skipped 1 / fail 0 / exit 0
 * ```
 *
 * **`NO_MERGE_BASE` も到達する**（main の先端だけを深さ 1 で足し、HEAD が離れている場合）:
 *
 * ```
 * git fetch --depth=1 origin '+refs/heads/main:refs/remotes/origin/main'
 * git merge-base refs/remotes/origin/main HEAD  →  exit 1              ← NO_MERGE_BASE に到達
 * ```
 *
 * ── **なぜ CI では赤にするか** ──────────────────────────────────────────────────────
 *
 * **`ci.yml` の `check` job の checkout は既定の `fetch-depth: 1` である**（`:146`）。
 * **履歴は「merge-base を届かせる」step（`:320`）が `--deepen=50` で足している。**
 * **だがその step には `if: github.event_name == 'pull_request'` が付いている**ので、
 * **`push`（main）では走らない。** **そして `ci.yml` は `push: branches: [main]` でも起動する。**
 *
 * **つまり「fetch 段が壊れた」「trigger が変わった」「job が増えた」のどれでも、
 * この検査は `skipped 1 / fail 0 / exit 0` になり、CI は緑のまま通る。**
 * **守っているのは「他人への誤帰属」**（#1101 で `MLehnus` が Contributors に出た）
 * **なので、「測れなかった」を緑にしてはいけない**（#1056 の fail-closed）。
 *
 * **#1069 / #1054 は CI の層で「skipped を緑に数える」を 2 回直している。**
 * **これは同じ型が検査コードの層で 3 回目なので、ここで閉じる。**
 *
 * ── **手元を赤にしない理由**（skip を全部やめない） ─────────────────────────────────
 *
 * **手元の clone は `origin/main` を持つので、通常は到達しない。**
 * **到達するのは「`origin` を別名にしている」「fetch していない」など
 * 利用者の作業環境の都合であり、そこで赤にしても誤帰属は防げない**（push 前に CI が見る）。
 * **だから `CI` が立っているときだけ落とす。**
 */
const failClosedOnUnreadableHistory = (): boolean =>
  process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";

/**
 * **この枝が `origin/main` に足すコミット**（マージでないもの）。
 *
 * **範囲が空なのは正常である**（main 上で走らせた場合・枝に何も無い場合）。
 * **空と「読めなかった」は区別する**——**読めなかったときだけ `reason` を返す。**
 */
const addedCommits = (): { shas: string[]; reason?: string } => {
  const base = gitOrUndefined("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main");
  if (base === undefined || base.trim() === "") return { shas: [], reason: NO_BASE };
  const mergeBase = gitOrUndefined("merge-base", "refs/remotes/origin/main", "HEAD");
  if (mergeBase === undefined || mergeBase.trim() === "") return { shas: [], reason: NO_MERGE_BASE };
  const out = git("rev-list", "--no-merges", `${mergeBase.trim()}..HEAD`);
  return { shas: out.split("\n").map((s) => s.trim()).filter((s) => s !== "") };
};

/**
 * **1 つのコミットの author / committer を、生オブジェクトのヘッダから読む。**
 *
 * **`--pretty=%ae` を使わない理由**: **`%ae` と `%ce` を取り違える変異や、空になる変異を、
 * `--pretty` 自身では検出できない**（#1075 が同じ理由で生ヘッダと突き合わせている）。
 * **ここは最初から生ヘッダだけを読む**ので、取り違えようがない。
 *
 * **戻す `checked` が母数である**（#757）——**`bad` が空でも `checked` が 0 なら
 * 「1 つも見ていない」。** **呼ぶ側がそれを区別できるようにする。**
 */
export const commitIdentities = (raw: string): { kind: string; email: string }[] => {
  const header = raw.split("\n\n")[0] ?? "";
  const out: { kind: string; email: string }[] = [];
  for (const line of header.split("\n")) {
    const m = /^(author|committer) .*<([^<>]*)>/.exec(line);
    if (m === null) continue;
    out.push({ kind: m[1] as string, email: m[2] as string });
  }
  return out;
};

test("この枝が足すコミットの author / committer が、本人確認した逐語のアドレスだけ", (t) => {
  const { shas, reason } = addedCommits();
  if (reason !== undefined) {
    // **CI では落とす**（#1233）。**`t.skip()` が出すのは `skipped 1 / fail 0` で、
    // 終了コードは 0 である**——**初版はここに「緑にはしない」と書いていたが、成り立っていなかった。**
    // **到達条件は上の `failClosedOnUnreadableHistory` の docblock に実測で在る。**
    assert.ok(
      !failClosedOnUnreadableHistory(),
      `**履歴が読めないので、この枝のコミットを 1 つも検査できていない**: ${reason}

**これは「誤帰属が無い」ではなく「測れなかった」である**（#1056 の fail-closed）。
**CI では緑にしない**——**この検査が守っているのは他人への誤帰属**（#1101）。

**直し方**: **\`ci.yml\` の「コミット trailer の検査に merge-base を届かせる」step が
\`origin/main\` と merge-base を取れているか見ること。** **その step は
\`if: github.event_name == 'pull_request'\` なので、\`push\` では走らない。**`,
    );
    // **手元（CI の外）では skip のまま**: 到達するのは利用者の作業環境の都合で、
    // **push 前に CI が見る**（上の docblock の「手元を赤にしない理由」）。
    t.skip(`履歴が読めないので走らせない: ${reason}`);
    return;
  }
  const bad: string[] = [];
  let checked = 0;
  for (const sha of shas) {
    const ids = commitIdentities(git("cat-file", "commit", sha));
    // **母数の裏づけ**: **コミットには author と committer が必ず 1 つずつ在る。**
    // **読み方が壊れて 0 件になったら、ここで落ちる**（`bad` が空のまま緑になるのを防ぐ）。
    assert.equal(
      ids.length,
      2,
      `${sha.slice(0, 8)}: 生オブジェクトから author / committer を 2 つ読めない（読み方が壊れている）: ${JSON.stringify(ids)}`,
    );
    for (const { kind, email } of ids) {
      checked += 1;
      if (!identityAllowed(email)) bad.push(`${sha.slice(0, 8)}: ${kind}=${email}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `本人確認していない identity でコミットされています（許すのは ${ALLOWED_IDENTITIES.join(" / ")} だけ）。

**直し方は 1 つである: コミットを直す。** **ALLOWED_IDENTITIES には足さない**（#1231）。
**ここに足せば緑になるが、この検査の存在理由が消える**——
**守っているのは「形は正しい他人の数字 ID」を落とすこと**（#1101 で \`MLehnus\` が
Contributors に実際に出た）。**足した瞬間、その誤帰属は通るようになる。**

  1 本だけなら:  git commit --amend --reset-author --no-edit
  複数本なら:    GIT_COMMITTER_EMAIL=${ALLOWED_IDENTITIES[0]} \\
                   git rebase --committer-date-is-author-date origin/main

**\`git config\` は叩かない**——**worktree 間で共有されるので、走っている他のエージェント全員に波及する。**
**木が変わっていないことを \`git diff --stat <旧 HEAD> HEAD\` が空になることで確かめ、
\`--force-with-lease=<枝>:<測った SHA>\` で push する。**

**\`gh pr update-branch --rebase\` は使わない**——**枝の全コミットの committer を
自分のアドレスに書き換えるので、この検査が必ず赤になる**（#1214 で PO が踏んだ。実測は
docs/WORKING_AGREEMENT.md の「コミットの身元」節）。**既定の \`gh pr update-branch\`（マージ）は
committer を書き換えない**ので、BEHIND の解消はそちらを使う（\`scripts/po/merge-when-green.sh\` が呼ぶのもそれ）。

${bad.join("\n")}`,
  );
  // **範囲が空なのは正常**（main 上）だが、**空でないのに 1 件も見ていないのは異常である。**
  assert.equal(checked, shas.length * 2, `見た数が合わない: commits=${shas.length} checked=${checked}`);
});

/**
 * **走査の側は、いま在るコミットが全部正しいので `bad` が構造的に空になる**
 * ——**だから `identityAllowed` を「何でも通す」形に緩めても緑のまま通る**
 * （#1043 / #1075 の両方が同じ穴を実測している）。
 *
 * **だから判定そのものに、通すべき綴りと通してはいけない綴りを直接当てる。**
 */
test("逐語 allowlist そのものを検査する（形が正しい他人の数字 ID が落ちること）", () => {
  // **通さなければならない**（本人確認済み。2026-09-28 に `gh api user/<id>` で逆引き）
  for (const good of ALLOWED_IDENTITIES) {
    assert.ok(identityAllowed(good), `通すべき綴りが落ちた: ${good}`);
  }
  // **大文字で書かれても同じ人である**（GitHub の紐づけは大小を区別しない）
  assert.ok(
    identityAllowed("120390190+UONOKO1@Users.NoReply.GitHub.com"),
    "大文字の綴りを別人扱いしている",
  );

  // **落とさなければならない。**
  // **★ が #1101 の実害そのもの**——**形（`/^\d+\+[^@]+@users\.noreply\.github\.com$/`）は
  // 正しいので、#1043 と #1075 の `OK` は 2 つとも通す。** **ここだけが落とせる。**
  const BAD: readonly string[] = [
    "219112946+seiji-kiroku-dev@users.noreply.github.com", // ★ = github.com/MLehnus（実際に Contributors に出た）
    "noreply@anthropic.com", // #1074 の発端（github.com/claude に誤帰属）
    "etl@users.noreply.github.com", // #1074 の実害（github.com/etl）
    "seiji-kiroku-dev@users.noreply.github.com", // PR #1070 で実際に刻まれた（`gh api users/…` は 404）
    "dev@users.noreply.github.com",
    "bot@users.noreply.github.com",
    "120390190+uonoko1@example.com", // 正しい数字 ID でもドメインが違えば別物
    "120390190@users.noreply.github.com", // login 部が無い
    "+uonoko1@users.noreply.github.com", // 数字が無い
    "41898282+github-actions@users.noreply.github.com", // `[bot]` が落ちている（別の login）
    // **実在しうる他人の数字 ID を例として書かない**（上の docblock。
    // **`999+dev@` は `id=999` = `github.com/maxthelion` という実在の個人だった**）。
    // **落ちることは、上の ★ と下の「桁だけ違う」で完全に言える。**
    "120390191+uonoko1@users.noreply.github.com", // 1 桁違い（★ と同じ機序を最小形で）
  ];
  for (const bad of BAD) {
    assert.ok(!identityAllowed(bad), `通してはいけない綴りが通った: ${bad}`);
  }
  // **母数**（#757）: **落とす側を 1 件も見ないまま緑になるのを防ぐ。**
  assert.ok(BAD.length >= 10, `落とす側の母数が縮んでいる: ${BAD.length}`);

  // **この検査が #1043 / #1075 の「形」より狭いことを、逐語で示す。**
  // **ここが落ちれば「allowlist が形の要求に退化した」と分かる。**
  const FORM_ONLY = /^\d+\+[^@]+@users\.noreply\.github\.com$/;
  const wrongId = "219112946+seiji-kiroku-dev@users.noreply.github.com";
  assert.ok(FORM_ONLY.test(wrongId), "前提が崩れている: この綴りは形としては正しいはず");
  assert.ok(!identityAllowed(wrongId), "形が正しい他人の数字 ID を通している（#1101 の再発）");
});

/**
 * **生ヘッダの読み方そのものを検査する。**
 *
 * **`commitIdentities` が 0 件を返すようになると、走査は `bad` が空のまま緑になる**
 * ——**上の走査に母数の assert を置いてあるが、そこは「この枝のコミット」に依存するので、
 * 枝が空のとき（main 上）は何も守らない。** **だからパーサ自身にも当てる。**
 *
 * **入力は実際の `git cat-file commit` の形**（`tree` / `parent` / `author` / `committer` /
 * 空行 / 本文）。
 */
test("生オブジェクトのヘッダから author / committer を読む側を検査する", () => {
  const raw = [
    "tree 0000000000000000000000000000000000000000",
    "parent 1111111111111111111111111111111111111111",
    "author seiji-kiroku-dev <219112946+seiji-kiroku-dev@users.noreply.github.com> 1759000000 +0900",
    "committer seiji-kiroku-dev <219112946+seiji-kiroku-dev@users.noreply.github.com> 1759000000 +0900",
    "",
    "fix: x",
    "",
    // **本文にアドレスが在っても、ヘッダとしては読まない**（本文は #1075 の担当）。
    "Co-authored-by: N <someone@example.com>",
  ].join("\n");
  const ids = commitIdentities(raw);
  assert.deepEqual(
    ids.map((i) => i.kind),
    ["author", "committer"],
    "author / committer を 2 つとも読めていない",
  );
  assert.ok(
    ids.every((i) => i.email === "219112946+seiji-kiroku-dev@users.noreply.github.com"),
    `アドレスの読み取りが壊れている: ${JSON.stringify(ids)}`,
  );
  // **本文の行を拾っていないこと**（拾うと #1075 と二重に見て、役割の切り分けが崩れる）。
  assert.ok(
    !ids.some((i) => i.email.includes("example.com")),
    "ヘッダの外（本文）のアドレスを拾っている",
  );
  // **`%ae` / `%ce` の取り違えでは作れない差**: **author と committer が違う場合に、
  // 2 つとも正しく別々に読めること。**
  const split = commitIdentities(
    [
      "tree 0000000000000000000000000000000000000000",
      "author A <120390190+uonoko1@users.noreply.github.com> 1 +0000",
      "committer B <41898282+github-actions[bot]@users.noreply.github.com> 1 +0000",
      "",
      "x",
    ].join("\n"),
  );
  assert.deepEqual(
    split,
    [
      { kind: "author", email: "120390190+uonoko1@users.noreply.github.com" },
      { kind: "committer", email: "41898282+github-actions[bot]@users.noreply.github.com" },
    ],
    "author と committer を取り違えている",
  );
});

/**
 * **エージェントに「逐語のアドレスを渡す」だけでは守られない**
 * ——**指示に書いたから守られるは #1083 / #1088 で何度も外している**（PBI 本文）。
 * **だから「書いてある」ことを検査で固定する。**
 *
 * **これは代理である**（作業合意「代理と実体」）——**指示文の綴りは実体ではない。**
 * **実体（実際に刻まれた author）は、このファイルの 1 つ目の検査が見ている。**
 * **両方在って初めて、「書いてあり、かつ守られている」が言える。**
 */
test("エージェントの指示に、本人確認した逐語のアドレスが書いてある", () => {
  const dir = resolve(root, ".claude/agents");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "エージェントの指示が 1 つも見つからない（走査が空回りしている）");
  const need = ALLOWED_IDENTITIES[0] as string;
  const missing: string[] = [];
  for (const f of ["developer.md", "reviewer.md"]) {
    assert.ok(files.includes(f), `${f} が無い（この検査が対象を見失っている）`);
    const text = readFileSync(join(dir, f), "utf8");
    if (!text.includes(need)) missing.push(f);
  }
  assert.deepEqual(
    missing,
    [],
    `エージェントの指示に、使うべき逐語のアドレス（${need}）が書かれていない`,
  );
});

/**
 * **「測れなかったときに落ちる」こと自体を検査する**（#1233）。
 *
 * **上の走査は、履歴が読める環境では `reason === undefined` の筋しか通らない**
 * ——**だから fail-closed の分岐は、普通に走らせても一度も踏まれない。**
 * **踏まれない分岐は「書いてあるだけ」なので、ここで直接当てる。**
 *
 * **#1069 / #1054 は CI の層で同じ型（skipped を緑に数える）を 2 回直している。**
 * **3 回目をこの層で閉じるので、閉じ方が退行しないようにする。**
 */
test("#1233 履歴が読めないとき、CI では落ちる（手元では skip のまま）", () => {
  const src = readFileSync(resolve(root, "packages/etl/test/commit-identity-allowlist.test.ts"), "utf8");
  // **自分のソースを読めていること**（読めなければ下は全部空振りする。#514）
  assert.ok(src.includes("#1233 履歴が読めないとき"), "自分のソースを読めていない");

  // **`t.skip(` の手前に `assert` が在ること。**
  // **`t.skip()` だけなら `skipped 1 / fail 0 / exit 0` で、CI は緑になる。**
  const idx = src.indexOf("t.skip(`履歴が読めないので走らせない");
  assert.ok(idx > 0, "走査の skip 行が見つからない（この検査が対象を見失っている）");
  const before = src.slice(0, idx);
  const guardIdx = before.lastIndexOf("failClosedOnUnreadableHistory()");
  // **`assert.ok(` は `failClosedOnUnreadableHistory()` より手前に在る**ので、
  // **その間だけを見る**（`guardIdx` から後ろを見ると、呼び出しの後ろしか入らない）。
  const assertIdx = before.lastIndexOf("assert.ok(", guardIdx);
  assert.ok(
    guardIdx > 0 && assertIdx > 0 && guardIdx - assertIdx < 200,
    "**`t.skip()` の手前に fail-closed の assert が無い。**\n" +
      "**`t.skip()` が出すのは `skipped 1 / fail 0` で、終了コードは 0 である**——\n" +
      "**「測れなかった」が緑になると、他人への誤帰属（#1101）が通る。**",
  );

  // **CI の判定が `CI` 環境変数を見ていること**（別の条件に差し替わると、CI で落ちなくなる）
  assert.ok(
    /failClosedOnUnreadableHistory\s*=\s*\(\)[^;]*process\.env\.CI/.test(src),
    "fail-closed の判定が `process.env.CI` を見ていない（CI で落ちなくなる）",
  );
});

/**
 * **実際に `assert.ok(!…)` で落ちる側を踏む**（#1233）。
 *
 * **上の検査はソースの形を見ているだけなので、「書いてある」しか言えない。**
 * **ここは判定関数そのものに両側を当てる**——**`CI` が立っていれば落とす側に、
 * 立っていなければ skip 側に倒れること。**
 */
test("#1233 fail-closed の判定が、CI の有無で両側に倒れる", () => {
  const saved = process.env.CI;
  try {
    for (const on of ["1", "true", "TRUE"]) {
      process.env.CI = on;
      assert.ok(failClosedOnUnreadableHistory(), `CI=${on} なのに落とさない側に倒れている`);
    }
    // **`false` と空文字は「CI ではない」**（`actions/checkout` 以外の実行環境で
    // `CI=false` を立てる道具が在るため）
    for (const off of ["", "false"]) {
      process.env.CI = off;
      assert.ok(!failClosedOnUnreadableHistory(), `CI=${JSON.stringify(off)} なのに落とす側に倒れている`);
    }
    delete process.env.CI;
    assert.ok(!failClosedOnUnreadableHistory(), "CI が無いのに落とす側に倒れている（手元が赤くなる）");
  } finally {
    if (saved === undefined) delete process.env.CI;
    else process.env.CI = saved;
  }
});

/**
 * **赤になった人が読む場所に、直し方が書いて在ること**（#1231）。
 *
 * **`ALLOWED_IDENTITIES` に足せば緑になる**——**そして、この検査が守っている
 * 「形は正しい他人の数字 ID を落とす」が消える**（#1101 の再発）。
 * **だから「足すな / コミットを直せ」を、失敗メッセージ自身が持つ。**
 *
 * **これは代理である**（作業合意「代理と実体」）——**散文が在ることは、人が読むことの保証ではない。**
 * **だが失敗メッセージは `node --test` の出力と CI のログに必ず出るので、
 * 「落ちた人が読む場所」としては最も確実な置き場所である。**
 */
test("#1231 失敗メッセージに「allowlist に足さない / コミットを直す」が在る", () => {
  const src = readFileSync(resolve(root, "packages/etl/test/commit-identity-allowlist.test.ts"), "utf8");
  assert.ok(src.includes("#1231 失敗メッセージに"), "自分のソースを読めていない");

  // **失敗メッセージの本体を切り出す**（docblock や他の検査の文を数えないように、
  // `bad` の `assert.deepEqual` の第 3 引数だけを見る）
  const start = src.indexOf("本人確認していない identity でコミットされています");
  assert.ok(start > 0, "失敗メッセージが見つからない（この検査が対象を見失っている）");
  const msg = src.slice(start, src.indexOf("${bad.join", start));
  assert.ok(msg.length > 200, `失敗メッセージが ${msg.length} 文字しか無い（切り出しが空振りしている）`);

  const need: readonly [string, string][] = [
    ["ALLOWED_IDENTITIES には足さない", "allowlist を触らない、が書かれていない"],
    ["commit --amend --reset-author", "1 本を直す手順が書かれていない"],
    ["git rebase --committer-date-is-author-date", "複数本を直す手順が書かれていない"],
    ["GIT_COMMITTER_EMAIL", "committer を環境変数で渡す形が書かれていない（git config を叩かせてしまう）"],
    ["force-with-lease", "push の仕方が書かれていない"],
    ["gh pr update-branch --rebase", "committer を書き換える操作の名前が書かれていない（#1231 の発端）"],
    ["#1101", "allowlist に足してはいけない理由（誤帰属の実害）が書かれていない"],
  ];
  const missing = need.filter(([k]) => !msg.includes(k)).map(([k, why]) => `${k}: ${why}`);
  assert.deepEqual(missing, [], `**赤になった人が読む場所に、直し方が足りない**（#1231）`);

  // **母数**（#757）: **7 件のうち何件見たかを数える。0 件を見て緑になったら何も言っていない。**
  assert.equal(need.length, 7, `要求の件数が変わっている: ${need.length}`);
});
