#!/usr/bin/env bash
# Issue #1110: スクラムの停滞を見張る。**リポジトリの中に在ること**がこの道具の存在理由である。
#
# **何が壊れていたか（PO が 2 回実測した。#1110 と #1099 のコメント）:**
#   PO はこれと同じ監視を `scratchpad` に立てていた。**scratchpad はセッション固有なので、
#   セッションが終わると消える。** **2026-09-29〜30 の 1 日で 2 回消えた。**
#     1 回目  セッション再開で監視が止まった  →  **PO が気づかず、監視なしで進めた**
#     2 回目  スクリプト自体が消えた          →  `MONITOR-BROKEN` が出て気づいた
#   **その日 23 本マージしており、そのあいだ監視が 2 回死んでいた。**
#   **死んでいる間は「止まった worktree」も「PR の赤」も誰も見ていない。**
#   `find scripts -iname '*monitor*'` → **`deploy/monitor/` はサイトを見るもので、
#   スクラムを見るものは 0 件**だった。
#
# 何を見るか（節ごとに、母数つきで出す）:
#   1. PR        開いている PR の赤い検査（`--paginate` + `total_count` の検算）
#   2. board     `In Progress` で Issue も PR も $STALE_MINUTES 分静かなもの（**判定不能として出す**）
#   3. worktree  止まっている疑い／幽霊（**判定は worktree-audit.sh に委ねる**）
#
# **「何も言わない」と「正常」を区別できること**が要件である（#1094）。
#   - **節ごとに「見た件数／測れなかった件数」を必ず出す**（#757 の母数。
#     **「赤 0 件」と「1 件も数えていない」を同じ顔にしない**）。
#   - **測れなかった節が在れば exit 4**（`MONITOR-BROKEN`）。**黙って 0 を出さない。**
#   - 末尾に必ず 1 行 `scrum-monitor: 終了（節 N/M を測れました）` を出す。
#     **この行が無ければ、この道具は途中で死んでいる**（`set -e` で落ちた）。
#
# **出力に書かないもの**（OSS で公開され、この出力は Issue にコピーされる。
# `deploy/test/environment-protection.test.sh:47` に同じ理由が在る）:
#   IP・ホスト名・**worktree の絶対パス**・鍵・アカウント名。
#   **件数と Issue/PR の番号は書いてよい**（番号は GitHub 上で既に公開されている）。
#   **worktree はパスではなく本数だけ出す**——**枝名も出さない**（枝名は担当者を指す）。
#   詳細が要るときは `worktree-audit.sh` を人が手で走らせる（あちらはローカル専用）。
#
# 終了コード:
#   0 = 全部測れて、行動が要るものが無い
#   2 = 使い方が違う
#   3 = 行動が要る事実が在る（赤い検査／判定不能／幽霊）。**測定自体は成功している**
#   4 = **測れなかった節が在る（MONITOR-BROKEN）**。**この道具を信じてはいけない**
#   3 と 4 が重なったら **4 を返す**——**「測れなかった」のほうが重い**
#   （行動が要るものを見落としている可能性が在るため）。
#
# Env:
#   PO_REPO           owner/name（既定は `gh repo view`）
#   STALE_MINUTES     静かと呼ぶ閾値（分。既定 90。**根拠は下の実測**）
#   MONITOR_NOW       現在時刻の epoch 秒（テスト用。既定は本物の時計）
#   MONITOR_SKIP_LOCAL  1 なら worktree の節を飛ばす（CI では worktree が 1 本しか無く、
#                       PO の手元の話は測れない。**飛ばしたことを出力に書く**）
#
# Tests: scripts/po/test/scrum-monitor.test.sh（fake `gh` / fake `git`。実在のツリーを触らない）
#
# Usage:
#   scripts/po/scrum-monitor.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/po/lib.sh
source "$HERE/lib.sh"

case "${1:-}" in
  "") ;;
  *) usage "scrum-monitor.sh" ;;
esac

# ---- 閾値の根拠（#1110 の受け入れ条件 3）------------------------------------------------------
#
# **PO の 90 分は勘だった**（#1099 のコメントに「根拠が在りません」と自分で書いている）。
# **測った**（2026-09-29、手元の agent worktree 6 本・直近 24 時間の書き込み。
# **メインの作業ツリーは除いた**——あれは PO のもので、エージェントの挙動ではない）。
#
# **測った量は「連続する書き込みの間隔」**である。**閾値はこの分布の上に乗っていなければ
# ならない**——**考えているだけのエージェントを「止まった」と呼ばないため**（#1110 の
# 「長く考えているだけのエージェントを誤報しないこと」）。
#
#   間隔 n=36（6 本の worktree、24 時間）
#     p50 = 0.0 分 / p75 = 0.3 分 / p90 = 3.3 分 / p95 = 10.6 分 / **max = 17.0 分**
#   閾値ごとの誤報（その閾値を超えた間隔の本数）:
#     > 5 分 2/36 (5.6%) / >10 分 2/36 (5.6%) / >15 分 1/36 (2.8%)
#     **>20 分 0/36 / >30 分 0 / >45 分 0 / >60 分 0 / >90 分 0 / >120 分 0**
#
# **20 分以上の間隔は 1 本も無かった。** つまり**働いているエージェントは 17 分以上
# 黙らない**（この標本では）。**90 分は観測された最大の約 5 倍**である。
#
# **なぜ 20 分や 30 分に下げないか**——**倒れる向きが非対称だから**である:
#     誤って鳴らす   → PO が 1 本目で見る。**失うものは無いが、鳴り続けると見なくなる**
#     誤って黙る     → **止まった作業が放置される。これが #1110 が起きた理由そのもの**
#   一見すると「黙るほうが重いので短くせよ」に見える。**逆である**——
#   **この道具は 10 分ごとに回る**ので、**閾値を下げても「見つかるのが早くなる」だけで、
#   見つからなくなるわけではない。** 一方**誤報は毎回出て、出力全体の信用を落とす**
#   （`worktree-audit.sh` の「毎回鳴ると鳴っていること自体を見なくなる」と同じ罠）。
#   **標本が 36 件しか無い**ことも効く: **p99 を 36 件から決めるのは無理**なので、
#   **観測された最大（17 分）から大きく離す**しかない。
#
# **標本の限界（正直に）:**
#   - **36 件・6 本・1 日**である。**夜間に人が止めた時間は「間隔」に入っていない**
#     （24 時間で切ったので、それより古い書き込みは数えていない）。
#   - **「ファイルが書かれている」は「進んでいる」の代理である**
#     （`docs/WORKING_AGREEMENT.md` の「代理と実体」）。
#     **同じファイルを無限に書き直しているのは、この道具では検出できない。**
#     **これは #1110 に「測っていないこと」として書かれており、ここでも解決していない。**
STALE_MINUTES=${STALE_MINUTES:-90}
is_int "$STALE_MINUTES" || die "STALE_MINUTES は正の整数で指定してください（受け取った値: $STALE_MINUTES）"
NOW=${MONITOR_NOW:-$(date +%s)}
is_int "$NOW" || die "MONITOR_NOW は epoch 秒で指定してください（受け取った値: $NOW）"

REPO=$(po_repo)

# 節ごとに「測れたか」を数える。**母数は 3**（PR / board / worktree）。
SECTIONS_TOTAL=3
SECTIONS_OK=0
FINDINGS=0        # 行動が要る事実の件数
UNMEASURED=()     # 測れなかった節の名前と理由

unmeasured() { UNMEASURED+=("$1"); log "MONITOR-BROKEN $1"; }

# ---- `gh` の言い分を、安全に、分類して出す（#1210）--------------------------------------------
#
# **何が壊れていたか**: この道具は `gh ... 2>/dev/null` で **`gh` の言い分を捨てていた。**
# 残るのは「GraphQL が返りませんでした」という**原因を含まない一文**だけで、
# **CI のログを読んだ人には「権限が無い（永久に緑にならない）」と
# 「一時的に返らなかった（待てば直る）」が区別できない。**
#
# **実害（#1210。仮定ではなく起きたこと）:**
#   #1168 を閉じた   2026-10-04T13:02:50Z  根拠「手元で再測定して 3/3・rc=0」
#   #1203 が立った   2026-10-04T14:29:31Z  同じ理由（board が読めない）
#   間隔             **87 分**
# **PO は `project` スコープを持つ手元の PAT で測って緑を見た。**
# **失敗した経路（`secrets.GITHUB_TOKEN`）は一度も試していない。**
# **つまり「ログが読みにくい」ではなく、これが誤診を生んだ原因である。**
#
# **なぜ raw をそのまま流さないか**（#1210 の受け入れ条件 2）:
# **この出力は Issue にコピーされ、OSS として公開される**（`unmeasured` →
# `scrum-monitor-report.sh` → **public リポジトリの Issue 本文**）。`gh` の stderr には
# **URL（クエリに鍵が乗りうる）・`Authorization` ヘッダ・絶対パス・枝名・
# 内部のホスト名・内部 IP・ポート**が出うる。
#
# **初版は「allowlist」と宣言していたが、秘密を落としていた層は denylist だった**
# （#1217 のレビューと PO が実測）。`tr -cd` の allowlist は**文字集合しか見ていない**ので、
# **「安全な文字だけで綴られた秘密」は素通りする。** 実測で漏れた 5 形:
#
#   error connecting to internal-db.<内部ドメイン>   → **そのまま**（`/` も `_`+20 も無い）
#   dial tcp 10.0.3.17:5432: connect: refused        → **IP:port がそのまま**
#   token ghp_ABCDEFGHIJKLMNOPQRS invalid            → **`_` の後 19 文字で `{20,}` の外**
#   Bearer sk-ant-verysecretvalue99                  → **ヘッダ名が無いので規則が当たらない**
#   query?token=abcdefghijklmnop&user=x              → **鍵が残り、無害な `x` だけ伏せた**
#
# **5 形目が一番危ない読み方を誘う**——**伏せ字が出ているので「効いている」と見えるが、
# 伏せたのは鍵ではない。** **denylist は「列挙に無い形」を必ず通す。**
#
# **だから向きを変える: 「危ない形を列挙して消す」から
# 「安全だと分かっている形だけを通す」へ。**
# **倒れる向きは「消えすぎる」側である**（**読めなくなっても、漏れるより良い**）。
#
# **何を通せば足りるか**は、この出力の用途から決まる。**役目は `gh_err_class` の
# `permission` / `transient` / `unknown` の判別を人が追認できることだけ**で、
# **固有名詞を 1 つも必要としない。** 実測した `gh` 2.89.0 の stderr（4 形）は
# すべて**英単語・`HTTP <番号>`・句読点**だけで判別できる:
#   gh: Bad credentials (HTTP 401)
#   gh: You must have repository read permissions or ... fine-grained permission. (HTTP 403)
#   gh: Could not resolve to a node with the global id of '<伏せる>'
#   error connecting to <伏せる> / check your internet connection or <伏せる>
# **4 形目のホスト名と URL は、判別には要らない**（「接続できなかった」で足りる）。

# gh_err_sanitize <生の stderr> → 安全化した 1 行以上（最大 GH_ERR_MAX_LINES 行）
#
# **「何行のうち何行を出したか」を必ず添える**（#757 の母数）——**黙って切らない。**
GH_ERR_MAX_LINES=${GH_ERR_MAX_LINES:-3}
GH_ERR_MAX_CHARS=${GH_ERR_MAX_CHARS:-300}
# **語の形の allowlist**（`gh_err_allow`）。**これに当たらない語は、まるごと `[redacted]`。**
#   1. 英字だけの語（ハイフンで繋いだ複合語も可）。24 文字まで
#      → `credentials` `fine-grained` `rate` `host`。**秘密は英字だけでは綴れない**
#        ——と言い切れないので長さで上限を置く（24 文字。実測した gh の最長語は
#        `INSUFFICIENT_SCOPES` の 19 文字）
#   2. 4 桁までの数（`401` `403` `502` `1234`）
#      → **5 桁以上は通さない**（ポート番号・ID・連番は長い）
#   3. 大文字と `_` だけの語（`HTTP` `INSUFFICIENT_SCOPES` `NOT_FOUND` `FORBIDDEN`）
#   4. **小文字 2 節を `:` で繋いだ語**（`read:project` `read:org` `admin:org`）。各節 12 文字まで
#      → **OAuth のスコープ名**。**これは判別に要る**——「権限が足りない」と言われた人が
#        **どのスコープを足せばよいか**を読めなければ、`permission` の verdict が行動に繋がらない
#        （#1210 の目的そのもの）。**`a.b` や `a:1234` は通さない**ので、
#        ホスト名（`.` を持つ）と IP:port（数字を持つ）は当たらない。
# **芯を判定する前に、前後の句読点を剥がす**（`(HTTP` `403)` `credentials,` を
# 「英単語」として通すため）。**剥がした句読点はそのまま戻す。**
#
# **この形で、上の 5 形はすべて落ちる**:
#   `internal-db.giinrecord.local` → 芯に `.` が残り 1 に当たらない
#   `10.0.3.17:5432:`              → 芯に `.` と `:` が残る（末尾の `:` は剥がれるが中は残る）
#   `ghp_ABCDEFGHIJKLMNOPQRS`      → 小文字と `_` の混在は 1 も 3 も通らない（**長さに依存しない**）
#   `sk-ant-verysecretvalue99`     → 数字が混じるので 1 を通らない
#   `query?token=abcdefghijklmnop&user=x` → `?` `=` `&` が芯に在る
# **バックティック・多バイト文字・`/`・`@`・`$` を含む語も、同じ理由で落ちる**
# （**初版は `tr -cd` でこれらを文字単位で消していたが、その層は 1 件も検査されていなかった**
# ——#1217 レビューの N1。**いまは語ごと落ち、検査が在る**）。
#
# **識別子の値を落とす規則を 1 本だけ足す**: `ID` / `installation` / `user` / `owner` /
# `org` / `login` / `node_id` / `number` の**直後に来た数**は、上の 2 を通ってしまうので
# `[redacted]` にする（`installation ID 1234` → `installation ID [redacted]`）。
# **これは allowlist の例外なので denylist 的だが、向きは「さらに消す」側である**
# ——**通す側を広げていない。**
#
# **`Authorization` の行は、その語より後ろを全部 `[redacted]` にする**（同じ「さらに消す」側）。
# **語の形だけでは足りない**: `Authorization: Bearer <鍵>` の `Bearer` は
# **「英字だけの 6 文字」なので allowlist の 1 に当たって通る。**
# **`<鍵>` は落ちるので漏洩にはならない**が、**`Bearer` が残ると
# 「ヘッダを出した」ことになる**ので、ヘッダ名を見たら行末まで伏せる
# （`scrum-monitor.test.sh` の `assert_not_contains "$ERR" "Bearer"` がこれを固定している）。
#
# **`awk` を使う**（`sed` では語ごとの判定が書けない。`scripts/po/` の
# `merge-when-green.sh` / `board-audit.sh` / `worktree-audit.sh` / `measure-pbi.sh`
# が既に `awk` を使っているので、依存は増えない）。
# **`LC_ALL=C` で呼ぶ**——**ロケール依存の文字クラスで多バイト文字が「英字」に数えられると、
# allowlist が静かに広がる。**
# **伏せ字は ASCII の `[redacted]` にする**（`[除去]` のような多バイト文字にしない。
# **多バイト文字は語の allowlist に当たらないので、伏せ字自身が伏せられる**）。
gh_err_allow() {
  LC_ALL=C awk '
    function safe(t) {
      if (t == "")                                              return 1
      if (t ~ /^[A-Za-z]+(-[A-Za-z]+)*$/ && length(t) <= 24)    return 1
      if (t ~ /^[0-9]{1,4}$/)                                   return 1
      if (t ~ /^[A-Z][A-Z_]*$/ && length(t) <= 24)              return 1
      if (t ~ /^[a-z]{1,12}:[a-z]{1,12}$/)                      return 1
      return 0
    }
    {
      out = ""; prev = ""; tail = 0
      n = split($0, w, / /)
      for (i = 1; i <= n; i++) {
        t = w[i]
        if (t == "") continue
        pre = ""; post = ""
        while (t ~ /^[("\047\[]/)       { pre  = pre substr(t, 1, 1);              t = substr(t, 2) }
        while (t ~ /[.,:;!?)"\047\]]$/) { post = substr(t, length(t), 1) post;     t = substr(t, 1, length(t) - 1) }
        if (tail) {
          word = "[redacted]"
        } else if (!safe(t)) {
          word = "[redacted]"
        } else if (t ~ /^[0-9]+$/ && tolower(prev) ~ /^(id|installation|user|owner|org|login|node_id|number)$/) {
          word = "[redacted]"
        } else {
          word = pre t post
        }
        if (tolower(t) ~ /^authorization$/) tail = 1
        prev = t
        out = out (out == "" ? "" : " ") word
      }
      print out
    }'
}
gh_err_sanitize() {
  local raw=$1 total kept shown
  total=$(printf '%s' "$raw" | grep -c '' || true)
  [[ -z "$raw" ]] && { printf 'gh は何も言いませんでした（stderr が空でした）'; return; }
  # **注意: `\` で続く行の途中にコメントを書けない**（bash は `|` を見つけられず
  # `syntax error near unexpected token` で落ちる。**実測で 297 件全部が落ちた**）。
  kept=$(printf '%s' "$raw" \
    | head -n "$GH_ERR_MAX_LINES" \
    | gh_err_allow \
    | cut -c "1-$GH_ERR_MAX_CHARS" \
    | tr '\n' '/' )
  kept=${kept%/}
  # **`[すべて除去されました]` と「空」を区別する**——**空のまま出すと
  # 「gh は何も言わなかった」と読まれる**（それは別の事実である）。
  # **空になる形は実在する**: **ASCII 以外だけで綴られた stderr**
  # （`gh_err_sanitize 'パスが見つかりません'` → これ）。
  [[ -z "$kept" ]] && kept='[すべて除去されました]'
  # **実際に出した行数を言う**（**`GH_ERR_MAX_LINES` をそのまま書くと、
  # 1 行しか無いときに「3 行のうち先頭 3 行」と嘘になる**）。
  shown=$GH_ERR_MAX_LINES
  [[ "$total" -lt "$shown" ]] && shown=$total
  printf '%s（gh の stderr %s 行のうち先頭 %s 行）' "$kept" "$total" "$shown"
}

# gh_err_class <生の stderr> → `permission` / `transient` / `unknown`
#
# **3 値である理由**: **「分からない」を「一時的」に倒すと #1168 の誤診が再現する。**
# **倒す向きが非対称**——「一時的」と言われた人は待つ（＝閉じる）が、
# **「分からない」と言われた人は調べる。** **だから分からないときは分からないと言う。**
#
# **分類の根拠は `gh` が実際に言う文面である**（#1210 の受け入れ条件 1。**実測した**。gh 2.89.0）:
#   GH_TOKEN=<無効な値> gh api graphql -f query='query{ viewer{ login } }'
#     → `gh: Bad credentials (HTTP 401)`
#   gh api repos/torvalds/linux/actions/secrets
#     → `gh: You must have repository read permissions or ... (HTTP 403)`
#   gh api graphql -f query='query{ node(id:"<存在しない PVT_ id>"){ ... } }'
#     → `gh: Could not resolve to a node with the global id of '...'`
# **`gh` は HTTP の状態を行末の括弧に入れる**——**`HTTP 401:` ではなく `(HTTP 401)` である。**
# **だから照合は部分一致にする**（`*"HTTP 401"*`）。**前置きを仮定すると当たらない。**
#
# **3 つめは `unknown` に落ちる。それが正しい。**
# **GraphQL は「見る権限が無いノード」を「存在しないノード」として隠す**ので、
# **この文面は「権限が無い」の症状でもありうるが、確定しない。**
#
# **測れていないこと（正直に）**: **`secrets.GITHUB_TOKEN` そのもので叩いた結果は測っていない。**
# **手元には `project` スコープを持つ PAT しか無く、それで叩くと `totalCount:495` / rc=0 が返る**
# ——**これがこの PBI の原因そのもの**（**より強い権限の計器に取り替えて緑を見ていた**）。
# **だから「`GITHUB_TOKEN` では権限が無くて読めない」は #1210 の本文の推測のままで、
# ここでも未証明である。** **この道具は次に CI で失敗したときに、自分でその答えを出す。**
#
# **文面は gh のバージョンで変わりうる**ので、**当たらなければ `unknown` に落ちる**
# （`permission` や `transient` を既定にしない。**既定は推測である**）。
gh_err_class() {
  local raw=$1
  [[ -z "$raw" ]] && { printf 'unknown'; return; }
  case "$raw" in
    # **rate limit を先に見る**（**`HTTP 403` より前**）。**順番が意味を持つ**:
    # **GitHub は rate limit を `HTTP 403` で返す**ので、`HTTP 403` を先に書くと
    # **「待てば直るもの」を「権限が足りません」と断言してしまう**
    # ——**#1168 の誤診の鏡像**（向きは逆だが、同じ「断言が間違っている」形である）。
    # **テストが実測で捕まえた**（fixture: `gh: HTTP 403: API rate limit exceeded ...`）。
    *"rate limit"*|*"abuse detection"*|*"secondary rate"*) printf 'transient'; return ;;
    # **権限・スコープ・認証**（**待っても直らない側**）
    *"required scopes"*|*"has not been granted"*|*"read:project"*|*"read:org"*) printf 'permission'; return ;;
    *"HTTP 401"*|*"Bad credentials"*|*"HTTP 403"*|*"Resource not accessible"*) printf 'permission'; return ;;
    *"INSUFFICIENT_SCOPES"*|*"FORBIDDEN"*|*"Must have admin rights"*) printf 'permission'; return ;;
    # **一時的に返らなかった側**（**待てば直る**）
    *"HTTP 50"*|*"timeout"*|*"timed out"*|*"Something went wrong while executing your query"*) printf 'transient'; return ;;
    *"connection refused"*|*"no such host"*|*"EOF"*) printf 'transient'; return ;;
  esac
  printf 'unknown'
}

# gh_err_verdict <class> → 読む人に行動を伝える一文
#
# **「権限が無い」と「返らなかった」が読み分けられること**が #1210 の受け入れ条件 3 である。
gh_err_verdict() {
  case "$1" in
    permission) printf '**権限が足りません。この環境では構造的に測れません**（待っても直りません。トークンの射程を変えるしかありません）' ;;
    transient)  printf '**一時的に返らなかった疑いです**（次の実行で直るなら一時障害です。続くなら一時的ではありません）' ;;
    # **ここに「一時的」という語を書かない**（**書くと `transient` の文と区別できなくなる**）。
    # **読み分けるのは人間だけである**（#1217 のレビューで実測。初版のここには
    # 「`scrum-monitor-report.sh` と読む人の両方が、語で読み分けている」と書いて在ったが、
    # **`scrum-monitor-report.sh` はこれらの語を 1 か所も grep していない**:
    #   grep -c '一時的\|構造的\|permission\|transient\|unknown\|分類' scripts/po/scrum-monitor-report.sh
    #     → **0**（母数: 同ファイル 143 行）
    # **機械の制約だと書くと、次に触る人が在りもしない制約に縛られる**——[[verify-before-citing]]）。
    # **語を固定しているのは `scrum-monitor.test.sh` の `assert_not_contains` である**
    # （`t_mon_classifier_table` が 10 通りについて、出てほしい語と出てはいけない語を両方向に固定する）。
    *)          printf '**原因を分類できませんでした**（待てば直るとも、権限の不足とも、まだ言えません。下の gh の言い分を読んでください）' ;;
  esac
}

# ---- 1. 開いている PR の赤い検査 --------------------------------------------------------------
#
# **`--paginate` が必要である**（#1093 で実測。**#1116 で必須 5 件が丸ごと消えた**）:
#   gh api ".../check-runs"            → returned 30 / total_count 53
#   gh api ".../check-runs" --paginate → returned 53 / total_count 53
# **30 件で消えていたのは branch protection の必須 4 件 + `pr-closes` の全部**だった。
# **消えた検査は「無い」ものとして扱われる**ので、**赤がそこに居れば黙って「赤 0 件」になる。**
#
# **`--paginate` だけでは足りない**（#1093、gh 2.89.0）:
#   **`--paginate` はオブジェクト応答を 1 個の JSON に畳まない**——**ページごとに 1 個の
#   JSON ドキュメントを並べて吐く。** `-q` を付けると **jq がドキュメントごとに走る**ので
#   `group_by` の畳み込みがページ境界をまたげない。**だから生 JSON を受けて `jq -s` で束ねる。**
#
# **母数の検算**（#757）: **`total_count` より少ない run しか手元に無いなら取りこぼしている。**
# **そのときは「赤 0 件」と言わず、`MONITOR-BROKEN` にする**——
# **これは監視なので、`merge-when-green.sh` のように die して止まる必要は無い**
# （止めると残りの節が測れなくなる）。**節として「測れなかった」に落とす。**
# `total_count` が**無い**応答では検算しない（「母数を知らない」と「取りこぼした」は別。
# 無いだけで壊れたと言うと、この道具が別の理由で鳴り続ける）。
#
# **同名の check-run をどう畳むか**——**`merge-when-green.sh` に合わせて `max_by(severity)`
# （最も悪いものを採る）にする。** **これは意図的な設計であって、真似られる欠陥ではない**:
#   `scripts/po/merge-when-green.sh` の `fetch_checks()` に逐語で在る:
#       「悪い順の重み。**同名グループからこれが最大の 1 件を採る**（fail が緑に塗り替えられない）」
#   **なぜ monitor も合わせるのか**: **この監視の役目は「マージが止まっている PR を PO に
#   見せること」である。** **ゲートが赤と見るものを monitor が緑と見たら、
#   PO には「詰まっていない」ように見えて、実際には詰まる。**
#   **食い違うほうが害が大きい**ので、**ゲートと同じ目で見る。**
#
#   **#1128 の限界をそのまま引き継ぐ**（あちらが未解決なのでここでも未解決である）:
#     同名が「古い失敗 → 新しい成功」で並ぶと、**直して緑にした PR も赤に見える。**
#     **実測（2026-09-29、直近 40 件のマージ済み PR の head、check-run 324 件）:**
#       同名が 2 件以上在った head          **4 / 40**
#       そのうち結論が食い違った head        **1 / 40**（PR #1131 の `pr-closes`:
#                                            failure@02:47 → success@03:08）
#     **つまり 40 件に 1 件は「直したのに赤と出る」。** **これは誤報だが、
#     ゲートが実際にその PR を止めるので、事実としては正しい**——
#     **「PO が行動する必要が在る」ことは合っている**（#1128 を進めるか、本文を直し直す）。
#     **#1128 が決着したら、両方を同時に直すこと**（片方だけ変えると食い違いが戻る）。
#
# **`skipped` の扱い**: **`merge-when-green.sh` は `SKIPPABLE_CHECKS` に列挙された名前だけを
# 緑と数える**（#1069。**必須 5 件が全部 `skipped` の PR が「全部緑」でマージされた**）。
# **monitor はその一覧を複製しない**——**複製すると 2 か所が食い違う**。
# **代わりに `skipped` を「赤」にも「緑」にも数えず、別の列として出す。**
# **monitor はマージを決めないので、判断を持つ必要が無い**（持つと二重管理になる）。
pr_section() {
  local list prs=0 red_prs=0 pending_prs=0 broken=0 runs_seen=0 runs_want=0
  # **`gh` の stderr を捨てずに受ける器**（#1210。ボードの節と同じ）。
  local gh_err_file gh_err gh_cls
  # **`die` は exit 1 で、この道具の 0/2/3/4 のどれでもない。** **それでよい**（確かめた）:
  # **`scrum-monitor-report.sh:133` が「知らない終了コードは測れていない」として Issue を立てる**
  # ——**黙って緑にならない。** **`unmeasured` に落とさない理由**: `mktemp` が失敗する環境では
  # 残りの節も測れないので、節単位の「測れなかった」より「道具が動かない」のほうが事実に近い。
  gh_err_file=$(mktemp) || die "一時ファイルを作れませんでした"
  # shellcheck disable=SC2064  # 展開は今やる（この関数を抜けるときに消したい）
  trap "rm -f '$gh_err_file'" RETURN

  if ! list=$(gh pr list --repo "$REPO" --state open --limit 200 \
      --json number,headRefOid,isDraft --jq '.[] | [(.number|tostring), .headRefOid, (.isDraft|tostring)] | @tsv' 2>"$gh_err_file"); then
    # **元の文は「gh の認証切れ／rate limit かもしれません」と原因を推測していた**（#1210）。
    # **推測を残すのが一番悪い**——**読む人は「かもしれません」を結論として受け取る。**
    # **#1168 を閉じた理由がまさにそれである。** **gh が言っていることを出す。**
    gh_err=$(cat "$gh_err_file" 2>/dev/null || true)
    gh_cls=$(gh_err_class "$gh_err")
    unmeasured "PR: 開いている PR の一覧が取れませんでした。$(gh_err_verdict "$gh_cls") gh の言い分: $(gh_err_sanitize "$gh_err")"
    return
  fi

  local num sha draft raw got want collapsed collapsed_n red pending skipped
  while IFS=$'\t' read -r num sha draft; do
    [[ -n "$num" && -n "$sha" ]] || continue
    prs=$((prs+1))

    # **終了コードで応答を捨てない**（#1116 のレビューで見つかった形。**PO も再現した**）。
    # **gh は「赤いチェックを含む応答を出しきってから非ゼロで終わる」ことがある**ので、
    # 捨てると**赤を読まずに「読めなかった」に倒れる。**
    raw=$(gh api "repos/$REPO/commits/$sha/check-runs" --paginate 2>/dev/null) || true

    if ! got=$(jq -s '[.[].check_runs[]] | length' <<<"$raw" 2>/dev/null); then
      log "MONITOR-BROKEN PR #$num: check-runs の応答が読めませんでした（空か壊れた JSON）"
      broken=$((broken+1)); continue
    fi
    want=$(jq -rs 'map(.total_count) | map(select(. != null)) | if length == 0 then "null" else .[0] end' <<<"$raw" 2>/dev/null || echo null)
    runs_seen=$((runs_seen+got))
    if [[ "$want" != "null" ]]; then
      is_int "$want" && runs_want=$((runs_want+want))
      if [[ "$got" -lt "$want" ]]; then
        # **取りこぼしたら「赤 0 件」と言わない**（#757 / #1093）。
        log "MONITOR-BROKEN PR #$num: check-runs を取りこぼしました（手元 $got 件 / total_count $want 件）。**赤を見落としている可能性が在ります**"
        broken=$((broken+1)); continue
      fi
    fi

    # **`max_by(severity)` で同名を畳む**（`merge-when-green.sh` と同じ目。上の docblock）。
    # **`// 2` は fail-closed**: `{...}[key]` は知らないキーで null を返し、
    # **`max_by` は null を最小として扱う**ので、表が痩せたらその bucket が消える。
    # **分からないものは fail の重みに倒す。**
    # **これは単独では変異で殺せない防御である**（`merge-when-green.sh` が同じことを実測して
    # 書いている: `// 2` → `// 0` でも 0 件落ちた）。**保険であって、測って裏づけた防御ではない。**
    # shellcheck disable=SC2016  # jq の変数。シェルに展開させない
    collapsed=$(jq -rs '
      def bucket_of:
        if .conclusion == null then "pending"
        elif (.conclusion == "success" or .conclusion == "neutral") then "pass"
        elif .conclusion == "skipped" then "skipped"
        else "fail" end;
      def severity: ({"pass": 0, "skipped": 1, "pending": 2, "fail": 3}[bucket_of]) // 3;
      # **`started_at` を落とさずに持つ。** **使っていないのに残す理由が在る**（実測）:
      # **これを落とすと、変異テストが `max_by(severity)` の正しさを測れなくなる。**
      #   投影が `{name, conclusion}` だったとき:
      #     max_by(severity)     → fail   ← 正しい
      #     max_by(.started_at)  → fail   ← **偶然一致する**（`.started_at` が全要素 null になり、
      #                                     `max_by` は同値のとき**最後の要素**を返す。
      #                                     fixture の最後が failure だったので偶然 fail）
      #   投影が `{name, conclusion, started_at}` なら:
      #     max_by(severity)     → fail
      #     max_by(.started_at)  → **pass** ← 2 つの設計が実際に分かれる
      # **つまり `started_at` が無いと「畳み方を取り替える変異」が生き残る**
      # ——**テストが常に緑になり、設計を守っていないのに守っているように見える。**
      [.[].check_runs[] | {name, conclusion, started_at}]
      | group_by(.name) | map(max_by(severity)) | .[] | bucket_of
    ' <<<"$raw" 2>/dev/null) || collapsed=""

    red=$(printf '%s\n' "$collapsed" | grep -c '^fail$' || true)
    pending=$(printf '%s\n' "$collapsed" | grep -c '^pending$' || true)
    skipped=$(printf '%s\n' "$collapsed" | grep -c '^skipped$' || true)
    # **畳んだ後の件数**（= 名前の異なる検査の数）。**出力に出す理由が 2 つ在る**:
    #   1. **人に有用**: 「検査 10 件のうち赤 1 件」より
    #      「別名 8 件に畳んで赤 1 件（生 10 件）」のほうが、再実行が在ったことが分かる。
    #   2. **これが無いと畳み込みの鍵を変異で殺せない**（#1150 のレビュー N2。**実測**):
    #      `group_by(.name)` → `group_by(.conclusion)` は
    #      **赤の数を変えず、緑の数だけ変える**（fail 1/pass 2 → fail 1/pass 1）。
    #      **緑の数を出力に出していなかったので、0 件落ちて素通りした。**
    #      **「測れるように出力を足す」ほうが、測れない防御を持つより良い。**
    collapsed_n=$(printf '%s\n' "$collapsed" | grep -c . || true)

    if [[ "$red" != 0 ]]; then
      red_prs=$((red_prs+1)); FINDINGS=$((FINDINGS+1))
      log "赤 PR #$num: 赤 $red 件・実行中 $pending 件・skipped $skipped 件（別名 $collapsed_n 件に畳みました。検査 $got/$want 件${draft:+ , draft=$draft}）"
    elif [[ "$pending" != 0 ]]; then
      pending_prs=$((pending_prs+1))
    fi
  done <<< "$list"

  # **母数を必ず出す**（#757）。**「赤 0 本」と「PR を 1 本も見ていない」を同じ顔にしない。**
  log "PR $prs 本を見ました: 赤 $red_prs 本 / 実行中 $pending_prs 本 / 測れなかったもの $broken 本（check-run 計 $runs_seen 件 / total_count 計 $runs_want 件）"
  if [[ "$broken" != 0 ]]; then
    unmeasured "PR: $prs 本のうち $broken 本の検査を測れていません（**赤 $red_prs 本は下限です**）"
  else
    SECTIONS_OK=$((SECTIONS_OK+1))
  fi
}

# ---- 2. In Progress のまま動いていない PBI ----------------------------------------------------
#
# **`board-audit.sh` の規則 5 とは別のものを見る**（**二重管理ではない**）:
#   board-audit 規則 5  `In Progress` **なのに枝も PR も無い**（$STALE_HOURS 既定 24 時間）
#                       = **着手されていない**（#781: 担当者を立て忘れた形）
#   ここ                `In Progress` で**動いている痕跡は在るが、最近動いていない**
#                       （既定 90 分）= **途中で止まった**
# **前者は「始まっていない」、後者は「止まった」である。** **#1110 が起きたのは後者だ。**
#
# **何を「最近動いた」の代理にするか**: **Issue の `content.updatedAt`。**
# **`gh` から見えるものだけを使う**——**worktree は PO の手元にしか無いので、
# CI からは測れない**（この節が CI でも動くことが #1110 の受け入れ条件「自動の入口」に要る）。
#
# **`board-audit.sh` とは違う時刻を読んでいる。意図的である**（**実測して選んだ**）:
#   board-audit  `fieldValueByName.updatedAt` = **Status を最後に変えた時刻**
#   ここ         `content.updatedAt`          = **Issue が最後に触られた時刻**
#
# **実測（2026-09-30、ボードの In Progress 7 件。両方を同時に読んで引き算した）:**
#   ```
#   issue  content.updatedAt      status.updatedAt       差（content - status、分）
#   867    2026-09-24T05:01:04Z   2026-09-13T19:39:14Z   **+14961**
#   1110   2026-09-29T18:35:23Z   2026-09-29T20:07:13Z   -91
#   1123   2026-09-28T16:41:55Z   2026-09-29T20:07:22Z   **-1645**
#   1125   2026-09-28T17:16:10Z   2026-09-29T20:07:19Z   **-1611**
#   1129   2026-09-28T20:02:29Z   2026-09-29T20:20:12Z   **-1457**
#   1137   2026-09-29T19:52:40Z   2026-09-29T20:07:10Z   -14
#   1140   2026-09-29T20:10:15Z   2026-09-29T20:13:06Z   -2
#   ```
#   **7 件のうち 6 件で `status.updatedAt` のほうが新しく、差は最大 27 時間あった。**
#   **`status.updatedAt` を使うと、#1123 / #1125 / #1129 は「2 分前に動いた」ことになる**
#   ——**実際には Issue が 1 日以上触られていない。** **ボードを一括で触った操作で
#   Status の時刻だけが新しくなる**ので、**停滞を見る目的には使えない。**
#   **逆に #867 は content のほうが 10 日新しい**（Status は 9/13 のまま、Issue は 9/24 に触られた）
#   ——**こちらは「Status を変えてから長い」を見る board-audit の目的には合う。**
# **目的が違うので読む時刻も違う。** **どちらかに統一してはいけない。**
#
# **【#1150 のレビューで直した】Issue の静けさだけでは代理にならない。**
#
# **最初の実装は `content.updatedAt` だけを見ていた。** **レビュアーが枝名で Issue↔PR を
# 突き合わせて測り、誤報率 83%（6 件中 5 件）だった:**
#   ```
#   #1110 / #1123 / #1125 / #1129 / #1137
#     → Issue は 676〜2,307 分静かだが、**対応する PR は 0〜10 分前に触られていた**
#   真の停滞は #867 の 1 件だけ
#   ```
# **これは閾値の問題ではない。** **閾値を 10 倍にしても 4 件は依然鳴る。**
# **担当者は PR の上で作業しており、Issue は触らない**——**それが普通の進め方である。**
#
# **担当者が自分で「対応表が無いので PR を見ていない」と書いていた**（#1150 の自己申告 4）。
# **レビュアーは枝名で対応表を作れることを示した。** **いまはそれを使う。**
#
# **いまの代理**: **Issue の `updatedAt` と、その番号を持つ PR の `updatedAt` の、
# 新しいほう。** **どちらかが動いていれば「動いている」と見る。**
#   - 対応づけは**枝名**で行う（`<type>/<番号>-<slug>` と `<番号>-<slug>`）。
#     **`board-audit.sh` の痕跡集め（規則 5）とまったく同じ正規表現を使う**
#     ——**2 か所で違う綴りにすると、片方だけが対応を見つける。**
#   - **PR は open だけでなく closed も見る**（**マージ直後の PBI が
#     「Issue が静か」で鳴るのを防ぐ**）。
#   - **対応する PR が 1 本も無いものは、Issue の時刻だけで判断する**
#     （**それは board-audit 規則 5 の領分**＝「着手されていない」なので、
#     ここでは鳴らしてよい。**#867 がまさにその形だった**）。
#
# **実測（直した後。下の「誤報の検算」の節に、走らせるたびの数字が出る）:**
#   **#1137 は Issue が 717 分静かだが PR #1142 が 51 分前 → 鳴らなくなった。**
#   **#867 は対応する PR が無く 8,809 分静か → 鳴り続ける（真の停滞）。**
#
# **残る代理の限界（正直に）**: **`updatedAt` はコメントやラベルでも動く。**
# **「PR に 1 行コメントしただけ」は「進んだ」と数えられてしまう。**
# **これは誤って黙る側の誤り**で、**誤って鳴る側より軽いと判断した**
# （**鳴り続ける監視は見られなくなる**。`worktree-audit.sh` の同じ判断に倣う）。
# **これは代理であって実体ではない**（`docs/WORKING_AGREEMENT.md` の「代理と実体」）。
#
# ---- なぜ「停滞」と断定せず「判定不能」と出すのか（**PR の赤や幽霊とは違う扱い**）------------
#
# **PR を見ても、まだ足りない。** **調べている担当者と、読んでいるレビュアーは、
# Issue も PR も触らない。** 隣のプロジェクトが同じ問題を先に踏んで、実測で表にしている:
#   ```
#   実態                        外形
#   調査中（ファイルを書かない）  何も現れない
#   レビュー中（読むだけ）        何も現れない
#   成果物をコミット済み          作業ツリーはクリーン
#   worktree が残骸              稼働中に見える（**逆向きの誤り**）
#   ```
# **向こうの道具は、サブエージェント 2 体が稼働中に「STOPPED の疑い」と出した。**
# **向こうの結論**: **`ListAgents` は Claude Code のツールで CLI ではないので、
# スクリプトから呼べない。** **つまり外形だけでは原理的に稼働数が分からない。**
# **「測れないなら『判定不能』と出すのが正しい」。**
#
# **これはこの道具にもそのまま当たる。** **`scrum-monitor.sh` も `ListAgents` を呼べない**ので、
# **「Issue も PR も静か」から「作業が止まっている」を導く経路は、原理的に埋まらない。**
# **枝名で PR を突き合わせたのは改善だが、埋まったわけではない。**
#
# **だから断定をやめた。** **この道具の設計は既に「測れた／測れなかった」を分けている**
# （上の母数・`MONITOR-BROKEN`・「黙って 0 を出さない」）のに、
# **停滞の判定だけがその仕組みの外に在って断定していた。** **揃えた。**
#
#   Issue も PR も静か                → **判定不能**（報告する。人が ListAgents で確定させる）
#   Issue は静かだが PR が動いている    → 動いている（報告しない）★ ここが誤報 83% だった
#   対応する PR が 1 本も無い          → **判定不能**（着手されていない疑い。規則 5 の領分）
#
# **「判定不能」は見出しに出す。注記に逃がさない。** **向こうの実測がその理由である**:
# **「注記に『ListAgents で確定させよ』と書いてあるのに、赤字で『STOPPED の疑い』と出るので
# 注記が読まれない」。** **断定的な見出しが先に読まれる。**
#
# **報告はやめない**（`FINDINGS` に数え、exit 3 に寄与する）。**PO が見る必要は在る**
# ——**ただし「止まっている」ではなく「確かめてほしい」として出す。**
# **83% が誤報なら、読む人は 3 回目で読まなくなる**（#1132 の
# 「無害な赤が並ぶと本物を見落とす」と同じ）。
PROJECT_ID="PVT_kwHOBy0CLs4BhHqj"   # 議員レコード スクラムボード (project 2)。board-set.sh / board-audit.sh と同じ値

# issue_number_from_branch — 枝名から Issue 番号を取り出す（無ければ空）。
#
# **`board-audit.sh` の規則 5 とまったく同じ正規表現である**（**逐語で同じにしてある**）:
#   `<type>/<番号>-<slug>` と、type の無い `<番号>-<slug>` の両方を拾う。
# **2 か所で違う綴りにすると、片方だけが対応を見つけて数字が食い違う。**
issue_number_from_branch() {
  printf '%s\n' "$1" | sed -nE 's|^([a-z]+/)?([0-9]+)-.*$|\2|p'
}

board_section() {
  local page cursor="" has_next next_cursor first_line
  # **`gh` の stderr を捨てずに受ける器**（#1210）。`mktemp` は失敗しうるので `||` で落とす。
  local gh_err_file gh_err gh_cls
  gh_err_file=$(mktemp) || die "一時ファイルを作れませんでした"
  # shellcheck disable=SC2064  # 展開は今やる（この関数を抜けるときに消したい）
  trap "rm -f '$gh_err_file'" RETURN
  local -a NUMS=()
  local items=0

  local -A PR_SEEN=()      # issue 番号 → その番号を持つ PR の最新 updatedAt（epoch）
  local -A PR_WHICH=()     # issue 番号 → その PR 番号（ログに出す）
  local pr_lookups=0 pr_matched=0 pr_lookup_failed=0
  local pr_err_first=""    # PR 検索が失敗したときの `gh` の言い分（**最初の 1 件だけ**。#1210）

  # shellcheck disable=SC2016  # $cursor / $project は GraphQL の変数
  local Q='query($project:ID!,$cursor:String){ node(id:$project){ ... on ProjectV2 {
    items(first:100, after:$cursor){ totalCount pageInfo{ hasNextPage endCursor }
      nodes{ content{ ... on Issue { number state updatedAt } }
        fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }'

  # **空のフィールドを `-` で埋める**（`// "-"`）。**これは飾りではない。**
  #
  # **`read` は tab を IFS の空白として扱うので、連続した tab を 1 個に畳む**（実測）:
  #   $ printf 'a\t\tb\n' | while IFS=$'\t' read -r x y z; do echo "[$x][$y][$z]"; done
  #     → **[a][b][]**   ← `y` に `b` が入り、**以降のフィールドが 1 つずつ前にずれる**
  # **つまり `updatedAt` が null の項目では、Status が `updated` に入って読まれる。**
  # **その項目は Status の照合に落ちるので、`In Progress` から黙って消える**
  # ——**「測っていないのに In Progress 0 件」**という、この道具が存在する理由そのものの形になる。
  # **実測でこの穴に落ちた**（`t_mon_board_bad_timestamp` が最初に落ちたのはこれである）。
  # **`-` は ISO 8601 でも Status の名前でもない**ので、どちらの列でも「値が無い」を意味できる。
  # **【#1150 のレビュー N8 で足した】`totalCount` と取得件数を突き合わせる。**
  #
  # **レビュアーの実測**: **ページングを打ち切ると 457 件中 357 件が消え、
  # 「In Progress 0 件」で exit 0 になった。** **これはこの PBI が直そうとしている問題そのもの**
  # ——**`unmeasured()` を入れたのに、ページングの経路には掛かっていなかった。**
  # **PO も同じ形を踏んでいる**（`gh project item-list --limit 300` が 450 件のうち
  # 300 件だけ返し、「Ready が 0 件」と誤判定した）。
  # **`--paginate` の `total_count` の検算（PR の節）と同じことを、ボードにもやる。**
  local num state updated status want_total=""
  while :; do
    # **ページングを打ち切らない**（打ち切ると「載っていない」の誤検出になる。board-audit.sh と同じ）
    if ! page=$(gh api graphql -f query="$Q" -F project="$PROJECT_ID" -F cursor="$cursor" \
        --jq '[(.data.node.items.pageInfo.hasNextPage|tostring), (.data.node.items.pageInfo.endCursor // "-"),
               ((.data.node.items.totalCount // "-")|tostring)],
              (.data.node.items.nodes[] | select(.content.number != null)
                | ["item", (.content.number|tostring), (.content.state // "-"), (.content.updatedAt // "-"),
                   (.fieldValueByName.name // "-")])
              | @tsv' 2>"$gh_err_file"); then
      # **`gh` の言い分を捨てない**（#1210。**`2>/dev/null` に戻すと検査が落ちる**）。
      # **原因が読めないと、読んだ人は「たぶん一時障害」と推測する**
      # ——**PO は実際にそう推測して #1168 を閉じ、87 分後に #1203 が立った。**
      gh_err=$(cat "$gh_err_file" 2>/dev/null || true)
      gh_cls=$(gh_err_class "$gh_err")
      unmeasured "board: スクラムボードが読めませんでした。$(gh_err_verdict "$gh_cls") gh の言い分: $(gh_err_sanitize "$gh_err")"
      return
    fi
    first_line=1; has_next="false"; next_cursor=""
    while IFS=$'\t' read -r a b c d e; do
      if [[ "$first_line" == 1 ]]; then
        has_next="$a"; next_cursor="$b"
        # **`totalCount` はどのページでも同じ値を返す**ので、最初の 1 つを母数とする。
        [[ -z "$want_total" && -n "$c" && "$c" != "-" ]] && want_total="$c"
        first_line=0; continue
      fi
      [[ "$a" == "item" ]] || continue
      items=$((items+1))
      num="$b"; state="$c"; updated="$d"; status="$e"
      [[ "$state" == "OPEN" && "$status" == "In Progress" ]] || continue
      NUMS+=("$num"$'\t'"$updated")
    done <<< "$page"
    [[ "$has_next" == "true" && -n "$next_cursor" ]] || break
    [[ "$next_cursor" == "-" ]] && break
    cursor="$next_cursor"
  done

  # **母数の検算**（N8）。**`totalCount` より少ない項目しか手元に無いなら取りこぼしている。**
  # **「In Progress 0 件」と言わずに「測れなかった」と言う。**
  # **`totalCount` が取れない応答では検算しない**——「母数を知らない」と「取りこぼした」は別で、
  # 無いだけで止めるとこの節が別の理由で鳴り続ける（PR の節の `total_count` と同じ扱い）。
  if [[ -n "$want_total" ]] && is_int "$want_total" && [[ "$items" -lt "$want_total" ]]; then
    log "MONITOR-BROKEN board: 項目を取りこぼしました（手元 $items 件 / totalCount $want_total 件）"
    unmeasured "board: ボードの項目を取りこぼしました（手元 $items 件 / totalCount $want_total 件）。**In Progress を数え切れていないので、停滞 0 件を「異常なし」と読まないでください**"
    return
  fi

  # ---- 対応する PR の最終更新を集める（誤報 83% の直し。上の docblock）------------------------
  #
  # **In Progress のものだけ引く。** **全 PR を取らない**——**実測でこの repo には PR が 696 本在り、
  # `--limit 400` では足りず、しかも増え続ける。** **「上限に達したら測れていない」と言い続ける
  # 監視は、鳴り続ける監視と同じで見られなくなる。** In Progress は実測 2〜8 件なので、
  # **1 件ずつ引くほうが確実で、母数も言い切れる。**
  #
  # **`--search "<番号> in:head"` は部分一致である**（実測。**必ず自分で照合し直す**）:
  #   $ gh pr list --search "1137 in:head"
  #     1142  ci/1137-split-build-deploy   ← 当たり
  #     1150  feat/1110-scrum-monitor      ← **外れ（1137 を含まない）**
  #     698   fix/693-pdf-table-ctm        ← **外れ**
  # **だから `issue_number_from_branch` で取り出した番号が一致するものだけを採る。**
  # **検索を信用しない**（検索が広すぎるのは安全側だが、狭すぎたら誤報に戻るので下で数える）。
  #
  # **open だけでなく closed も見る**（`--state all`）——**マージ直後の PBI が
  # 「Issue が静か」で鳴るのを防ぐ。**
  local ip_num ip_row
  local pn br pup n pts
  local pr_rows
  for ip_row in "${NUMS[@]+"${NUMS[@]}"}"; do
    ip_num="${ip_row%%$'\t'*}"
    pr_lookups=$((pr_lookups+1))
    if ! pr_rows=$(gh pr list --repo "$REPO" --state all --limit 100 \
        --search "$ip_num in:head" --json number,headRefName,updatedAt \
        --jq '.[] | [(.number|tostring), (.headRefName // "-"), (.updatedAt // "-")] | @tsv' 2>"$gh_err_file"); then
      # **引けなければ「PR が無い」と混同しない**（#757）。**数えて、最後に測れなかったと言う。**
      pr_lookup_failed=$((pr_lookup_failed+1))
      # **`gh` の言い分は最初の 1 件だけ覚える**（#1210）。
      # **In Progress が 8 件在れば 8 回同じことを言うので、Issue 本文が同じ文で埋まる**
      # ——**鳴り続ける監視は見られなくなる**（`worktree-audit.sh` と同じ理由）。
      # **「最初の 1 件だけ」と断ること**。**件数は下の母数で別に出る。**
      [[ -z "$pr_err_first" ]] && pr_err_first=$(cat "$gh_err_file" 2>/dev/null || true)
      continue
    fi
    while IFS=$'\t' read -r pn br pup; do
      [[ -n "$pn" ]] || continue
      n=$(issue_number_from_branch "$br")
      # **検索の結果を自分で照合し直す**（上の実測。部分一致で外れが混ざる）
      [[ "$n" == "$ip_num" ]] || continue
      pts=$(date -u -d "$pup" +%s 2>/dev/null) || continue
      is_int "$pts" || continue
      # **同じ Issue に複数の PR が在れば、いちばん新しいものを採る**
      # （#512 の形: 1 つの Issue に PR が 2 本立つことが実際にある）
      if [[ -z "${PR_SEEN[$ip_num]:-}" || "$pts" -gt "${PR_SEEN[$ip_num]}" ]]; then
        PR_SEEN["$ip_num"]=$pts; PR_WHICH["$ip_num"]=$pn
      fi
    done <<< "$pr_rows"
    [[ -n "${PR_SEEN[$ip_num]:-}" ]] && pr_matched=$((pr_matched+1))
  done

  local inprogress=0 undecidable=0 unknown=0 saved_by_pr=0 no_pr=0 ts age
  local pr_ts pr_age last_ts last_src
  for row in "${NUMS[@]+"${NUMS[@]}"}"; do
    inprogress=$((inprogress+1))
    num="${row%%$'\t'*}"; updated="${row#*$'\t'}"
    # **時刻が取れなければ鳴らさず、数えて出す**（#757。取れないことを鳴らすと全件鳴る）。
    # **`-` は上の jq が埋めた「値が無い」の印**（tab の畳み込み対策。上の docblock）。
    if [[ -z "$updated" || "$updated" == "-" ]] || ! ts=$(date -u -d "$updated" +%s 2>/dev/null) || ! is_int "$ts"; then
      unknown=$((unknown+1)); continue
    fi

    # **Issue と PR の、新しいほうを「最後に動いた時刻」とする**（誤報 83% の直し）。
    # **どちらかが動いていれば動いている。**
    last_ts=$ts; last_src="Issue"
    pr_ts="${PR_SEEN[$num]:-}"
    if [[ -n "$pr_ts" ]]; then
      if [[ "$pr_ts" -gt "$last_ts" ]]; then last_ts=$pr_ts; last_src="PR #${PR_WHICH[$num]}"; fi
    else
      # **対応する PR が 1 本も無い**（board-audit 規則 5 の領分＝着手されていない形）。
      # **数えて出す**——**「PR が無い」と「PR が静か」は別の話である。**
      no_pr=$((no_pr+1))
    fi

    age=$(( (NOW - last_ts) / 60 ))
    # **未来の時刻は 0 に丸める**（負の「N 分前」を出さない。worktree-audit.sh と同じ扱い）
    [[ "$age" -lt 0 ]] && age=0

    if [[ "$age" -ge "$STALE_MINUTES" ]]; then
      # **ここは「停滞」と断定しない。「判定不能」である**（下の docblock の理由）。
      # **見出しに出す。注記に逃がさない。**
      undecidable=$((undecidable+1)); FINDINGS=$((FINDINGS+1))
      if [[ -n "$pr_ts" ]]; then
        log "判定不能 #$num: Issue も PR #${PR_WHICH[$num]} も $age 分静かです（閾値 $STALE_MINUTES 分）。**止まったのか、調べている／読んでいるだけなのか、この道具では区別できません**"
      else
        log "判定不能 #$num: Issue が $age 分静かで、**対応する PR が 1 本もありません**（閾値 $STALE_MINUTES 分）。**着手されていない疑い**（board-audit.sh の規則 5 が本筋）"
      fi
    elif [[ "$last_src" != "Issue" ]]; then
      # **Issue は静かだが PR が動いていたので鳴らさなかった**——**その件数を出す。**
      # **これが誤報 83% だった分である。** **黙って救うと「なぜ鳴らないか」が分からない。**
      pr_age=$(( (NOW - ts) / 60 ))
      saved_by_pr=$((saved_by_pr+1))
      log "動いている #$num: Issue は $pr_age 分静かですが ${last_src} が $age 分前に動いています（鳴らしません）"
    fi
  done

  log "ボードの項目 $items 件を見ました（totalCount ${want_total:-不明}）: In Progress $inprogress 件（**判定不能 $undecidable 件** / PR が動いていて鳴らさなかったもの $saved_by_pr 件 / 対応する PR が無いもの $no_pr 件 / 時刻が取れなかったもの $unknown 件）"
  log "  対応表: In Progress $pr_lookups 件を 1 件ずつ引き、$pr_matched 件で PR が見つかりました（枝名で照合。引けなかったもの $pr_lookup_failed 件）"
  [[ "$undecidable" != 0 ]] && log "  **判定不能は「止まっている」ではありません。** 稼働中かどうかは ListAgents（人の手元のツール）でしか分かりません"
  if [[ "$items" == 0 ]]; then
    # **0 件は「ボードが空」ではなく「読めていない」ことのほうが多い**（#757）。
    unmeasured "board: 項目が 0 件でした。**ボードが空なのか読めていないのか区別できません**"
  elif [[ "$pr_lookup_failed" != 0 ]]; then
    # **対応表が欠けると「PR が無い」に見えて誤報に戻る**ので、測れていないと言う。
    gh_cls=$(gh_err_class "$pr_err_first")
    unmeasured "board: In Progress $pr_lookups 件のうち $pr_lookup_failed 件で PR を引けませんでした（**対応表が欠けています。判定不能 $undecidable 件は上限です**）。$(gh_err_verdict "$gh_cls") gh の言い分（最初の 1 件）: $(gh_err_sanitize "$pr_err_first")"
  elif [[ "$unknown" != 0 ]]; then
    unmeasured "board: In Progress $inprogress 件のうち $unknown 件の更新時刻が取れていません（**判定不能 $undecidable 件は下限です**）"
  else
    SECTIONS_OK=$((SECTIONS_OK+1))
  fi
}

# ---- 3. worktree（停滞と幽霊）-----------------------------------------------------------------
#
# **幽霊と残留の判定は `worktree-audit.sh` に委ねる**（#1110 の「同じ判定を 2 か所に書かない」）。
# **あちらは「読めない worktree」を数えて出す**ので、**幽霊はその数で分かる。**
# **あちらを書き換えない**——**この monitor はあちらの出力を読む側である。**
#
# **この節が足すのは「停滞」の軸だけである**（`worktree-audit.sh` が持っているのは
# 「作業中かもしれない」＝ 6 時間の印で、**意味が逆**: あちらは「触るな」を多めに付ける道具、
# こちらは「止まっている」を挙げる道具）。
#
# **パスも枝名も出さない**（OSS。上の docblock）。**本数だけ出す。**
worktree_section() {
  if [[ "${MONITOR_SKIP_LOCAL:-}" == 1 ]]; then
    # **飛ばしたことを必ず言う**（#1094。**黙って飛ばすと「正常」に見える**）。
    # **これは「測れなかった」ではなく「測らないと決めた」**なので `MONITOR-BROKEN` にしない
    # ——ただし**母数からも外す**ので、末尾の N/M が 2/2 になって区別がつく。
    log "worktree: MONITOR_SKIP_LOCAL=1 のため飛ばしました（**この環境では PO の手元の worktree は見えません**）"
    SECTIONS_TOTAL=$((SECTIONS_TOTAL-1))
    return
  fi

  local total=0 ghosts=0 stale=0 unknown=0
  local -a PATHS=()
  local wt="" line
  if ! out=$(git worktree list --porcelain 2>/dev/null); then
    unmeasured "worktree: git worktree list が失敗しました（作業ツリーの中で走っていますか）"
    return
  fi
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt="${line#worktree }"; PATHS+=("$wt") ;;
    esac
  done <<< "$out"
  total=${#PATHS[@]}

  local p last age idx_path idx_mtime
  for p in "${PATHS[@]+"${PATHS[@]}"}"; do
    if [[ ! -d "$p" ]]; then
      # **幽霊**: 登録は在るがディレクトリが無い（#1099 の変異 2 が出したもの）。
      ghosts=$((ghosts+1)); FINDINGS=$((FINDINGS+1)); continue
    fi
    # **最終更新は「HEAD のコミット時刻」と「index の mtime」の遅いほう**
    # （`worktree-audit.sh` と同じ理由: commit せずに編集し続けているツリーは HEAD が古い）。
    last=$(git -C "$p" log -1 --format=%ct 2>/dev/null || echo 0)
    is_int "$last" || last=0
    # **`rev-parse --git-path index` はメインの作業ツリーで相対パスを返す**（#1070 で実測）。
    # **相対は `$p` 基準であって cwd 基準ではない。** **cwd 基準で解くと、
    # 監視を走らせた場所で答えが変わる**（無関係な repo の index を読んだ実測が在る）。
    idx_path=$(git -C "$p" rev-parse --git-path index 2>/dev/null || true)
    [[ -n "$idx_path" && "$idx_path" != /* ]] && idx_path="$p/$idx_path"
    if [[ -n "$idx_path" && -f "$idx_path" ]]; then
      idx_mtime=$(stat -c %Y "$idx_path" 2>/dev/null || echo 0)
      is_int "$idx_mtime" && [[ "$idx_mtime" -gt "$last" ]] && last=$idx_mtime
    fi
    if [[ "$last" == 0 ]]; then
      unknown=$((unknown+1)); continue
    fi
    age=$(( (NOW - last) / 60 ))
    [[ "$age" -lt 0 ]] && age=0
    if [[ "$age" -ge "$STALE_MINUTES" ]]; then
      stale=$((stale+1)); FINDINGS=$((FINDINGS+1))
      # **パスも枝名も出さない**（OSS）。**どれかを知りたければ人が worktree-audit.sh を走らせる。**
      log "停滞 worktree: $age 分書き込みがありません（閾値 $STALE_MINUTES 分）"
    fi
  done

  log "worktree $total 本を見ました: 停滞 $stale 本 / 幽霊 $ghosts 本 / 最終更新が取れなかったもの $unknown 本"
  [[ "$ghosts" != 0 ]] && log "幽霊が $ghosts 本あります（登録は在るがディレクトリが無い）。**未 push の成果物が在りうる**ので、消す前に 'git worktree list' を人が見てください（#1087）"
  # **残留の分類は `worktree-audit.sh` の仕事**なので、**呼んで、その終了コードを伝える。**
  # **同じ判定をここに書き直さない**（#1110）。**あれは読むだけの道具である。**
  if [[ -x "$HERE/worktree-audit.sh" ]]; then
    local wa_status=0
    "$HERE/worktree-audit.sh" >/dev/null 2>&1 || wa_status=$?
    if [[ "$wa_status" == 3 ]]; then
      FINDINGS=$((FINDINGS+1))
      log "worktree-audit.sh が exit 3 を返しました: **staged に削除が在るツリーが在ります。commit すると他人の成果物が消えます**。'scripts/po/worktree-audit.sh' を人が読んでください"
    elif [[ "$wa_status" != 0 ]]; then
      unmeasured "worktree: worktree-audit.sh が exit $wa_status を返しました（残留の分類は測れていません）"
      return
    fi
  else
    unmeasured "worktree: worktree-audit.sh が見つかりません（残留の分類は測れていません）"
    return
  fi
  if [[ "$unknown" != 0 ]]; then
    unmeasured "worktree: $total 本のうち $unknown 本の最終更新が取れていません（**停滞 $stale 本は下限です**）"
  else
    SECTIONS_OK=$((SECTIONS_OK+1))
  fi
}

pr_section
board_section
worktree_section

# ---- 締め -------------------------------------------------------------------------------------
#
# **この行が無ければ、この道具は途中で死んでいる**（#1094 / #1110 の
# 「『何も言わない』と『正常』を区別できること」）。
# **`set -e` で落ちたらこの行は出ない**ので、**入口（cron / Actions）はこの行の有無を見れば
# 『監視自身が死んだ』を検出できる。** **「出力が空」＝「異常なし」と読んではいけない。**
log "scrum-monitor: 終了（節 $SECTIONS_OK/$SECTIONS_TOTAL を測れました・行動が要る事実 $FINDINGS 件）"

if [[ ${#UNMEASURED[@]} -gt 0 ]]; then
  log "MONITOR-BROKEN: 測れなかった節が ${#UNMEASURED[@]} 件あります。**この出力を『異常なし』として読まないでください**"
  printf '  - %s\n' "${UNMEASURED[@]}" >&2
  exit 4
fi
[[ "$FINDINGS" != 0 ]] && exit 3
exit 0
