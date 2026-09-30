# shellcheck shell=bash
# **Do not run this file directly** (#1124). It is sourced by scripts/po/test/run.sh, which
# defines test_case / assert_* / run_script. Running it with `bash` prints nothing but
# `test_case: command not found` and runs not one assertion.
[[ -n ${PO_TEST_RUN_SH:-} ]] || {
  echo "$(basename "${BASH_SOURCE[0]}"): このファイルは単体では走りません（run.sh が source します）。" >&2
  echo "  bash scripts/po/test/run.sh                       # 全部" >&2
  echo "  bash scripts/po/test/run.sh ${BASH_SOURCE[0]##*/} # このファイルだけ" >&2
  exit 2
}
# Tests for scripts/po/scrum-monitor.sh (sourced by run.sh)
#
# **検査の重心**: **「測れなかった」を「異常なし」と言わないこと**（#1110 の要件 5 / #1094）。
# **取りこぼし（`--paginate` の欠落・`total_count` の不一致）で黙って緑にならないこと**が
# この道具が存在する理由なので、そこに検査を厚く置く。
#
# **`log()` は stderr に書く**ので、断定は `$ERR` に対して行う（他の scripts/po/test と同じ）。
#
# **worktree の節だけは実在のディレクトリを使う**——`-d` と `stat` は fake `git` で偽装できない。
# `$TMP` の下に作るので、実在の worktree は 1 本も触らない（`MONITOR_SKIP_LOCAL=1` で
# 飛ばすテストと、実在の temp ディレクトリを使うテストの 2 通りで測る）。

# ---- ヘルパ -----------------------------------------------------------------------------------
# check-runs の応答を 1 ページぶん組む。`$1` = total_count、`$2..` = `name:conclusion`
# （conclusion が `null` なら実行中）。**本物の API と同じ形にする**——
# **`gh --paginate` はページごとに 1 個の JSON ドキュメントを吐く**ので、
# 複数ページを試すテストはこれを 2 回並べて返す。
cr_page() {
  local total=$1; shift
  local runs="" n c
  for spec in "$@"; do
    n="${spec%%:*}"; c="${spec#*:}"
    [[ "$c" == "null" ]] && c=null || c="\"$c\""
    runs+="{\"name\":\"$n\",\"conclusion\":$c},"
  done
  echo "{\"total_count\":$total,\"check_runs\":[${runs%,}]}"
}

# ボードの GraphQL 応答。`$1..` = `number:state:status:updatedAt`
board_page() {
  local nodes=""
  for spec in "$@"; do
    IFS=: read -r n st stat up <<<"$spec"
    nodes+="{\"content\":{\"number\":$n,\"state\":\"$st\",\"updatedAt\":\"$up\"},\"fieldValueByName\":{\"name\":\"$stat\"}},"
  done
  echo "{\"data\":{\"node\":{\"items\":{\"pageInfo\":{\"hasNextPage\":false,\"endCursor\":null},\"nodes\":[${nodes%,}]}}}}"
}

# ---- 1. PR の節 -------------------------------------------------------------------------------

t_mon_all_green() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":11,"headRefOid":"sha11","isDraft":false}]' ;;
    "api repos/"*"/commits/sha11/check-runs --paginate")
      echo '$(cr_page 3 check:success gitleaks:success audit:success)' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "全部緑なら exit 0: $ERR"
  assert_contains "$ERR" "PR 1 本を見ました" "**母数を出す（#757）**"
  assert_contains "$ERR" "赤 0 本" "**「赤 0 本」と言い切れるのは測れたときだけ**"
  assert_contains "$ERR" "check-run 計 3 件 / total_count 計 3 件" "**取れた件数と母数の両方を出す**"
  assert_contains "$ERR" "節 2/2 を測れました" "**締めの行が出る（これが無ければ途中で死んでいる）**"
  assert_not_contains "$ERR" "MONITOR-BROKEN" "測れているときに壊れたと言わない"
}
test_case "monitor: 全部緑 → exit 0、母数つきで報告し MONITOR-BROKEN を出さない" t_mon_all_green

t_mon_red_check() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":12,"headRefOid":"sha12","isDraft":false}]' ;;
    "api repos/"*"/commits/sha12/check-runs --paginate")
      echo '$(cr_page 3 check:failure gitleaks:success audit:null)' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "赤が在れば exit 3（測定は成功している）: $ERR"
  assert_contains "$ERR" "赤 PR #12" "**PR を番号で名指しする**"
  assert_contains "$ERR" "赤 1 件" "赤の件数"
  assert_contains "$ERR" "実行中 1 件" "実行中を赤と混ぜない"
  assert_not_contains "$ERR" "MONITOR-BROKEN" "**赤が在ることは「測れなかった」ではない**"
}
test_case "monitor: 赤い検査 → exit 3、PR 番号と件数を出す（実行中と混ぜない）" t_mon_red_check

# **これが #1093 / #1116 の形そのものである。** **取りこぼしを「赤 0 件」と言ってはいけない。**
t_mon_short_page_is_broken() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":13,"headRefOid":"sha13","isDraft":false}]' ;;
    # **total_count 53 と言いながら 2 件しか返らない**（#1093 の 30/53 と同じ形）
    "api repos/"*"/commits/sha13/check-runs --paginate")
      echo '$(cr_page 53 check:success gitleaks:success)' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**取りこぼしは exit 4（MONITOR-BROKEN）。緑にしない**: $ERR"
  assert_contains "$ERR" "MONITOR-BROKEN" "壊れたと言う"
  assert_contains "$ERR" "手元 2 件 / total_count 53 件" "**両方の数字を出す（#757）**"
  assert_contains "$ERR" "赤を見落としている可能性" "**何を信じてはいけないかを言う**"
}
test_case "monitor: total_count より少ない check-runs → exit 4（#1093 の 30/53 の形）" t_mon_short_page_is_broken

# **`--paginate` を実際に付けているか**を、呼び出しログで固定する。
# **付いていないと 30 件で切れる**（#1093 で必須 5 件が丸ごと消えた）。
t_mon_uses_paginate() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":14,"headRefOid":"sha14","isDraft":false}]' ;;
    "api repos/"*"/commits/sha14/check-runs --paginate")
      echo '$(cr_page 1 check:success)' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "check-runs	--paginate" "**--paginate を付けて呼ぶ（#1093）**"
}
test_case "monitor: check-runs は --paginate を付けて呼ぶ (#1093)" t_mon_uses_paginate

# **`--paginate` は複数ページを 1 個の JSON に畳まない**（#1093 の実測）。
# **ページごとに 1 個のドキュメントが並ぶので、束ねてから畳まないと同名が 2 件に数えられる。**
# ここでは **`check` が 2 ページに分かれ、片方が failure** の形にする——
# **束ねずにページごとに畳むと、2 ページ目の success だけを見て緑になる。**
t_mon_folds_across_pages() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":15,"headRefOid":"sha15","isDraft":false}]' ;;
    "api repos/"*"/commits/sha15/check-runs --paginate")
      echo '$(cr_page 2 check:failure)'
      echo '$(cr_page 2 check:success)' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**ページを跨いだ failure を見落とさない**: $ERR"
  assert_contains "$ERR" "赤 PR #15" "赤として挙げる"
  assert_contains "$ERR" "赤 1 件" "**2 ページを 1 件に畳む（2 件と数えない）**"
}
test_case "monitor: --paginate の複数ドキュメントを束ねてから畳む (#1093)" t_mon_folds_across_pages

# **同名の畳み方が `merge-when-green.sh` と揃っているか**（#1110 の要件 2 / #1128）。
# **古い failure → 新しい success** は **failure を採る**。
# **これはゲートと同じ目である**（ゲートが止める PR を monitor が緑と見たら、PO には
# 「詰まっていない」ように見える）。
t_mon_collapses_worst() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":16,"headRefOid":"sha16","isDraft":false}]' ;;
    "api repos/"*"/commits/sha16/check-runs --paginate")
      echo '{"total_count":2,"check_runs":[
        {"name":"pr-closes","conclusion":"success","started_at":"2026-09-29T03:08:15Z"},
        {"name":"pr-closes","conclusion":"failure","started_at":"2026-09-29T02:47:20Z"}]}' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**同名は最も悪いものを採る（merge-when-green.sh と同じ目）**: $ERR"
  assert_contains "$ERR" "赤 1 件" "**新しい success で塗り替えない（#1128）**"
}
test_case "monitor: 同名の check-run は最も悪いものを採る (merge-when-green と同じ。#1128)" t_mon_collapses_worst

# **`skipped` を赤にも緑にも数えない**（#1069 の一覧を複製しないため）。**別の列で出す。**
t_mon_skipped_is_its_own_column() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[{"number":17,"headRefOid":"sha17","isDraft":false}]' ;;
    "api repos/"*"/commits/sha17/check-runs --paginate")
      echo '$(cr_page 3 check:failure issue-secrets:skipped audit:success)' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "exit status: $ERR"
  assert_contains "$ERR" "赤 1 件" "**skipped を赤に数えない**"
  assert_contains "$ERR" "skipped 1 件" "**skipped を別の列で出す（緑にも数えない）**"
}
test_case "monitor: skipped は赤にも緑にも数えず別の列で出す (#1069 の一覧を複製しない)" t_mon_skipped_is_its_own_column

t_mon_pr_list_fails() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo "boom" >&2; exit 1 ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**PR を 1 本も見られなかったら exit 4。緑にしない**: $ERR"
  assert_contains "$ERR" "MONITOR-BROKEN" "壊れたと言う"
  assert_contains "$ERR" "開いている PR の一覧が取れませんでした" "何が取れなかったかを言う"
  assert_not_contains "$ERR" "赤 0 本" "**「赤 0 本」と言ってはいけない（数えていない）**"
}
test_case "monitor: PR の一覧が取れない → exit 4（「赤 0 本」と言わない。#757）" t_mon_pr_list_fails

# ---- 2. ボードの節 ----------------------------------------------------------------------------

# **90 分（既定）を超えて動いていない In Progress を挙げる。**
t_mon_stale_inprogress() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    # #31 は 2 時間前、#32 は 5 分前
    "api graphql"*) echo '$(board_page 31:OPEN:"In Progress":2026-09-29T18:00:00Z 32:OPEN:"In Progress":2026-09-29T19:55:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  # 2026-09-29T20:00:00Z
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "停滞が在れば exit 3: $ERR"
  assert_contains "$ERR" "停滞 #31" "**2 時間動いていないものを挙げる**"
  assert_not_contains "$ERR" "停滞 #32" "**5 分前に動いたものを挙げない（誤報しない）**"
  assert_contains "$ERR" "In Progress 2 件（停滞 1 件" "**母数と内訳を出す**"
  assert_contains "$ERR" "120 分動いていません" "**何分止まっているかを出す**"
}
test_case "monitor: In Progress のまま 90 分動いていない PBI を挙げる（動いているものは挙げない）" t_mon_stale_inprogress

t_mon_threshold_is_configurable() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '$(board_page 33:OPEN:"In Progress":2026-09-29T19:30:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  # 30 分前。既定 90 分では鳴らない
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "30 分では既定の 90 分に届かない: $ERR"
  assert_not_contains "$ERR" "停滞 #33" "既定では鳴らない"
  # 20 分に下げると鳴る（**閾値が実際に効いていることを固定する**）
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 STALE_MINUTES=20 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**閾値を下げれば同じ入力で鳴る**: $ERR"
  assert_contains "$ERR" "停滞 #33" "閾値が効いている"
  assert_contains "$ERR" "閾値 20 分" "**使った閾値を出力に書く**"
}
test_case "monitor: STALE_MINUTES が実際に効く（同じ入力で答えが変わる）" t_mon_threshold_is_configurable

t_mon_ignores_other_statuses() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    # Backlog / In Review / Done / CLOSED はどれも「止まった作業」ではない
    "api graphql"*) echo '$(board_page 41:OPEN:Backlog:2026-01-01T00:00:00Z 42:OPEN:"In Review":2026-01-01T00:00:00Z 43:OPEN:Done:2026-01-01T00:00:00Z 44:CLOSED:"In Progress":2026-01-01T00:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "**In Progress 以外は鳴らさない**: $ERR"
  assert_contains "$ERR" "項目 4 件を見ました" "**母数は 4 件（見たことは出す）**"
  assert_contains "$ERR" "In Progress 0 件" "**In Progress は 0 件**"
}
test_case "monitor: Backlog / In Review / Done / CLOSED は停滞に数えない" t_mon_ignores_other_statuses

t_mon_board_empty_is_broken() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**ボードが 0 件なら「空」と言い切らず壊れたと言う（#757）**: $ERR"
  assert_contains "$ERR" "ボードが空なのか読めていないのか区別できません" "区別できないと言う"
}
test_case "monitor: ボードの項目が 0 件 → exit 4（空と読めないを区別しない。#757）" t_mon_board_empty_is_broken

t_mon_board_bad_timestamp() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
      {"content":{"number":51,"state":"OPEN","updatedAt":null},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**時刻が読めないものは鳴らさず、測れなかったと言う**: $ERR"
  assert_contains "$ERR" "更新時刻が取れていません" "何が取れなかったかを言う"
  assert_contains "$ERR" "停滞 0 件は下限です" "**0 件が下限であることを言う（#757）**"
  # **これが tab の畳み込みを固定する断定である**（**実測でここに落ちた**）。
  # **`read` は tab を IFS の空白として扱い、連続した tab を 1 個に畳む**:
  #   printf 'a\t\tb\n' | while IFS=$'\t' read -r x y z  →  **[a][b][]**
  # **`updatedAt` が null だと Status が 1 つ前にずれて読まれ、この項目は
  # `In Progress` の照合に落ちて黙って消える**——**`In Progress 0 件` になる。**
  # **「測っていないのに 0 件」**はこの道具が存在する理由そのものの形なので、
  # **本数を逐語で固定する。**
  assert_contains "$ERR" "In Progress 1 件" "**時刻が無くても In Progress として数える（tab の畳み込みでずれない）**"
  assert_contains "$ERR" "時刻が取れなかったもの 1 件" "**取れなかった件数を出す**"
  assert_not_contains "$ERR" "In Progress 0 件" "**黙って消えてはいけない**"
}
test_case "monitor: In Progress の更新時刻が取れない → 鳴らさず exit 4（0 件は下限と言う）" t_mon_board_bad_timestamp

t_mon_board_graphql_fails() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo "boom" >&2; exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "スクラムボードが読めませんでした" "何が読めなかったかを言う"
  assert_contains "$ERR" "節 1/2 を測れました" "**測れた節の数を出す（1/2 と 2/2 が区別できる）**"
}
test_case "monitor: ボードの GraphQL が失敗 → exit 4、測れた節の数を出す" t_mon_board_graphql_fails

# ---- 3. worktree の節 -------------------------------------------------------------------------
#
# **実在のディレクトリを使う**（`-d` と `stat` は fake `git` では偽装できない）。
# **$TMP の下だけを使うので、実在の worktree は 1 本も触らない。**

t_mon_stale_worktree() {
  local live="$TMP/wt-live" stale="$TMP/wt-stale"
  mkdir -p "$live/.git" "$stale/.git"
  : > "$live/.git/index";  touch -d "@1790711700" "$live/.git/index"   # 5 分前
  : > "$stale/.git/index"; touch -d "@1790704800" "$stale/.git/index"  # 120 分前
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' "worktree $live" "" "worktree $stale" "" ;;
    "-C $live rev-parse --git-path index")  echo "$live/.git/index" ;;
    "-C $stale rev-parse --git-path index") echo "$stale/.git/index" ;;
    *"log -1 --format=%ct") echo 1 ;;
    "-C "*" status --porcelain") ;;
    "-C "*" diff --cached --name-status") ;;
    *) ;;
  esac
}
EOF
)
  MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "停滞 worktree が在れば exit 3: $ERR"
  assert_contains "$ERR" "停滞 worktree: 120 分" "**120 分止まっているものを挙げる**"
  assert_contains "$ERR" "worktree 2 本を見ました: 停滞 1 本" "**母数と内訳（5 分前のものは挙げない）**"
  # **OSS なのでパスを出さない**（#1110 の作法）
  assert_not_contains "$ERR" "$live" "**worktree のパスを出力に書かない（OSS）**"
  assert_not_contains "$ERR" "$stale" "**停滞しているツリーのパスも書かない（OSS）**"
}
test_case "monitor: 停滞 worktree を挙げ、パスは出力に書かない（OSS）" t_mon_stale_worktree

t_mon_ghost_worktree() {
  local live="$TMP/wt-g-live" ghost="$TMP/wt-g-ghost"
  mkdir -p "$live/.git"; : > "$live/.git/index"; touch -d "@1790711700" "$live/.git/index"
  rm -rf "$ghost"
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' "worktree $live" "" "worktree $ghost" "" ;;
    "-C $live rev-parse --git-path index") echo "$live/.git/index" ;;
    *"log -1 --format=%ct") echo 1 ;;
    "-C "*" status --porcelain") ;;
    "-C "*" diff --cached --name-status") ;;
    *) ;;
  esac
}
EOF
)
  MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "幽霊が在れば exit 3: $ERR"
  assert_contains "$ERR" "幽霊 1 本" "**幽霊を数える（#1099 の変異 2）**"
  assert_contains "$ERR" "未 push の成果物が在りうる" "**消す前に人が見るべきだと言う（#1087）**"
  assert_not_contains "$ERR" "$ghost" "**幽霊のパスも出力に書かない（OSS）**"
}
test_case "monitor: 幽霊 worktree（登録は在るがディレクトリが無い）を数える" t_mon_ghost_worktree

# **worktree-audit.sh の判定をここに書き直さない**（#1110）。**呼んで、終了コードを伝える。**
t_mon_delegates_to_worktree_audit() {
  local live="$TMP/wt-d-live"
  mkdir -p "$live/.git"; : > "$live/.git/index"; touch -d "@1790711700" "$live/.git/index"
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' "worktree $live" "branch refs/heads/x" "" ;;
    "-C $live rev-parse --git-path index") echo "$live/.git/index" ;;
    # **worktree-audit.sh が見る形**: staged に削除が在る → あちらが exit 3 を返す
    "-C $live status --porcelain") printf '%s\n' "D  src/a.ts" ;;
    "-C $live diff --cached --name-status") printf '%s\n' "D	src/a.ts" ;;
    *"log -1 --format=%ct") echo 1790711700 ;;
    *) ;;
  esac
}
EOF
)
  MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**worktree-audit.sh の exit 3 を伝える**: $ERR"
  assert_contains "$ERR" "worktree-audit.sh が exit 3 を返しました" "**判定を委ねたことを言う**"
  assert_contains "$ERR" "commit すると他人の成果物が消えます" "**何が危ないかを言う（#1033 / #1057）**"
  assert_contains "$LOG" "git	worktree	list	--porcelain" "worktree-audit.sh が実際に走った"
}
test_case "monitor: 残留の分類は worktree-audit.sh に委ね、その exit 3 を伝える (#1110)" t_mon_delegates_to_worktree_audit

t_mon_skip_local_is_announced() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$ERR" "MONITOR_SKIP_LOCAL=1 のため飛ばしました" "**飛ばしたことを黙らない（#1094）**"
  assert_contains "$ERR" "節 2/2 を測れました" "**飛ばした節は母数から外す（3/3 と 2/2 が区別できる）**"
  assert_not_contains "$LOG" "git	worktree	list" "**飛ばしたら git を呼ばない**"
}
test_case "monitor: MONITOR_SKIP_LOCAL=1 は飛ばしたことを言い、母数から外す (#1094)" t_mon_skip_local_is_announced

# ---- 4. 道具自身が壊れたこと（#1110 の要件 5 / #1094）-----------------------------------------

# **「測れなかった」と「行動が要る」が重なったら 4 を返す**（**測れなかったほうが重い**）。
t_mon_broken_beats_findings() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    # 赤（行動が要る）と、ボードが読めない（測れなかった）を同時に起こす
    "pr list --repo "*) echo '[{"number":61,"headRefOid":"sha61","isDraft":false}]' ;;
    "api repos/"*"/commits/sha61/check-runs --paginate")
      echo '$(cr_page 1 check:failure)' ;;
    "api graphql"*) echo "boom" >&2; exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**測れなかったほうが重い（3 ではなく 4）**: $ERR"
  assert_contains "$ERR" "赤 PR #61" "測れた側の事実はちゃんと出す"
  assert_contains "$ERR" "行動が要る事実 1 件" "**件数も出す**"
  assert_contains "$ERR" "この出力を『異常なし』として読まないでください" "**信じてはいけないと言う**"
}
test_case "monitor: 測れなかった節と赤が同時に在れば exit 4（測れなかったほうが重い）" t_mon_broken_beats_findings

# **締めの 1 行は必ず出る**——**入口がこの行の有無で「監視自身の死」を検出する**（#547 / #1110）。
t_mon_always_prints_closing_line() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo "boom" >&2; exit 1 ;;
    "api graphql"*) echo "boom" >&2; exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "全部測れなくても exit 4（0 ではない）: $ERR"
  assert_contains "$ERR" "scrum-monitor: 終了（節 0/2 を測れました" "**1 つも測れなくても締めの行は出る**"
  assert_contains "$ERR" "測れなかった節が 2 件" "**測れなかった節の数を出す**"
}
test_case "monitor: 全部測れなくても締めの行を出す（入口がこれで死を検出する。#547）" t_mon_always_prints_closing_line

t_mon_rejects_args() {
  local h; h=$(handler <<'EOF'
handle() { echo '[]'; }
git_handle() { :; }
EOF
)
  run_script "$h" scrum-monitor.sh --wat
  assert_eq 2 "$STATUS" "知らない引数は usage（exit 2）"
  assert_contains "$ERR" "usage" "usage を出す"
}
test_case "monitor: 知らない引数は exit 2" t_mon_rejects_args

t_mon_rejects_bad_threshold() {
  local h; h=$(handler <<'EOF'
handle() { echo '[]'; }
git_handle() { :; }
EOF
)
  STALE_MINUTES=abc run_script "$h" scrum-monitor.sh
  assert_eq 1 "$STATUS" "**閾値が数でなければ落ちる（0 分として扱って全件鳴らさない）**"
  assert_contains "$ERR" "STALE_MINUTES" "何が悪いかを言う"
}
test_case "monitor: STALE_MINUTES が数でなければ落ちる（全件鳴らさない）" t_mon_rejects_bad_threshold
