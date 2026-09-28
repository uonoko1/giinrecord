import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FAKE_PERSON, FAKE_BOT, REQUIRED_TRAILER_ADDRESS } from "./fake-addresses.ts";

/**
 * **コミットメッセージの `Co-authored-by:` trailer に書くメールアドレスは、
 * 数字 ID 付きの GitHub noreply でなければならない。**
 *
 * **`workflow-commit-identity.test.ts`（#1043）は `.github/workflows/*.yml` の
 * `user.email` しか見ていない。** **コミットメッセージの trailer は完全に無検査だった** ので、
 * `noreply@anthropic.com` がすり抜けた。
 * **これが #1043 が `github.com/claude` を捕まえられなかった理由である**（#1074）。
 *
 * ── 測った数（**基点を書く。基点が動くと数も動く**）─────────────────────────────
 *
 * **メッセージ本文の trailer 形の行（`Co-authored-by:`）に現れたアドレスの全数。**
 * **`git log <基点> --pretty=format:%B | grep -ciE '^[ \t]*co-authored-by[ \t]*:'` で数えた。**
 *
 * ```
 *                                                          068be5c2   2f136cd1
 *                                                          (696 cmt)  (711 cmt)
 * noreply@anthropic.com         github.com/claude に帰属      1643       1708
 *                               （**誤帰属ではない**。#1106 で
 *                                実測し直した。下の「2 つの道」）
 * 120390190+uonoko1@users.noreply.github.com      OK          518        529
 * 41898282+github-actions[bot]@users.noreply…     OK           66         69
 * （利用者本人の個人アドレス。下の「本人のアドレス」節）           2          2
 * etl@users.noreply.github.com  ★ github.com/etl              1          0
 * 219112946+seiji-kiroku-dev@users.noreply…       OK*          0          1
 *                               （*形は正しいが github.com/MLehnus
 *                                に帰属する。下の「守れないもの 1」）
 *                                                          ────────   ────────
 * 合計（= 身元 trailer 行の実数）                              2230       2309
 * ```
 *
 * **`etl@` が `1 → 0` に減っているのは直したからではない**——
 * **`068be5c2` は現在の `origin/main` の祖先ではない**（実測: `git merge-base --is-ancestor
 * 068be5c2 origin/main` が exit 1）。**その 1 件は別の系列に在り、いまの main には無い。**
 * **`etl@` を含むコミットは `--all` でなら見つかる**（`1e41501f` / `a1325eaf` ほか）。
 * **「基点が動くと数も動く」の実例である**（#1074 が同じ節で書いているとおり）。
 *
 * **レビューは 67 / 2231 を実測し、PR 本文の 66 / 2230 を「誤り」とした。**
 * **どちらも、その基点では正しい。** **自分で数え直して分かったのは、
 * 数え直しの間に `796b18d1`（`data: districts …(#1077)`）が main に入っていたことである**
 * ——**その 1 コミットが `41898282+github-actions[bot]@…` の trailer を 1 行足すので、
 * 66 → 67 / 2230 → 2231 に動いた**（実測: `git rev-list --count 068be5c2..origin/main` = 1、
 * その 1 件の `co-authored-by` 行は `github-actions[bot]` の 1 行）。
 * **合計はどの基点でも行の実数と一致する**（1643+518+66+2+1 = 2230 /
 * `2f136cd1` では 1708+529+69+2+0+1 = 2309）。
 * **だから「どちらが正しい数か」ではなく「どの基点の数か」を書く。**
 *
 * **`Co-authored-by:` 以外に、アドレスを運ぶ trailer 形の token は 1 つも無い**
 * （全履歴を token ごとに数えた）。
 *
 * ── **`git` の trailer パーサだけを見てはいけない**（この PBI で測って分かったこと）─────
 *
 * **`git log --pretty='%(trailers:only=true)'` は `noreply@anthropic.com` を 650 しか返す。
 * 本文を直接読むと 1708 ある**（基点 `2f136cd1` / 711 commits。実測 2026-09-28）**。**
 * 差は **squash merge のメッセージの形** から来る:
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

/**
 * **`users.noreply.github.com` の「ローカル部がユーザー名になる」形だけを問題にする**（#1106）。
 *
 * ── **#1075 はここを 1 ドメイン分ではなく *全ドメイン* に広げていた**（#1106 で実測して直した）──
 *
 * **#1075 は「数字 ID 付きの GitHub noreply *でないもの* は全部誤帰属」と書いた。**
 * **その結果、規約が全コミットに要求している `noreply@anthropic.com` が誤帰属と判定され、
 * 開いている PR が全部赤になった**（#1092 / #1084 の `check`。#1106 の発端）。
 * **`main` が緑だったのは直っていたからではなく、範囲が `merge-base..HEAD` なので
 * `main` の上では空になるからである。**
 *
 * ── **GitHub が trailer のアドレスを人に解決する道は 2 つある**（#1106 で実測）───────────
 *
 * **GraphQL の `Commit.authors` は、GitHub が実際にそのコミットを誰に帰属させたかを返す。**
 * **1 つのコミット（`1e41501f`）が 2 形を同時に持っていたので、同じ条件で並べて測れた:**
 *
 * ```
 * trailer のアドレス                            GitHub が解決した user
 * noreply@anthropic.com                        login=claude  databaseId=81847
 * etl@users.noreply.github.com                 login=etl     databaseId=1859882
 * 120390190+uonoko1@users.noreply.github.com   login=uonoko1 databaseId=120390190
 * ```
 *
 * **(A) 登録済みメールアドレス**: そのアドレスを verified email として持つアカウントに解決する。
 * **`noreply@anthropic.com` → `github.com/claude` はこの道である。**
 * **ローカル部 `noreply` はユーザー名として読まれていない**——**実測: `github.com/noreply` は
 * `id=1239515` で実在するのに、Contributors に 1 度も出ない**
 * （`stats/contributors` = `github-actions[bot]` 59 / `claude` 650 / `uonoko1` 656。
 * `noreply` は出ない。`main` の trailer 1708 件はすべて `claude` に行っている）。
 * **利用者本人の個人アドレス（`@gmail.com`）→ `uonoko1` も同じ道である**（実測 `f15aad8d`）。
 * **アドレスの逐語は書かない**（#1043。OSS なので grep でもスクレイパでも永久に拾われる）。
 *
 * **(B) `users.noreply.github.com` のローカル部**: このドメインでだけ、GitHub は
 * **ローカル部をユーザー名（または `<id>+<name>` の `<id>`）として読む。**
 * **実測で 2 形とも無関係の実在の個人に解決した:**
 * ```
 * etl@users.noreply.github.com  → github.com/etl  id=1859882  （実測 1e41501f / a1325eaf）
 * dev@users.noreply.github.com  → github.com/dev  id=12158001 （実測 42f9c225）
 * ```
 *
 * **これは観測だけではなく、GitHub の一次資料に明記されている**
 * （`https://docs.github.com/en/account-and-profile/reference/email-addresses-reference`
 * の "Your noreply email address"。2026-09-28 取得）:
 *
 * > If you created your account after July 18, 2017, your noreply email address is
 * > **an ID number and your username in the form of `ID+USERNAME@users.noreply.github.com`**.
 * > If you created your account prior to July 18, 2017, ... your noreply email address is
 * > **`USERNAME@users.noreply.github.com`**.
 * >
 * > If you use your noreply email address for GitHub to make commits and then **change your
 * > username, those commits will not be associated with your account. This does not apply if
 * > you're using the ID-based noreply address from GitHub.**
 *
 * **後半が「なぜ数字 ID 付きだけが安全か」の一次資料である**——
 * **裸の `USERNAME@` はユーザー名に束縛されるので、その名前を持つ別のアカウントに移りうる。**
 * **数字 ID の形は ID に束縛されるので移らない。**
 *
 * **実測もこれと整合する**——**誤帰属した 2 つは、どちらも 2017-07-18 より前に作られた
 * アカウントである**（`etl` は 2012-06-17 / `dev` は 2015-04-28。実測 `gh api users/<name>`）。
 * **だから裸の `<name>@users.noreply.github.com` がその人の noreply アドレスとして成立する。**
 *
 * ── **この一次資料が言っていないこと（断定しない）** ───────────────────────────
 *
 * **一次資料は「noreply アドレスの *形*」を定めているだけで、
 * 「他のドメインでローカル部が照合されない」とは明示していない。**
 * **そこは実測で補っている**——**そして実測は「2 例で出なかった」であって、
 * 「絶対に出ない」ではない:**
 *
 * ```
 * trailer のアドレス          同名の GitHub ユーザー       実在           実際の帰属先
 * noreply@anthropic.com      github.com/noreply        id=1239515      claude   (650)
 * （利用者本人の個人 gmail）    github.com/sakai          id=15643        uonoko1  (656)
 * etl@users.noreply.github…  github.com/etl            id=1859882      etl      ★ 誤帰属
 * ```
 * **`origin/main`（`2f136cd1`）の身元 trailer に出るドメインは 3 つだけである**
 * （実測: `anthropic.com` 1708 / `users.noreply.github.com` 599 / `gmail.com` 2）。
 * **`noreply` も `sakai` も実在するのに Contributors に出ない**
 * （`github-actions[bot]` 59 / `claude` 650 / `uonoko1` 656 のみ）。
 * **ドメインを問わずローカル部で照合しているなら、この 2 つも出ているはずである。**
 * **出ていない、というのが測れた全部である。**
 *
 * ── **この検査が受け持つのは (B) だけである** ───────────────────────────────────
 *
 * **(A) は「そのアドレスを持っている人に帰属する」ので、この検査では誤りだと言えない**
 * ——**アドレスの持ち主が誰かは、リポジトリの中からは判定できない。**
 * **`noreply@anthropic.com` は規約が要求する trailer で、実測で `claude` に帰属している。**
 * **これを赤にするのは偽陽性である**（下に偽陽性の検査を置いた）。
 *
 * **(B) は形だけで判定できる**——**`users.noreply.github.com` 宛てなのに
 * `<数字>+<名前>` になっていなければ、ローカル部の綴りがそのままユーザー名として読まれ、
 * その名前の他人に帰属する。** **だからここだけを赤にする。**
 *
 * ── **守れないもの（明記する）** ──────────────────────────────────────────────
 *
 * **1. 数字 ID の *中身* は検査できない**（実例つき。2026-09-28 に実際に起きた）:
 *
 * ```
 * Co-authored-by: seiji-kiroku-dev <219112946+seiji-kiroku-dev@users.noreply.github.com>
 *
 * misattributesViaGithubNoreply(…) → false  ★ この検査は通す（形は正しい）
 * gh api users/seiji-kiroku-dev → 404  （その名前の GitHub ユーザーは存在しない）
 * gh api user/219112946        → login=MLehnus / id=219112946 / type=User
 *                                       / created_at=2025-07-03
 * ```
 * **数字 ID が指しているのは `github.com/MLehnus` という無関係の実在の個人で、
 * その人が Contributors に出た。** **形が正しいのでこの検査は止められない。**
 * **逐語の allowlist にすれば止まるが、新しい貢献者を足すたびに検査を直すことになる。**
 * **どちらを採るかは別 PBI で PO が判断する。**
 *
 * **2. `users.noreply.github.com` 以外のドメインは、この検査では一切見ない。**
 * **(A) の道で「そのアドレスを持つ他人」に帰属する可能性は残る**——
 * **だがそれは「アドレスを間違えて書いた」場合であって、形からは判定できない。**
 * **`workflow-commit-identity.test.ts`（#1043）が workflow の `user.email` の綴りを、
 * 下の author / committer の検査が実際に刻まれた identity を受け持つ。**
 */
/** `users.noreply.github.com` 宛てかどうか（**ローカル部がユーザー名として読まれるドメイン**）。 */
const GITHUB_NOREPLY = /@users\.noreply\.github\.com$/;
/** そのドメインで、**ローカル部がユーザー名として読まれない**唯一の形（`<数字 ID>+<名前>`）。 */
const NUMERIC_ID = /^\d+\+[^@]+@users\.noreply\.github\.com$/;

/**
 * **そのアドレスが、GitHub の `users.noreply.github.com` 経由で他人に誤帰属するか。**
 *
 * **真になるのは「`users.noreply.github.com` 宛てなのに `<数字>+<名前>` でない」場合だけ。**
 * **他のドメインは常に偽である**（上の docblock (A)。この経路では誤帰属しない）。
 */
export const misattributesViaGithubNoreply = (email: string): boolean =>
  GITHUB_NOREPLY.test(email) && !NUMERIC_ID.test(email);

/**
 * **author / committer に要求する形**（trailer とは別の規則である。#1106 で分けた）。
 *
 * **trailer は「誰と一緒に書いたか」を名指しするので、他人の verified email を書くこと自体は
 * ありうる**（`noreply@anthropic.com` → `github.com/claude`）。
 * **だが author / committer は「この作業ツリーの `git config user.email`」であり、
 * このリポジトリはそこに数字 ID 付きの GitHub noreply を使うと決めている**
 * （`.git/config` の実測値は `120390190+uonoko1@users.noreply.github.com`）。
 *
 * **だからここは形を要求したままにする。** **実測で偽陽性が出ないことを確かめてある**:
 * **`origin` の全ブランチ 12 本の枝の範囲で、マージでないコミット 43 件（重複除去）のうち
 * この形を外れる author/committer は 1 件だけで、それは #1074 (B) の実害そのものだった**
 * （`cdc55734` author=committer=`etl@users.noreply.github.com`）。
 *
 * **trailer 側の `misattributesViaGithubNoreply` と混ぜない**——
 * **混ぜると「author に `noreply@anthropic.com` を書いても緑」になり、
 * squash merge がそれを Co-authored-by に合成する経路が開く**（下の検査が固定する）。
 */
const AUTHOR_OK = /^\d+\+[^@]+@users\.noreply\.github\.com$/;

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
      // **`users.noreply.github.com` 経由の誤帰属だけを赤にする**（#1106。上の docblock (B)）。
      // **他のドメインは、この経路では誤帰属しない**ので見ない。
      if (!misattributesViaGithubNoreply(email)) continue;
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

/**
 * **`git commit-tree` を、identity を必ず渡して呼ぶ**（ref は一切触らない）。
 *
 * ── **なぜ 1 か所にまとめたか（3 度目のレビューの必須 1。CI が実際に赤くなった）** ──────────
 *
 * **CI の runner には git の identity が無い。** **`user.name` / `user.email` が未設定だと
 * `commit-tree` は `fatal: empty ident name` で throw する。**
 *
 * **実機で赤くなった**（run 36383021832、`check: completed/failure`）:
 * ```
 * ✖ 「範囲が空でよい」の裏づけが、4 つの分岐で実際に火を噴く
 *   Error: Command failed: git … commit-tree 9ee92ffb…
 *   Author identity unknown
 *   fatal: empty ident name (for <runner@…>) not allowed
 *   ℹ tests 13 / pass 12 / fail 1
 * ```
 *
 * **原因は「同じことを 3 か所で別々に書いていた」ことである**（直す前の実測）:
 * ```
 * 検査 3  の make    env: { GIT_AUTHOR_* , GIT_COMMITTER_* }   → 通る
 * 検査 5  の mk      何も渡していない                          → ★ throw（CI が赤）
 * 検査 11 の sample  -c user.name=… -c user.email=…            → 通る
 * ```
 * **2 つが別々の書き方で正しく、3 つ目だけが抜けていた。**
 * **開発者の手元には identity が在るので、手元では 3 つとも緑になる。**
 *
 * **これは 2 度目のレビューの `HEAD~1` と同じクラスである**——
 * **「開発者の手元では通るが、CI の素の環境では通らない」形を、同じ関数のすぐ隣でもう一度やった。**
 * **同じクラスを 2 度踏んだので、次に足す人が忘れられない形にする**:
 * **`commit-tree` を呼ぶ道をこの 1 本だけにして、identity を引数ではなく既定で入れる。**
 * **下の検査が「呼び口が 1 本であること」を逐語で固定する。**
 */
const commitTree = (
  opts: { tree: string; parents?: string[]; message: string; author?: string; committer?: string },
): string => {
  const who = "120390190+uonoko1@users.noreply.github.com";
  return execFileSync(
    "git",
    ["-C", root, "commit-tree", opts.tree, ...(opts.parents ?? []).flatMap((x) => ["-p", x])],
    {
      input: opts.message,
      encoding: "utf8",
      // **identity は必ず渡す。** **既定を置いてあるので、呼ぶ側が忘れても CI で throw しない。**
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: opts.author ?? who,
        GIT_COMMITTER_NAME: "A",
        GIT_COMMITTER_EMAIL: opts.committer ?? who,
      },
    },
  ).trim();
};

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
 * **数はすべて「測った時点の本数」で書く**（`0989337a` と同じ。検査は 9 本 → 12 本に増えた）。
 * ```
 *                                                                          検査 9 本のとき  直した後（12 本）
 * X1  走査に渡す本文を "" にする                                            pass 9 / fail 0  pass 10 / fail 2
 * X2  --format=%B → --format=%s（件名だけ。ありがちな「簡略化」）             pass 9 / fail 0  pass 10 / fail 2
 * X3  --format=%B → --format=%(trailers:only=true)                        pass 9 / fail 0  pass 10 / fail 2
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
 *                                                                検査 10 本のとき  直した後（12 本）
 * X4  rawCommitMessage も %B を読む（比較を恒真にする）            pass 10 / fail 0  pass 11 / fail 1
 * X5  一致の assert を `if (false)` で無効化                       pass 10 / fail 0  pass 11 / fail 1
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
 * **なぜ全履歴を見ないか**: **いま在る履歴に誤帰属が既に刻まれているから**である。
 *
 * **#1074 はここを「1644 件」と書いていたが、その内訳の 1643 件は
 * `noreply@anthropic.com` で、実測すると誤帰属ではなかった**（#1106。`github.com/claude`
 * に正しく帰属している）。**実際に誤帰属しているのは、現在の `origin/main`（`2f136cd1`）では
 * `219112946+seiji-kiroku-dev@users.noreply.github.com` の 1 件だけである**
 * （→ `github.com/MLehnus`。**形が正しいのでこの検査は止められない**。下の「守れないもの」）。
 * **`etl@` は現在の main には 0 件**（`068be5c2` は現 main の祖先ではない。上の表）。
 *
 * **それでも全履歴には当てない**——**この検査は「枝が *足す* もの」を止めるためのもので、
 * 既に刻まれたものを数え直すのは別の仕事である。**
 * **既存履歴を直すには protected branch の history rewrite が必要で 711 commits に触る**ので、
 * **#1074 は「利用者に確認してから」として範囲外にしている。**
 *
 * **この選択で守れないもの**（明記する）:
 * - **数字 ID の *中身* は検査できない。** **逐語の allowlist に無い数字 ID は通る**
 *   ——**2026-09-28 に実際に誤帰属が 1 件入った**（`219112946+seiji-kiroku-dev@…` →
 *   `github.com/MLehnus`。`OK` の docblock に実測）。**形は正しいので止められない。**
 * - **既に main に在る誤帰属は、この検査では永久に見えない**（`2f136cd1` で 1 件。上の実測）。
 *   直すのは別の PBI。
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

/**
 * **走査した範囲が空だったとき、その「空」が本当に正しいかを別の源で裏づける。**
 *
 * ── **なぜこれが要るか（2 度目のレビューの実測。必須 2。R9）** ──────────────────────────
 *
 * **初版の母数 assert は `if (mergeBase !== head)` で囲われていた。**
 * **「`merge-base == HEAD` なら枝は base に何も足していないので 0 が正しい」という理屈だが、
 * その前提そのものを 1 行の変異で作れる:**
 *
 * ```
 * R9   mergeBase = git("merge-base", "HEAD", "HEAD").trim();   ← 1 行だけ書き換える
 *   → [#1074] 枝が足したコミット 0 件 / 本文 0 行 / trailer のアドレス 0 件を走査
 *   → [#1074] author/committer: マージでないコミット 0 件 / アドレス 0 件を走査
 *   → tests 12 / pass 12 / fail 0 / skipped 0     ★ 12/12 緑（走査が全消え）
 * ```
 *
 * **「ありがちな壊し方」である**（`merge-base` の引数を取り違える）。
 * **同じ「走査を空にする」変異でも `rev-list` の側（R10: 範囲を `HEAD..HEAD`）は
 * `pass 10 / fail 2` で落ちる**——**落ちるかどうかが「どこを壊したか」で変わるのは、
 * 母数が構造で守られていないということである。**
 * **R9 は skip すらしない**——**`0 件` とログに出して、`skipped 0` で緑を返す。**
 *
 * **そして同じ根から、実際に 2 つの害が出ていた:**
 *
 * ```
 * (a) push: branches: [main] で CI が走ると merge-base == HEAD になり、0 件走査で緑
 *     （実機: fetch step は `if: github.event_name == 'pull_request'` なので push では走らない）
 * (b) fork PR は refs/remotes/origin/main を枝の側から動かせる
 *     （レビューの実測: 本物の main なら pass 10 / fail 2 → update-ref で pass 12 / fail 0）
 * ```
 *
 * ── **どう解くか: 「空でよい」と言うなら、別の源で裏づける** ──────────────────────────
 *
 * **`merge-base == HEAD` の綴りを信じない**（`originMainReallyAbsent` / `mergeBaseObtainable` と
 * 同じ形）。**範囲が空であることの意味は「HEAD が origin/main の祖先か同一」であり、
 * それは `git merge-base --is-ancestor` が `merge-base` とは別に答える:**
 *
 * ```
 *                               mergeBase == head   is-ancestor HEAD origin/main
 * ふつうの PR の枝                   違う                 exit 1
 * main への push（正しく 0 件）       同じ                 exit 0   ← ここだけ空を許す
 * R9（枝の上で 1 行変異）             同じ（捏造）          exit 1   ★ 裏づけが取れない → 落とす
 * ```
 *
 * **実測（2026-09-28、この worktree と depth=1 clone）:**
 * ```
 * depth=1 clone（main の先端 = origin/main）  is-ancestor → exit 0
 * test/1074-… の枝                            is-ancestor → exit 1
 * ```
 *
 * **これで R9 と (a) が分かれる**——**(a) は「本当に main を検査している」ので空が正しく、
 * R9 は枝の上なので裏づけが取れずに落ちる。**
 *
 * ── **(b)（fork の `update-ref`）だけは、これでは閉じない。閉じないと書く** ──────────────
 *
 * **`update-ref refs/remotes/origin/main HEAD` をすると HEAD は本当に祖先になる**ので、
 * **`is-ancestor` は exit 0 を返す**（実測。使い捨て clone で再現した）。
 * **ローカルの ref だけを見るどの git コマンドも、この 2 つを区別できない**
 * ——**枝の側が書けるものを、枝の側が書けるもので裏づけても意味がないからである。**
 *
 * **区別できる源は 1 つだけある**: **`git ls-remote origin refs/heads/main`**
 * ——**これは remote に問い合わせるので、ローカルの ref をいくら書き換えても変わらない**
 * （実測: `update-ref` 後も `ls-remote` は本物の main の sha を返した）。
 * **だから「空でよい」と言うときだけ、`ls-remote` にも同じことを言わせる。**
 *
 * **`ls-remote` は network を叩くので落ちうる。** **落ちたときに黙って通すのは、
 * まさに `|| true` で踏んだ形なので、そうしない**——**「裏づけが取れなかった」と言って落とす。**
 * **範囲が空でないときは `ls-remote` を一度も叩かない**ので、
 * **ふつうの PR の速度と安定性は変わらない**（実測: 空でない枝では呼ばれない）。
 *
 * ── **この番人自身が何も主張しないのを防ぐ**（X4 / X5 と同じ罠。自分で変異を当てて見つけた）──
 *
 * **番人を足しただけでは足りなかった。** **この枝は範囲が空にならないので、
 * `emptyRangeIsTrustworthy` は一度も呼ばれない**——**だから中身を潰しても緑で通る:**
 *
 * ```
 * G1  関数の先頭に `return { ok: true, why: "G1" };` を足す（番人を恒真にする）
 *   → tests 12 / pass 12 / fail 0     ★ 12/12 緑（実測）
 * ```
 *
 * **走査の側が構造的に緑なら、そこに置いた assert は何も主張しない**
 * （`scannedBody` の `read` 引数と同じ理由で、同じ解き方をする）。
 * **だから 2 つの源を差し替えられる形にし**（`isAncestor` / `remoteMain` 引数）、
 * **下の検査で「4 つの分岐が実際にどう答えるか」を本物のコミットに当てて固定する。**
 */
/** **`a` は `b` の祖先か同一か**（`merge-base --is-ancestor` の終了コード）。**既定の源 1。** */
const isAncestorByGit = (a: string, b: string): boolean => {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** **origin が実際に持っている `main` の sha**（`ls-remote`。**ローカルの ref では書き換えられない**）。**既定の源 2。** */
const remoteMainByLsRemote = (): string =>
  git("ls-remote", "origin", "refs/heads/main").split("\t")[0]?.trim() ?? "";

const emptyRangeIsTrustworthy = (
  isAncestor: (a: string, b: string) => boolean = isAncestorByGit,
  remoteMain: () => string = remoteMainByLsRemote,
): { ok: boolean; why: string } => {
  // 1. **ローカルの源**: HEAD は origin/main の祖先か同一か。
  //    **R9 はここで落ちる**（枝の上では祖先ではない）。
  if (!isAncestor("HEAD", "refs/remotes/origin/main")) {
    return {
      ok: false,
      why:
        "範囲が空なのに、HEAD は refs/remotes/origin/main の祖先ではない" +
        "（merge-base が HEAD と等しいという主張が別の源で裏づけられない。" +
        "merge-base の取り方が壊れていないか）",
    };
  }
  // 2. **remote の源**: ローカルの ref は枝の側から書ける（fork PR の `update-ref`）。
  //    **`ls-remote` だけは remote に聞くので書き換えられない。**
  //    **取れなかったら黙って通さない**（`|| true` で踏んだ形にしない）。
  let remote: string;
  try {
    remote = remoteMain();
  } catch {
    return {
      ok: false,
      why:
        "範囲が空だが、origin の main を ls-remote で確かめられなかった" +
        "（空である裏づけが取れないので、緑にはしない）",
    };
  }
  if (remote === "") {
    return { ok: false, why: "範囲が空だが、ls-remote が origin の main を返さなかった" };
  }
  if (!isAncestor("HEAD", remote)) {
    return {
      ok: false,
      why:
        `範囲が空で、ローカルの refs/remotes/origin/main では HEAD が祖先に見えるが、` +
        `origin が実際に持っている main（${remote.slice(0, 8)}）の祖先ではない` +
        `（refs/remotes/origin/main が書き換えられている。fork PR の経路）`,
    };
  }
  return { ok: true, why: `HEAD は origin の main（${remote.slice(0, 8)}）の祖先か同一である` };
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
    if (!AUTHOR_OK.test(email)) bad.push(`${sha.slice(0, 8)}: ${kind}=${email}`);
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
  // **塞ぎ方**: **範囲が空なら、空であることを別の源で裏づける。**
  //
  // **初版は `if (mergeBase !== head)` で母数 assert を囲っていた**——
  // **`mergeBase` を `head` と等しくする 1 行の変異（R9）が、その囲いをそのまま素通りした**
  // （実測: `tests 12 / pass 12 / fail 0`。走査は 0 件でログにも `0 件` と出る）。
  // **「空でよい」の根拠を、空にした本人（`mergeBase`）に言わせていたのが誤りである。**
  // **`emptyRangeIsTrustworthy` が別の 2 源（`--is-ancestor` と `ls-remote`）で裏づける**
  // （関数の docblock に実測と、閉じないもの）。
  if (shas.length === 0) {
    const t = emptyRangeIsTrustworthy();
    assert.ok(
      t.ok,
      `走査した範囲が空である（走査が空回りしている）: ${t.why}` +
        ` / merge-base=${mergeBase?.slice(0, 8)} HEAD=${head?.slice(0, 8)}`,
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
  //
  // **空のときは別の源で裏づける**（必須 2。R9 はここでも落ちる。
  // 上の trailer 側と同じ理由なので、同じ番人を使う）。
  if (shas.length === 0) {
    const t = emptyRangeIsTrustworthy();
    assert.ok(
      t.ok,
      `走査した範囲が空である（走査が空回りしている）: ${t.why}` +
        ` / merge-base=${mergeBase?.slice(0, 8)} HEAD=${head?.slice(0, 8)}`,
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
 *
 * ── **`HEAD~1` を使ってはいけない（`push: branches: [main]` で CI が毎回赤くなっていた）** ──
 *
 * **初版は 4 形目（2 親）の 2 番目の親を `git rev-parse HEAD~1` で取っていた。**
 * **`ci.yml` の `check` ジョブは `on: pull_request` と `on: push: branches: [main]` の
 * 両方で走る**（`if:` は付いていない）。**そして `actions/checkout@v4` の既定は `fetch-depth: 1` で、
 * 新しい fetch step は `if: github.event_name == 'pull_request'` なので push では走らない。**
 * **depth=1 の checkout に `HEAD~1` は存在しない**ので、**この検査は trailer の内容とは無関係に
 * main への push ごとに throw していた。**
 *
 * **実機ログで push 時の checkout の形が確定している**
 * （レビューが `gh run view 36349678166 --log` で実測。`fetch-depth: 1` / `fetch --depth=1`）。
 * **レビューが depth=1 clone で実測した数: `pass 11 / fail 1`。**
 * **こちらでも同じ条件（`git clone --depth=1`）で再現した**（下の「測った数」）。
 *
 * **偽陽性で赤が常態になる**——**この検査自身の docblock が「赤が常態になった検査は誰も見なくなる」
 * と書いている形そのものである。**
 *
 * **直し**: **`HEAD~1` に依存しない。** **2 番目の親も `commit-tree` で作る**
 * ——`make(GOOD, GOOD, [p1])` は `HEAD` を親に持つ単親コミットを 1 つ書くだけなので、
 * **`HEAD` 1 つしか無い depth=1 の checkout でも作れる。**
 * **これで 12 本すべてが depth=1 でも走る**（実測: `pass 12 / fail 0`）。
 * **`fetch` の `if:` を外す道もあったが、それでも push では `merge-base == HEAD` になるので
 * 1 の (a)（0 件走査で緑）は残る**——**そちらは下の `emptyRangeIsTrustworthy` が受け持つ。**
 */
test("author / committer の検査が、誤帰属する 3 形で実際に落ちる（マージは対象外）", () => {
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  const p1 = git("rev-parse", "HEAD").trim();
  /** ref を触らずにコミットオブジェクトを 1 つ書く（`commitTree`。identity は既定で入る）。 */
  const make = (author: string, committer: string, parents: string[]): string =>
    commitTree({ tree, parents, message: "test: 検査に当てるためのコミット\n", author, committer });
  const ETL = "etl@users.noreply.github.com"; // #1074 (B) の実害そのもの
  const GOOD = "120390190+uonoko1@users.noreply.github.com";
  const OTHER = FAKE_PERSON; // 架空。綴りは fake-addresses.ts が持つ（#1043 / #1111）
  // **2 親コミットの 2 番目の親も `commit-tree` で作る。**
  // **`HEAD~1` を使ってはいけない**——**depth=1 の checkout には存在せず、
  // main への push で毎回 throw していた**（上の docblock の実測）。
  // **`HEAD` を親に持つ単親コミットなら、`HEAD` 1 つしか無い checkout でも書ける。**
  const p2 = make(GOOD, GOOD, [p1]);

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

/**
 * **`commit-tree` を呼ぶ道が 1 本だけであることを、このファイル自身のソースで固定する**
 * （3 度目のレビューの必須 1。**CI が実際に赤くなったので、クラスごと閉じる**）。
 *
 * **identity を渡し忘れた `commit-tree` は、開発者の手元では通り、CI の runner でだけ throw する。**
 * **だから「手元で緑」では守れない。** **実機で 1 度、`pass 12 / fail 1` になった。**
 *
 * **同じ誤りを 2 度踏んでいる**（`HEAD~1` と `empty ident`。どちらも「手元では通る」形）。
 * **3 度目を防ぐには、呼ぶ側の注意ではなく、呼び口の本数を固定する必要がある。**
 *
 * **`git` の argv に `commit-tree` を置く箇所は、`commitTree` の中の 1 つだけ。**
 * **新しく足したくなったら、この検査が落ちて `commitTree` に気づく。**
 *
 * **綴りは実行時に組み立てる**（`"commit" + "-tree"`）。
 * **この docblock や assert のメッセージにも同じ語が出るので、
 * ソースに逐語で書くと検査が自分の文章を数えてしまう**
 * （**実際にそうなった。最初 6 件、regex を狭めても 5 件を数えた**）。
 */
test("`commit-tree` を呼ぶ道は 1 本だけ（identity の渡し忘れを構造で防ぐ）", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // **argv の位置だけを数える**: `"<綴り>",` の直後に次の引数が続く形。
  // **綴りを組み立てるので、この行自身は当たらない。**
  const argv = new RegExp(`"${"commit"}-tree",\\s*\\S`, "g");
  const callSites = src.match(argv) ?? [];
  assert.equal(
    callSites.length,
    1,
    `git の argv に該当の綴りを置く箇所が ${callSites.length} 本ある。` +
      `**identity を渡し忘れると CI の runner でだけ throw する**（実機で 1 度赤くなった）。` +
      `commitTree() を通すこと`,
  );
  // **その 1 本が `commitTree` の中に在ること**（別の関数に移されていないこと）。
  const fn = src.slice(src.indexOf(`const ${"commitTree"} =`), src.indexOf(`const ${"addedCommits"} =`));
  assert.match(
    fn,
    new RegExp(`"${"commit"}-tree",\\s*\\S`),
    "呼び口が commitTree の外に移っている（identity の既定が効かなくなる）",
  );
  // **その 1 本が identity を渡していること**を語で固定する。
  for (const v of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    assert.ok(fn.includes(v), `commitTree が ${v} を渡していない（CI の runner で throw する）`);
  }
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
 * **「範囲が空でよい」を裏づける番人が、実際に火を噴くことを固定する**（必須 2 の後半）。
 *
 * **この枝は範囲が空にならないので `emptyRangeIsTrustworthy` は一度も呼ばれない。**
 * **だから番人を恒真に潰す変異（G1: 先頭に `return { ok: true }` を足す）が
 * `tests 12 / pass 12 / fail 0` で生き残った**（実測。上の docblock）。
 *
 * **2 つの源を引数で差し替えて、4 つの分岐が実際にどう答えるかを直接当てる。**
 * **これは「実データに当てない単体の検査」だが、それが要る理由は
 * 走査の側が構造的に緑だからである**（X4 / X5 を `read` 引数で解いたのと同じ形）。
 *
 * **当てる 4 形**（`why` の語も見る——分岐を取り違える変異を落とすため）:
 * ```
 * 1. 両方の源が「祖先である」と言う                → ok      （main への push。0 件が正しい）
 * 2. ローカルの源が「祖先でない」と言う             → 落とす  （R9。枝の上で merge-base を捏造）
 * 3. ローカルは祖先だが、remote の main の祖先でない → 落とす  （fork の update-ref）
 * 4. ls-remote が throw / 空を返す                 → 落とす  （裏づけが取れないので緑にしない）
 * ```
 */
test("「範囲が空でよい」の裏づけが、4 つの分岐で実際に火を噴く", () => {
  const REAL = "53e3c8cc"; // 綴りは何でもよい（差し替えた源しか見ないので）
  const FORGED = "a91f6b62";
  // 1. 両方の源が祖先だと言う → 空でよい（main への push）
  const push = emptyRangeIsTrustworthy(() => true, () => REAL);
  assert.equal(push.ok, true, "main への push（両方の源が祖先と言う）で落ちている（偽陽性）");
  assert.match(push.why, /祖先か同一/, "通した理由が「祖先か同一」になっていない");
  // 2. ローカルの源が「祖先でない」と言う → 落とす（R9 がここで落ちる）
  const r9 = emptyRangeIsTrustworthy((_a, b) => b !== "refs/remotes/origin/main", () => REAL);
  assert.equal(r9.ok, false, "HEAD が origin/main の祖先でないのに、空の範囲を通している（R9）");
  assert.match(r9.why, /refs\/remotes\/origin\/main の祖先ではない/, "落とした理由がローカルの源になっていない");
  // 3. ローカルは祖先と言うが、remote の main の祖先ではない → 落とす（fork の update-ref）
  const fork = emptyRangeIsTrustworthy((_a, b) => b === "refs/remotes/origin/main", () => REAL);
  assert.equal(fork.ok, false, "refs/remotes/origin/main が書き換えられているのに通している（fork の経路）");
  assert.match(fork.why, /書き換えられている/, "落とした理由が remote の源になっていない");
  // 4a. `ls-remote` が throw → 落とす（黙って通さない。`|| true` の形にしない）
  const threw = emptyRangeIsTrustworthy(() => true, () => {
    throw new Error("network");
  });
  assert.equal(threw.ok, false, "ls-remote が落ちたのに空の範囲を通している（裏づけが取れていない）");
  assert.match(threw.why, /確かめられなかった/, "落とした理由が ls-remote の失敗になっていない");
  // 4b. `ls-remote` が空を返す → 落とす
  const empty = emptyRangeIsTrustworthy(() => true, () => "");
  assert.equal(empty.ok, false, "ls-remote が何も返さないのに空の範囲を通している");
  assert.match(empty.why, /返さなかった/, "落とした理由が「返さなかった」になっていない");
  // **既定の源が本当に git を叩いていることを固定する。**
  // **「既定が何もしない（常に true / 常に空でない綴りを返す）」に潰す変異を落とす。**
  //
  // **答えの真偽では固定できない**——**この枝では既定は `false`、main への push では `true` で、
  // どちらを書いても片方で偽陽性になる**（それがこの PR が直している 1 の (b) そのものである）。
  // **だから「既定が返す答え」ではなく「既定が本物の git に聞いていること」を当てる:**
  // **到達不能なコミットを 2 つ作り、既定の `isAncestor` がその関係を正しく答えるか**を見る。
  // **`commit-tree` は ref を触らないので、リポジトリの状態を変えない。**
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  // **`commitTree` を通す**——**identity を渡し忘れると CI の runner で throw する。**
  // **ここが渡し忘れていて、実機 run 36383021832 が `pass 12 / fail 1` で赤くなった**
  // （`fatal: empty ident name`。`commitTree` の docblock に経緯）。
  const mk = (parents: string[]): string =>
    commitTree({ tree, parents, message: "test: 既定の源が git に聞いていることを見る\n" });
  const parent = mk([]);
  const child = mk([parent]);
  assert.notEqual(parent, child, "commit-tree が同じコミットを 2 回返している");
  // **既定の源 1 を、答えの分かっている 2 形に当てる。**
  // **`parent` は `child` の祖先で、`child` は `parent` の祖先ではない。**
  // **恒真（常に true）に潰す変異は 2 つ目で落ち、恒偽は 1 つ目で落ちる。**
  assert.equal(isAncestorByGit(parent, child), true, "親が子の祖先だと答えられていない（既定の源 1）");
  assert.equal(isAncestorByGit(child, parent), false, "子が親の祖先だと答えている（既定の源 1 が恒真）");
  // **既定の源 2 が、`ls-remote` の書式（`<sha>\t<ref>`）から sha を取れていること。**
  // **`origin` の main の sha は 40 桁の hex である**（綴りそのものは基点で動くので当てない）。
  assert.match(
    remoteMainByLsRemote(),
    /^[0-9a-f]{40}$/,
    "既定の源 2 が origin の main の sha を返していない（ls-remote の読み方が壊れている）",
  );
  // **そして既定の 2 源が、この番人に実際に配線されていること**
  // （引数の既定値を「常に ok を返すもの」に差し替える変異を落とす）。
  // **答えの真偽では固定できない**——**この枝では `false`、main への push では `true` になる**
  // （それがこの PR が直している 1 の (b) そのものである）。
  // **だから「既定が返す答え」ではなく「既定の源で計算した答えと一致すること」を当てる。**
  const expected = isAncestorByGit("HEAD", "refs/remotes/origin/main")
    && isAncestorByGit("HEAD", remoteMainByLsRemote());
  assert.equal(
    emptyRangeIsTrustworthy().ok,
    expected,
    "既定の 2 源が番人に配線されていない（既定を差し替える変異が素通りする）",
  );
  assert.equal(FORGED.length, 8, "綴りの長さが変わっている");
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
 *
 * ── **同じクラスがもう 1 つ残っていた**（2 度目のレビューの実測。必須 3）───────────────
 *
 * ```
 * N7  /^\d+\+[^@]+@users\.noreply\.github\.com$/ → …@users.noreply.github.com$/
 *     （`\.` を `.` に。ドメインのドットを未エスケープにする）              pass 12 / fail 0
 * ```
 *
 * **`.` は任意の 1 文字なので、区切りがドットでない綴りが全部通るようになる**
 * （`1+x@users-noreply-github-com` / `1+x@usersXnoreplyXgithubXcom`）。
 * **「アンカーを 3 形で守った」だけでは足りず、ドットのエスケープも 1 形で守る必要があった**
 * ——**列挙で守っている以上、列挙漏れは全部そのまま穴である。**
 * **`bad` に 1 形足して母数を 12 → 13 にした**（実測: N7 が `pass 12 / fail 1` で落ちる）。
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
    // ── 2 度目のレビューが素通りを実測した 1 形（N7）──────────────────────────────
    // **ドメインのドットはエスケープが要る（`\.`）**。
    // **`\.` を `.` に書き落とすのは、この種の正規表現でいちばんありがちな見落ちである**
    // （実測: `OK = /^\d+\+[^@]+@users.noreply.github.com$/` は 12/12 緑で生き残った）。
    // **`.` は任意の 1 文字なので、区切りがドットでない綴りが全部通る**
    // ——`users-noreply-github-com` / `usersXnoreplyXgithubXcom` など。
    // **severity は N2（`…github.com.evil.com`）より低い**（TLD が無いので実在ドメインになりにくい）
    // **が、「形の要求を守る検査が denylist」という構造は同じである。**
    "1+x@users-noreply-github-com",
  ];
  // **母数**（#757）: **列挙そのものの本数を固定する。**
  // **列挙が縮んだら、また同じアンカーの穴が開く**（N2 / N4 / N6 はこの列挙漏れで生き残っていた）。
  assert.equal(good.length, 2, "通すべき綴りの列挙が縮んでいる");
  assert.equal(bad.length, 13, "通してはいけない綴りの列挙が縮んでいる（アンカーを外す変異が素通りする）");
  for (const e of good) assert.ok(AUTHOR_OK.test(e), `通すべき綴りが落ちた: ${e}`);
  for (const e of bad) assert.ok(!AUTHOR_OK.test(e), `通してはいけない綴りが通った: ${e}`);
});

/**
 * **`misattributingTrailerEmails` を、`origin/main` の履歴に実際に在った形に当てる。**
 *
 * **これが「いま在る履歴の 2 形を赤にできる」ことの証明である**（#1074 の受け入れ条件）。
 * **母数（`checked`）も一緒に固定する**（#757。`bad` が空でも `checked` が落ちていれば走査が壊れている）。
 */
test("履歴に実際に在った 5 形を、赤 2 / 緑 3 に分ける（母数も固定する）", () => {
  const body = [
    "fix: 何かを直した",
    "",
    "Closes #1074",
    "",
    // **緑**: 規約が全コミットに要求する trailer。**実測で `github.com/claude` に帰属する**
    // （#1106。ローカル部 `noreply` はユーザー名として読まれない）。
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    "Co-authored-by: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
    "Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    // **赤**: `users.noreply.github.com` のローカル部がそのままユーザー名になる 2 形。
    // **実測: `etl` → id=1859882 / `dev` → id=12158001（どちらも無関係の実在の個人）。**
    "Co-authored-by: giinrecord-etl[bot] <etl@users.noreply.github.com>",
    "Co-authored-by: seiji-kiroku-dev <dev@users.noreply.github.com>",
    "Claude-Session: https://claude.ai/code/session_x",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(
    bad,
    ["etl@users.noreply.github.com", "dev@users.noreply.github.com"],
    "履歴に在った 2 つの誤帰属が赤にならない（または規約どおりの trailer を赤にしている）",
  );
  // **母数**: trailer 形の行 5 つからアドレスを 5 つ拾っている
  // （`Claude-Session:` は身元の trailer ではないので数に入らない）。
  assert.equal(checked, 5, "走査したアドレス数が変わっている（走査が空回りしているか、広がりすぎている）");
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
 * **`EMAIL` そのものを当てる**（3 度目のレビューの必須 2。M7）。
 *
 * ── **なぜ要るか: 3 つの正規表現のうち、ここだけ検査が 1 本も無かった** ──────────────────
 *
 * ```
 * OK                 通す 2 形 / 通してはいけない 13 形 + 母数        ← 守られている
 * IDENTITY_TRAILERS  拾う 14 形 / 拾わない 6 形                      ← 守られている
 * EMAIL              （検査なし）                                    ← ★ ここが穴だった
 * ```
 *
 * **`EMAIL` は「走査する対象を決める」ので、狭めると *見なくなる*。**
 * **`bad` に積まれないだけでなく、`checked`（母数）にも数えられない**ので、
 * **走査カウンタは正常な数を出したまま、特定の形だけが静かに素通りする。**
 *
 * **実測した変異（どちらも直す前は `tests 14 / pass 14 / fail 0` で緑）**:
 * ```
 * M7  [A-Za-z]{2,} → {3,}   TLD が 2 文字のアドレスを全部見なくなる
 *                           → bot@claude.ai / x@foo.io / x@foo.co が誤帰属のまま通る
 * E3  matchAll → match      1 行の 2 件目以降を見なくなる
 * ```
 *
 * **`claude.ai` は実在のドメインである。** **`noreply@anthropic.com` を弾いた次に
 * そこへ書き換えられたら、M7 が当たっていれば誰も気づけない**——
 * **走査した数は 9 のまま正常に見える。**
 *
 * **前回のレビューは E1（同じ形）を「履歴に該当が無いので低 severity」と判定し、
 * 自分もそれに同意して足さなかった。** **3 度目のレビューはそれを「上げるべき」とし、PO も同意した。**
 * **「履歴に無い」は「これから来ない」ではない**——**`OK` と `IDENTITY_TRAILERS` を
 * 列挙で守っておきながら、`EMAIL` だけ無検査なのは筋が通らない。**
 */
test("メールアドレスの拾い方が狭まっていない（走査の対象そのものを固定する）", () => {
  /** 1 行から拾えたアドレスの全部（`EMAIL` は `g` 付きなので毎回作り直す）。 */
  const pick = (s: string): string[] => [...s.matchAll(EMAIL)].map((m) => m[0]);
  const mustFind: readonly [string, string][] = [
    // **TLD が 2 文字**（M7 が落とす。`claude.ai` は実在のドメインである）
    ["Co-authored-by: N <bot@claude.ai>", "bot@claude.ai"],
    ["Co-authored-by: N <x@foo.io>", "x@foo.io"],
    ["Co-authored-by: N <x@foo.co>", "x@foo.co"],
    // **`[bot]` の角括弧**（これを落とすと github-actions[bot] が見えなくなる）
    [
      "Co-authored-by: b <41898282+github-actions[bot]@users.noreply.github.com>",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ],
    // **数字 ID 付きの正しい形**（走査に入らなければ母数が落ちる）
    [
      "Co-authored-by: u <120390190+uonoko1@users.noreply.github.com>",
      "120390190+uonoko1@users.noreply.github.com",
    ],
    // **#1074 の実害 2 形**
    ["Co-Authored-By: C <noreply@anthropic.com>", "noreply@anthropic.com"],
    ["Co-authored-by: e <etl@users.noreply.github.com>", "etl@users.noreply.github.com"],
    // **ローカル部の記号**（`.` `_` `%` `+` `-`）
    ["Co-authored-by: N <a.b_c%d+e-f@example.com>", "a.b_c%d+e-f@example.com"],
    // **サブドメイン / ハイフンを含むドメイン**
    ["Co-authored-by: N <x@a.b.example-site.com>", "x@a.b.example-site.com"],
    // **長い TLD**
    ["Co-authored-by: N <x@foo.technology>", "x@foo.technology"],
  ];
  assert.equal(mustFind.length, 10, "拾うべき綴りの列挙が縮んでいる（狭める変異が素通りする）");
  for (const [line, want] of mustFind) {
    assert.ok(
      pick(line).includes(want),
      `走査すべきアドレスを拾えていない（この形は誤帰属でも静かに通る）: ${want}`,
    );
  }
  // **1 行に 2 件あるときは 2 件とも拾う**（E3 = `matchAll` → `match` がここで落ちる）。
  // **2 件目は「実際に誤帰属する形」にする**（#1106）——**`noreply@anthropic.com` は
  // 実測で `github.com/claude` に正しく帰属するので、走査の本体は赤にしない。**
  // **ここで確かめたいのは「2 件目を見落とさないこと」なので、2 件目を誤帰属の形にする。**
  const twoOnOneLine =
    "Co-authored-by: N <120390190+uonoko1@users.noreply.github.com> <etl@users.noreply.github.com>";
  assert.deepEqual(
    pick(twoOnOneLine),
    ["120390190+uonoko1@users.noreply.github.com", "etl@users.noreply.github.com"],
    "1 行に 2 つ書かれたアドレスの 2 件目を拾えていない（2 件目に誤帰属を隠せる）",
  );
  // **`EMAIL` を直接当てるだけでは足りない**——**走査の本体（`misattributingTrailerEmails`）が
  // 1 行から何件取るかは、別の場所（`for (const m of line.matchAll(EMAIL))`）が決めている。**
  // **実測: 走査側だけを「先頭 1 件」に狭める変異は、`pick` の検査があっても `pass 15 / fail 0` で
  // 生き残った**（`pick` はこの検査が持つ自前の helper で、本番の走査を通らないため
  // ——作業合意の「配線が繋がっていない」）。**だから本体に当てる。**
  const two = misattributingTrailerEmails(twoOnOneLine, new Set());
  assert.deepEqual(
    two.bad,
    ["etl@users.noreply.github.com"],
    "1 行に 2 つ書かれたアドレスの 2 件目の誤帰属を、走査の本体が見落としている",
  );
  assert.equal(two.checked, 2, "1 行から 2 件を走査していない（母数）");
  // **アドレスでないものを拾わない**（偽陽性。広げる方向の変異を落とす）。
  const mustNotFind = [
    "Claude-Session: https://claude.ai/code/session_x", // **URL のホスト名を拾わない**
    "Closes #1074",
    "本文に @ とだけ書いた行",
    "Co-authored-by: N <not-an-email>",
  ];
  assert.equal(mustNotFind.length, 4, "拾ってはいけない綴りの列挙が縮んでいる");
  for (const line of mustNotFind) {
    assert.deepEqual(pick(line), [], `アドレスでないものを拾っている（偽陽性）: ${line}`);
  }
});

/**
 * **`git` の trailer パーサ（`%(trailers:only=true)`）に頼ると、
 * squash merge の区切りより上の `Co-Authored-By:` がまるごと落ちる**（この PBI の実測）。
 *
 * **実測（`origin/main` = `068be5c2`、696 commits）**:
 * `%(trailers:only=true)` で `noreply@anthropic.com` は **650**。本文を直接読むと **1708**。
 * **1058 件、つまり 62% が見えていなかった**（基点 `2f136cd1` / 711 commits。実測 2026-09-28。
 * `068be5c2` では 640 / 1643 で 61% だった）。
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
    // **誤帰属する形を区切りの上下に 1 つずつ置く**（#1106）——**`noreply@anthropic.com` は
    // 実測で正しく帰属するので、「拾えたか」を `bad` で測れない。**
    // **`etl@` なら、拾えていれば必ず `bad` に出る。**
    "Co-Authored-By: giinrecord-etl[bot] <etl@users.noreply.github.com>", // 開発者が書いた分（区切りより上）
    "Claude-Session: https://claude.ai/code/session_x",
    "",
    "---------",
    "",
    "Co-authored-by: giinrecord-etl[bot] <etl@users.noreply.github.com>", // squash が合成した分
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.equal(checked, 2, "区切りより上の trailer を拾っていない（%(trailers) と同じ見落とし）");
  assert.deepEqual(bad, ["etl@users.noreply.github.com", "etl@users.noreply.github.com"]);
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
  // **`commitTree` を通す**（identity の渡し方を 1 本にまとめた。上の docblock）。
  const sample = commitTree({ tree, message: body });
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
  const { bad, checked } = misattributingTrailerEmails("x\n\nCo-authored-by: e <etl@users.noreply.github.com>");
  assert.equal(checked, 1, "既定の呼び方で走査していない（母数 0）");
  assert.deepEqual(bad, ["etl@users.noreply.github.com"], "既定の許容集合が広がっている");
});

/**
 * **規約が全コミットに要求する trailer が、この検査を通ること**（#1106。**偽陽性の検査**）。
 *
 * ── **これが無かったので #1075 が全 PR を赤にした** ──────────────────────────────
 *
 * **#1075 のレビューは「誤帰属 trailer を足すと落ちる」を確かめた**（**赤くなることは確かめた**）。
 * **「規約どおりの trailer が通る」を一度も確かめていなかった**（**緑になることを確かめていない**）。
 * **偽陽性の側を測っていなかったので、`OK` を「数字 ID 付き以外は全部誤帰属」と書いたことに
 * 誰も気づかないまま main に入り、`merge-base..HEAD` が空でない PR が全部赤になった**
 * （#1092 / #1084 の `check`。**`main` は範囲が空なので緑のままだった**）。
 *
 * **だから「赤になること」と対で「緑になること」を固定する。**
 *
 * ── **なぜ `noreply@anthropic.com` が誤帰属でないと言えるか（実測。推測で書かない）** ────
 *
 * **GraphQL の `Commit.authors` は、GitHub が実際にそのコミットを誰に帰属させたかを返す。**
 * **`1e41501f` は 3 形を同時に持っていたので、同じ条件で並べて測れた**（2026-09-28）:
 *
 * ```
 * noreply@anthropic.com                        → login=claude  databaseId=81847
 * etl@users.noreply.github.com                 → login=etl     databaseId=1859882
 * 120390190+uonoko1@users.noreply.github.com   → login=uonoko1 databaseId=120390190
 * ```
 *
 * **`github.com/noreply` は実在する**（`id=1239515` / `created_at=2011-12-04`）**のに、
 * そこへは 1 件も行っていない。** **`stats/contributors` にも出ない**
 * （`github-actions[bot]` 59 / `claude` 650 / `uonoko1` 656。**`noreply` は出ない**）。
 * **`origin/main`（711 commits）の trailer 1708 件はすべて `claude` に行っている。**
 *
 * **つまりローカル部がユーザー名として読まれるのは `users.noreply.github.com` の場合だけで、
 * それ以外のドメインは「そのアドレスを verified email として持つアカウント」に解決される**
 * （利用者本人の個人アドレス → `uonoko1` も同じ道。実測 `f15aad8d`）。
 */
test("規約が要求する trailer は緑（#1075 が全 PR を赤にした偽陽性そのもの）", () => {
  // **#1092 / #1084 のコミットと同じ形**（規約が全コミットに要求する 2 行）。
  const body = [
    "fix(ci): 何かを直した",
    "",
    "Closes #1106",
    "",
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    "Claude-Session: https://claude.ai/code/session_01NNvvWoGxL9KnKQBoHK3PyS",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body);
  assert.deepEqual(
    bad,
    [],
    "規約が全コミットに要求する trailer を誤帰属と判定している" +
      "（#1075 がこれで全 PR を赤にした。`noreply@anthropic.com` は実測で github.com/claude に帰属する）",
  );
  // **母数**（#757）: **`bad` が空なのは「見ていない」からかもしれない。**
  // **1 件走査した上で空である**ことを言う。
  assert.equal(checked, 1, "規約どおりの trailer を 1 件も走査していない（空回りで緑になっている）");
  // **`users.noreply.github.com` 以外のドメインは、この経路では誤帰属しない**（上の docblock）。
  // **ドメインを限定する条件を外す変異（`GITHUB_NOREPLY.test(email) &&` を落とす）は、
  // ここで落ちる。**
  for (const e of [
    "noreply@anthropic.com", // 規約が要求する trailer。実測で github.com/claude
    // **利用者本人の個人アドレスは逐語で書かない**（#1043）。
    // 実測では `<利用者本人の gmail>` → github.com/uonoko1（f15aad8d）。
    // ここでは同じ「ローカル部と同名のユーザーが実在するのに帰属しない」形を架空で置く。
    FAKE_PERSON,
    FAKE_BOT,
    "x@example.com", // ローカル部が 1 文字の形（この綴り自体が検査の対象なので逐語で置く）
  ]) {
    assert.ok(
      !misattributesViaGithubNoreply(e),
      `users.noreply.github.com 以外のドメインを誤帰属と判定している（偽陽性）: ${e}`,
    );
  }
  // **対で固定する**: **`users.noreply.github.com` 宛ての誤帰属 3 形は赤のままであること。**
  // **ドメインの限定を「全部通す」方向に広げる変異は、ここで落ちる。**
  for (const e of [
    "etl@users.noreply.github.com", // 実測 github.com/etl (id=1859882)
    "dev@users.noreply.github.com", // 実測 github.com/dev (id=12158001)
    "noreply@users.noreply.github.com", // 同じ綴りでもドメインが違えば誤帰属する
  ]) {
    assert.ok(
      misattributesViaGithubNoreply(e),
      `users.noreply.github.com のローカル部がユーザー名になる形を通している: ${e}`,
    );
  }
});

/**
 * **`misattributesViaGithubNoreply` そのものを、通す綴り / 通さない綴りに直接当てる**（#1106）。
 *
 * **上の検査は本物のメッセージに当てるので、`misattributesViaGithubNoreply` を
 * 「常に false」に潰しても、この枝のメッセージが正しい限り緑のままである。**
 * **だから述語そのものに当てる**（`AUTHOR_OK` を同じ理由で直接当てているのと同じ形）。
 *
 * **ドメインの限定は「`$` で終わる」ことが効いている**——
 * **`@users.noreply.github.com.evil.com` は GitHub のユーザーに紐づかない外部ドメインなので、
 * この経路では誤帰属しない**（**`noreply@anthropic.com` と同じ (A) の道になる**）。
 * **`users.noreply.github.com` で終わらないものを「誤帰属」と言うと、また偽陽性になる。**
 */
test("誤帰属の判定は users.noreply.github.com 宛てだけに掛かる（述語そのものを検査する）", () => {
  // **誤帰属する**（ローカル部がそのままユーザー名として読まれる）。
  const misattributes = [
    "etl@users.noreply.github.com",
    "dev@users.noreply.github.com",
    "noreply@users.noreply.github.com",
    "claude@users.noreply.github.com",
    "+uonoko1@users.noreply.github.com", // 数字 ID が無い
    "1+@users.noreply.github.com", // 名前が無い
    "a1+x@users.noreply.github.com", // 先頭が数字でない
    "ETL@Users.NoReply.GitHub.Com".toLowerCase(), // 走査は小文字化してから当てる
  ];
  // **誤帰属しない**（この経路では他人のユーザー名にならない）。
  const doesNot = [
    // **正しい形**（数字 ID がユーザーを決める）
    "120390190+uonoko1@users.noreply.github.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
    // **別ドメイン**——**(A) の「登録済みアドレス」の道。実測で正しく帰属する 2 形**
    REQUIRED_TRAILER_ADDRESS,
    FAKE_PERSON,
    // **別ドメイン（一般）**
    FAKE_BOT,
    "x@example.com",
    "etl@example.com", // 同じローカル部でもドメインが違えば github.com/etl にはならない
    // **サフィックスが違う**——**外部ドメインなので (A) の道であり、(B) では誤帰属しない**
    "1+x@users.noreply.github.com.evil.com",
    "x@users.noreply.github.company",
    "x@users-noreply-github-com",
  ];
  // **母数**（#757）: **列挙が縮んだら、また同じ穴が開く。**
  assert.equal(misattributes.length, 8, "誤帰属する綴りの列挙が縮んでいる");
  assert.equal(doesNot.length, 10, "誤帰属しない綴りの列挙が縮んでいる（偽陽性の検査が痩せる）");
  for (const e of misattributes) {
    assert.ok(misattributesViaGithubNoreply(e), `誤帰属する綴りを通している: ${e}`);
  }
  for (const e of doesNot) {
    assert.ok(!misattributesViaGithubNoreply(e), `誤帰属しない綴りを赤にしている（偽陽性）: ${e}`);
  }
});

/**
 * **「守れないもの」を、散文ではなく検査で固定する**（#1106）。
 *
 * **上の docblock は「数字 ID の *中身* は検査できない」と書いている。**
 * **散文は読まれないし、変異でも落ちない。** **だから通ることを逐語で固定して、
 * 「いつか閉じた／閉じたつもりになった」ときにここが落ちるようにする。**
 *
 * **#1106 で 4 形を本物のコミットに載せて測った**（`origin/main` の実装と、この枝の実装を
 * 同じ手順で並べた。実測 2026-09-28）:
 *
 * ```
 * trailer に載せた 1 形                                  origin/main   この枝
 * etl@users.noreply.github.com                            赤            赤
 * dev@users.noreply.github.com                            赤            赤
 * 219112946+seiji-kiroku-dev@users.noreply.github.com     緑 ★          緑 ★   ← 変えていない
 * noreply@anthropic.com                                   赤 ★★         緑     ← #1106 で直した
 * ```
 *
 * **★ は #1074 が明記した既知の限界**（`github.com/MLehnus` に帰属するが形は正しい）。
 * **#1106 はここを変えていない**——**閉じるなら逐語 allowlist が要り、それは別 PBI で
 * PO が判断すると #1074 が書いている。**
 * **★★ が #1106 で直した偽陽性である。**
 */
test("数字 ID の中身は検査できない、という限界がそのままであること（散文でなく検査で固定する）", () => {
  // **形が正しいので通る。** **その数字が指すのは github.com/MLehnus という無関係の個人である**
  // （実測 `gh api user/219112946` → login=MLehnus / created_at=2025-07-03）。
  assert.ok(
    !misattributesViaGithubNoreply("219112946+seiji-kiroku-dev@users.noreply.github.com"),
    "数字 ID の中身を検査できるようになった（#1074 の既知の限界が閉じた）。" +
      "閉じたのなら、それは良いことなので、この検査と上の docblock を一緒に直すこと",
  );
  // **author / committer の側も同じ限界を持つ**（同じ形を要求しているため）。
  assert.ok(
    AUTHOR_OK.test("219112946+seiji-kiroku-dev@users.noreply.github.com"),
    "author 側の限界だけが閉じた（trailer 側と食い違っている）",
  );
});
