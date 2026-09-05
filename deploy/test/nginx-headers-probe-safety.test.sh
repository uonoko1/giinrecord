#!/usr/bin/env bash
# Issue #505: nginx-headers.test.sh のプローブ生成にパストラバーサルがあった。
#
# **何が起きていたか**（origin/main で再現した実測）:
# nginx-headers.test.sh は site.conf の location を機械的に拾い（#499）、前方一致の location には
# プローブ用のファイルを置く。その置き先が `mkdir -p "$ROOT$pfx"` と**無検証の文字列連結**だった。
# site.conf に `location /../../pbi505-escaped/` を書くと:
#     -- 17 passed, 0 failed（exit 0）
#     $ find /tmp -maxdepth 3 -name 'pbi505-escaped'
#     /tmp/pbi505-escaped        ← $TMP の外。cleanup の rm -rf "$TMP" では消えない
# `..` は「ファイルシステムの根を超えると根で止まる」ので、`../` を十分並べれば
# **書ける場所ならどこにでも**届く（実測: `/tmp/pbi505-B` に着地した）。
#
# **なぜ攻撃経路ではないか**: site.conf は自分たちが書くファイルで、外部から `..` を注入される
# 経路は無い。実害は「テスト実行が $TMP の外にゴミを残す」程度。
# **それでも塞ぐ理由**: 検査が「意図しない場所を読み書きしうる」状態は、レビューで
# 気づけない形の間違いを許す。**隠れて通れなくする**（作業合意「防御は不可能にすることではなく、
# 隠れて通れなくすること」）。
#
# **なぜ `..` を弾く1行ではなく allowlist か**（作業合意 #333）:
# denylist は綴りの変種に原理的に勝てない。`..` だけを弾いても、絶対パス風・`~`・シェルメタ文字・
# 空白・改行はそのままプローブ生成に流れる。だから nginx-headers.test.sh 側は
# **「通してよい形」を書き出して完全一致で照合**し、さらに**実際の書き先が $ROOT の下に
# 収まっていること**を別に確かめる（経路が2つあるものは、それぞれ別々に釘打つ・#485）。
#
# このファイルは**その検査器自身の検査**（#451）。悪い location を1つずつ食わせて
# 「落ちること」を、良い location を食わせて「通ること」を固定する。
# 落ちる側だけ試すと、正しい書き方まで落とす検査ができあがる（#451 のレビューの教訓）。
#
# **このレイヤで塞げないもの**（作業合意 #504「塞げるのに塞いでいないと、そのレイヤでは
# 塞げないを区別する」）:
# **このファイルごと削除する**、または **t_bad_locations_fail の本体を丸ごと `:` にする**変異は、
# ここでは検出できない（実測: 本体を `:` にすると 5 passed, 0 failed のまま緑）。
# 同一ファイル内の仕掛けは、そのファイルごと消せるので**原理的に自己防衛できない**。
# ただしどちらも**レビューで目に見える改変**（関数の中身の全削除・ファイルの削除）で、
# 「述語を 1 つ足すだけ」のような隠れて通る変異ではない。
# CI は `deploy/test/*.test.sh` を glob で回す（.github/workflows/ci.yml）ので、
# ファイルを消せば黙るが、その diff は PR に必ず出る。
#
# **ループを飛ばす形は塞いである**: 見本を 1 件ずつ判定した数（JUDGED）を、
# **同じ関数の最後で**配列の長さと突き合わせる（実測: ループ先頭に `continue` を入れると
# 「見本 17 形のうち 0 形しか判定していない」で落ちる）。
#
#   bash deploy/test/nginx-headers-probe-safety.test.sh
# docker は要らない（プローブ生成は docker 起動より前に走り、不正な location はそこで落ちる）。
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
# （実測: 自作の最小 conf では 15 形中 14 形が「ヘッダが無い」で落ち、プローブ生成が拒んだのか
#  区別できなかった）。作業合意「『落ちた』ではなく『狙った理由で落ちた』を確かめる」（#451）。
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

# run_target <conf> → STATUS / OUT。プローブ生成は docker より前なので、docker が無くても
# 不正な location はここで落ちる。docker がある環境では skip されずに最後まで走る。
run_target() {
  local conf=$1
  set +e
  ( cd "$CAGE" && TMPDIR="$CAGE" SITE_CONF="$conf" bash "$TARGET" ) > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
}

# 逃走の検知は **2 通り**でやる。片方だけでは足りないことを実測した:
#   (1) 檻の直下に出たか  … `..` が数段のとき（実測 /...../ は檻の直下 pbi505-escaped に着地）
#   (2) マーカー名で広く探す … `..` を十分並べると**根で止まって檻の外**に着地する
#       （origin/main で `/../..(略)../tmp/pbi505-deep/` が **/tmp/pbi505-deep** に着地したのを実測）。
#       檻を見ているだけでは 0 件に見え、**逃げたのに緑**になる。
# 見本の location はすべて `pbi505-` で始まる名前を使い、その名前が檻の外に現れたら逃走とみなす。
escaped_entries() {
  find "$CAGE" -mindepth 1 -maxdepth 1 -not -name 'tmp.*' 2>/dev/null
  # 檻の外（親をたどって根まで）に pbi505-* が現れていないか。/ 全体を舐めると遅いので、
  # `..` が着地しうる祖先ディレクトリの直下だけを見る。
  local d="$CAGE"
  while [ "$d" != "/" ]; do
    d=$(dirname "$d")
    find "$d" -mindepth 1 -maxdepth 1 -name 'pbi505-*' 2>/dev/null
  done
}

# ---- 落とすべき location（それぞれ「どの経路で危ないか」が違う） ----
# 名前 => location 指定。**形の数ではなく、通る経路の数**を意識して選んである（#485）:
#   - `..` 系          : $ROOT の外に書ける（実際に再現した本体）
#   - `~` / 絶対パス風  : $ROOT の中には収まるが、意図しない名前のディレクトリを掘る
#   - シェルメタ・空白・改行: 引用が1つ外れた瞬間に評価される形。今は引用されているが、
#                        「今は安全」を検査に頼らず、形そのものを拒む
BAD_LOCATIONS=(
  'dotdot_dir|/../../pbi505-escaped/'
  'dotdot_deep|/../../../../../../../../../../pbi505-deep/'
  'dotdot_file|/../pbi505-escaped.txt'
  'dotdot_middle|/assets/../../pbi505-escaped/'
  'dotdot_prefix_caret|^~ /../../pbi505-escaped/'
  'tilde|/~/pbi505/'
  'cmdsubst|/$(touch /tmp/pbi505-cmdsubst)/'
  'backtick|/`touch /tmp/pbi505-backtick`/'
  'semicolon|/x;y/'
  'space|/a b/'
  'glob_star|/*/'
  'pipe|/a|b/'
  'redirect|/a>b/'
  'no_leading_slash|assets/'
  'backslash|/a\b/'
  # 完全一致（`= uri`）の枝。ファイルは置かないが **curl の URL にそのまま入る**ので、
  # ここを素通しすると `= /../../x` が curl に渡る。前方一致の見本だけでは
  # **この枝を 1 度も通らない**（実測: 完全一致の枝の検査を消す変異で
  # `ok   /../../pbi505-exact` と表示されて **17 passed, 0 failed** になった）。
  'exact_dotdot|= /../../pbi505-exact'
  'exact_space|= /a b'
)

# **判定した件数を、判定そのものと同じ場所で数える**（作業合意 #507「無罪判決を引き直す」）。
# ループ本体を丸ごと `:` にする変異（Z2）は、**本体を消しただけで 5 passed, 0 failed のまま**
# 通った（実測）。見本の配列は無傷なので、テスト名の「17 形」も嘘のまま表示される。
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
    # 「プローブ生成が拒んだ」と読み違える。実測: 完全一致の枝の検査を消す変異（M7）は、
    # 終了コードと "FAIL" の有無だけでは**素通りした**（5 passed, 0 failed）。
    # そのとき `= /../../pbi505-exact` は本物の site.conf 相手に
    # **`ok /../../pbi505-exact` と表示されて 17 passed, 0 failed** になっていた。
    # だから **プローブ生成が出す固有の文言**を要求する。
    # `location の数え上げが壊れている` も、**プローブ生成の手前にある見張り**（#499）が
    # 捕まえた正しい拒否。`;` を含む location は `location[^;]*{` の独立な数え方を狂わせるので、
    # allowlist に届く前にここで落ちる（実測: /x;y/ は「拾えた 8 個 / site.conf にある 7 個」）。
    case "$OUT" in
      *'安全でない location'*|*'docroot の外に出る'*|*'未対応の location'*|*'location の数え上げが壊れている'*) ;;
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
      *'安全でない location'*|*'未対応の location'*)
        fail "$name [$loc]: 正しい形なのにプローブ生成が拒んだ: $(printf '%s' "$OUT" | grep -E '安全でない|未対応' | head -1)";;
    esac
    rm -f "$conf"
  done
}

# ---- 改行を含む location（行単位の抽出では現れないが、抽出を変えたときに効く） ----
# 作業合意「正規表現をまとめる変更は、見本に改行・入れ子・複数件を必ず含めてから」（#506）。
# 今の抽出は行単位なので改行入りの location は grep の時点で分割されるが、**抽出を変えた将来**に
# 素通りしないよう、見本として置く。落ちる理由は問わない（拒むか、拾えず数が合わないか）。
t_newline_location_does_not_escape() {
  local conf="$TMP/conf.newline" before after
  {
    echo 'server {'
    echo '    listen 80;'
    printf '    location /..\n/../pbi505-newline/ {\n'
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
    *'安全でない location'*) fail "本物の site.conf をプローブ生成が拒んだ: $(printf '%s' "$OUT" | grep '安全でない' | head -3)";;
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

test_case "不正な location は素通りせず落ちる（$( : )${#BAD_LOCATIONS[@]} 形）" t_bad_locations_fail
test_case "正しい location はプローブ生成に拒まれない（${#GOOD_LOCATIONS[@]} 形）" t_good_locations_pass_probe_generation
test_case "改行を含む location でも作業ディレクトリの外に出ない" t_newline_location_does_not_escape
test_case "本物の site.conf はそのまま通る" t_real_site_conf_is_accepted
test_case "見本の件数が固定されている（見本を空にしたら落ちる）" t_fixture_counts_are_pinned

echo "-- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
