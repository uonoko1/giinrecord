#!/usr/bin/env bash
# Issue #642: #505 で採らなかった枝（fix/505-probe-path-traversal）が持っていた「見本」を main に取り込む。
#
# **これは何か**: `deploy/test/nginx-headers.test.sh` が持つ**プローブ生成の門そのものを検査する**、
# 検査器の検査（#451）。悪い location を 1 つずつ食わせて「落ちること」を、
# 良い location を食わせて「通ること」を固定する。落ちる側だけ試すと、
# 正しい書き方まで落とす検査ができあがる（#451 のレビューの教訓）。
#
# **背景（#505）**: nginx-headers.test.sh は site.conf の location を機械的に拾い（#499）、
# 前方一致の location にはプローブ用のファイルを置く。その置き先が
# `mkdir -p "$ROOT$pfx"` と**無検証の文字列連結**だった時期があり、
# `location /../../probe-escaped/` を書くだけで **17 passed, 0 failed のまま $TMP の外に書けた**。
# 末尾スラッシュ無しの形は `printf 'x' > "$ROOT$pfx"` に落ちるので、**外の既存ファイルを上書きした**。
# 今の main はそこに 3 つの門を持っている:
#   入口 : location_shape_ok（**allowlist**。使ってよい文字と形だけを通す・#505）
#   出口 : assert_confined（組み立てたパスを字句解決して $ROOT の下か見る・#505）
#   実体 : assert_no_symlink_ancestor（祖先を lstat してリンクが挟まっていないか見る・#580）
#
# **なぜ「今は安全」なのに見本を置くのか**（この PBI の理由）:
# 入口の allowlist（`*[!/A-Za-z0-9._-]*) return 1 ;;`）は今、空白・改行・`~`・シェルメタ文字を
# すべて弾いている。**だが、それを緩めても main の検査は一切声を上げない。**
# **実測した否定的対照**（このファイルを入れる前の origin/main）:
#     allowlist の行を `*[!/A-Za-z0-9._-]*) : ;;` に潰す（＝入口を全開にする）
#       → `bash deploy/test/nginx-headers.test.sh`  … **19 passed, 0 failed**（無言で緑）
#       → `bash deploy/test/nginx-headers-probe-safety.test.sh` … **4 passed, 1 failed**
#          （17 形のうち tilde / cmdsubst / backtick / space / glob_star / pipe / redirect /
#            backslash / exact_space の **9 形**が落ちた）
# **緩めたことに気づく検査は、このファイルしかない。** それがここに置く理由。
#
# **なぜ `..` を弾く1行ではなく allowlist か**（作業合意 #333）:
# denylist は綴りの変種に原理的に勝てない。`..` だけを弾いても、絶対パス風・`~`・シェルメタ文字・
# 空白・改行はそのままプローブ生成に流れる。だから入口は**「通してよい形」を書き出す**。
#
# **このレイヤで塞げないもの**（作業合意 #504「塞げるのに塞いでいないと、そのレイヤでは
# 塞げないを区別する」）:
# **このファイルごと削除する**変異は、ここでは検出できない。同一ファイル内の仕掛けは、
# そのファイルごと消せるので**原理的に自己防衛できない**。
# それは**レイヤを 1 つ上げた** `packages/etl/test/deploy-test-inventory.test.ts` が受け持つ
# （台帳にこのファイル名・anchors・assertion の下限が載っており、消すと etl 側が落ちる・#513／#526）。
#
# **ループを飛ばす形は塞いである**: 見本を 1 件ずつ判定した数（JUDGED）を、
# **同じ関数の最後で**配列の長さと突き合わせる（実測: ループ先頭に `continue` を入れると
# 「見本 17 形のうち 0 形しか判定していない」で **4 passed, 1 failed**）。
#
#   bash deploy/test/nginx-headers-probe-safety.test.sh
# docker は要らない（プローブ生成は docker 起動より前に走り、不正な location はそこで落ちる）。
# shellcheck disable=SC2016  # 単一引用符は意図的（$ や ` を**展開させずに**見本の location として渡す）
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
TARGET="$HERE/nginx-headers.test.sh"
CONF_REAL="$DEPLOY/nginx/site.conf"
PASS=0; FAIL=0

TMP=$(mktemp -d)
# 逃がしたファイルの着地点を観測するための「檻」。$TMP 自身の外に出たかを見たいので、
# 檻の中に作業ディレクトリを掘り、檻の直下に何か現れたら traversal が起きたと判定する。
CAGE="$TMP/cage"; mkdir -p "$CAGE"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [ "$CURRENT_FAILED" = 0 ]; then PASS=$((PASS+1)); echo "ok   $name"
  else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# mkconf <location 指定> → **本物の site.conf に、その location 1 つだけを差し込んだ**設定を作る。
# 最小の conf を自作すると、add_header が無いせいでヘッダ検査が落ち、**狙っていない理由で落ちる**
# （実測: 自作の最小 conf では、当時の見本 15 形のうち 14 形が「ヘッダが無い」で落ち、
#  プローブ生成が拒んだのか区別できなかった）。作業合意「『落ちた』ではなく『狙った理由で落ちた』を確かめる」（#451）。
# 本物に差し込めば、**差分はその location 1 つだけ**なので、落ちた理由をその location に帰せる。
mkconf() {
  local loc=$1 out="$TMP/conf.$$.$RANDOM"
  # location /assets/ の直前に差し込む（server ブロックの中で、他の location と同じ階層）。
  awk -v loc="$loc" '
    !done && /^[[:space:]]*location \/assets\/ \{/ {
      printf "    location %s {\n        try_files $uri =404;\n    }\n", loc
      done = 1
    }
    { print }
  ' "$CONF_REAL" > "$out"
  printf '%s' "$out"
}

# run_target <conf> → STATUS / OUT。
#
# **docker は本物を使わない。** nginx-headers.test.sh は冒頭で `docker info` を見て、
# 無ければ **skip して exit 0** する（= プローブ生成に到達しない）。かといって本物の docker で
# 走らせると 1 ケースにつきコンテナ 1 つで、変異を何通りも試す時間に収まらない
# （実測: 本物の docker で全 26 ケース **2 分 07 秒** / スタブで **22 秒**）。
#
# ここで見たいのは **docker を起動する前のプローブ生成**だけなので、
# `docker info` は成功し `docker run` は失敗する**スタブ**を PATH の先頭に置く。
#   - 不正な location  … プローブ生成で落ちる（docker には到達しない）
#   - 正しい location  … プローブ生成を通り、docker run で落ちる。
#                        ここでは「プローブ生成が拒まなかったこと」だけを見る
# 実配信の検査は nginx-headers.test.sh 自身が本物の docker で持っている。ここはその**手前**の係。
STUB_BIN="$TMP/stubbin"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/docker" <<'STUB'
#!/usr/bin/env bash
# info だけ成功させる。run/exec/port は失敗させ、コンテナを一切作らない。
case "${1:-}" in
  info) exit 0 ;;
  rm)   exit 0 ;;
  *)    echo "docker stub: $* は実行しない（#642 の検査はプローブ生成までを見る）" >&2; exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN/docker"

run_target() {
  local conf=$1
  set +e
  ( cd "$CAGE" && PATH="$STUB_BIN:$PATH" TMPDIR="$CAGE" SITE_CONF="$conf" bash "$TARGET" ) > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
  # スタブで skip されていないこと（= プローブ生成に到達したこと）を毎回確かめる。
  # ここを見ないと、docker が使えない環境で**全ケースが skip して exit 0**になり、
  # 「落ちるはずのものが落ちない」を検出できないまま緑になる（#451: 検査が死んでも緑）。
  case "$OUT" in
    *'skip nginx-headers.test.sh'*)
      fail "プローブ生成に到達していない（docker スタブが効いていない）: $OUT" ;;
  esac
}

# 逃走の検知は **2 通り**でやる。片方だけでは足りない——
# **以下は #505 当時（門が 1 つも無かった頃の main）の実測で、今の main では再現しない**
# （今は入口の allowlist が届く前に落とすので、どちらの経路にもファイルは出ない）。
# 門を将来緩めたときに**また**必要になるので、検知の側は落とさずに残す:
#   (1) 檻の直下に出たか  … `..` が数段のとき（当時 /...../ は檻の直下に着地した）
#   (2) マーカー名で広く探す … `..` を十分並べると**根で止まって檻の外**に着地する
#       （当時 `/../..(略)../tmp/<marker>/` が **/tmp/<marker>** に着地した）。
#       檻を見ているだけでは 0 件に見え、**逃げたのに緑**になる。
# 見本の location はすべて `probe642-` で始まる名前を使い、その名前が檻の外に現れたら逃走とみなす。
escaped_entries() {
  find "$CAGE" -mindepth 1 -maxdepth 1 -not -name 'tmp.*' 2>/dev/null
  # 檻の外（親をたどって根まで）に probe642-* が現れていないか。/ 全体を舐めると遅いので、
  # `..` が着地しうる祖先ディレクトリの直下だけを見る。
  local d="$CAGE"
  while [ "$d" != "/" ]; do
    d=$(dirname "$d")
    find "$d" -mindepth 1 -maxdepth 1 -name 'probe642-*' 2>/dev/null
  done
}

# ---- 落とすべき location（それぞれ「どの経路で危ないか」が違う） ----
# 名前 => location 指定。**形の数ではなく、通る経路の数**を意識して選んである（#485）:
#   - `..` 系          : $ROOT の外に書ける（実際に再現した本体）
#   - `~` / 絶対パス風  : $ROOT の中には収まるが、意図しない名前のディレクトリを掘る
#   - シェルメタ・空白・改行: 引用が1つ外れた瞬間に評価される形。今は引用されているが、
#                        「今は安全」を検査に頼らず、形そのものを拒む
BAD_LOCATIONS=(
  'dotdot_dir|/../../probe642-escaped/'
  'dotdot_deep|/../../../../../../../../../../probe642-deep/'
  'dotdot_file|/../probe642-escaped.txt'
  'dotdot_middle|/assets/../../probe642-escaped/'
  'dotdot_prefix_caret|^~ /../../probe642-escaped/'
  'tilde|/~/probe642/'
  'cmdsubst|/$(touch /tmp/probe642-cmdsubst)/'
  'backtick|/`touch /tmp/probe642-backtick`/'
  'semicolon|/x;y/'
  'space|/a b/'
  'glob_star|/*/'
  'pipe|/a|b/'
  'redirect|/a>b/'
  'no_leading_slash|assets/'
  'backslash|/a\b/'
  # 完全一致（`= uri`）の枝。ファイルは置かないが **curl の URL にそのまま入る**ので、
  # ここを素通しすると `= /../../x` が curl に渡る。前方一致の見本だけでは
  # **この枝を 1 度も通らない**（#505 当時、完全一致の枝の検査を消す変異で
  # `ok   /../../<marker>` と表示されたまま緑になったのを実測している）。
  'exact_dotdot|= /../../probe642-exact'
  'exact_space|= /a b'
)

# **判定した件数を、判定そのものと同じ場所で数える**（作業合意 #507「無罪判決を引き直す」）。
# 数えていないと、ループを飛ばす変異が**本体を消しただけで 5 passed, 0 failed のまま**通る。
# 見本の配列は無傷なので、テスト名の「17 形」も嘘のまま表示される。
# #642 で実測: `for entry in ...; do continue;` を当てると
# 「見本 17 形のうち 0 形しか判定していない」で **4 passed, 1 failed**。
# 数えたものを**同じ関数の最後で突き合わせる**ことで、本体を消すと「0 形しか判定していない」で落ちる。
# 別の it に置くと「その it だけ消す」で黙るので、ここに置く。
JUDGED=0

t_bad_locations_fail() {
  local entry name loc conf before after
  JUDGED=0
  for entry in "${BAD_LOCATIONS[@]}"; do
    name=${entry%%|*}; loc=${entry#*|}
    conf=$(mkconf "$loc")
    before=$(escaped_entries | wc -l)
    run_target "$conf"
    after=$(escaped_entries | wc -l)

    # **「落ちた」ではなく「狙った理由で落ちた」を見る**（作業合意 #451）。
    # 終了コードだけを見ていると、**docker スタブが後で失敗するせいで exit 1 になった**のを
    # 「プローブ生成が拒んだ」と読み違える。だから **プローブ生成が出す固有の文言**を要求する。
    #
    # **ここに並ぶ文言は、nginx-headers.test.sh が持つ 4 つの拒否経路すべてに対応する。**
    # どれで落ちたかは location の形によって変わるので、**どれか 1 つ**を満たせばよい:
    #   扱えない文字か形が入っている       … 入口の allowlist（location_shape_ok・#505）
    #   docroot の外に出る                 … 出口の封じ込め（assert_confined・#505）
    #   シンボリックリンクが挟まっている   … 実体の門（assert_no_symlink_ancestor・#580）
    #   未対応の location                  … 修飾子が扱える形でない
    #   location の数え上げが壊れている     … プローブ生成の**手前**にある見張り（#499）。
    #     `;` や改行を含む location は `location[^;]*{` の独立な数え方を狂わせるので、
    #     allowlist に届く前にここで落ちる（#642 で実測: /x;y/ は「拾えた 8 個 / site.conf にある 7 個」、
    #     改行入りは「拾えた 1 個 / 0 個」）。**拒めていれば経路は問わない。**
    #
    # **この一覧は allowlist なので、緩めれば骨抜きになる。** `*'FAIL'*` のような
    # 「何か落ちた」を足すと、docker スタブの失敗まで「拒んだ」に数えてしまう。足すときは
    # **nginx-headers.test.sh に新しい拒否経路ができたときだけ**、その逐語の文言を足すこと。
    case "$OUT" in
      *'扱えない文字か形が入っている'*|*'docroot の外に出る'*|*'未対応の location'*|\
      *'シンボリックリンクが挟まっている'*|*'location の数え上げが壊れている'*) ;;
      *) fail "$name [$loc]: プローブ生成の拒否メッセージが無い（別の理由で落ちただけ）: $(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')" ;;
    esac

    # **拒んだ location が、叩くパスの一覧に入っていないこと。**
    # 上のメッセージは「表示した」だけで、その後も使い続けていれば意味が無い。
    # `ok <その location>` が出ていたら、拒否したつもりで curl に渡している。
    case "$OUT" in
      *"ok   $loc"*|*"ok   ${loc#= }"*)
        fail "$name [$loc]: 拒否したはずの location を叩いている（ok 行が出た）" ;;
    esac

    [ "$STATUS" -ne 0 ] || fail "$name [$loc]: 終了コードが 0（落ちていない）"
    [ "$before" = "$after" ] || fail "$name [$loc]: 作業ディレクトリの外に $((after-before)) 件できた: $(escaped_entries | tr '\n' ' ')"
    JUDGED=$((JUDGED+1))
    rm -f "$conf"
  done
  # 見本を 1 件ずつ本当に走らせたか。ループ本体を消す・continue で飛ばす変異はここで落ちる。
  [ "$JUDGED" -eq "${#BAD_LOCATIONS[@]}" ] || \
    fail "見本 ${#BAD_LOCATIONS[@]} 形のうち $JUDGED 形しか判定していない（ループが飛ばされている）"
}

# ---- 通すべき location（厳しすぎて正しい書き方を落としていないか・#451） ----
# 実際に site.conf に書いてある形と、nginx の location 修飾子のうちこのテストが扱える形。
GOOD_LOCATIONS=(
  'root|/'
  'prefix_dir|/assets/'
  'prefix_dir_nested|/a/b/c/'
  'prefix_file|/robots.txt'
  'exact|= /compare'
  'exact_file|= /__spa-fallback.html'
  'caret_prefix|^~ /fonts/'
  'hyphen_underscore_dot|/a-b_c.d/'
)

t_good_locations_pass_probe_generation() {
  local entry name loc conf
  for entry in "${GOOD_LOCATIONS[@]}"; do
    name=${entry%%|*}; loc=${entry#*|}
    conf=$(mkconf "$loc")
    run_target "$conf"
    # docker が無ければ skip して 0、あれば nginx を起動して最後まで走る。どちらでも
    # 「プローブ生成が location を拒んだ」という失敗は出てはいけない。
    case "$OUT" in
      *'扱えない文字か形が入っている'*|*'未対応の location'*|*'docroot の外に出る'*)
        fail "$name [$loc]: 正しい形なのにプローブ生成が拒んだ: $(printf '%s' "$OUT" | grep -E '扱えない文字か形|未対応|docroot の外' | head -1)";;
    esac
    rm -f "$conf"
  done
}

# ---- 改行を含む location（行単位の抽出では現れないが、抽出を変えたときに効く） ----
# 作業合意「正規表現をまとめる変更は、見本に改行・入れ子・複数件を必ず含めてから」（#506）。
# 今の抽出は行単位なので改行入りの location は grep の時点で分割される。**抽出を変えた将来**に
# 素通りしないよう、見本として置く。**落ちる理由は問わない**（拒むか、拾えず数が合わないか）。
#
# **今どこで落ちているか、#642 で実測した**——allowlist ではなく**数え上げの見張り**（#499）:
#     FAIL location の数え上げが壊れている: 拾えた 1 個 / site.conf にある 0 個
#          拾えたもの: /..|
# つまり `/..` だけが行として拾われ、`{` の数（0）と合わずに落ちる。
# **だから allowlist を全開にする変異では、この見本は落ちない**（#642 で確認済み。
# 数え上げの見張りを `if false; then` に潰す変異でも落ちない——そのときは allowlist の
# `*..*` が拾う。門が 2 つあるので、片方ずつ潰しても通り抜けない）。
# **それがこの見本の意図で、弱さではない**: ここが見張るのは
# 「**抽出を複数行対応に書き換えた**とき、改行入りが素通りしないか」であって、
# 特定の門ではない。**どの門でもよいから止まること**を固定する。
t_newline_location_does_not_escape() {
  local conf="$TMP/conf.newline" before after
  {
    echo 'server {'
    echo '    listen 80;'
    printf '    location /..\n/../probe642-newline/ {\n'
    echo '        try_files $uri =404;'
    echo '    }'
    echo '}'
  } > "$conf"
  before=$(escaped_entries | wc -l)
  run_target "$conf"
  after=$(escaped_entries | wc -l)
  [ "$STATUS" -ne 0 ] || fail "改行入り location で終了コードが 0（落ちていない）"
  [ "$before" = "$after" ] || fail "改行入り location で作業ディレクトリの外に $((after-before)) 件できた"
}

# ---- 正常な site.conf では、これまで通り全部通る（既存 16 件を弱めていないこと） ----
# ここでは件数までは見ない（docker の有無で変わる）。**プローブ生成が本物の site.conf を
# 1 つも拒まないこと**だけを固定する。件数の固定は nginx-headers.test.sh 自身が持っている。
t_real_site_conf_is_accepted() {
  run_target "$DEPLOY/nginx/site.conf"
  case "$OUT" in
    *'扱えない文字か形が入っている'*) fail "本物の site.conf をプローブ生成が拒んだ: $(printf '%s' "$OUT" | grep '扱えない文字か形' | head -3)";;
  esac
  case "$OUT" in
    *'未対応の location'*) fail "本物の site.conf に未対応の location がある: $(printf '%s' "$OUT" | grep '未対応' | head -3)";;
  esac
}

# ---- 検査そのものが生きているか（#451: 検査器のテストが無いと、検査が死んでも緑） ----
# 上の t_bad_locations_fail は「落ちること」を見るが、**何件見たか**を見ていないと
# BAD_LOCATIONS=() に書き換えるだけで黙る。件数をハードコードして突き合わせる
# （検査対象から生成すると自己参照になり、対象が痩せれば期待値も一緒に痩せる・#499）。
t_fixture_counts_are_pinned() {
  [ "${#BAD_LOCATIONS[@]}" -eq 17 ] || fail "落とすべき location の見本が ${#BAD_LOCATIONS[@]} 件（17 件を期待）。減らすなら理由を書くこと"
  [ "${#GOOD_LOCATIONS[@]}" -eq 8 ]  || fail "通すべき location の見本が ${#GOOD_LOCATIONS[@]} 件（8 件を期待）。減らすなら理由を書くこと"
}

test_case "不正な location は素通りせず落ちる（${#BAD_LOCATIONS[@]} 形）" t_bad_locations_fail
test_case "正しい location はプローブ生成に拒まれない（${#GOOD_LOCATIONS[@]} 形）" t_good_locations_pass_probe_generation
test_case "改行を含む location でも作業ディレクトリの外に出ない" t_newline_location_does_not_escape
test_case "本物の site.conf はそのまま通る" t_real_site_conf_is_accepted
test_case "見本の件数が固定されている（見本を空にしたら落ちる）" t_fixture_counts_are_pinned

echo "-- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
