import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * **コミットメッセージの `Co-authored-by:` trailer に書くメールアドレスは、
 * 数字 ID 付きの GitHub noreply でなければならない。**
 *
 * **`workflow-commit-identity.test.ts`（#1043）は `.github/workflows/*.yml` の
 * `user.email` しか見ていない。** **コミットメッセージの trailer は完全に無検査だった** ので、
 * `noreply@anthropic.com` がすり抜けた。
 * **これが #1043 が `github.com/claude` を捕まえられなかった理由である**（#1074）。
 *
 * ── 測った数（2026-09-28、`origin/main` = `068be5c2`、696 commits の全履歴）───────────
 *
 * **メッセージ本文の trailer 形の行（`Co-authored-by:`）に現れたアドレスの全数**:
 * ```
 * 1643  noreply@anthropic.com                                  ★ github.com/claude に誤帰属する
 *                                                                 （id=81847 / type=User /
 *                                                                  created_at=2009-05-07。実測）
 *  518  120390190+uonoko1@users.noreply.github.com              OK（数字 ID 付き）
 *   66  41898282+github-actions[bot]@users.noreply.github.com   OK（数字 ID 付き / type=Bot）
 *    2  （利用者本人の個人アドレス。下の「本人のアドレス」節）    squash が合成した 2 件だけ
 *    1  etl@users.noreply.github.com                            ★ github.com/etl（無関係の実在の人）
 * ```
 * **`Co-authored-by:` 以外に、アドレスを運ぶ trailer 形の token は 1 つも無い**
 * （全履歴を token ごとに数えた: `co-authored-by` 2230 行のみ）。
 *
 * ── **`git` の trailer パーサだけを見てはいけない**（この PBI で測って分かったこと）─────
 *
 * **`git log --pretty='%(trailers:only=true)'` は `noreply@anthropic.com` を 640 しか返す。
 * 本文を直接読むと 1643 ある。** 差は **squash merge のメッセージの形** から来る:
 *
 * ```
 * Closes #1053
 *
 * Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>     ← 開発者が書いた分
 * Claude-Session: https://claude.ai/code/session_…
 *
 * ---------                                                  ← GitHub が入れる区切り
 *
 * Co-authored-by: Claude Opus 5 <noreply@anthropic.com>      ← squash が合成した分
 * ```
 * **git は「最後の段落」だけを trailer と見なす**ので、**区切りより上の
 * `Co-Authored-By:` は trailer として数えない。** **実測で、本文の実数がパーサの数より
 * 多いコミットが 696 中に多数ある**（例 `22222a6c` は raw 8 / trailer 1、`068be5c2` は raw 3 / trailer 1）。
 * **`%(trailers)` に頼ると、開発者が書いた分がまるごと検査から落ちる。**
 * **だから本文の行を直接走査する。**
 *
 * ── denylist ではなく形の要求にする（#858 / #1043 と同じ向き）─────────────────────
 *
 * 「`noreply@anthropic.com` を禁じる」だと **次に別のドメインを書いた人を捕まえられない。**
 * **`数字+名前@users.noreply.github.com` という形そのものを要求する。**
 *
 * ── 本人のアドレス（リポジトリには書かない）─────────────────────────────────
 *
 * **利用者本人の個人アドレスは `uonoko1` に正しく紐づくので、本来は通してよい。**
 * **だがこの検査は逐語もハッシュもリポジトリに置かない:**
 * - **#1043 はリポジトリの追跡ファイルに利用者の個人アドレスを書かない方針を採った**
 *   （`git grep` で 0 件を確認して架空のアドレスに置き換えた経緯がある。実測: いまも 0 件）。
 * - **SHA-256 で書いても実質は同じ**である。**メールアドレスはハッシュから総当たりで戻せる**
 *   （よくあるドメインの短いローカル部なら安い）。**「ハッシュだから書いていない」は成り立たない。**
 * - **そして、そもそも要らない。** **履歴に在る本人アドレスの trailer 2 件は、どちらも
 *   squash merge が合成した分である**（実測 `6e6b9b99` / `5fb2cf0e`。合成元はマージした人の
 *   git の author identity）。**合成はマージの瞬間に起きるので、PR の枝には存在しない。**
 *   **この検査が見るのは枝のコミットだけなので、合成された trailer には当たらない。**
 *
 * **逃げ道（環境変数）は置かない。** **初版は `GIINRECORD_TRAILER_EMAIL_ALLOW` を置き、
 * 「repo のどこからも設定されていない」ことを検査 1 本で守っていたが、レビューで消した。**
 * 理由は 2 つで、どちらも実測である:
 * - **通す必要が測って 0。** 上のとおり、本人アドレスの trailer 2 件はどちらも squash 合成で、
 *   枝には出ない。**この検査の範囲（枝のコミットだけ）に本人アドレスが入る場面が無い。**
 * - **grep の検査では守れない。** **環境変数だけで赤→緑にできる**
 *   （レビューの実測: 誤帰属 trailer を枝に足して `pass 8 / fail 1` → 環境変数を渡すと `pass 9 / fail 0`）。
 *   **`ci.yml` に書いた場合は grep が捕まえるが、Secrets / repo 変数 / runner の環境から渡されれば
 *   grep には映らない。**
 *
 * **使う場面が無い逃げ道を、検査 1 本を足して維持するのは、守る面積を増やすだけである**（#1043 の
 * 「守られていないコードは置かない」と同じ向き）。**将来必要になったら、必要だと測ってから足す。**
 * **`allow` 引数は単体テスト用に残してある**（既定は空集合。環境は一切読まない）。
 */

/** **数字 ID 付きの GitHub noreply だけを通す**（`workflow-commit-identity.test.ts` の `OK` と同じ形）。 */
const OK = /^\d+\+[^@]+@users\.noreply\.github\.com$/;

/**
 * **trailer の形をした行のうち、コミットの帰属を決めるもの。**
 *
 * **GitHub が Contributors に数えるのは `Co-authored-by:` だけ**だが、
 * **`Signed-off-by:` などの「人を名指しする trailer」も同じ穴を開けうる**ので一緒に拾う
 * （拾っても偽陽性にならない——どれも本来は実在の人のアドレスを書く場所である）。
 * **列挙なので漏れがそのまま穴になる。** **だから下で列挙自身に当てている。**
 */
const IDENTITY_TRAILERS =
  /^[ \t]*(?:co[-\s]?authored[-\s]?by|signed[-\s]?off[-\s]?by|reviewed[-\s]?by|acked[-\s]?by|tested[-\s]?by|helped[-\s]?by|reported[-\s]?by|suggested[-\s]?by)[ \t]*:/i;

/** **メールアドレスらしい文字列**。`[bot]` の角括弧を含める（`github-actions[bot]@…` を落とさないため）。 */
const EMAIL = /[A-Za-z0-9._%+\-[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * **1 つのメッセージ本文から、誤帰属するアドレスを取り出す。**
 *
 * **戻す 2 つ目の数（`checked`）が母数である**（#757）。
 * **`bad` が空でも `checked` が 0 なら「1 つも見ていない」**ので、呼ぶ側がそれを区別できる。
 *
 * **`allow` は単体テスト用の引数で、既定は空集合**——**環境変数は読まない**（上の docblock）。
 */
export const misattributingTrailerEmails = (
  body: string,
  allow: Set<string> = new Set<string>(),
): { bad: string[]; checked: number } => {
  const bad: string[] = [];
  let checked = 0;
  for (const line of body.split("\n")) {
    if (!IDENTITY_TRAILERS.test(line)) continue;
    for (const m of line.matchAll(EMAIL)) {
      const email = m[0].toLowerCase();
      checked += 1;
      if (OK.test(email)) continue;
      if (allow.has(email)) continue;
      bad.push(email);
    }
  }
  return { bad, checked };
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** 末尾の改行だけを落とす（`%B` は末尾に改行を足し、生オブジェクトは足さない。それ以外は一致する）。 */
const trimTrailingNewlines = (s: string): string => s.replace(/\n+$/, "");

/**
 * **コミットの生オブジェクトからメッセージ本文を取り出す**（`git cat-file commit`）。
 *
 * **これは `--pretty` を一切通らない独立の源である。** ヘッダ（`tree` / `parent` / `author` /
 * `committer` / `gpgsig` …）は**最初の空行まで**で、そこから先が本文である
 * （git のオブジェクト形式。実測で `%B` と末尾改行を除いて**バイト一致**することを確かめた）。
 */
const rawCommitMessage = (sha: string): string => {
  const obj = git("cat-file", "commit", sha);
  const sep = obj.indexOf("\n\n");
  return sep < 0 ? "" : trimTrailingNewlines(obj.slice(sep + 2));
};

/**
 * **走査に使う本文を取り、それが「本当にメッセージ全文か」を独立の源で確かめて返す。**
 *
 * ── **なぜこれが要るか（レビューが実測した穴。#1074 の最重要の直し）** ────────────────
 *
 * **初版は `git show -s --format=%B` の結果をそのまま走査に流し、母数は `shas.length > 0`
 * だけだった。** **`shas.length > 0` は「コミットを列挙した」ことしか言っておらず、
 * 「そのメッセージを読んだ」ことを何も言っていない。**
 * **実データに当たる唯一の部分が、中身を空にしても緑になっていた**（レビューの実測。すべて 9/9 緑）:
 *
 * ```
 * X1  misattributingTrailerEmails(git("show",…)) → misattributingTrailerEmails("")   pass 9 / fail 0
 * X2  --format=%B → --format=%s（件名だけ。ありがちな「簡略化」）                     pass 9 / fail 0
 * X3  --format=%B → --format=%(trailers:only=true)                                  pass 9 / fail 0
 * ```
 *
 * **X3 がいちばん重い。** **この PBI の中核の発見は「`%(trailers)` は squash の区切りより上を
 * 見ないので 1003 件（61%）が見えない」ことである。** **なのに `%(trailers)` に差し替えても緑だった**
 * ——レビューは**使い捨て clone に「区切りより上に誤帰属 trailer を持つコミット」**（この PBI が
 * 見つけた形そのもの）**を植えて、無改造なら `pass 8 / fail 1` で赤になるところを、
 * X3 を当てると `pass 9 / fail 0` で通した。**
 *
 * **検査 8（`%(trailers)` に頼らない）は `misattributingTrailerEmails` を単体で当てているだけで、
 * 範囲の走査が本文をどう取るかを一切拘束していなかった。**
 *
 * ── **どう解いたか: 母数を「読んだ本文そのもの」で取る** ─────────────────────────
 *
 * **「trailer が 0 件の PR は正常」なので、`checked` に下限は置けない**（#757。母数は 1 つではない）。
 * **だから「読んだ trailer 行の数」ではなく、`--pretty` を通らない独立の源との一致で取る:**
 *
 * **走査に使った文字列は、`git cat-file commit` の生オブジェクトの本文と（末尾改行を除いて）
 * 逐語で一致しなければならない。**
 *
 * **これが 3 変異すべてを落とす**——`""` も `%s`（件名だけ）も `%(trailers:only=true)`
 * （件名も本文も落ちる）も、**生オブジェクトの本文と一致しない。**
 * **`--pretty` の書式を何に差し替えても、`%B` 以外は一致しない**ので、
 * **denylist（「`%s` を禁じる」）ではなく、形の要求になっている。**
 *
 * **加えて「読んだ行の総数」も母数として返す**——`assert` は上の一致で足りるが、
 * **ログに出す数が 0 のまま緑だったのが穴の発端なので、行数を人が読める場所に出す。**
 *
 * ── **この番人自身が何も主張しないのを防ぐ** ─────────────────────────────────
 *
 * **番人を足しただけでは足りなかった。** **自分で変異を当てて 2 つ見つけた**（どちらも 9/9 緑で生き残った）:
 *
 * ```
 * X4  rawCommitMessage も %B を読むようにする（比較を恒真にする）   pass 9 / fail 0
 * X5  一致の assert を `if (false)` で無効化する                    pass 9 / fail 0
 * ```
 *
 * **理由は「この枝の本文はどれも正しいので、番人が一度も火を噴かない」こと。**
 * **#1043 と同じ形である**——**走査の側が構造的に緑なら、そこに置いた assert は何も主張しない。**
 *
 * **だから読み取りを差し替えられる形にし**（`read` 引数）、**下の検査で
 * 「`%s` / `""` / `%(trailers)` で読んだら実際に落ちる」ことを本物のコミットに当てて固定する。**
 * **X5 はその検査が落とす。X4 は「独立の源が `cat-file` であること」を同じ検査が語で固定する。**
 */
/** 走査に使う本文の読み方。既定は `%B`（メッセージ全文）。**差し替えられるのは検査のためである。** */
const readBodyByFormat = (sha: string): string =>
  trimTrailingNewlines(git("show", "-s", "--format=%B", sha));

const scannedBody = (
  sha: string,
  read: (sha: string) => string = readBodyByFormat,
): { body: string; lines: number } => {
  const body = read(sha);
  // **独立の源（`git cat-file commit` の生オブジェクト）と逐語で一致すること。**
  // **ここが X1 / X2 / X3 を落とす番人である。**
  assert.equal(
    body,
    rawCommitMessage(sha),
    `走査に使った本文が、コミットの生オブジェクトの本文と一致しない` +
      `（メッセージ全文ではないものを走査している。%s / %(trailers) / 空文字などに差し替わっていないか）: ${sha.slice(0, 8)}`,
  );
  // **メッセージが空のコミットは、ふつうには作れない**（`--allow-empty-message` が要る。
  // 実測: `origin/main` 696 commits すべて 1 行以上）。
  // **「一致」だけだと「両方とも空」で通ってしまう**ので、空でないことも言う。
  assert.ok(body.length > 0, `メッセージ本文が空である（走査が空回りしている）: ${sha.slice(0, 8)}`);
  return { body, lines: body.split("\n").length };
};

/**
 * **この PR が足すコミットだけを見る**（`merge-base(origin/main, HEAD)..HEAD`）。
 *
 * **なぜ全履歴を見ないか**: **いま在る履歴には 1644 件の誤帰属が既に刻まれている**
 * （`noreply@anthropic.com` 1643 / `etl@users.noreply.github.com` 1）。
 * **全履歴に当てると、この検査は `origin/main` で必ず赤になる**——
 * **赤が常態になった検査は誰も見なくなる**（作業合意の「偽陽性を出す検査」）。
 * **既存履歴を直すには protected branch の history rewrite が必要で 640 commits に触る**ので、
 * **#1074 は「利用者に確認してから」として範囲外にしている。**
 *
 * **この選択で守れないもの**（明記する）:
 * - **既に main に在る 1644 件は、この検査では永久に見えない。** 直すのは別の PBI。
 * - **`origin/main` や merge-base が取れない浅い checkout では、この検査は 1 件も見ない**
 *   （下で skip する。緑にはしない。**ただし「読めない」という主張は別の git コマンドで
 *   裏づける**——理由の綴りだけで skip できないようにした。必須 2）。
 * - **main へ直 push されたコミットは、`..HEAD` が空になるので見えない**
 *   （`main` は protected で直 push できない設定を `branch-protection.yml` が固定している）。
 * - **squash merge が合成する trailer は、マージの瞬間に作られる**ので **枝には存在せず、
 *   この検査（trailer の側）を通り抜ける。**
 *   **合成元は「squash 対象のコミットの author」なので、そこは下の author / committer の検査が
 *   受け持つ**（#1074 の必須 4 で足した）。
 *
 *   **初版はここに「author の側は `workflow-commit-identity.test.ts`（#1043）が受け持つ」と
 *   書いていた。これは事実と違ったので訂正した。**
 *   **あれは `.github/workflows/*.yml` に書かれた `user.email` の *綴り* の検査であって、
 *   実際に刻まれた author を 1 件も読んでいない**（レビューと PO が独立に検算。
 *   `child_process` を import していない）。**#1074 の (B)（`etl@` 1 件）は
 *   #1043 では閉じていなかった。**
 * - **マージコミットの author / committer は見ない**（下の docblock に測った理由。
 *   本人が手元で作る `Merge branch 'main' into …` で毎回赤くなるのを避けるため）。
 * - **`fork` からの PR では、`origin/main` を枝の側が動かせる**（レビューの実測。#1074 の任意）。
 *   `actions/checkout` は fork PR でも `origin` を**その PR のリポジトリ**に向けるので、
 *   **`git update-ref refs/remotes/origin/main <誤帰属コミット>` で範囲を空に近づけられる**
 *   （実測: 本物の main なら `pass 8 / fail 1` で赤 → `origin/main` を誤帰属コミットまで
 *   進めると `pass 9 / fail 0` で緑）。
 *   **いまは単独リポジトリなので実害は低いが、範囲の取り方が「枝の側から動かせる ref」に
 *   依存していることは事実である。** **`ci.yml` の fetch 段が毎回 `+refs/heads/main` を
 *   名指しで上書き fetch するので、CI では上書きされて戻る**——**だが手元では戻らない。**
 */
/**
 * **走らせないでよい理由は、この 2 つだけ。**
 *
 * **「skip」は赤にならないので、理由を増やせば検査は黙って無力化できる。**
 * **だから理由の集合を逐語で固定する**（`SKIP_REASONS` を広げる変異は下のテストが落とす）。
 */
const NO_BASE = "refs/remotes/origin/main が無い";
const NO_MERGE_BASE = "origin/main と HEAD の merge-base が取れない（浅い checkout）";
const SKIP_REASONS: readonly string[] = [NO_BASE, NO_MERGE_BASE];

/**
 * **`origin/main` が本当に無いことを、別の git コマンドで確かめる。**
 *
 * **理由の文字列を逐語で固定するだけでは足りなかった**（レビューの実測。必須 2）——
 * **`SKIP_REASONS` は理由の *綴り* を守るだけで、「その理由が本当に成立しているか」を何も見ていない。**
 * **許された理由で skip させる変異は 3 通りとも `pass 9 / fail 0 / skipped 1` で生き残った:**
 *
 * ```
 * R2  `if (reason !== undefined)` → `if (true) { const reason = NO_BASE;`   skipped 1
 * R3  `base = git("rev-parse",…)` → `base = ""`                            skipped 1
 * R4  `mergeBase = git("merge-base",…)` → `mergeBase = ""`                 skipped 1
 * ```
 *
 * **R3 / R4 は「ありがちな壊し方」そのものである**（ref の名前を書き間違える、
 * `--quiet` の挙動を読み違える）。**そして `skipped > 0` を落とすものはリポジトリのどこにも無い**
 * ——**`ci.yml` の fetch 段は `|| true` なので、fetch が全滅しても step は exit 0 になる**
 * （レビューが origin を差し替えて再現した）。**「fetch が壊れたら検査は静かに走らなくなり、
 * CI は緑になる」経路が実在していた。**
 *
 * **だから「走らせない」と言う前に、その主張を別の源で裏づける。**
 * `rev-parse` が取れなかったと言うなら、**`for-each-ref` にも 1 件も出ないはず**である。
 * **出るなら主張が嘘なので、skip ではなく落とす。**
 */
const originMainReallyAbsent = (): boolean => {
  try {
    return git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main").trim() === "";
  } catch {
    return true; // `for-each-ref` 自体が失敗するなら、git の履歴が読めていない
  }
};

/**
 * **merge-base が本当に取れないことを、その場でもう一度確かめる。**
 *
 * **`addedCommits` が返した `reason` の綴りを信じない**——**許された綴りを捏造する変異
 * （R2b: `if (true) { const reason = NO_MERGE_BASE;`）は、綴りの逐語固定を素通りする**
 * （実測: `pass 9 / fail 0 / skipped 1`）。**「走らせない」と言うなら、その主張を裏づける。**
 */
const mergeBaseObtainable = (): boolean => {
  try {
    return git("merge-base", "refs/remotes/origin/main", "HEAD").trim() !== "";
  } catch {
    return false;
  }
};

const addedCommits = (): {
  shas: string[];
  reason?: string;
  lie?: string;
  mergeBase?: string;
  head?: string;
} => {
  let base: string;
  try {
    base = git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main").trim();
  } catch {
    base = "";
  }
  if (base === "") {
    // **主張を別の源で裏づける**（R3 はここで落ちる）。
    if (!originMainReallyAbsent()) {
      return {
        shas: [],
        lie: `origin/main が取れなかったと言っているが、for-each-ref には出ている` +
          `（走査を止める理由が成り立っていない）: ${git("for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin/main").trim()}`,
      };
    }
    return { shas: [], reason: NO_BASE };
  }
  // **浅い checkout では merge-base が取れない。** 取れないまま `A..B` を走らせると
  // **git は「B から届く範囲だけ」を返す**ので、母数が落ちて検査が無意味になる。
  let mergeBase: string;
  try {
    mergeBase = git("merge-base", base, "HEAD").trim();
  } catch {
    mergeBase = "";
  }
  if (mergeBase === "") {
    // **`origin/main` が在るのに merge-base が取れないなら、それは「浅い」ではなく壊れている**
    // ——**浅さの手当ては `ci.yml` の fetch 段が責任を持つ。そこが壊れたら赤くなるべきである**
    // （レビューの指摘。R4 はここで落ちる）。
    // **本当に浅くて届かない場合だけ skip を許す**ので、`--is-shallow-repository` で裏づける。
    // **実測（2026-09-28）: `--depth=1` の clone は `is-shallow=true` で `origin/main` も無い
    // （＝上の NO_BASE に落ちる）。`--deepen=50` を足すと shallow のままだが
    // `origin/main` も merge-base も取れる**ので、CI はこちらの分岐に来ない。
    const shallow = (() => {
      try {
        return git("rev-parse", "--is-shallow-repository").trim() === "true";
      } catch {
        return false;
      }
    })();
    if (!shallow) {
      return {
        shas: [],
        lie:
          `origin/main（${base.slice(0, 8)}）は取れているのに merge-base が取れず、` +
          `しかも浅い checkout でもない（走査を止める理由が成り立っていない）`,
      };
    }
    return { shas: [], reason: NO_MERGE_BASE };
  }
  const head = git("rev-parse", "HEAD").trim();
  const out = git("rev-list", `${mergeBase}..HEAD`).trim();
  return { shas: out === "" ? [] : out.split("\n"), mergeBase, head };
};

/**
 * **1 つのコミットの author / committer を読み、誤帰属するものを返す。**
 *
 * **マージコミットは対象外**（親が 2 つ以上。上の docblock に測った理由）。
 * **戻す `checked` が母数である**（#757）——**マージなら 0、そうでなければ 2。**
 *
 * **生オブジェクトのヘッダと突き合わせて読む**——**`%ae` / `%ce` は `--pretty` なので、
 * 取り違え（`%ce` を `%ae` にする）や空になる変異を、それ自身では検出できない。**
 */
const misattributingCommitIdentity = (
  sha: string,
): { bad: string[]; checked: number; merge: boolean } => {
  const parents = git("show", "-s", "--format=%p", sha).trim().split(/\s+/).filter((x) => x !== "");
  if (parents.length >= 2) return { bad: [], checked: 0, merge: true };
  const ae = git("show", "-s", "--format=%ae", sha).trim().toLowerCase();
  const ce = git("show", "-s", "--format=%ce", sha).trim().toLowerCase();
  // **母数**: **生オブジェクトの `author` / `committer` ヘッダにも同じアドレスが在ること。**
  // **`%ae` を `%ce` に取り違える／空になる変異は、ここで落ちる。**
  const rawHeader = git("cat-file", "commit", sha).split("\n\n")[0] ?? "";
  const bad: string[] = [];
  let checked = 0;
  for (const [kind, email] of [["author", ae], ["committer", ce]] as const) {
    assert.ok(
      new RegExp(`^${kind} .*<${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "m").test(rawHeader),
      `${sha.slice(0, 8)}: ${kind} のアドレスが生オブジェクトのヘッダと一致しない（読み方が壊れている）: ${email}`,
    );
    checked += 1;
    if (!OK.test(email)) bad.push(`${sha.slice(0, 8)}: ${kind}=${email}`);
  }
  return { bad, checked, merge: false };
};

test("この枝が足すコミットの trailer に、誤帰属するアドレスが無い", (t) => {
  const { shas, reason, lie, mergeBase, head } = addedCommits();
  // **「走らせない理由が成り立っていない」なら、skip ではなく落とす**（必須 2。R3 / R4 はここで落ちる）。
  assert.equal(lie, undefined, `走査を止める理由が成り立っていない: ${lie}`);
  if (reason !== undefined) {
    // **skip する前に、「本当に skip すべき状態か」を別の源で確かめ直す。**
    // **これが R2（`if (true)` にして許された理由を捏造する変異）を落とす唯一の番人である**
    // ——**`SKIP_REASONS` の逐語固定は理由の綴りしか守らないので、
    // 許された綴りを渡されると通ってしまっていた**（レビューの実測: `pass 9 / fail 0 / skipped 1`）。
    // **どちらの理由も、別の源で成り立つことを確かめる**（`reason` の綴りを信じない）。
    // `NO_BASE`       → `for-each-ref` にも 1 件も出ないこと
    // `NO_MERGE_BASE` → その場でもう一度 `merge-base` を叩いて、本当に取れないこと
    assert.ok(
      reason === NO_BASE ? originMainReallyAbsent() : !mergeBaseObtainable(),
      `「${reason}」で走らせないと言っているが、別の源では履歴が読める（検査が黙って無力化されている）`,
    );
    // **「落ちる」ではなく「明示的に skip」にした理由**:
    // **`pnpm test` を走らせる CI の `check` ジョブは `actions/checkout@v4` の既定
    // （`fetch-depth: 1`）で checkout する**（`ci.yml` 実測: `fetch-depth: 0` を持つのは
    // `stale-base` ジョブと `security.yml` だけ）。**そこで落とすと、誤帰属が 1 件も無い PR まで
    // 赤になる**——**偽陽性で赤が常態になるのを避ける**（作業合意）。
    // **黙って緑にはしない**: skip は `node --test` の出力と CI のログに残り、
    // **履歴が読める環境（開発者の手元・深さを足した checkout）では必ず走る。**
    // **「0 件だから緑」とは区別がつく形になっている**のが要点である。
    //
    // **skip は赤にならないので、「いつも skip」に潰されうる。**
    // **実測（変異）: `if (reason !== undefined)` を `if (true)` に変えると、
    // 下の `assert.ok` が無いときは **tests 8 / 7 pass / 0 fail / skipped 1** で生き残った。**
    // **`assert.ok` と「理由の集合」のテストを足したら **tests 9 / 8 pass / 1 fail** になった**——
    // **理由が `undefined` になったところで落ちる。**
    // **そして CI 側では `ci.yml` の fetch 段が「取れなかった」を echo する**ので、
    // **ログにも理由が残る。**
    assert.ok(
      SKIP_REASONS.includes(reason),
      `知らない理由で skip しようとしている（検査が黙って無力化されている）: ${reason}`,
    );
    t.skip(`履歴が読めないので走らせない: ${reason}`);
    return;
  }
  const bad: string[] = [];
  let checked = 0;
  let scannedLines = 0;
  for (const sha of shas) {
    // **`scannedBody` が「読んだものがメッセージ全文か」を独立の源で確かめる**
    // （X1 / X2 / X3 の 3 変異はここで落ちる。関数の docblock に実測を書いた）。
    const { body, lines } = scannedBody(sha);
    scannedLines += lines;
    const r = misattributingTrailerEmails(body);
    checked += r.checked;
    for (const email of r.bad) bad.push(`${sha.slice(0, 8)}: ${email}`);
  }
  assert.deepEqual(
    bad,
    [],
    "trailer のアドレスが無関係の GitHub ユーザーに誤帰属する。" +
      "数字 ID 付きの `<id>+<name>@users.noreply.github.com` にするか、trailer を落とすこと:\n  " +
      bad.join("\n  "),
  );
  // **母数（#757）。** **`checked` そのものに下限は置けない**——**trailer を 1 つも書かない PR は
  // アドレス 0 件が正しい。** **だが「コミットの数」には置ける。**
  //
  // **これは変異で見つけた穴である**（#705 の「検算が空回り」と同じ形）。
  // **実測: `rev-list` の結果を `""` に潰す変異を当てたら、この `assert.ok` が無いときは
  // **tests 8 / 8 pass / 0 fail** で生き残った。足したら **tests 9 / 8 pass / 1 fail** になった。**
  // **変異は当たっている（md5 が変わった）。振る舞いも変わっている
  // （走査が 1 commit → 0 commit）。それでも緑だった**——
  // **`bad` が空であることしか見ておらず、「見る対象そのものが消えた」ことを誰も見ていなかった。**
  //
  // **塞ぎ方**: **HEAD が merge-base と違うなら、範囲は空であってはならない。**
  // （`merge-base == HEAD` は「枝が base に何も足していない」= main そのものを検査している状態で、
  // そのときだけ 0 が正しい。）
  if (mergeBase !== head) {
    assert.ok(
      shas.length > 0,
      `HEAD が merge-base と違うのに走査した範囲が空である（走査が空回りしている）: ` +
        `merge-base=${mergeBase?.slice(0, 8)} HEAD=${head?.slice(0, 8)}`,
    );
  }
  // **本文の行数も出す**——**「アドレス 0 件」のまま緑だったのが穴の発端である**（X1 / X2）。
  // **行数が 0 に落ちたら人の目にも映る**（assert は `scannedBody` の側が持っている）。
  assert.ok(
    scannedLines >= shas.length,
    `本文の行数が コミット数 を下回った（1 行も無いメッセージを読んでいる）: 行 ${scannedLines} / コミット ${shas.length}`,
  );
  console.log(
    `[#1074] 枝が足したコミット ${shas.length} 件 / 本文 ${scannedLines} 行 / trailer のアドレス ${checked} 件を走査`,
  );
});

/**
 * **「走らせない理由」の集合を逐語で固定する。**
 *
 * **skip は赤にならない**ので、**理由を 1 つ増やすだけで検査は黙って無力化できる**
 * （実測: `if (reason !== undefined)` を `if (true)` に潰す変異は **7 pass / 0 fail / skipped 1**
 * で生き残った。**赤が出ないので、上のテスト自身では捕まえられない**）。
 * **ここが「その変異を捕まえる唯一の番人」である**——理由が `undefined` や新しい文字列になれば、
 * 上の `assert.ok(SKIP_REASONS.includes(reason))` が落ちる。
 *
 * **2 つの理由はどちらも「履歴が読めない」に限る。**
 * **「trailer が無い」「アドレスが無い」のような、中身に依存する理由を足してはいけない**
 * ——それは skip ではなく、検査が通ったということである。
 */
/**
 * **枝が足すコミットの author / committer も、同じ `OK` を当てる**（#1074 の必須 4）。
 *
 * ── **なぜこれが要るか: trailer は結果で、author が起点である** ──────────────────────
 *
 * **PR の初版は「author の側は `workflow-commit-identity.test.ts`（#1043）が受け持つ」と書いた。
 * これは事実と違った。** **レビューと PO が独立に検算した:**
 *
 * ```
 * workflow-commit-identity.test.ts の import:
 *   node:test / node:assert/strict / node:fs / node:url / node:path
 *   → child_process が無い。grep で出てくる `git` は全部コメントか文字列リテラル。
 *   → 実際のコミットの author を 1 件も読んでいない。
 * ```
 *
 * **あれは `.github/workflows/*.yml` に書かれた `user.email` の *綴り* の検査であって、
 * 「実際に刻まれた author」の検査ではない。** **workflow 以外の経路で author が汚れることは、
 * 誰も止めていなかった**（すでに open だった PR、手元の `git config`、別の bot、fork）。
 *
 * **そしてこれが #1074 の実害そのものの経路である:**
 *
 * ```
 * 1. cdc55734 が author=etl@users.noreply.github.com でコミットされた   ← 起点
 * 2. squash merge が author から Co-authored-by を合成した
 * 3. main に etl@ trailer が刻まれた → github.com/etl が Contributors に出た  ← 結果
 * ```
 *
 * **レビューは、まったく同じ形（author が `etl@` / trailer は無し）を枝に足して
 * 新テストと #1043 の両方を流し、`tests 14 / pass 14 / fail 0` で通ることを実測した。**
 * **起点を検査していないなら、また起こる。**
 *
 * ── **マージコミットを外す理由（測ってから決めた）** ──────────────────────────────
 *
 * **`origin` の全ブランチ 12 本の枝の範囲（`merge-base..枝`）を数えた（2026-09-28、実測）:**
 *
 * ```
 * マージでないコミット   43 件（重複除去）  … うち OK でない author/committer は 1 件
 *                                            cdc55734 author=committer=etl@users.noreply.github.com
 *                                            ＝ #1074 (B) の実害そのもの。偽陽性 0
 * マージコミット          8 件              … うち OK でない author は 5 件（すべて本人の個人アドレス。
 *                                            `Merge branch 'main' into …` を手元で作ったもの）
 * ```
 *
 * **マージコミットまで見ると、本人が手元で `git merge main` するたびに赤くなる**
 * ——**5/8 が落ちる。** **それは誤帰属ではない**（本人のアドレスは本人に紐づく）し、
 * **GitHub もマージコミットを Contributors の帰属には使わない。**
 * **`--no-merges` にすると、実害の 1 件だけが残り、偽陽性は 0 になる。**
 *
 * **この選択で守れないもの**（明記する）:
 * - **マージコミットの author は見ない。** **squash merge が合成する trailer の元は
 *   「squash 対象のコミット」の author** なので、**合成元は `--no-merges` の側に入る。**
 *   **実害の経路は塞げている**が、**マージコミット自身の author を誤帰属に使う経路は残る。**
 * - **本人の個人アドレスは、マージでないコミットの author に来たら赤になる。**
 *   **実測ではそういうコミットは 43 件中 0 件**（本人は数字 ID 付きでコミットしている）。
 *   **来たら、それは git の設定が戻ったということなので、赤にしてよい。**
 */
test("この枝が足すコミットの author / committer が誤帰属しない（trailer の起点を押さえる）", (t) => {
  const { shas, reason, lie, mergeBase, head } = addedCommits();
  assert.equal(lie, undefined, `走査を止める理由が成り立っていない: ${lie}`);
  if (reason !== undefined) {
    assert.ok(
      reason === NO_BASE ? originMainReallyAbsent() : !mergeBaseObtainable(),
      `「${reason}」で走らせないと言っているが、別の源では履歴が読める（検査が黙って無力化されている）`,
    );
    t.skip(`履歴が読めないので走らせない: ${reason}`);
    return;
  }
  const bad: string[] = [];
  let checked = 0;
  let merges = 0;
  for (const sha of shas) {
    // **マージコミットは対象外**（上の docblock に測った理由）。
    const r = misattributingCommitIdentity(sha);
    if (r.merge) merges += 1;
    checked += r.checked;
    for (const e of r.bad) bad.push(e);
  }
  assert.deepEqual(
    bad,
    [],
    "コミットの author / committer が無関係の GitHub ユーザーに誤帰属する。" +
      "**squash merge はここから Co-authored-by を合成するので、trailer を直しても main に刻まれる**" +
      "（#1074 の (B) がこの経路）。数字 ID 付きの `<id>+<name>@users.noreply.github.com` にすること:\n  " +
      bad.join("\n  "),
  );
  // **母数（#757）。** **マージでないコミットが 1 件でもあるなら、アドレスは 2 件ずつ読めるはず。**
  // **`shas` が空でないのに `checked` が 0 なら、全部マージだったか、走査が空回りしている。**
  if (mergeBase !== head) {
    assert.ok(
      shas.length > 0,
      `HEAD が merge-base と違うのに走査した範囲が空である: merge-base=${mergeBase?.slice(0, 8)} HEAD=${head?.slice(0, 8)}`,
    );
  }
  assert.equal(
    checked,
    (shas.length - merges) * 2,
    `読んだアドレスの数が「マージでないコミット × 2」と合わない（走査が空回りしている）: ` +
      `checked=${checked} / commits=${shas.length} / merges=${merges}`,
  );
  console.log(
    `[#1074] author/committer: マージでないコミット ${shas.length - merges} 件 / アドレス ${checked} 件を走査（マージ ${merges} 件は対象外）`,
  );
});

/**
 * **author / committer の検査が、実際に火を噴くことを固定する。**
 *
 * ── **なぜこの検査が要るか（自分で当てた変異。上と同じ形の罠）** ──────────────────────
 *
 * **author の走査を足しただけでは、何も主張していなかった。**
 * **この枝の author はすべて数字 ID 付きなので、走査は構造的に緑になる。**
 * **実測（すべて 11/11 緑で生き残った）**:
 *
 * ```
 * A1  bad.push(...) を消す                        pass 11 / fail 0
 * A2  マージ判定を `if (true)` にして全部を対象外  pass 11 / fail 0
 * A3  %ce を %ae にする（committer を読まない）    pass 11 / fail 0
 * A4  checked の母数 assert を恒真にする           pass 11 / fail 0
 * ```
 *
 * ── **どう固定するか: `git commit-tree` で形の分かったコミットを作る** ────────────────
 *
 * **`git commit-tree` は ref を一切触らずにコミットオブジェクトを 1 つ書くだけである**
 * （実測: `for-each-ref --points-at` は 0 件。到達不能なので `gc` が回収する）。
 * **だから author / committer / 親の数を自由に決めた「本物のコミットオブジェクト」を作れる。**
 *
 * **当てる 4 形**（それぞれが上の変異のどれかを落とす）:
 * ```
 * 1. author=etl@ / committer=etl@ の単親コミット   → 赤 2 件（A1 が落ちる）
 *                                                    ＝ #1074 (B) cdc55734 と同じ形
 * 2. author だけ誤帰属の単親コミット                → 赤 1 件（author を読んでいる）
 * 3. committer だけ誤帰属の単親コミット             → 赤 1 件（A3 が落ちる。%ce を読んでいる）
 * 4. author が誤帰属の 2 親（マージ）コミット        → 赤 0 件 / checked 0（A2 が落ちる。
 *                                                    マージを対象外にできている）
 * ```
 */
test("author / committer の検査が、誤帰属する 3 形で実際に落ちる（マージは対象外）", () => {
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  const p1 = git("rev-parse", "HEAD").trim();
  const p2 = git("rev-parse", "HEAD~1").trim();
  /** ref を触らずにコミットオブジェクトを 1 つ書く（`commit-tree`）。 */
  const make = (author: string, committer: string, parents: string[]): string =>
    execFileSync(
      "git",
      ["-C", root, "commit-tree", tree, ...parents.flatMap((x) => ["-p", x])],
      {
        input: "test: 検査に当てるためのコミット\n",
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: author,
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: committer,
        },
      },
    ).trim();
  const ETL = "etl@users.noreply.github.com"; // #1074 (B) の実害そのもの
  const GOOD = "120390190+uonoko1@users.noreply.github.com";
  const OTHER = "person@example.com"; // 架空。実在の個人アドレスは書かない（#1043）

  // 1. 両方が誤帰属の単親（cdc55734 と同じ形）
  const both = misattributingCommitIdentity(make(ETL, ETL, [p1]));
  assert.equal(both.merge, false, "単親のコミットをマージと判定している");
  assert.equal(both.checked, 2, "単親のコミットでアドレスを 2 件読んでいない（母数）");
  assert.deepEqual(
    both.bad.map((b) => b.split(": ")[1]),
    [`author=${ETL}`, `committer=${ETL}`],
    "author / committer の両方が誤帰属しているのに赤にならない（#1074 (B) と同じ形）",
  );
  // 2. author だけ誤帰属
  const onlyAuthor = misattributingCommitIdentity(make(ETL, GOOD, [p1]));
  assert.deepEqual(
    onlyAuthor.bad.map((b) => b.split(": ")[1]),
    [`author=${ETL}`],
    "author の誤帰属だけが赤にならない（author を読んでいない）",
  );
  // 3. committer だけ誤帰属（**`%ce` を `%ae` にする変異はここが落とす**）
  const onlyCommitter = misattributingCommitIdentity(make(GOOD, ETL, [p1]));
  assert.deepEqual(
    onlyCommitter.bad.map((b) => b.split(": ")[1]),
    [`committer=${ETL}`],
    "committer の誤帰属だけが赤にならない（committer を読んでいない）",
  );
  // 4. 正しい 2 形は緑（偽陽性の確認）
  const good = misattributingCommitIdentity(make(GOOD, GOOD, [p1]));
  assert.deepEqual(good.bad, [], "正しいアドレスで赤になっている（偽陽性）");
  assert.equal(good.checked, 2, "正しいコミットでアドレスを 2 件読んでいない（母数）");
  // 5. マージコミットは対象外（**マージ判定を `if (true)` にする変異はここが落とす**——
  //    対象外にした 1 件が `merge: true` / `checked: 0` で返ることを言う）。
  const merge = misattributingCommitIdentity(make(OTHER, OTHER, [p1, p2]));
  assert.equal(merge.merge, true, "2 親のコミットをマージと判定していない");
  assert.equal(merge.checked, 0, "マージコミットのアドレスを読んでいる（偽陽性になる）");
  assert.deepEqual(merge.bad, [], "マージコミットで赤になっている（本人の手元のマージで毎回赤になる）");
});

test("走らせない理由は「履歴が読めない」2 つだけ（skip で無力化できないようにする）", () => {
  assert.deepEqual(
    [...SKIP_REASONS],
    [
      "refs/remotes/origin/main が無い",
      "origin/main と HEAD の merge-base が取れない（浅い checkout）",
    ],
    "走らせない理由が増えている（skip は赤にならないので、増やせば検査は黙って死ぬ）",
  );
  // **どちらも「履歴が読めない」ことしか言っていない**ことを、語で固定する。
  for (const r of SKIP_REASONS) {
    assert.ok(
      /origin\/main|merge-base/.test(r),
      `履歴の読めなさ以外を理由に skip しようとしている: ${r}`,
    );
  }
});

/**
 * **上の検査は、この枝が正しい trailer だけを書いていれば `bad` が構造的に空になる。**
 * **だから `OK` を「何でも通す」形に緩めても緑のまま通る**（#1043 のレビューが同じ穴を実測した）。
 * **`OK` そのものが何も主張していない。**
 *
 * **だから `OK` を、通すべき綴りと通してはいけない綴りに直接当てる。**
 *
 * ── **アンカーを外す変異が 3 通り、10/10 緑で生き残っていた**（レビューの実測。#1074 の必須 3）──
 *
 * ```
 * N2  …github\.com$/ → …github\.com/    （末尾の $ を外す）   pass 10 / fail 0
 * N4  /^\d+\+…       → /\d+\+…          （先頭の ^ を外す）   pass 10 / fail 0
 * N6  [^@]+           → [^@]*            （ローカル部を空可に） pass 10 / fail 0
 * ```
 *
 * **`OK` を「形の要求」として書いたのに、その形を守る検査自身が denylist**で、
 * **列挙漏れがそのまま穴になっていた**（作業合意が繰り返し指摘している型。#1043 で同じ直し方をした）。
 *
 * **N2 は実害の形である**——**`…users.noreply.github.com.evil.com` は GitHub のユーザーに
 * 紐づかない外部ドメイン**で、**`noreply@anthropic.com` とまったく同じクラスの誤帰属を生む。**
 * **サフィックス攻撃の形が「通してはいけない」側に 1 つも入っていなかった。**
 *
 * **下の 3 形（`suffix` / `prefix` / `empty-local`）を足すと、N2 / N4 / N6 が全部落ちる**
 * （実測は PR 本文）。**アンカーごとに 1 形ずつ対応させてある**ので、
 * どのアンカーが外れたかがメッセージから分かる。
 */
test("数字 ID 付きの noreply だけを通す正規表現そのものを検査する", () => {
  const good = [
    "41898282+github-actions[bot]@users.noreply.github.com",
    "120390190+uonoko1@users.noreply.github.com",
  ];
  const bad = [
    "noreply@anthropic.com", // #1074 の発端。github.com/claude（id=81847、実在の個人）に誤帰属する
    "etl@users.noreply.github.com", // #1043 の発端。github.com/etl に誤帰属する
    "dev@users.noreply.github.com",
    "claude@anthropic.com",
    "noreply@example.com",
    "41898282+github-actions[bot]@example.com",
    "+uonoko1@users.noreply.github.com",
    "120390190@users.noreply.github.com",
    // ── ここから下はレビューが素通りを実測した 3 形（必須 3）──────────────────
    // **末尾アンカー（`$`）が要る**。これは実害の形である——`…github.com.evil.com` は
    // **GitHub のユーザーに紐づかない外部ドメイン**で、誤帰属のクラスは anthropic.com と同じ。
    "1+x@users.noreply.github.com.evil.com",
    "1+x@users.noreply.github.company", // 末尾アンカーが無いと `.com` の後ろに何を足しても通る
    // **先頭アンカー（`^`）が要る**。前に何を付けても通ってしまう。
    "evil+1+x@users.noreply.github.com",
    // **ローカル部は 1 文字以上（`[^@]+`）でなければならない**。
    // `1+@users.noreply.github.com` は名前の無い形で、どのユーザーにも紐づかない。
    "1+@users.noreply.github.com",
  ];
  // **母数**（#757）: **列挙そのものの本数を固定する。**
  // **列挙が縮んだら、また同じアンカーの穴が開く**（N2 / N4 / N6 はこの列挙漏れで生き残っていた）。
  assert.equal(good.length, 2, "通すべき綴りの列挙が縮んでいる");
  assert.equal(bad.length, 12, "通してはいけない綴りの列挙が縮んでいる（アンカーを外す変異が素通りする）");
  for (const e of good) assert.ok(OK.test(e), `通すべき綴りが落ちた: ${e}`);
  for (const e of bad) assert.ok(!OK.test(e), `通してはいけない綴りが通った: ${e}`);
});

/**
 * **`misattributingTrailerEmails` を、`origin/main` の履歴に実際に在った形に当てる。**
 *
 * **これが「いま在る履歴の 2 形を赤にできる」ことの証明である**（#1074 の受け入れ条件）。
 * **母数（`checked`）も一緒に固定する**（#757。`bad` が空でも `checked` が落ちていれば走査が壊れている）。
 */
test("履歴に実際に在った 4 形を、赤 2 / 緑 2 に分ける（母数も固定する）", () => {
  const body = [
    "fix: 何かを直した",
    "",
    "Closes #1074",
    "",
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    "Co-authored-by: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
    "Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    "Co-authored-by: giinrecord-etl[bot] <etl@users.noreply.github.com>",
    "Claude-Session: https://claude.ai/code/session_x",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(
    bad,
    ["noreply@anthropic.com", "etl@users.noreply.github.com"],
    "履歴に在った 2 つの誤帰属が赤にならない",
  );
  // **母数**: trailer 形の行 4 つからアドレスを 4 つ拾っている
  // （`Claude-Session:` は身元の trailer ではないので数に入らない）。
  assert.equal(checked, 4, "走査したアドレス数が変わっている（走査が空回りしているか、広がりすぎている）");
});

/**
 * **身元を名指ししない trailer を拾ってはいけない**（偽陽性）。
 * **`Claude-Session:` の URL や `mailto:` を拾うと、無関係な行で CI が赤くなる。**
 */
test("身元を名指ししない trailer は走査しない（偽陽性を出さない）", () => {
  const body = [
    "docs: 何か",
    "",
    "Claude-Session: https://claude.ai/code/session_01N",
    "Refs: https://example.com/a@b.co",
    "Link-To: mailto:someone@example.com",
    "Co-authored-by: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(bad, [], "身元でない trailer のアドレスで赤になっている（偽陽性）");
  assert.equal(checked, 1, "身元の trailer だけを拾っていない");
});

/**
 * **正しい形だけを書いた本物のメッセージが緑であること**（偽陽性の確認）。
 * **この 2 形は `origin/main` の履歴で 518 件 / 66 件の実数を持つ**（実測 2026-09-28）。
 */
test("正しい 2 形だけのメッセージは緑（偽陽性の確認）", () => {
  const body = [
    "test(etl): 何かを検査に載せる (#1065)",
    "",
    "本文に Co-authored-by: という語を書いても拾わない。",
    "",
    "Closes #1074",
    "",
    "Co-Authored-By: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
    "Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    "Claude-Session: https://claude.ai/code/session_x",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(bad, [], "正しい形のメッセージで赤になっている（偽陽性）");
  assert.equal(checked, 2, "正しい 2 形を走査していない");
});

/**
 * **`IDENTITY_TRAILERS` は形ではなく列挙なので、縮めても上の検査は緑のまま通りうる。**
 * **だから列挙自身に当てる。**
 *
 * **大文字小文字の揺れは履歴に実在する**（`Co-authored-by:` 1175 行 / `Co-Authored-By:` 51 行、
 * 実測 2026-09-28）。**先頭に空白が付く形も squash のメッセージに実在する。**
 */
test("身元を名指しする trailer の列挙が縮んでいない", () => {
  for (const line of [
    "Co-authored-by: N <x@y.z>",
    "Co-Authored-By: N <x@y.z>", // 履歴に 51 行実在する
    "CO-AUTHORED-BY: N <x@y.z>",
    "co-authored by: N <x@y.z>",
    "Co-authored-by : N <x@y.z>",
    "  Co-authored-by: N <x@y.z>", // 先頭に空白
    "\tCo-authored-by: N <x@y.z>",
    "Signed-off-by: N <x@y.z>",
    "Reviewed-by: N <x@y.z>",
    "Tested-by: N <x@y.z>",
    "Reported-by: N <x@y.z>",
    "Acked-by: N <x@y.z>",
    "Helped-by: N <x@y.z>",
    "Suggested-by: N <x@y.z>",
  ]) assert.ok(IDENTITY_TRAILERS.test(line), `身元を名指しする trailer が走査から漏れている: ${line}`);
  for (const other of [
    "Claude-Session: https://claude.ai/code/session_x",
    "Closes #1074",
    "fix: Co-authored-by という語を件名に書いただけ", // 行頭の token: でない
    "本文の途中に Co-authored-by: と書いた文",
    "Refs: https://example.com",
    "Signed: N <x@y.z>",
  ]) assert.ok(!IDENTITY_TRAILERS.test(other), `関係の無い行を拾っている: ${other}`);
});

/**
 * **`git` の trailer パーサ（`%(trailers:only=true)`）に頼ると、
 * squash merge の区切りより上の `Co-Authored-By:` がまるごと落ちる**（この PBI の実測）。
 *
 * **実測（`origin/main` = `068be5c2`、696 commits）**:
 * `%(trailers:only=true)` で `noreply@anthropic.com` は **640**。本文を直接読むと **1643**。
 * **1003 件、つまり 61% が見えていなかった。**
 *
 * **だから「本文を行ごとに走査する」ことを固定する。**
 * **`%(trailers)` に切り替える変異はここが落とす。**
 */
test("squash merge の区切りより上の trailer も拾う（%(trailers) に頼らない）", () => {
  const body = [
    "feat: 何か (#1065)",
    "",
    "Closes #1053",
    "",
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>", // 開発者が書いた分（区切りより上）
    "Claude-Session: https://claude.ai/code/session_x",
    "",
    "---------",
    "",
    "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>", // squash が合成した分
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.equal(checked, 2, "区切りより上の trailer を拾っていない（%(trailers) と同じ見落とし）");
  assert.deepEqual(bad, ["noreply@anthropic.com", "noreply@anthropic.com"]);
  // **git のパーサが 1 しか返すこと**を、その場で実測して固定する。
  // **前提が変わったら（git が区切りより上も数えるようになったら）ここが落ちて気づける。**
  const parsed = execFileSync("git", ["interpret-trailers", "--parse"], { input: body, encoding: "utf8" });
  const parsedCount = parsed.split("\n").filter((l) => /^co-authored-by:/i.test(l)).length;
  assert.equal(
    parsedCount,
    1,
    "git のパーサが 2 つ返すようになった（この検査の前提が変わった。本文走査はそれでも正しい）",
  );
});

/**
 * **「本文を読んだ」ことを確かめる番人が、実際に火を噴くことを固定する。**
 *
 * ── **なぜこの検査が要るか（自分で当てた変異）** ────────────────────────────────
 *
 * **`scannedBody` に「生オブジェクトと一致すること」の assert を足しただけでは、
 * X1 / X2 / X3 は落ちるようになったが、番人そのものは何も主張していなかった。**
 * **実測（どちらも 9/9 緑で生き残った）**:
 *
 * ```
 * X4  rawCommitMessage も %B を読むようにして比較を恒真にする   pass 9 / fail 0
 * X5  一致の assert を `if (false)` で無効化する                pass 9 / fail 0
 * ```
 *
 * **理由は「この枝の本文はどれも正しく読めているので、番人が一度も火を噴かない」こと**
 * ——**#1043 のレビューが `OK` について実測したのと同じ形である**（走査の側が構造的に緑なら、
 * そこに置いた assert は何も言っていない）。
 *
 * ── **どう固定するか** ────────────────────────────────────────────────
 *
 * **本物のコミット（`HEAD`）に、間違った読み方を 3 通り当てて、3 通りとも落ちることを言う。**
 * **落ちなければ番人が死んでいる。** **これは X5 を落とす**（assert が無効なら 3 通りとも落ちない）。
 * **X4 も落とす**——**`rawCommitMessage` が `%B` を読むようになったら、`%s` の読み方が
 * 「一致」してしまう**ので、`%s` の行が落ちなくなる。
 *
 * **`%(trailers:only=true)` を入れてあるのが要点である**——**この PBI の中核の発見
 * （区切りより上が見えない）を無効化する変異が、いちばん効いてほしい場所で通っていた。**
 */
test("本文を読んだことを確かめる番人が、間違った読み方 3 通りで実際に落ちる", () => {
  // **HEAD を使ってはいけない**（**最初にそう書いて、自分の検算に捕まった**）。
  // **`HEAD` のメッセージが 1 行だけ（件名のみ）だと `%s` が本文と一致してしまい、
  // `%s` の読み方が正しく落ちない**——**実測: `data: refresh …` のような 1 行のコミットを
  // HEAD に足したら、この検査が `%s（X2）` を素通りさせた**（`pass 9 / fail 2` の 2 本目）。
  // **検査が環境（HEAD の形）に依存していた。**
  //
  // **だから、形の分かっているコミットをその場で作る。**
  // **`git commit-tree` は ref を一切触らずにコミットオブジェクトを 1 つ書くだけ**
  // （実測: `for-each-ref --points-at` は 0 件。到達不能なので `gc` が回収する）。
  // **件名 / 本文 / squash の区切り / 区切りより上と下の trailer をすべて含む形にしてある**
  // ——**この PBI が見つけた形そのものを、番人に当てる。**
  const body = [
    "test: 番人に当てるための件名",
    "",
    "本文の段落。**`%s` はここから先を落とす。**",
    "",
    "Co-Authored-By: N <1+x@users.noreply.github.com>",
    "",
    "---------",
    "",
    "Co-authored-by: N <1+x@users.noreply.github.com>",
  ].join("\n");
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  const sample = execFileSync(
    "git",
    ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", tree],
    { input: body, encoding: "utf8" },
  ).trim();
  // **作ったものが狙った形であることを、まず確かめる**（母数。ここが崩れたら下は何も言っていない）。
  assert.equal(rawCommitMessage(sample), body, "その場で作ったコミットの本文が狙った形になっていない");
  assert.ok(body.split("\n").length >= 5, "1 行だけの本文で番人を当てようとしている（%s が一致してしまう）");

  // **番人が「一致」の基準に使う源は `cat-file`（生オブジェクト）でなければならない。**
  // **`%B` 同士を比べる形（X4）にすると、下の `%s` が落ちなくなる。**
  // **だから源が `--pretty` を通らないことを、まず語で固定する。**
  assert.match(
    rawCommitMessage.toString(),
    /cat-file/,
    "独立の源が `git cat-file` でなくなっている（`--pretty` 同士を比べると比較が恒真になる）",
  );
  // **正しい読み方（既定）は通ること**——恒偽の検査になっていないことを言う。
  const okRead = scannedBody(sample);
  assert.equal(okRead.lines, body.split("\n").length, "既定の読み方で本文を全部読めていない");

  // **間違った読み方は、3 通りとも落ちること。**
  const wrong: ReadonlyArray<readonly [string, (sha: string) => string]> = [
    ["空文字（X1: 走査に何も流さない）", () => ""],
    ["%s（X2: 件名だけ。ありがちな「簡略化」）", (sha) => trimTrailingNewlines(git("show", "-s", "--format=%s", sha))],
    [
      "%(trailers:only=true)（X3: git のパーサに頼る。区切りより上が落ちる）",
      (sha) => trimTrailingNewlines(git("show", "-s", "--format=%(trailers:only=true)", sha)),
    ],
  ];
  const survived: string[] = [];
  for (const [name, read] of wrong) {
    let threw = false;
    try {
      scannedBody(sample, read);
    } catch {
      threw = true;
    }
    if (!threw) survived.push(name);
  }
  assert.deepEqual(
    survived,
    [],
    "本文を全文読んでいない読み方が番人を素通りした（番人が何も主張していない）:\n  " + survived.join("\n  "),
  );
  // **母数**（#757）: 当てた読み方の数そのものを固定する（配列を空にする変異はここが落ちる）。
  assert.equal(wrong.length, 3, "間違った読み方の当て方が減っている");
  // **`%(trailers)` が本当に区切りより上を落とすことも、この場で実測して固定する**
  // （**X3 が「等価な変異」でないことの根拠**——落ちる理由が実在することを言う）。
  const trailersOnly = git("show", "-s", "--format=%(trailers:only=true)", sample);
  const above = body.split("\n").filter((l) => /^co-authored-by:/i.test(l)).length;
  const parsed = trailersOnly.split("\n").filter((l) => /^co-authored-by:/i.test(l)).length;
  assert.equal(above, 2, "本文の trailer 行が 2 つでない（この検査の前提が崩れている）");
  assert.equal(parsed, 1, "git のパーサが区切りより上も返すようになった（X3 が等価な変異になる）");
});

/**
 * **`allow` を省いて呼んだときに、許容集合が空であること**（既定が閉じている）。
 *
 * **初版はここに「逃げ道の環境変数がリポジトリのどこからも設定されていない」という検査を置いていた。**
 * **レビューで環境変数そのものを消した**（上の docblock。**環境変数だけで赤→緑にできるのに、
 * 通す必要が測って 0 だった**）。**残すのは「既定が広がっていない」ことだけである**——
 * **他の検査はどれも `new Set()` を明示的に渡すので、既定の中身を誰も見ていない。**
 * （`allow` の既定を `new Set(["noreply@anthropic.com"])` に変える変異はここだけが落とす。）
 */
test("許容集合の既定は空（第 2 引数を省いても誤帰属は赤になる）", () => {
  const { bad, checked } = misattributingTrailerEmails("x\n\nCo-authored-by: C <noreply@anthropic.com>");
  assert.equal(checked, 1, "既定の呼び方で走査していない（母数 0）");
  assert.deepEqual(bad, ["noreply@anthropic.com"], "既定の許容集合が広がっている");
});
