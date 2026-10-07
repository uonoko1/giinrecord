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

# 1 件ずつ引く PR 検索（`gh pr list --search "<番号> in:head"`）の応答。
# `$1..` = `prnumber:branch:updatedAt`
# **本物の検索は部分一致で外れが混ざる**（実測: `1137 in:head` が
# `feat/1110-scrum-monitor` と `fix/693-pdf-table-ctm` も返した）ので、
# **外れを混ぜた fixture も使う**（実装が自分で照合し直していることを測るため）。
pr_search() {
  local rows=""
  for spec in "$@"; do
    IFS=: read -r pn br up <<<"$spec"
    rows+="{\"number\":$pn,\"headRefName\":\"$br\",\"updatedAt\":\"$up\"},"
  done
  echo "[${rows%,}]"
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
# **【#1150 のレビュー N2】畳み込みの「鍵」が `.name` であることを固定する。**
#
# **レビュアーの実測**: **`group_by(.name)` を消しても 0 件落ちた。**
# **原因は fixture**——**「同名の重複」と「別名だが同じ conclusion」が同時に在る形が無く、
# `group_by(.conclusion)` に変えても同じ答えになっていた。**
# **これは M3（`started_at` を投影から落としていた）とまったく同じ型の見落としである。**
#
# **この fixture は 2 つの鍵を分ける**（実測。`jq` に直接当てて確かめた）:
#   ```
#   check    failure  01:00      group_by(.name)       → fail 1 / pass 2  （検査 3 件）
#   check    success  02:00      group_by(.conclusion) → fail 1 / pass 1  （検査 2 件）
#   audit    success  01:00
#   gitleaks success  01:00
#   ```
# **`check` の重複が畳まれ、`audit` と `gitleaks` は別々に残る**のが正しい。
# **conclusion で畳むと `audit` と `gitleaks` が 1 つになって消える。**
# **だから「畳んだ後の件数」を逐語で固定する**——**赤の数だけでは両者が同じになる。**
t_mon_collapse_key_is_the_name() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[{"number":18,"headRefOid":"sha18","isDraft":false}]' ;;
    "api repos/"*"/commits/sha18/check-runs --paginate")
      echo '{"total_count":4,"check_runs":[
        {"name":"check","conclusion":"failure","started_at":"2026-09-29T01:00:00Z"},
        {"name":"check","conclusion":"success","started_at":"2026-09-29T02:00:00Z"},
        {"name":"audit","conclusion":"success","started_at":"2026-09-29T01:00:00Z"},
        {"name":"gitleaks","conclusion":"success","started_at":"2026-09-29T01:00:00Z"}]}' ;;
    "api graphql"*) echo '$(board_page 20:OPEN:Ready:2026-09-29T20:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "赤が在れば exit 3: $ERR"
  # **`check` の 2 件が 1 件に畳まれ、悪いほう（failure）が採られる**
  assert_contains "$ERR" "赤 1 件" "**同名を畳んで赤 1 件（2 件と数えない）**"
  # **`audit` と `gitleaks` は別名なので畳まれない**——**conclusion で畳むと 1 件になって消える。**
  # **緑の件数は出力に出ないので、実行中と skipped が 0 であることと合わせて
  # 「検査 4/4 件」で母数を固定する**（取りこぼしの検算が効いていることも兼ねる）。
  # **これが鍵を固定する断定である**: `check` の重複が畳まれて 3 件（check/audit/gitleaks）。
  # **conclusion で畳むと 2 件になる**（audit と gitleaks が 1 つに潰れる）。
  assert_contains "$ERR" "別名 3 件に畳みました" "**鍵は .name（conclusion で畳むと 2 件になる）**"
  assert_contains "$ERR" "検査 4/4 件" "**畳む前の母数は 4 件**"
  assert_contains "$ERR" "実行中 0 件" "実行中は 0"
  assert_contains "$ERR" "skipped 0 件" "skipped は 0"
}
test_case "monitor: 畳み込みの鍵は .name（conclusion で畳むと別名が消える。#1150 レビュー N2)" t_mon_collapse_key_is_the_name

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
    # 節 1（開いている PR の赤）は空にする
    "pr list --repo "*" --state open"*) echo '[]' ;;
    # #31 は 2 時間前、#32 は 5 分前。**どちらも対応する PR は同じだけ静か**にしておく
    "pr list --repo "*"--search 31 in:head"*) echo '$(pr_search 91:fix/31-a:2026-09-29T18:00:00Z)' ;;
    "pr list --repo "*"--search 32 in:head"*) echo '$(pr_search 92:fix/32-b:2026-09-29T19:55:00Z)' ;;
    "api graphql"*) echo '$(board_page 31:OPEN:"In Progress":2026-09-29T18:00:00Z 32:OPEN:"In Progress":2026-09-29T19:55:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  # 2026-09-29T20:00:00Z
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "判定不能が在れば exit 3: $ERR"
  # **「停滞」と断定しない。「判定不能」と出す**（#1150 のレビュー【重】。ListAgents を呼べない）
  assert_contains "$ERR" "判定不能 #31" "**2 時間静かなものを挙げる**"
  assert_not_contains "$ERR" "#32" "**5 分前に動いたものは挙げない（誤報しない）**"
  assert_contains "$ERR" "In Progress 2 件（**判定不能 1 件**" "**母数と内訳を出す**"
  assert_contains "$ERR" "120 分静かです" "**何分静かかを出す**"
  assert_contains "$ERR" "区別できません" "**断定しないことを見出しに出す（注記に逃がさない）**"
  assert_not_contains "$ERR" "停滞 #31" "**「停滞」と断定しない**"
}
test_case "monitor: Issue も PR も静かなものは「判定不能」として挙げる（断定しない。#1150 レビュー）" t_mon_stale_inprogress

t_mon_threshold_is_configurable() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search 33 in:head"*) echo '$(pr_search 93:fix/33-c:2026-09-29T19:30:00Z)' ;;
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
  assert_not_contains "$ERR" "#33" "既定では鳴らない"
  # 20 分に下げると鳴る（**閾値が実際に効いていることを固定する**）
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 STALE_MINUTES=20 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**閾値を下げれば同じ入力で鳴る**: $ERR"
  assert_contains "$ERR" "判定不能 #33" "閾値が効いている"
  assert_contains "$ERR" "閾値 20 分" "**使った閾値を出力に書く**"
}
test_case "monitor: STALE_MINUTES が実際に効く（同じ入力で答えが変わる）" t_mon_threshold_is_configurable

# **【#1150 の 2 人目のレビュー 軽微】境界値を fixture に置く。**
#
# **`-ge` → `-gt` と「未来時刻を 0 に丸める」の削除が、どちらも緑だった**
# ——**閾値とちょうど等しい値と、未来の時刻が fixture に 1 つも無かったから。**
# **`started_at` / `group_by` の鍵と同じ、fixture の薄さである。**
#
# **閾値は「$STALE_MINUTES 分以上」の意味である**（`-ge`）。
# **ちょうど 90 分は鳴る**——**`-gt` にすると鳴らなくなる。**
t_mon_threshold_is_inclusive() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    # **ちょうど 90 分前**（MONITOR_NOW=1790712000 = 2026-09-29T20:00:00Z の 90 分前）
    "pr list --repo "*"--search 301 in:head"*) echo '$(pr_search 391:fix/301-a:2026-09-29T18:30:00Z)' ;;
    # **89 分前**（1 分だけ内側。こちらは鳴らない）
    "pr list --repo "*"--search 302 in:head"*) echo '$(pr_search 392:fix/302-b:2026-09-29T18:31:00Z)' ;;
    "api graphql"*) echo '$(board_page 301:OPEN:"In Progress":2026-09-29T18:30:00Z 302:OPEN:"In Progress":2026-09-29T18:31:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**ちょうど閾値は鳴る（-ge。-gt にすると鳴らない）**: $ERR"
  assert_contains "$ERR" "判定不能 #301" "**ちょうど 90 分は「以上」に含む**"
  assert_not_contains "$ERR" "#302" "**89 分は含まない（1 分の差で分かれる）**"
  assert_contains "$ERR" "90 分静かです" "**境界の値をそのまま出す**"
}
test_case "monitor: 閾値はちょうどの値を含む（-ge。#1150 2 人目 軽微）" t_mon_threshold_is_inclusive

# **未来の時刻を 0 に丸める**（`worktree-audit.sh` と同じ扱い）。
# **丸めを消すと `-1440 分静かです` のような負の表示が出る。**
# **印が付く側は変わらない**（負の age は閾値未満なので鳴らない）ので、**変わるのは表示だけ**
# ——**だから「負の数を出さない」ことを逐語で固定するしかない。**
t_mon_future_timestamp_is_clamped() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    # **PR の updatedAt が 1 日先**（時計のずれで実際に起こりうる）。
    # **Issue より PR が新しい**ので「動いている」の行に入り、そこで age が表示される
    # ——**丸めを消すと、その行に負の分数が出る。**
    "pr list --repo "*"--search 303 in:head"*) echo '$(pr_search 393:fix/303-c:2026-09-30T20:00:00Z)' ;;
    "api graphql"*) echo '$(board_page 303:OPEN:"In Progress":2026-09-29T08:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "**未来の時刻は鳴らさない**: $ERR"
  # **負の分数を出力に出さない**（丸めを消すと `-1440` が出る）
  assert_not_contains "$ERR" "-1440 分前" "**負の分数を出さない（未来時刻を 0 に丸める）**"
  assert_contains "$ERR" "0 分前に動いています" "**未来は 0 分前として出す**"
  assert_not_contains "$ERR" "判定不能 #303" "未来の時刻で鳴らさない"
}
test_case "monitor: 未来の時刻は 0 に丸める（負の分数を出さない。#1150 2 人目 軽微）" t_mon_future_timestamp_is_clamped

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
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search 51 in:head"*) echo '[]' ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"totalCount":1,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
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
  assert_contains "$ERR" "判定不能 0 件は下限です" "**0 件が下限であることを言う（#757）**"
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

# **【#1150 のレビュー【重】】Issue が静かでも PR が動いていれば鳴らさない。**
# **レビュアーの実測では誤報率 83%（6 件中 5 件）だった**——
# **#1110/#1123/#1125/#1129/#1137 は Issue が 676〜2,307 分静かだが、
# 対応する PR は 0〜10 分前に触られていた。** **真の停滞は #867 の 1 件だけ。**
# **これは閾値の問題ではない**（閾値を 10 倍にしても 4 件は依然鳴る）。
t_mon_pr_activity_silences_quiet_issue() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    # **#1137 の実物の形**: Issue は 720 分静か、PR #1142 は 54 分前
    "pr list --repo "*"--search 1137 in:head"*) echo '$(pr_search 1142:ci/1137-split-build-deploy:2026-09-29T19:06:00Z)' ;;
    "api graphql"*) echo '$(board_page 1137:OPEN:"In Progress":2026-09-29T08:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "**PR が動いていれば鳴らさない（誤報 83% の直し）**: $ERR"
  assert_not_contains "$ERR" "判定不能 #1137" "**Issue が 720 分静かでも鳴らさない**"
  assert_contains "$ERR" "動いている #1137" "**なぜ鳴らさなかったかを出す（黙って救わない）**"
  assert_contains "$ERR" "PR #1142 が 54 分前" "**どの PR がいつ動いたかを出す**"
  assert_contains "$ERR" "鳴らさなかったもの 1 件" "**救った件数を母数に出す**"
}
test_case "monitor: Issue が静かでも PR が動いていれば鳴らさない (#1150 レビュー【重】誤報 83%)" t_mon_pr_activity_silences_quiet_issue

# **検索は部分一致なので、返ってきたものを自分で照合し直す**（実測:
# `1137 in:head` が `feat/1110-scrum-monitor` と `fix/693-pdf-table-ctm` も返した）。
# **照合しないと、無関係な PR の新しい時刻で「動いている」ことになって黙る。**
t_mon_reverifies_search_results() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    # **外れだけを返す**（どれも 61 の枝ではない）。**新しい時刻を持たせて罠にする**
    "pr list --repo "*"--search 61 in:head"*) echo '$(pr_search 99:feat/1110-scrum-monitor:2026-09-29T19:59:00Z 98:fix/693-pdf-table-ctm:2026-09-29T19:59:00Z)' ;;
    "api graphql"*) echo '$(board_page 61:OPEN:"In Progress":2026-09-29T08:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 3 "$STATUS" "**枝名が一致しない PR で黙ってはいけない**: $ERR"
  assert_contains "$ERR" "判定不能 #61" "**外れを採らないので、静かなままと判定する**"
  assert_contains "$ERR" "対応する PR が 1 本もありません" "**照合の結果「無い」と言う**"
  assert_contains "$ERR" "対応する PR が無いもの 1 件" "**母数に出す**"
}
test_case "monitor: PR 検索は部分一致なので枝名で照合し直す（外れを採らない）" t_mon_reverifies_search_results

# **【#1150 の 2 人目のレビュー 要修正 1】ボードのページングを打ち切ると盲目になる。**
#
# **レビュアーの実測**: **`break` で打ち切ると、実データで 459 件 → 100 件、
# 停滞 2 件 → 0 件になり、しかも `MONITOR-BROKEN` が出ず「節 2/2 を測れました」と言った。**
# **設計（「黙って 0 を出さない」）に直接反している。**
#
# **原因は fixture の薄さ**（**`max_by(severity)` の `started_at` / `group_by` の鍵と同型**）:
# **`board_page()` が全 fixture で `"hasNextPage":false` を固定していた**ので、
# **2 ページ目が存在せず、打ち切りを測れなかった。**
# **実測で In Progress の 2 件はどちらも 1 ページ目に載っていない。**
#
# **ここでは 2 ページに分け、In Progress を 2 ページ目にだけ置く。**
# **打ち切ると In Progress が 0 件になり、かつ totalCount の検算が落ちる**
# ——**「0 件」ではなく「測れなかった」と言うことを固定する。**
t_mon_board_follows_pagination() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search 202 in:head"*) echo '[]' ;;
    # **1 ページ目**: In Progress は 1 件も載っていない（hasNextPage=true）
    "api graphql"*"cursor=CUR2"*) echo '{"data":{"node":{"items":{"totalCount":2,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
      {"content":{"number":202,"state":"OPEN","updatedAt":"2026-09-29T08:00:00Z"},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"totalCount":2,"pageInfo":{"hasNextPage":true,"endCursor":"CUR2"},"nodes":[
      {"content":{"number":201,"state":"OPEN","updatedAt":"2026-09-29T19:59:00Z"},"fieldValueByName":{"name":"Backlog"}}]}}}}' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  # **2 ページ目まで追えば In Progress が 1 件見つかり、静かなので判定不能になる**
  assert_eq 3 "$STATUS" "**2 ページ目を追えば In Progress が見つかる**: $ERR"
  assert_contains "$ERR" "判定不能 #202" "**2 ページ目の In Progress を拾う（打ち切ると消える）**"
  assert_contains "$ERR" "項目 2 件を見ました" "**2 ページ合わせて 2 件（1 件ではない）**"
  assert_contains "$ERR" "totalCount 2" "母数を出す"
  assert_not_contains "$ERR" "MONITOR-BROKEN" "**全部追えていれば壊れたと言わない**"
  # **2 ページ目を実際に取りに行ったことを、呼び出しログで固定する**
  assert_contains "$LOG" "CUR2" "**endCursor を渡して 2 ページ目を引いている**"
}
test_case "monitor: ボードの 2 ページ目まで追う（打ち切ると In Progress が消える。#1150 2 人目 要修正 1）" t_mon_board_follows_pagination

# **【#1150 のレビュー N8】ボードのページングで黙って盲目にならない。**
# **レビュアーの実測**: **打ち切ると 457 件中 357 件が消え「In Progress 0 件」で exit 0 になった。**
# **PO も同じ形を踏んでいる**（`gh project item-list --limit 300` が 450 件のうち 300 件だけ返し、
# 「Ready が 0 件」と誤判定した）。
t_mon_board_short_page_is_broken() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    # **totalCount 457 と言いながら 1 件しか返さず、hasNextPage も false**（打ち切られた形）
    "api graphql"*) echo '{"data":{"node":{"items":{"totalCount":457,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
      {"content":{"number":71,"state":"OPEN","updatedAt":"2026-09-29T19:59:00Z"},"fieldValueByName":{"name":"Backlog"}}]}}}}' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**取りこぼしは exit 4。「In Progress 0 件」で緑にしない**: $ERR"
  assert_contains "$ERR" "MONITOR-BROKEN" "壊れたと言う"
  assert_contains "$ERR" "手元 1 件 / totalCount 457 件" "**両方の数字を出す（#757）**"
  assert_contains "$ERR" "停滞 0 件を「異常なし」と読まないでください" "**何を信じてはいけないかを言う**"
}
test_case "monitor: ボードの項目が totalCount より少ない → exit 4 (#1150 レビュー N8)" t_mon_board_short_page_is_broken

# **`totalCount` と一致していれば、ページングは足りている**（上の検査が
# 「常に MONITOR-BROKEN」になっていないことを固定する）。
t_mon_board_full_page_is_measured() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search "*) echo '[]' ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"totalCount":2,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
      {"content":{"number":72,"state":"OPEN","updatedAt":"2026-09-29T19:59:00Z"},"fieldValueByName":{"name":"Backlog"}},
      {"content":{"number":73,"state":"OPEN","updatedAt":"2026-09-29T19:59:00Z"},"fieldValueByName":{"name":"Ready"}}]}}}}' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 0 "$STATUS" "**母数が合っていれば測れたと言う**: $ERR"
  assert_contains "$ERR" "totalCount 2" "**母数を出力に書く**"
  assert_not_contains "$ERR" "取りこぼしました" "合っているときに取りこぼしと言わない"
}
test_case "monitor: ボードの項目が totalCount と一致 → 測れたと言う（常に赤にしない）" t_mon_board_full_page_is_measured

# **PR を 1 件も引けなければ「対応表が無い」ので、Issue の静けさだけで判断することになる。**
# **それは誤報 83% の状態に戻ることなので、測れなかったと言う。**
t_mon_pr_lookup_failure_is_broken() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search "*) echo "boom" >&2; exit 1 ;;
    "api graphql"*) echo '$(board_page 81:OPEN:"In Progress":2026-09-29T08:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**対応表が作れなければ exit 4**: $ERR"
  assert_contains "$ERR" "PR を引けませんでした" "何が引けなかったかを言う"
  assert_contains "$ERR" "対応表が欠けています" "**対応表が欠けていると言う**"
  assert_contains "$ERR" "引けなかったもの 1 件" "**件数を母数に出す**"
}
test_case "monitor: PR の対応表が作れない → exit 4（Issue の静けさだけで判断しない）" t_mon_pr_lookup_failure_is_broken

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

# ---- 2b. 「なぜ測れなかったか」が読み分けられること（#1210）------------------------------------
#
# **何が壊れていたか**: `gh api graphql ... 2>/dev/null` が `gh` の言い分を捨てていた。
# **残る一文は「GraphQL が返りませんでした」だけで、原因を含まない。**
# **だから CI のログを読んだ人は「たぶん一時障害」と推測する。**
#
# **実害（#1210 の本文。これは仮定ではなく起きたこと）:**
#   #1168 を閉じた   2026-10-04T13:02:50Z  根拠「手元で再測定して 3/3・rc=0」
#   #1203 が立った   2026-10-04T14:29:31Z  同じ理由（board が読めない）
#   間隔             **87 分**
# **PO は「手元の PAT（`project` スコープ有り）」で測って緑を見た。**
# **失敗した経路（`secrets.GITHUB_TOKEN`、`project` スコープ無し）は一度も試していない。**
#
# **だから検査は 3 つを固定する:**
#   1. **`gh` の言い分が出力に出る**（捨てない）
#   2. **「権限が無い」と「返らなかった」が読み分けられる**（別の語で出る）
#   3. **そのときも秘密・パス・枝名・トークンは出ない**（allowlist 寄りに通す）

# `gh` が権限の不足を言って落ちる形。**本物の文面は `gh` のバージョンと API で変わる**ので、
# **fixture は「`gh` がこう言った」という一次の文字列をそのまま置き、
# 実装がそれを分類できることだけを測る**（文面そのものを実装に焼き込まない）。
t_mon_board_permission_error_is_named() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: Your token has not been granted the required scopes to execute this query. The '"'"'id'"'"' field requires one of the following scopes: ['"'"'read:project'"'"'], but your token has only been granted the: ['"'"'repo'"'"'] scopes.' >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  # **1. gh の言い分が出る**（**これが #1210 の本体。捨てると誤診が起きる**）
  assert_contains "$ERR" "required scopes" "**gh の言い分を出力に出す（2>/dev/null に戻すとここが落ちる）**"
  assert_contains "$ERR" "read:project" "**どのスコープが足りないかが読める**"
  # **2. 「権限が無い」と名指しする**（**「待てば直る」と推測されないため**）
  assert_contains "$ERR" "権限が足りません" "**権限の不足だと名指しする**"
  assert_contains "$ERR" "この環境では構造的に測れません" "**待っても直らないと言う（#1210 のやること 2）**"
  assert_not_contains "$ERR" "一時的" "**権限の不足を「一時的」と言ってはいけない（#1168 の誤診）**"
}
test_case "monitor: ボードが権限で読めない → gh の言い分を出し「構造的に測れない」と言う (#1210)" t_mon_board_permission_error_is_named

# **一時的に返らなかった形**（5xx / タイムアウト）。**上と同じ exit 4 だが、文が違う。**
# **この 2 本が同じ文を出すなら、読み分けは出来ていない。**
t_mon_board_transient_error_is_distinguished() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.' >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "timeout" "**gh の言い分を出力に出す**"
  assert_contains "$ERR" "一時的" "**一時障害の疑いだと言う**"
  assert_not_contains "$ERR" "権限が足りません" "**権限の不足と混ぜない（これが読み分け）**"
  assert_not_contains "$ERR" "構造的に測れません" "**待てば直るものを「構造的」と言わない**"
}
test_case "monitor: ボードが一時的に返らない → 「一時的」と言い、権限の不足と混ぜない (#1210)" t_mon_board_transient_error_is_distinguished

# **原因が分からない形**（`gh` が何も言わずに落ちた）。
# **「分からない」を「一時的」や「権限」に倒さない**——**倒すと #1168 の誤診が再現する。**
t_mon_board_silent_failure_says_so() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "gh は何も言いませんでした" "**言い分が無かったことを言う**"
  assert_not_contains "$ERR" "一時的" "**分からないものを「一時的」に倒さない（#1168 の誤診の型）**"
  assert_not_contains "$ERR" "権限が足りません" "**分からないものを「権限」にも倒さない**"
}
test_case "monitor: gh が何も言わずに落ちた → 「何も言わなかった」と言い、原因を推測しない (#1210)" t_mon_board_silent_failure_says_so

# **秘密を出さない**（#1210 の受け入れ条件 2。**既存の「パスも枝名も出さない」と同じ検査に載せる**）。
#
# **`gh` の stderr をそのまま流すと何が出るか**——**実際に出うるものを fixture に全部混ぜる:**
#   - `Authorization: Bearer ghp_…` / `token ghs_…`     ← トークンの断片
#   - `https://api.github.com/...?token=…`              ← URL とクエリ
#   - worktree の絶対パス                               ← 担当者の手元を指す
#   - 枝名                                              ← 担当者を指す
# **だから raw をそのまま流す実装では、この検査が落ちる**（それが狙いである）。
t_mon_board_error_text_does_not_leak() {
  # **架空の鍵の綴りに本物の接頭辞（`ghp_` 等）を使わない**（`forbidden-patterns.sh` の
  # `github-token` 規則に当たる。**実測で当たった**: `scrum-monitor.test.sh:781`）。
  # **この検査が測りたいのは「`_` のあとに 20 文字以上続く語」を落とす規則**で、
  # **接頭辞の綴りには依存していない**——**依存させてはいけない**
  # （知らない鍵の綴りに無力な denylist になる）。
  local secretish="faketoken_AAAABBBBCCCCDDDDEEEEFFFFGGGG"
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: HTTP 401: Bad credentials (https://api.github.com/graphql?access_token=$secretish)' >&2
      echo 'Authorization: Bearer $secretish' >&2
      echo 'cwd=/home/someone/Development/gikailog/.claude/worktrees/agent-7 branch=feat/999-secret-slug' >&2
      exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  # **HTTP の状態は出していい**（これが無いと原因が読めない）
  assert_contains "$ERR" "HTTP 401" "**HTTP の状態は読めるように出す**"
  assert_contains "$ERR" "権限が足りません" "**401 は権限の側に分類する**"
  # **出してはいけないもの**
  assert_not_contains "$ERR" "$secretish" "**トークンの断片を出さない**"
  assert_not_contains "$ERR" "Bearer" "**Authorization ヘッダを出さない**"
  assert_not_contains "$ERR" "https://" "**URL を出さない（クエリに鍵が乗りうる）**"
  assert_not_contains "$ERR" "/home/" "**絶対パスを出さない（OSS）**"
  assert_not_contains "$ERR" "worktrees" "**worktree のパスを出さない（OSS）**"
  assert_not_contains "$ERR" "999-secret-slug" "**枝名を出さない（枝名は担当者を指す）**"
}
test_case "monitor: gh の言い分を出すときも鍵・URL・パス・枝名は出さない (#1210)" t_mon_board_error_text_does_not_leak

# **鍵が「裸で」出てくる形を別に測る**（上の fixture では鍵が URL と
# `Authorization` の中に在り、**先の 2 つの規則が先に消していたので、
# この規則を丸ごと消しても 0 件落ちた**——実測。**だから fixture を足す**）。
#
# **規則は接頭辞の綴りに依存しない**（`_` のあとに 20 文字以上続く語を落とす）。
# **依存させてはいけない**——**知らない鍵の綴りに無力な denylist になる。**
t_mon_board_bare_token_is_redacted() {
  local bare="sometoken_ZZZZYYYYXXXXWWWWVVVVUUUU"
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: HTTP 401: token $bare was rejected' >&2
      exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "HTTP 401" "**HTTP の状態は読めるように出す**"
  assert_not_contains "$ERR" "$bare" "**裸で出てきた鍵らしき語も落とす（接頭辞の綴りに依存しない）**"
  assert_not_contains "$ERR" "ZZZZYYYY" "**部分も残さない（断片でも鍵は鍵である）**"
}
test_case "monitor: URL でもヘッダでもない裸の鍵らしき語を落とす (#1210)" t_mon_board_bare_token_is_redacted

# **長い stderr を無制限に流さない**（Issue 本文にコピーされるので、1 行の上限と総量を決める）。
#
# **上限は 2 つで、どちらも必要である**（**片方だけ外しても落ちる形にする**）:
#   `head -n $GH_ERR_MAX_LINES`（既定 3）   行数
#   `cut -c 1-$GH_ERR_MAX_CHARS`（既定 300） 1 行の長さ
# **実測で初版の断定はどちらも殺せなかった**（`< 4000` が緩すぎた。
# **`head` を外しても 361 → 1039 文字で、4000 に届かなかった**）。
# **だから fixture は「長い行を何本も」にし、断定は設計の関係式そのものにする。**
#
#   出る長さ ≈ min(行数, 3) × min(1 行の長さ, 300) + 定型文
# **つまり 1,000 文字の行を 40 本もらっても、900 文字 + 定型文に収まる。**
t_mon_board_error_text_is_bounded() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      # **長い行を 41 本**（1 本目だけ HTTP の状態を持つ。残りも 1,400 文字ほど在る）
      # **語は `credentials`（allowlist の形 1 を通る純英字 11 文字）を並べる。**
      # **`xxxx…` では測れない**（#1217 の 2 回目のレビューが実測）:
      # **`gh_err_allow` は 1,000 文字の `x` を 1 語と見て `[redacted]`（10 文字）に畳む**ので、
      # **`head` と `cut` の限界に届かず、M7 / M8 がどちらも 302/0 で生き残った。**
      # **守りを消したのではなく、守りを試す材料が消えた**
      # ——**サニタイザが denylist から allowlist に変わった副作用である。**
      # **fixture は「allowlist を素通りする語」でなければ、上限を試せない。**
      long=$(for _ in $(seq 1 120); do printf 'credentials '; done)
      echo "gh: HTTP 502: $long" >&2
      for i in $(seq 1 40); do echo "gh: noise $i $long"; done >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "HTTP 502" "**先頭は出す**"
  # **母数を出す**（#757）: 何行のうち何行を出したか。**黙って切らない。**
  assert_contains "$ERR" "41 行のうち先頭 3 行" "**何行のうち何行を出したかが読める（黙って切らない）**"
  # **関係式を断定する。数は散文に書かない**（#1189 / #1200 の型。
  # **初版はここに「2,369 / 12,000 超 / 6,000 超」と書いていたが、
  # サニタイザを allowlist に替えたら実測が動いた**——**散文の数は必ずずれる**）。
  #
  # **上限は `$ERR` 全体ではなく、`gh` の言い分の部分に効く**
  # ——**`$ERR` には監視の他の行も入り、しかも `unmeasured` の文は 2 回出る**
  # （`log` で 1 回、末尾の一覧で 1 回）。**だから閾値は関係式から導く:**
  #
  #   gh の言い分 ≦ min(行数, GH_ERR_MAX_LINES) × min(1 行, GH_ERR_MAX_CHARS) + 定型文
  #   $ERR        ≦ （それ）× 2 + 監視の他の行
  #
  # **設計の定数はここに逐語で持つ**（**実装から読まない**。
  # [[expected-table-is-not-a-knob]]: **実装を読むと、実装を緩めたとき表も一緒に緩む**）。
  # **余白は「定型文 + 監視の他の行」のぶんで、両方の変異を破れるだけ小さく取る。**
  #
  # **`overhead=1200` を小さくしない**（#1235 R3。**実測 2026-10-08・基点 272cb286**）。
  # **この上限には「捕まらない帯」が構造的に在る**——測って中身を説明できたので、残す判断をした:
  #
  #   `$ERR` の実測（既定 `GH_ERR_MAX_CHARS=300`）            **2,369 文字**
  #   うち gh の言い分   3 行 × 300 文字 × 2 回（log と一覧）   1,800 文字
  #   うち監視の他の行（この fixture では固定）                   **569 文字**
  #   上限 3,000 までの余白                                      **631 文字**
  #   `GH_ERR_MAX_CHARS` を +1 すると `$ERR` は **+6 文字**（3 行 × 2 回）
  #   → **捕まるのは 300 + 631/6 ≒ 406 から**（**実測: 405 は通り、406 で落ちる**）
  #
  # **つまり帯は 300→405 で、これは「`$ERR` 全体を測る」設計の帰結である。**
  # **狭めるには `overhead` を 580〜600 まで落とすことになるが、それでは
  # baseline（2,369）との余白が 11〜31 文字しか残らない**（実測。580/600 でも緑にはなる）。
  # **その余白は「監視の他の行」の文章量そのもの**なので、
  # **サニタイザと無関係な文言の変更でこの検査が赤くなる**——**偽陽性で読まれなくなる方が害が大きい。**
  # **帯を本当に狭めたいなら `$ERR` 全体ではなく「gh の言い分の部分」だけを測る作り直しが要る**
  # （Issue #1235 の「どちらを採るか」。**ここでは採らない。測って残す判断である**）。
  local max_lines=3 max_chars=300 overhead=1200
  local bound=$(( max_lines * max_chars * 2 + overhead ))
  [[ ${#ERR} -lt $bound ]] || fail "**上限が効いていません**（${max_lines} 行 × ${max_chars} 文字が設計。上限 ${bound}）: ${#ERR} 文字"
  # **fixture が本当に限界に届いているかを、同じ検査で見張る**（**これが無いと、
  # fixture が畳まれて 0 件落ちる状態に戻っても誰も気づかない**——**今回それが起きた**）。
  # **1 行の素の長さ（1,440 文字）が `max_chars` を超え、行数（41）が `max_lines` を超えること。**
  assert_contains "$ERR" "41 行のうち先頭 3 行" "**fixture が行数の限界を超えている（超えないと head を試せない）**"
  [[ ${#ERR} -gt $(( max_lines * max_chars )) ]] || fail "**fixture が限界に届いていません**（畳まれて短くなった疑い）: ${#ERR} 文字"
}
test_case "monitor: gh の言い分は上限つきで出し、何行のうち何行かを言う (#1210)" t_mon_board_error_text_is_bounded

# **同じ欠陥は 1 か所ではない**（#1210 の本文はボードの 1 行を名指しするが、**全部数えた**）。
# **`scripts/po/scrum-monitor.sh` の `gh` 呼び出しは 4 か所**:
#   270  `gh pr list --state open`      → 言い分を捨てていた。**しかも文が原因を推測していた**
#                                         （「gh の認証切れ／rate limit かもしれません」）
#   284  `gh api .../check-runs`        → **対象外**。ここは意図的に rc を捨てる設計で
#                                         （赤を含む応答を出しきってから非ゼロで終わる gh のため）、
#                                         **失敗は `jq` 側の「読めなかった」で検出している。**
#                                         stderr を混ぜると全 PR ぶん出て、Issue 本文が溢れる。
#   521  `gh api graphql`（ボード）      → **#1210 が名指しした 1 行**
#   588  `gh pr list --search`           → 言い分を捨てていた
# **推測の文を残すのが一番悪い**——**「かもしれません」は読む人の推測を誘導する。**
# **#1168 を閉じた理由がまさにそれである。**

t_mon_pr_list_error_text_is_shown() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*)
      echo 'gh: HTTP 403: API rate limit exceeded for installation ID 1234.' >&2
      exit 1 ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**PR を 1 本も見られなかったら exit 4**: $ERR"
  assert_contains "$ERR" "rate limit exceeded" "**gh の言い分を出す（PR の節も同じ欠陥だった）**"
  # **推測の文を残さない**（これが #1168 の誤診を誘導した形）
  assert_not_contains "$ERR" "かもしれません" "**原因を推測する文を残さない（gh が言っている）**"
  assert_not_contains "$ERR" "installation ID 1234" "**ID のような識別子は出さない**"
}
test_case "monitor: PR の一覧が取れない → gh の言い分を出し、原因を推測しない (#1210)" t_mon_pr_list_error_text_is_shown

t_mon_pr_search_error_text_is_shown() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search "*)
      echo 'gh: Your token has not been granted the required scopes' >&2
      exit 1 ;;
    "api graphql"*) echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"content":{"number":81,"state":"OPEN","updatedAt":"2026-09-29T08:00:00Z"},"fieldValueByName":{"name":"In Progress"}}]}}}}' ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**対応表が作れなければ exit 4**: $ERR"
  assert_contains "$ERR" "PR を引けませんでした" "何が引けなかったかを言う"
  assert_contains "$ERR" "required scopes" "**gh の言い分を出す（PR 検索も同じ欠陥だった）**"
  assert_contains "$ERR" "権限が足りません" "**権限の不足だと名指しする**"
}
test_case "monitor: PR 検索が失敗 → gh の言い分を出し、権限の不足を名指しする (#1210)" t_mon_pr_search_error_text_is_shown

# **分類の表そのものを測る**（#1210 の受け入れ条件 3）。
# **`permission` と `transient` の両方について、代表的な gh の文面を 1 つずつ通す。**
# **ここが無いと、分類の分岐を丸ごと削っても「どちらか一方の」テストしか落ちない。**
t_mon_classifier_table() {
  local spec
  # `<fixture>|<出てほしい語>|<出てはいけない語>`
  # **先頭 3 件は実測した文面である**（#1210 の受け入れ条件 1。
  # **`gh` は HTTP の状態を行末の括弧に入れる**——`HTTP 401:` ではなく `(HTTP 401)`。
  # **fixture を推測で書くと、実装が当たらない形を測ってしまう**）:
  #   GH_TOKEN=<無効な値> gh api graphql -f query='query{ viewer{ login } }'
  #     → gh: Bad credentials (HTTP 401)
  #   gh api repos/torvalds/linux/actions/secrets
  #     → gh: You must have repository read permissions or ... (HTTP 403)
  #   gh api graphql -f query='query{ node(id:"<存在しない PVT_ id>"){ ... } }'
  #     → gh: Could not resolve to a node with the global id of '...'
  #
  # **3 つめは `unknown` に落ちる。それが正しい。**
  # **GraphQL は「見る権限が無いノード」を「存在しないノード」として隠す**ので、
  # **この文面は「権限が無い」の症状でもありうるが、確定しない。**
  # **`permission` に倒すと、本当に id が間違っている場合に嘘になる**
  # ——**「分からない」を断言に倒すのが #1168 の誤診の型である。**
  local -a cases=(
    # **rate limit は `HTTP 403` で返る**ので、**`transient` と `permission` の
    # どちらに倒れるかが `case` の順番で決まる**（#1210 の実装のコメント）。
    # **この 2 件が無いと、順番を入れ替える変異が 0 件落ちた**（実測）。
    'gh: HTTP 403: API rate limit exceeded for user ID 0.|一時的|権限が足りません'
    'gh: HTTP 403: You have exceeded a secondary rate limit.|一時的|権限が足りません'
    'gh: Bad credentials (HTTP 401)|権限が足りません|一時的'
    'gh: You must have repository read permissions or have the repository secrets fine-grained permission. (HTTP 403)|権限が足りません|一時的'
    "gh: Could not resolve to a node with the global id of 'PVT_kwDOAAAAAAAAAAA'|原因を分類できませんでした|権限が足りません"
    'gh: HTTP 403: Resource not accessible by integration|権限が足りません|一時的'
    'gh: HTTP 502 Bad Gateway|一時的|権限が足りません'
    'gh: Post "api": dial tcp: lookup api: no such host|一時的|権限が足りません'
    # **gh 2.89.0 が接続に失敗したときの実際の文面**（#1217 のレビューが実測）。
    # **`no such host` でも `connection refused` でもない**ので、初版は `unknown` に落としていた。
    # **一番ありふれた一時障害がこれである。**
    'error connecting to api.example.invalid|一時的|権限が足りません'
    'gh: GraphQL: INSUFFICIENT_SCOPES|権限が足りません|一時的'
    'gh: wat|原因を分類できませんでした|権限が足りません'
  )
  local fx want deny
  for spec in "${cases[@]}"; do
    IFS='|' read -r fx want deny <<<"$spec"
    local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*) echo '$fx' >&2; exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
    MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
    assert_eq 4 "$STATUS" "[$fx] 測れなければ exit 4"
    assert_contains "$ERR" "$want" "[$fx] **$want と言う**"
    assert_not_contains "$ERR" "$deny" "[$fx] **$deny と混ぜない**"
  done
}
test_case "monitor: 分類の表が読み分けられる（実測した文面を含む。件数は cases 配列が母数。#1210)" t_mon_classifier_table

# ---- 2c. **サニタイザの中核が無検査だった 4 か所**（#1217 のレビューで実測）--------------------
#
# **4 件の変異が 297/0 のまま生き残っていた。** **検査されていない実装は、
# 次に触る人が黙って壊せる。** **恒真なテストは 1 件も無かったのに、無検査のコードが在った。**
#   N1  語の形の allowlist（`gh_err_allow`）を丸ごと外す  → 0 件落ちた
#   N4  `pr_err_first` を「最初の 1 件」→「最後の 1 件」   → 0 件落ちた
#   N5  `[すべて除去されました]` の枝を消す                → 0 件落ちた
#   N6  `shown` を `total` で切り詰める行を外す            → 0 件落ちた

# **N1: 語の形の allowlist が本当に効いているか。**
#
# **初版はここを `tr -cd`（文字集合）で書いていて、しかも 1 件も検査が無かった**
# ——**散文が「これが allowlist の層である」と最も強く主張していた行が、唯一無検査だった。**
#
# **この fixture は「安全な文字だけで綴られた秘密」を並べる**（**だから `tr -cd` では落ちない**。
# **PO が実測した 5 形をそのまま使う**。[[fixtures-and-prose-drift-from-reality]]:
# **fixture は実物が出す行から採る**——`error connecting to` は `gh` 2.89.0 が
# `GH_HOST=<存在しないホスト>` で実際に吐く文面である）。
#
# **架空の鍵に本物の接頭辞（`ghp_` 等）を使わない**（`forbidden-patterns.sh` の
# `fixture-secret` 規則に当たる。**実測で当たった**）。
# **だが「長さが境界を外れた鍵」は測りたい**（初版の `_[A-Za-z0-9]{20,}` は
# **`_` の後 19 文字で素通りした**）ので、**`faketok_` + 19 文字**で測る。
# **いまの規則は長さを見ていないので、19 文字でも 28 文字でも同じく落ちる。**
t_mon_err_allowlist_passes_only_safe_word_shapes() {
  # **安全な文字だけで綴った秘密**（`/` も `://` も無く、`_` の後は 19 文字）
  local host="internal-db.giinrecord.invalid"
  local ipport="10.0.3.17:5432"
  local shortkey="faketok_ABCDEFGHIJKLMNOPQRS"
  local bearerval="sk-ant-verysecretvalue99"
  local qs="graphql?token=abcdefghijklmnop&user=x"
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: error connecting to $host (HTTP 403)' >&2
      echo 'gh: dial tcp $ipport connect refused token $shortkey Bearer $bearerval $qs' >&2
      exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  # **漏れてはいけないもの**（**すべて「安全な文字だけ」で綴られている**）
  assert_not_contains "$ERR" "$host"      "**内部のホスト名を出さない（OSS。/ も :// も持たない）**"
  assert_not_contains "$ERR" "giinrecord.invalid" "**ドメインの一部も残さない**"
  assert_not_contains "$ERR" "$ipport"    "**内部 IP とポートを出さない**"
  assert_not_contains "$ERR" "10.0.3.17"  "**IP の一部も残さない**"
  assert_not_contains "$ERR" "$shortkey"  "**鍵は長さに依存せず落ちる（アンダースコアの後 19 文字でも）**"
  assert_not_contains "$ERR" "ABCDEFGHIJKLMNOPQRS" "**断片でも鍵は鍵である**"
  assert_not_contains "$ERR" "$bearerval" "**ヘッダ名が無くても鍵の値は落ちる**"
  assert_not_contains "$ERR" "verysecret" "**断片も残さない**"
  assert_not_contains "$ERR" "abcdefghijklmnop" "**クエリ文字列の鍵も落ちる（スラッシュを持たない）**"
  # **判別に必要な情報は残る**（#1210 の受け入れ条件 3。**消えすぎても困る**）
  assert_contains "$ERR" "HTTP 403"       "**HTTP の状態は読める（これが無いと分類を追認できない）**"
  assert_contains "$ERR" "error connecting to" "**英単語は残る（何が起きたかが読める）**"
  assert_contains "$ERR" "[redacted]"     "**落ちた語は黙って消さず、伏せたことが見える**"
}
test_case "monitor: 語の形の allowlist だけを通す（安全な文字で綴った秘密も落ちる。#1217 N1)" t_mon_err_allowlist_passes_only_safe_word_shapes

# **N1 の続き: バックティックと多バイト文字が落ちること。**
#
# **これは [[gh-body-must-be-a-file-not-inline]] の実害の直系である**——
# **隣のプロジェクトでは、Issue 本文に引用されていた `docker rm -f <コンテナ名>` が実際に走った。**
# **この文字列は `gh issue comment` の本文に入るので、バックティックが残れば同じ経路に乗る。**
# **別の検査に分けるのは、N1 の fixture（秘密の形）と関心が違うから。**
t_mon_err_allowlist_drops_shell_metacharacters() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: host=vps.internal`whoami` $(id) (HTTP 403)' >&2
      echo 'gh: エラー: 日本語の秘密です' >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  # **バックティックと `$(` を literal で書くと shellcheck が SC2006 / SC2016 で落ちる**
  # （**`scripts/ci/shellcheck.sh` は info も error として扱う**。実測で rc=1）。
  # **8 進で組み立てる**——**測りたいのは「出力にこの文字が在るか」だけ**で、
  # **綴りを shellcheck に解釈させる必要が無い。**
  local bt dollarparen
  bt=$(printf '\140'); dollarparen=$(printf '\044\050')
  assert_not_contains "$ERR" "$bt"          "**バックティックを出さない（引用が実行に化ける）**"
  assert_not_contains "$ERR" "$dollarparen" "**コマンド置換の形も出さない**"
  assert_not_contains "$ERR" 'whoami'  "**バックティックの中身も残さない（語ごと落とす）**"
  assert_not_contains "$ERR" '日本語の秘密' "**多バイト文字を通さない（allowlist の外）**"
  assert_contains "$ERR" "HTTP 403"    "**HTTP の状態は残る**"
}
test_case "monitor: バックティックと多バイト文字を語ごと落とす (#1217 N1)" t_mon_err_allowlist_drops_shell_metacharacters

# **allowlist の「上限」を固定する**（#1217 の 2 回目のレビュー P1 / P2。**どちらも 302/0 で生存した**）。
#
# **N1 は「allowlist を無効化する」向きを測っていたが、「allowlist を広げる」向きが無検査だった。**
# **穴では在らない**（いまの値では正しく伏せる）**が、広げても誰も気づかない。**
# **#1224 と同じ「正しいが検査されていない」型である。**
#
# **この 2 つの数が、この allowlist で何を止めているか**（実測）:
#   `length(t) <= 24` → **純英字で綴られた鍵**（`deadbeefcafebabe…` のような hex は
#                        形 1 を通ってしまうので、**長さだけが止めている**）
#   `^[0-9]{1,4}$`    → **ポート番号・node id**（`54321` / `987654321098765`）
#
# **境界値を両側から測る**（**通る側と止まる側の両方**。片側だけでは
# 「全部通す」変異も「全部止める」変異も捕まらない）:
#   24 文字の純英字 → **通る**（`HTTP` の文が読めなくなっては困る）
#   25 文字の純英字 → **止まる**
#    4 桁の数       → **通る**（`401` `403` `502` が読めなくなっては困る）
#    5 桁の数       → **止まる**
#
# **fixture の鍵に本物の接頭辞を使わない**（`forbidden-patterns.sh` の `fixture-secret`）。
# **`deadbeef…` は純英字 32 文字で、hex としても読める**——**形 1 を長さだけが止めている**
# ことを示すのにちょうどよい。
#
# **スコープ規則（形 4 = `^[a-z]{1,12}:[a-z]{1,12}$`）の上限も、同じ理由で無検査だった**
# （#1235 = #1217 の 3 巡目のレビュー X1 / X2。**実測 2026-10-08・基点 272cb286 で
# どちらも 303 passed / 0 failed で素通りした**）。
# **この規則は `read:project` のような OAuth のスコープ名を通すために在る**
# （`gh_err_sanitize` の散文 4）。**だが数字や長さを許すと内部の情報が通る。**
#
#   **数字を許す変異**  `[a-z]` → `[a-z0-9]`   → **`db01:5432` が通る**（ホスト名とポート）
#   **長さを許す変異**  `{1,12}` → `{1,40}`    → **`db01` は 4 文字なので長さでは止まらない。**
#                                                **数字を含まないことが止めている**ので、
#                                                **長さの変異を殺すには長い純英字の `a:b` 形が要る**
#   **大文字を許す変異** `[a-z]` → `[a-zA-Z]`  → **`vpsHost:appWeb` が通る**（#1248 のレビュー。
#                                                **`db01:5432` と `averyverylongname:…` は
#                                                どちらもこの変異では止まったまま**なので、
#                                                **上の 2 行では殺せない**）
#   **点を許す変異**     `[a-z]` → `[a-z.]`    → **`abc.internal:web` が通る**（#1248 のレビュー。
#                                                **FQDN とサービス名の形。**
#                                                **既存の 2 行はどちらも点を含まない**ので、
#                                                **やはり上の 2 行では殺せない**）
# **だから fixture は 4 つ要る**（**1 行では X2 を、2 行では大文字と点を殺せない**）:
#   `db01:5432`                      → **数字**を許す変異で漏れる
#   `averyverylongname:averylongsub` → **長さ**を許す変異で漏れる（各節 13 文字以上・純英字）
#   `vpsHost:appWeb`                 → **大文字**を許す変異で漏れる（#1248 のレビュー）
#   `abc.internal:web`               → **点**を許す変異で漏れる（#1248 のレビュー）
#
# **実測（2026-10-08、基点 7c135ac6。`gh_err_allow` の awk を切り出して 4 語を流した）**:
#   いまの規則 `^[a-z]{1,12}:[a-z]{1,12}$`
#     → `abc.internal:web` / `vpsHost:appWeb` / `db01:5432` を**3 件すべて伏せる**（正しい）
#     → `read:project` は**通る**（スコープ名が読めなくなっては困る）
#   `[a-z]` → `[a-zA-Z]`  → **`vpsHost:appWeb` が漏れる**（他の 2 件は伏せたまま）
#   `[a-z]` → `[a-z.]`    → **`abc.internal:web` が漏れる**（他の 2 件は伏せたまま）
# **どちらの変異も、この 2 語を足す前の検査は緑のまま通していた**（#1248 のレビュー）。
# **通る側（`read:project` が残ること）は `t_mon_pr_search_error_text_is_shown` が既に固定している**
# ——**規則を消す／狭める向きの変異はそちらで死ぬ**ので、ここでは重ねない。
t_mon_err_allowlist_upper_bounds_are_fixed() {
  local pass24="abcdefghijklmnopqrstuvwx"          # 24 文字 → 通る
  local stop25="abcdefghijklmnopqrstuvwxy"         # 25 文字 → 止まる
  local hexkey="deadbeefcafebabedeadbeefcafebabe"  # 32 文字の純英字（hex 鍵の形）
  local hostport="db01:5432"                       # 数字を許すと通る（内部ホスト名とポート）
  local longscope="averyverylongname:averylongsub" # 各節 13 文字以上 → 長さを許すと通る
  local camelhost="vpsHost:appWeb"                 # 大文字を許すと通る（#1248 のレビュー）
  local fqdnhost="abc.internal:web"                # 点を許すと通る（#1248 のレビュー）
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: HTTP 502 word $pass24 word $stop25 key $hexkey port 54321 node 987654321098765 code 1234 host $hostport scope $longscope camel $camelhost fqdn $fqdnhost' >&2
      exit 1 ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  # **通る側**（**締めすぎを捕まえる**。これが無いと「全部伏せる」実装でも緑になる）
  assert_contains "$ERR" "$pass24" "**24 文字の純英字は通る（gh の英文が読めなくなっては困る）**"
  assert_contains "$ERR" "HTTP 502" "**4 桁までの数は通る（HTTP の状態が読めなくなっては困る）**"
  assert_contains "$ERR" "code 1234" "**4 桁の数は通る（境界のすぐ内側）**"
  # **止まる側**（**広げすぎを捕まえる**。P1 / P2 がここで死ぬ）
  assert_not_contains "$ERR" "$stop25" "**25 文字の純英字は止まる（長さの上限が効いている）**"
  assert_not_contains "$ERR" "$hexkey" "**純英字で綴られた鍵は長さだけが止めている**"
  assert_not_contains "$ERR" "deadbeef" "**断片も残さない**"
  assert_not_contains "$ERR" "54321" "**5 桁の数は止まる（ポート番号）**"
  assert_not_contains "$ERR" "987654321098765" "**15 桁の数も止まる（node id）**"
  # **スコープ規則の上限**（#1235 X1 / X2）。**どちらも「さらに通す」向きの変異で死ぬ。**
  assert_not_contains "$ERR" "$hostport"  "**スコープ規則は数字を通さない（db01:5432 が漏れる・#1235 X1）**"
  assert_not_contains "$ERR" "db01"       "**ホスト名の断片も残さない**"
  assert_not_contains "$ERR" "$longscope" "**スコープ規則は各節 12 文字まで（長い a:b が漏れる・#1235 X2）**"
  assert_not_contains "$ERR" "averyverylongname" "**断片も残さない**"
  # **#1248 のレビュー**: **大文字を許す変異（`[a-z]` → `[a-zA-Z]`）と
  # 点を許す変異（`[a-z]` → `[a-z.]`）は、上の 4 行では 1 つも死ななかった**（実測は上の散文）。
  assert_not_contains "$ERR" "$camelhost" "**スコープ規則は大文字を通さない（vpsHost:appWeb が漏れる・#1248）**"
  assert_not_contains "$ERR" "vpsHost"    "**ホスト名の断片も残さない**"
  assert_not_contains "$ERR" "$fqdnhost"  "**スコープ規則は点を通さない（abc.internal:web が漏れる・#1248）**"
  assert_not_contains "$ERR" "abc.internal" "**FQDN の断片も残さない**"
}
test_case "monitor: allowlist の上限（24 文字 / 4 桁）を両側から固定する (#1217 P1/P2)" t_mon_err_allowlist_upper_bounds_are_fixed

# **N5: `[すべて除去されました]` と「gh は何も言わなかった」を区別する。**
#
# **初版はこの枝を消しても 0 件落ちた**（#1217 レビュー）。**区別は設計の意図である**:
# **「何も言わなかった」は gh の事実**で、**「全部除去した」はこの道具の事実**。
# **混ぜると、読む人が「gh は黙っていた」と誤って受け取る。**
#
# **到達可能である。実測して条件を詰めた**（**最初に書いた fixture は到達しなかった**）:
#   `printf '\n\n'`          → **`$(cat)` が末尾の改行を落とすので `$raw` が空**になり、
#                               **「gh は何も言いませんでした」の枝に落ちた**（別の枝である）
#   **空白だけの stderr**      → **`$raw` は空ではない**（空白が在る）が、
#                               **語が 1 つも無いので `gh_err_allow` の出力が空**になる。
#                               **これが唯一この枝に落ちる形である**（実測）
# **`gh` が字下げだけの行を吐く形は実在しうる**（JSON の整形途中で落ちる等）。
# **`[redacted]` が 1 つでも出れば空にならない**ので、
# **「ASCII 以外だけの stderr」はこの枝に落ちない**（`[redacted]` が残る）。
t_mon_err_fully_redacted_is_not_silence() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      printf '   \n' >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "すべて除去されました" "**「全部除去した」と言う（この道具の事実）**"
  assert_not_contains "$ERR" "gh は何も言いませんでした" "**「gh が黙っていた」と混ぜない（別の事実）**"
}
test_case "monitor: 全部除去されたことと「gh が黙っていた」を混ぜない (#1217 N5)" t_mon_err_fully_redacted_is_not_silence

# **N6: 母数の `shown` が `total` で切り詰められること**（#757。**境界値の `total=1`**）。
#
# **初版は切り詰める行を外しても 0 件落ちた**（#1217 レビュー）。
# **既存の検査は `total=41 > 3` の側だけを測っていた**ので、
# **`GH_ERR_MAX_LINES` をそのまま書く実装でも「41 行のうち先頭 3 行」で通ってしまう。**
# **嘘が出るのは `total < GH_ERR_MAX_LINES` の側**——**1 行しか無いのに「先頭 3 行」と言う。**
# **[[two-numbers-in-two-files-drift]] と同型で、母数の正しさが誰にも見られていなかった。**
t_mon_err_shown_count_is_clamped_to_total() {
  local h; h=$(handler <<'EOF'
handle() {
  case "$*" in
    "pr list --repo "*) echo '[]' ;;
    "api graphql"*)
      echo 'gh: Bad credentials (HTTP 401)' >&2
      exit 1 ;;
    *) echo "unexpected: $*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "ボードが読めなければ exit 4: $ERR"
  assert_contains "$ERR" "1 行のうち先頭 1 行" "**1 行しか無ければ「先頭 1 行」と言う（母数を嘘にしない）**"
  assert_not_contains "$ERR" "1 行のうち先頭 3 行" "**GH_ERR_MAX_LINES をそのまま書くと嘘になる**"
}
test_case "monitor: 出した行数は実際の行数で切り詰める（1 行なら「先頭 1 行」。#1217 N6)" t_mon_err_shown_count_is_clamped_to_total

# **N4: `gh` の言い分は「最初の 1 件」を覚える**（**最後の 1 件ではない**）。
#
# **初版は「最後の 1 件」に変えても 0 件落ちた**（#1217 レビュー）。
# **「最初の 1 件」は設計の選択である**: **In Progress が N 件在れば N 回同じ `gh` を叩くので、
# 全部出すと Issue 本文が同じ文で埋まる**（**鳴り続ける監視は見られなくなる**——
# [[alerts-ringing-is-not-being-seen]]）。**だから 1 件に絞り、「最初の 1 件」と断る。**
#
# **どちらでも 1 件に絞れるので、区別するには 2 件の失敗が違う文面でなければならない。**
# **fixture は In Progress を 2 件にし、1 件目と 2 件目で別の stderr を出す。**
# **番号の若い順に引くので、1 件目が「最初」である。**
t_mon_pr_lookup_error_keeps_the_first_not_the_last() {
  local h; h=$(handler <<EOF
handle() {
  case "\$*" in
    "pr list --repo "*" --state open"*) echo '[]' ;;
    "pr list --repo "*"--search 11 in:head"*)
      echo 'gh: FIRSTERRORMARKER (HTTP 401)' >&2
      exit 1 ;;
    "pr list --repo "*"--search 22 in:head"*)
      echo 'gh: LASTERRORMARKER (HTTP 401)' >&2
      exit 1 ;;
    "api graphql"*) echo '$(board_page 11:OPEN:"In Progress":2026-09-29T08:00:00Z 22:OPEN:"In Progress":2026-09-29T08:00:00Z)' ;;
    *) echo "unexpected: \$*" >&2; exit 99 ;;
  esac
}
git_handle() { :; }
EOF
)
  MONITOR_SKIP_LOCAL=1 MONITOR_NOW=1790712000 run_script "$h" scrum-monitor.sh
  assert_eq 4 "$STATUS" "**対応表が作れなければ exit 4**: $ERR"
  assert_contains "$ERR" "2 件のうち 2 件で PR を引けませんでした" "**母数と失敗数を出す（#757）**"
  assert_contains "$ERR" "FIRSTERRORMARKER" "**最初の 1 件を覚える**"
  assert_not_contains "$ERR" "LASTERRORMARKER" "**最後の 1 件に上書きしない（同じ文で Issue を埋めない）**"
}
test_case "monitor: PR 検索の言い分は最初の 1 件を覚える（最後ではない。#1217 N4)" t_mon_pr_lookup_error_keeps_the_first_not_the_last

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
