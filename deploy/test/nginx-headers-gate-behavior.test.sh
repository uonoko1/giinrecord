#!/usr/bin/env bash
# Issue #652: `nginx-headers.test.sh` の**出口 `assert_confined`（#505）と
# 実体 `assert_no_symlink_ancestor`（#580）が、実際に働くこと**を固定する。
#
# **なぜ別ファイルなのか**（`nginx-headers-probe-safety.test.sh` に足さなかった理由）:
# probe-safety は `SITE_CONF=` に細工した conf を食わせる**ブラックボックス**の検査で、
# `nginx-headers.test.sh` を**外から丸ごと起動する**。その流儀では、この 2 つの門に届かない:
#
#   (1) **実体の門に届かない**。門が見るのは `$ROOT = $TMP/html` の祖先で、
#       `$TMP` は対象自身が `mktemp -d` で**毎回新しく作る**。外からその中に
#       シンボリックリンクを**事前に**置く経路が無い（`ROOT` を差し替える env も無い。
#       対象が読む env は `SITE_CONF` と `NGINX_TEST_IMAGE` の 2 つだけ）。
#       検査のために対象へ「$ROOT を差し替える口」を足すのは、**検査のためだけの抜け道を
#       製品側に開ける**ことなので採らない。
#   (2) **出口の門にも届かない**。出口が働くのは「入口を通ったのに docroot の外に出る」形だけで、
#       今の入口の allowlist は `..` も絶対パス風も全部落とすので、**出口は素通しでも同じ結果になる**。
#       実測（#652、無改造の origin/main）:
#         `assert_confined() { return 0` に潰す
#           → nginx-headers.test.sh              **19 passed, 0 failed**
#           → nginx-headers-probe-safety.test.sh **5 passed, 0 failed**（どちらも無言で緑）
#         入口 `location_shape_ok` と出口 `assert_confined` を**同時に**潰すと
#           → nginx-headers-probe-safety.test.sh **4 passed, 1 failed**
#       つまり probe-safety が出口について見ているのは「入口が死んだときの受け皿」までで、
#       **出口そのものが死んだことは検出できない**。
#
# **だからここはホワイトボックスにする**: `nginx-headers.test.sh` から
# **門の関数の定義を逐語で切り出して**、こちらが用意した使い捨てディレクトリを `$ROOT` に見立て、
# **本物のシンボリックリンクを実際に張って**呼ぶ。切り出しなので**実装の写しは持たない**
# （写しを持つと、対象を直しても写しが古いまま緑になる）。
#
# **切り出しに失敗したら黙って緑にならない**。関数が見つからない・行数が 0 のときは落とす。
# それを見ていないと、対象の関数名を変えただけで「0 個切り出して 0 個検査した」で緑になる（#451）。
#
# **このファイルが実際に何を捕まえるか**（#652 で当てた変異。母数は 12 形。
#  変異は scripts/dev/mutate.sh で当て、毎回 md5 の変化と `bash -n` の通過を確認した。
#  「一見よく落ちたが実は bash syntax error だった」形は破棄している・#642 の教訓）:
#   実体の門（assert_no_symlink_ancestor）に 6 形 … **6 形すべてで 5 passed, 1 failed**
#     丸ごと return 0 / `if [ -L ]` を `if false` / `-L` を `! -e` に差し替え /
#     exit 1 を消して表示だけにする / 祖先を先頭 1 段しか見ない / 段を進めない
#   出口の門（assert_confined とその補助）に 6 形 … **6 形すべてで 5 passed, 1 failed**
#     丸ごと return 0 / `if ! under_root` を `if false` / under_root を return 0 /
#     `"$ROOT_RESOLVED"/*` を `"$ROOT_RESOLVED"*` にして兄弟を通す（#520 の穴） /
#     exit 1 を消して表示だけにする / resolve_lexical が `..` を畳まない
#   **否定的対照（同じ 12 形について実測）**: そのすべてで
#     `nginx-headers.test.sh` は **19 passed, 0 failed**、
#     `nginx-headers-probe-safety.test.sh` は **5 passed, 0 failed**（無言で緑）。
#     ただ 1 つ、出口の exit 1 を消す形だけは probe-safety も 4 passed, 1 failed になるが、
#     それは同じ perl 式が**他の 3 か所の exit 1 も巻き込んで**いたためで、
#     165 行目だけに当て直すと probe-safety は **5 passed, 0 failed** に戻る（測り直し済み）。
#
# **このファイルで塞げないもの**（作業合意 #504）:
# このファイルごと削除する変異は、ここでは検出できない。それは
# `packages/etl/test/deploy-test-inventory.test.ts` の台帳が受け持つ（#513／#526。
#  実測: このファイルを消すと etl 側が **1010 pass / 3 fail**「台帳にあるのに存在しない」で落ちる）。
#
# **シンボリックリンクの張り先は必ずこのテストの一時ディレクトリの中**。
# `/etc` のような本物の外部パスを指すリンクは 1 つも作らない（#652 の指示）。
#
#   bash deploy/test/nginx-headers-gate-behavior.test.sh
# docker は要らない（門は docker 起動より前に働く関数で、ここでは関数だけを呼ぶ）。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TARGET="$HERE/nginx-headers.test.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [ "$CURRENT_FAILED" = 0 ]; then PASS=$((PASS+1)); echo "ok   $name"
  else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# ---- 門の定義を、対象から逐語で切り出す ----
# `<名前>() {` の行から、**列 0 の `}`** までを 1 つの塊として取る。対象の関数はすべて
# インデント無しで開き、閉じ括弧も列 0 なので、この切り方で過不足なく取れる。
# **切り出した行数を数えて返す**（0 行なら呼び出し側が落とす）。
extract_fn() {
  local name=$1
  awk -v want="$name() {" '
    $0 == want { on = 1 }
    on { print }
    on && $0 == "}" { exit }
  ' "$TARGET"
}

# 門が依存する補助（resolve_lexical / under_root）も同じ流儀で切り出す。
# **ここに並ぶ名前は、対象が持つ「プローブ生成の門とその補助」の全部**である。
GATE_FNS=(resolve_lexical under_root assert_confined assert_no_symlink_ancestor)

HARNESS="$TMP/gates.sh"
: > "$HARNESS"
EXTRACTED=0
for fn in "${GATE_FNS[@]}"; do
  body=$(extract_fn "$fn")
  # **切り出せたことを毎回確かめる。** ここを見ないと、対象の関数名が変わった瞬間に
  # ハーネスが空になり、**門を 1 つも呼ばないまま全部 pass する**（#451: 検査が死んでも緑）。
  if [ -z "$body" ]; then
    echo "FAIL $TARGET から関数 $fn を切り出せなかった（名前が変わった？ GATE_FNS を直すこと）"
    FAIL=$((FAIL+1)); exit 1
  fi
  case "$body" in
    *"$fn() {"*) ;;
    *) echo "FAIL 切り出した $fn の中身に定義の先頭が無い"; FAIL=$((FAIL+1)); exit 1 ;;
  esac
  printf '%s\n' "$body" >> "$HARNESS"
  EXTRACTED=$((EXTRACTED+1))
done

# ---- ハーネス: 切り出した門を、こちらが作った $ROOT に対して 1 回だけ呼ぶ ----
# 対象の門は落とすとき `exit 1` するので、**別プロセス**で呼んで終了コードと出力を見る。
# `FAIL=$((FAIL+1))` を門が触るので、ハーネス側にも `FAIL` を用意しておく（未定義だと
# `set -u` で門の中が落ち、**狙っていない理由で非 0 になる**・#451）。
#
# run_gate <門の名前> <$ROOT> <組み立てるパス> <location 表記> → STATUS / OUT
run_gate() {
  local fn=$1 root=$2 built=$3 loc=$4
  set +e
  OUT=$(bash "$RUNNER" "$root" "$fn" "$built" "$loc" 2>&1)
  STATUS=$?
  set -e
}

RUNNER="$TMP/run-gate.sh"
cat > "$RUNNER" <<'RUNNER_EOF'
#!/usr/bin/env bash
# 切り出した門を 1 つだけ呼ぶ薄い殻。門は落とすとき exit 1 するので、別プロセスで呼ぶ。
set -euo pipefail
ROOT=$1; fn=$2; built=$3; loc=$4
FAIL=0
# shellcheck disable=SC1090  # 対象から切り出した門の定義（実行時に決まる）
. "$(dirname "$0")/gates.sh"
ROOT_RESOLVED=$(resolve_lexical "$ROOT")
"$fn" "$built" "$loc"
echo "GATE_RETURNED_OK"
RUNNER_EOF

# ---- 見本: 実体の門（assert_no_symlink_ancestor・#580）----
# **どれも「字句上は docroot の中」**（`..` も絶対パスも無く、入口の allowlist を通る形）で、
# **実体だけが外を指す**。だから入口・出口では捕まらず、この門だけが捕まえる。
#
# 各行: 名前|リンクを張る $ROOT 内の相対パス|組み立てるパス（$ROOT からの相対）
# リンク先は**すべてこのテストの一時ディレクトリの中**（$TMP/outside）に作る。
SYMLINK_CASES=(
  # 直下のディレクトリがリンク。#580 の再現そのもの。
  'dir_link|link|/link/__probe.txt'
  # リンクの**先**にさらに掘る形。mkdir -p が外に段を作ってしまう形（#580 のコメントの実測）。
  'dir_link_nested|link|/link/sub/__probe.txt'
  # 末尾スラッシュ無しの location が作る形（printf > で**既存ファイルを上書きする**いちばん危ない枝）。
  'dir_link_noslash_file|link|/link/notes.txt'
  # **祖先の途中**がリンク。先頭だけ見る実装では素通りする。
  'mid_link|a/b|/a/b/c/__probe.txt'
  # 深い段にあるリンク。段数を決め打ちした実装では素通りする。
  'deep_link|a/b/c/d|/a/b/c/d/e/__probe.txt'
  # **リンクそのものが最後の段**（ファイルへのリンク。上書き先が外のファイルになる）。
  'leaf_file_link|leaf.txt|/leaf.txt'
)

# **判定した件数を、判定と同じ場所で数える**（作業合意 #507）。
# ループを飛ばす変異は、見本の配列が無傷なのでテスト名の件数まで嘘のまま緑になる。
SYMLINK_JUDGED=0

t_symlink_ancestor_is_rejected() {
  local entry name link built root outside
  SYMLINK_JUDGED=0
  for entry in "${SYMLINK_CASES[@]}"; do
    name=${entry%%|*}; rest=${entry#*|}
    link=${rest%%|*}; built=${rest#*|}

    # 見本ごとに新しい $ROOT を作る（前の見本が残したものに引きずられないように）。
    root="$TMP/root.$name"; outside="$TMP/outside.$name"
    mkdir -p "$root" "$outside"
    mkdir -p "$(dirname "$root/$link")"
    # **リンク先はこの一時ディレクトリの中**。/etc のような本物の外部パスは指さない（#652）。
    case "$link" in
      *.txt) printf 'original' > "$outside/target.txt"; ln -s "$outside/target.txt" "$root/$link" ;;
      *)     ln -s "$outside" "$root/$link" ;;
    esac
    # リンクが本当に張れたこと（張れていないと、**門が働かなくても緑**になる）。
    [ -L "$root/$link" ] || { fail "$name: シンボリックリンクを張れていない: $root/$link"; continue; }

    run_gate assert_no_symlink_ancestor "$root" "$root$built" "$built"

    # **「落ちた」ではなく「狙った理由で落ちた」を見る**（#451）。
    case "$OUT" in
      *'シンボリックリンクが挟まっている'*) ;;
      *) fail "$name [$built]: 実体の門が止めなかった（#580 の文言が無い）: $(printf '%s' "$OUT" | tr '\n' ' ')" ;;
    esac
    [ "$STATUS" -ne 0 ] || fail "$name [$built]: 実体の門が終了コード 0 で通した"
    case "$OUT" in
      *GATE_RETURNED_OK*) fail "$name [$built]: 門が返ってきてしまった（止めていない）" ;;
    esac
    # **まだ何も書いていないこと**（#580 の門は mkdir -p より前に置く約束）。
    # リンク先に何か現れていたら、門が「止めた」と言いながら書いている。
    [ "$(find "$outside" -mindepth 1 | wc -l)" -eq "$(find "$outside" -mindepth 1 -name 'target.txt' | wc -l)" ] ||       fail "$name: 門が止めたのにリンク先に $(find "$outside" -mindepth 1 | tr '\n' ' ') ができている"
    if [ -f "$outside/target.txt" ]; then
      [ "$(cat "$outside/target.txt")" = original ] || fail "$name: リンク先のファイルが書き換わっている"
    fi
    SYMLINK_JUDGED=$((SYMLINK_JUDGED+1))
  done
  [ "$SYMLINK_JUDGED" -eq "${#SYMLINK_CASES[@]}" ] ||     fail "見本 ${#SYMLINK_CASES[@]} 形のうち $SYMLINK_JUDGED 形しか判定していない（ループが飛ばされている）"
}

# ---- 通すべき形（厳しすぎて正しい書き方を落としていないか・#451）----
# **リンクが 1 つも無い普通のディレクトリ**は通さないといけない。落ちる側だけ試すと、
# 「常に exit 1」でも全部 pass する検査ができあがる。
NO_SYMLINK_CASES=(
  'plain_new|/assets/__probe.txt'      # まだ何も無い段（mkdir -p がこれから作る）
  'plain_existing|/exists/__probe.txt' # 既にある普通のディレクトリ
  'plain_deep|/a/b/c/__probe.txt'
  'root_itself|/__probe.txt'
)
NO_SYMLINK_JUDGED=0

t_plain_paths_are_not_rejected() {
  local entry name built root
  NO_SYMLINK_JUDGED=0
  root="$TMP/root.plain"; mkdir -p "$root/exists" "$root/a/b/c"
  for entry in "${NO_SYMLINK_CASES[@]}"; do
    name=${entry%%|*}; built=${entry#*|}
    run_gate assert_no_symlink_ancestor "$root" "$root$built" "$built"
    [ "$STATUS" -eq 0 ] || fail "$name [$built]: リンクが無いのに実体の門が落とした: $(printf '%s' "$OUT" | tr '\n' ' ')"
    case "$OUT" in
      *GATE_RETURNED_OK*) ;;
      *) fail "$name [$built]: 門が最後まで返ってこなかった: $(printf '%s' "$OUT" | tr '\n' ' ')" ;;
    esac
    NO_SYMLINK_JUDGED=$((NO_SYMLINK_JUDGED+1))
  done
  [ "$NO_SYMLINK_JUDGED" -eq "${#NO_SYMLINK_CASES[@]}" ] ||     fail "見本 ${#NO_SYMLINK_CASES[@]} 形のうち $NO_SYMLINK_JUDGED 形しか判定していない（ループが飛ばされている）"
}

# ---- 見本: 出口の門（assert_confined・#505）----
# **入口の allowlist が今は全部落とすので、probe-safety からはこの門に届かない。**
# ここは門を**直接**呼ぶので、入口とは独立に固定できる。
# 各行: 名前|組み立てるパス（$ROOT からの相対の見た目）
CONFINED_BAD_CASES=(
  'dotdot_out|/../../escaped652/'          # docroot を飛び越える
  'dotdot_file|/../escaped652.txt'         # 外の既存ファイルを上書きしうる形
  'dotdot_middle|/assets/../../../escaped652/'  # 打ち消しながら深く抜ける
  'sibling_prefix|-evil/x'                 # $ROOT の**兄弟**（startsWith だけの実装が通す形・#520）
)
CONFINED_JUDGED=0

t_confined_rejects_outside() {
  local entry name built root
  CONFINED_JUDGED=0
  root="$TMP/root.confined"; mkdir -p "$root"
  for entry in "${CONFINED_BAD_CASES[@]}"; do
    name=${entry%%|*}; built=${entry#*|}
    run_gate assert_confined "$root" "$root$built" "$built"
    case "$OUT" in
      *'docroot の外に出る'*) ;;
      *) fail "$name [$built]: 出口の門が止めなかった（#505 の文言が無い）: $(printf '%s' "$OUT" | tr '\n' ' ')" ;;
    esac
    [ "$STATUS" -ne 0 ] || fail "$name [$built]: 出口の門が終了コード 0 で通した"
    case "$OUT" in
      *GATE_RETURNED_OK*) fail "$name [$built]: 門が返ってきてしまった（止めていない）" ;;
    esac
    CONFINED_JUDGED=$((CONFINED_JUDGED+1))
  done
  [ "$CONFINED_JUDGED" -eq "${#CONFINED_BAD_CASES[@]}" ] ||     fail "見本 ${#CONFINED_BAD_CASES[@]} 形のうち $CONFINED_JUDGED 形しか判定していない（ループが飛ばされている）"
}

# ---- 通すべき形（出口の門が厳しすぎないか・#451）----
CONFINED_GOOD_CASES=(
  'plain|/assets/__probe.txt'
  'nested|/a/b/c/__probe.txt'
  'dotdot_cancelled|/a/../assets/__probe.txt'  # `..` を含むが $ROOT を出ない
  'root_itself|'                               # $ROOT 自身
)
CONFINED_GOOD_JUDGED=0

t_confined_allows_inside() {
  local entry name built root
  CONFINED_GOOD_JUDGED=0
  root="$TMP/root.confined-good"; mkdir -p "$root"
  for entry in "${CONFINED_GOOD_CASES[@]}"; do
    name=${entry%%|*}; built=${entry#*|}
    run_gate assert_confined "$root" "$root$built" "${built:-/}"
    [ "$STATUS" -eq 0 ] || fail "$name [$built]: docroot の中なのに出口の門が落とした: $(printf '%s' "$OUT" | tr '\n' ' ')"
    case "$OUT" in
      *GATE_RETURNED_OK*) ;;
      *) fail "$name [$built]: 門が最後まで返ってこなかった: $(printf '%s' "$OUT" | tr '\n' ' ')" ;;
    esac
    CONFINED_GOOD_JUDGED=$((CONFINED_GOOD_JUDGED+1))
  done
  [ "$CONFINED_GOOD_JUDGED" -eq "${#CONFINED_GOOD_CASES[@]}" ] ||     fail "見本 ${#CONFINED_GOOD_CASES[@]} 形のうち $CONFINED_GOOD_JUDGED 形しか判定していない（ループが飛ばされている）"
}

# ---- 切り出しそのものの検査（#451: 検査器のテストが無いと、検査が死んでも緑）----
# **門を 1 つも切り出せていないのに全部 pass する**状態を塞ぐ。件数はハードコードする
# （GATE_FNS から生成すると自己参照になり、対象が痩せれば期待値も一緒に痩せる・#499）。
t_gates_were_extracted() {
  [ "$EXTRACTED" -eq 4 ] || fail "門の切り出しが $EXTRACTED 個（4 個を期待）"
  # 切り出した中身に、**門の判定の要点**が逐語で入っていること。
  # 空のハーネスや、名前だけ合っている別物を掴んでいないか。
  grep -q 'readlink' "$HARNESS" || fail "切り出したハーネスに readlink が無い（実体の門の中身を取れていない）"
  grep -q 'ROOT_RESOLVED' "$HARNESS" || fail "切り出したハーネスに ROOT_RESOLVED が無い（出口の門の中身を取れていない）"
  # **写しを持っていないこと**: ハーネスは対象から切り出した行だけでできている。
  local fn body
  for fn in "${GATE_FNS[@]}"; do
    body=$(extract_fn "$fn")
    grep -qF "$(printf '%s' "$body" | tail -2 | head -1)" "$HARNESS" ||       fail "$fn の末尾がハーネスに入っていない（切り出しが途中で切れている）"
  done
}

# ---- 見本の件数を固定する（見本を空にしたら落ちる）----
t_fixture_counts_are_pinned() {
  [ "${#SYMLINK_CASES[@]}" -eq 6 ]      || fail "実体の門の見本が ${#SYMLINK_CASES[@]} 件（6 件を期待）。減らすなら理由を書くこと"
  [ "${#NO_SYMLINK_CASES[@]}" -eq 4 ]   || fail "実体の門で通すべき見本が ${#NO_SYMLINK_CASES[@]} 件（4 件を期待）"
  [ "${#CONFINED_BAD_CASES[@]}" -eq 4 ] || fail "出口の門の見本が ${#CONFINED_BAD_CASES[@]} 件（4 件を期待）"
  [ "${#CONFINED_GOOD_CASES[@]}" -eq 4 ]|| fail "出口の門で通すべき見本が ${#CONFINED_GOOD_CASES[@]} 件（4 件を期待）"
  [ "${#GATE_FNS[@]}" -eq 4 ]           || fail "切り出す門が ${#GATE_FNS[@]} 個（4 個を期待）"
}

test_case "実体の門はシンボリックリンクの祖先を止める（${#SYMLINK_CASES[@]} 形・#580）" t_symlink_ancestor_is_rejected
test_case "実体の門はリンクの無い普通のパスを通す（${#NO_SYMLINK_CASES[@]} 形）" t_plain_paths_are_not_rejected
test_case "出口の門は docroot の外を止める（${#CONFINED_BAD_CASES[@]} 形・#505）" t_confined_rejects_outside
test_case "出口の門は docroot の中を通す（${#CONFINED_GOOD_CASES[@]} 形）" t_confined_allows_inside
test_case "門の定義を対象から切り出せている（写しを持たない）" t_gates_were_extracted
test_case "見本の件数が固定されている（見本を空にしたら落ちる）" t_fixture_counts_are_pinned

echo "-- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
