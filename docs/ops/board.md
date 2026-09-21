# スクラムボードと PO 定型スクリプト（`scripts/po/`）

Sprint 4 レトロ（`docs/sprints/sprint-4.md`）：PO の手元スクリプトの変数ミス（`gh pr list --head` に main を渡す等）を
繰り返さないため、定型操作をリポジトリに置き、偽の `gh` でテストし、shellcheck を CI で通す（#70）。

## ボードの ID（GitHub Projects v2、project 2「議員レコード スクラムボード」）

| 対象 | ID |
|---|---|
| Project | `PVT_kwHOBy0CLs4BhHqj` |
| Status（single select） | `PVTSSF_lAHOBy0CLs4BhHqjzhgEpXs` |
| Status: Backlog | `569dcc89` |
| Status: Ready | `d2186140` |
| Status: In Progress | `5b5c55b5` |
| Status: In Review | `9e9b8e0c` |
| Status: Done | `e92e5038` |
| Sprint（text） | `PVTF_lAHOBy0CLs4BhHqjzhgEpbE` |
| Points（number） | `PVTF_lAHOBy0CLs4BhHqjzhgEpbI` |

ID は `scripts/po/board-set.sh` にも埋め込んである。ボードのフィールドを作り直したらここと同時に更新する。
再取得：`gh project field-list 2 --owner uonoko1 --format json`。

## ボードを動かすのは PO の仕事（2026-09-08 に一度落とした）

**Issue と PR だけで進めて、ボードを一度も動かさなかったことがある。**
**ユーザーから「カンバンみても今まで何をやってたかと今何をやってるかが分からん」と指摘された。**
**そのとき実際に起きていたこと:**

```
Issue 260 件のうち Project に載っていたのは 103 件（157 件が未登録）
非 Done の 15 件のうち 13 件は既に CLOSED（Backlog / In Progress / In Review のまま放置）
ボードの最新は #260、当日の作業（#632〜#668）は 1 件も載っていない
```

**`scripts/po/board-set.sh` は Sprint 4 から存在していた。使っていなかっただけである。**

**やること**（PBI ごとに、状態が変わった時点で動かす）:

| 出来事 | Status |
|---|---|
| PBI を起票した（まだ着手しない） | `Backlog` |
| リファインメントを終え、着手してよい | `Ready` |
| 担当者を立てた | `In Progress` |
| PR が出た | `In Review` |
| マージした | `Done` |

```sh
scripts/po/board-set.sh <issue> <Backlog|Ready|In Progress|In Review|Done>
```

**「人間の判断・操作待ち」は `Backlog` に置き、`blocked` ラベルで区別する**
（`docs/ops/pending-decisions.md` に理由を書く）。**Ready に置いてはいけない**——
**Ready は「開発者が今すぐ取れる」という意味であり、誰も取れないものを置くと
ボードが「作業があるのに誰も動いていない」ように見える。**

**起票と同時にボードへ載せる。** 後でまとめて載せると、**その間ボードは嘘をつく。**

**Issue の無い PR は載せない。** **ボードに載るのは PBI（Issue）であって PR ではない。**
**「記録の更新」「他の PBI で分かった事実の反映」のような、
それ自体が独立した作業単位でないものは、Issue を作らずに PR だけ出す**
（例: 2026-09-09 の #669 ボードの運用、#675 #537 の対象が増えたことの反映）。
**載せるために Issue を作ると、ボードが PR と 1 対 1 になり、PBI の単位が失われる。**

### マージしたら Issue も閉じる（2026-09-09 に落とした）

**ボードを動かすようになった翌日、今度は「マージと Issue のクローズ」が繋がっていなかった。**

```
#688  PR #690 が 2026-09-08 20:03 にマージ済み → Issue は OPEN のまま
#694  PR #704 が 2026-09-08 22:58 にマージ済み → Issue は OPEN のまま
```

**PO はこの状態で #688 に新しい担当者を立ててしまった。**
担当者が着手前に「同じ Issue のブランチが既にある」と気づいて止めた（`WORKING_AGREEMENT.md` の #512）。
**気づかなければ、自治体のサーバーに 2 度目のリクエストを送っていた。**

**Sprint 26 で落としたものと形が同じである**——道具（`board-set.sh`）は使い始めたが、
**「マージ → Done → Issue クローズ」の 3 つ目が繋がっていなかった。**

**やること**: **`merge-when-green.sh` でマージしたら、その場で 3 つ全部やる。**

```sh
scripts/po/merge-when-green.sh <pr>
scripts/po/board-set.sh <issue> Done
gh issue close <issue> --comment "..."   # 何が入ったか・残る留保を書く
```

**残る留保があるなら、クローズのコメントに書いて別 Issue を起票する。**
**「Issue を開けたままにしておく」で留保を表現しない**——
**開いたままの Issue は「まだ誰もやっていない」に見え、担当者を二重に立てる原因になる。**

### `In Review` を飛ばしている（2026-09-09 に落とした。3 つ目）

**「マージしたら Issue も閉じる」を書いた同じ日に、今度は `In Review` を一度も使っていなかった。**

**実測**（Sprint 27 の PBI 5 件。PR が出た時刻は `gh pr list --json createdAt`）:

```
#707  PR #712 が 2026-09-08 23:59 に出た → In Progress のまま
#705  PR #713 が 2026-09-09 00:01 に出た → In Progress のまま
#711  PR #716 が 2026-09-09 00:14 に出た → PO が気づいたのは 00:40 頃
#710  PR #719 が 2026-09-09 00:18 に出た → 同上
```

**5 件中 2 件しか `In Review` を通らず、その 2 件も PR から 20 分以上あとだった。**

**なぜ落ちるか**: **PR が出たことを PO が知るのは、担当者の完了報告か Monitor の通知である。**
**担当者は「PR を出して CI が緑になるまで見届けてから報告」するので、報告が来た時点で既にマージできる。**
**つまり `In Review` に置ける時間が短く、置く動機が働かない。**

**それでも置く理由**: **ボードが「今どこまで」を答えるためである。**
**`In Progress` が 8 件並んでいると、着手したばかりのものと PR が出て緑のものが区別できない。**
**ユーザーの指摘（「カンバンみても今まで何をやってたかと今何をやってるかが分からん」）は、まさにこれである。**

**やること**: **担当者の完了報告を受けたら、マージの前に `In Review` に動かす。**

```sh
scripts/po/board-set.sh <issue> "In Review"   # 報告を受けたら（＝マージの前に）
scripts/po/merge-when-green.sh <pr>            # マージは非同期に走る
scripts/po/board-set.sh <issue> Done           # マージ後
gh issue close <issue> --comment "..."         # Closes #N で自動なら不要
```

**`merge-when-green.sh` は `update-branch` から CI 再実行まで待つので数分かかる。**
**その間ボードが `In Review` であることに意味がある**——**「緑で、マージ待ち」という状態が実在する。**

**同じ形が 3 回続いていることに注意**（Sprint 26: ボードを動かさない → Sprint 27: 閉じ忘れ → これ）。
**道具（`board-set.sh`）はあり、書いてもある。実行の側が抜ける。**

### 必須でない検査が赤い PR をどうするか（#858）

**`merge-when-green.sh` は「どれか 1 つでも赤なら止める」だった。**
**その慎重さは実地の事故 5 件（#389/#392/#414/#434/#446）を背負っており、正しい。**
**だが赤い検査が必須でないとき、GitHub はマージを許すのに道具だけが止めていた。**
**PO はそのたびに `gh pr merge` を手で打って回避し、そのとき
「HEAD が動いていないか」「上に PR が積まれていないか」の守りが全部飛んでいた。**

**母数**（実測 2026-09-21、直近 12 件のマージ済み PR は全部同じ）:
**1 PR につき check-run は 7 件**——`audit` / `check` / `docker-web` / `forbidden-patterns` /
`gitleaks` / `pr-closes` / `stale-base`。

| | 名前 | 赤いとき |
|---|---|---|
| **必須 5 件** | `check` `gitleaks` `forbidden-patterns` `audit` `pr-closes` | **絶対にマージしない**（`--allow-nonrequired-red` でも通らない） |
| **必須でない 2 件** | `stale-base` `docker-web` | 何がどう赤いかと**その job のログの URL**を出して**既定では止まる**。`--allow-nonrequired-red` があるときだけ、読み上げてからマージする |
| 一覧に無い名前 | （新しい job） | **必須として扱い**、「知らない検査がある」と言う |

**線引きは「赤いが通してよい状態が、正常に起こりうるか」である。**

- **`stale-base` は起こる。** 2 つ目の step（`--net-deletions`、#836）は #846 の担当者自身が
  **「合図であって証拠ではありません（4 件中 2 件が本物）」**と書いている。**実地 5 件中 3 件が
  「通してよい」側だった。** **PR #856 がこれで詰まり、PO が手で `gh pr merge` を打った。**
  **これが #858 の本題である。**
- **`pr-closes` は起こらない。** 「本文に `Closes #N`（または『Closes なし（理由）』）を書いたか」
  を見るだけで、**赤いなら本文を直せば緑にできる。** だから必須のまま。
- **`docker-web` は起こりうる**（環境要因で落ちることがある）が、**赤は本物のことが多い**
  ——nginx の設定・CSP・SPA フォールバックの壊れは、**ここでしか見ていない**。

**GitHub の branch protection に登録されているのは 4 件**（`check` / `gitleaks` /
`forbidden-patterns` / `audit`。実測）。**`pr-closes` は登録できない**（PR 本文依存なので
「全 PR が永久に pending」になる。理由は
`packages/etl/test/branch-protection-jobs.test.ts` の `EXEMPT_FROM_REQUIRED`）が、
**この道具は GitHub より厳しくてよい**ので必須として扱っている。**逆は許されない**
——GitHub が必須にしているものをここで外すと、道具が保護を跨ぐことになる。

**使うとき**:

```sh
scripts/po/merge-when-green.sh <pr>                           # まずこれ。何が赤いか読む
scripts/po/merge-when-green.sh --allow-nonrequired-red <pr>   # 読んだうえで通す
```

**止まったときの出力**（`stale-base` だけが赤い＝#856 の形）:

```
[..] 検査 7 件 / 必須 5 件 / 赤 1 件（必須の赤: なし / 必須でない赤: stale-base (failure)）
error: checks failed on PR #12: stale-base (failure)
       これは必須の検査ではありません（必須 5 件は全部緑）。GitHub はマージを許します。
       **なぜ赤いのかを読んでから**判断してください。赤い検査のログ:
         stale-base (failure): https://github.com/.../actions/runs/.../job/...
       手元で読むなら:
         gh pr checks 12
         gh run view --log-failed --job <上の URL 末尾の数字>
       読んだうえで通すなら:
         scripts/po/merge-when-green.sh --allow-nonrequired-red 12
```

**ログの URL を出すのは、「何行が減っているか」がそこにしか無いからである。**
`--net-deletions` はファイルごとの行数と、減った行を 20 行まで出す——**だがそれは job の
ログの中だけ**で、PR の画面にも `gh pr checks` の一覧にも出てこない。
**この道具は数字を作り直さない**（検査が既に数えたものを二重に実装すると、
片方が古くなったときに嘘をつく）。**指すだけにしてある。**

**赤いまま通したときは「all N checks green」と言わない。**
**ログは後から「何が起きたか」を読む唯一の記録**なので、そこに嘘を混ぜない:

```
[..] 必須でない検査が赤いまま進みます（--allow-nonrequired-red）: stale-base (failure)
[..] 赤い検査のログ:
         stale-base (failure): https://github.com/.../job/...
[..] 必須 5 件は緑。stale-base (failure) を赤いまま通してマージします
```

**「必須でないから無視してよい」ではない。**
**赤の理由を読まずに `--allow-nonrequired-red` を付けるのは、手で `gh pr merge` を打つのと同じである。**

**`board-set.sh` に渡すのは Issue 番号である。PR 番号を渡すと失敗する**（実測）:

```
$ scripts/po/board-set.sh 719 "In Review"
gh: Could not resolve to an Issue with the number of 719.
```

**ボードに載るのは PBI（Issue）なので、これは正しい挙動である**（上の「Issue の無い PR は載せない」）。
**Issue と PR は番号を共有するので、取り違えやすい。**

### worktree も片付ける（2026-09-13 に落とした。4 つ目）

**担当者は `git worktree add` で専用ツリーを作る**（PO が Issue にそう指示している）。
**マージした後、そのツリーを消すのは誰の仕事でもなかった。**

```
#629（2026-09-08）  84 本まで溜まっていた
#726（2026-09-13）  5 本が残っていた（#705 #707 #709 #710 #711 のマージ済み）
```

**どちらも PO が手で消した。** **道具が無かったので、`scripts/po/worktree-sweep.sh` を作った**（#726）。

```sh
scripts/po/worktree-sweep.sh          # 何が消えるかだけ出す（dry-run）
scripts/po/worktree-sweep.sh --yes    # 実際に消す
```

**`merge-when-green.sh` には入れていない**——**実測で、担当者はマージ後もツリーを使っている**
（#709 の担当者は PR がマージされた後に Dependabot を確認して報告した。
#710 の担当者は CI を見ている最中にマージされた）。
**マージ直後に消すと、測っている最中のツリーを消すことになる。**

**消さない側に倒してある**（未コミットがある／push していないコミットがある／PR が MERGED でない／
`--force` は使わない／メインの作業ツリーは対象外／既定は dry-run）。

**いつ呼ぶか**: **スプリントの区切りと、担当者を新しく立てる前。**
**「消せる 0」と出るのが正常な状態である。**

**この節が 4 つ目である**（ボードを動かさない → 閉じ忘れ → `In Review` を飛ばす → worktree）。
**道具はどれも「PO が呼ばないと動かない」**——**だから手順に書く。**

### 4 つとも、機械が見るようになった（2026-09-13。#783）

**2026-09-13 に、マージ済みの PR に対応する Issue が 3 件 open のまま残っていた**
（#763←#770 / #769←#775 / #771←#776）。**上の 4 つの節を書いた後に起きた。**
**つまり「書く」は 4 回とも対策になっていない。**

**だから `scripts/po/board-audit.sh` を作った**（#783）。上の 4 つの食い違いを列挙する:

```sh
scripts/po/board-audit.sh          # 食い違いを列挙する（読むだけ。既定）
scripts/po/board-audit.sh --fix    # 直す（Issue を閉じる／Status を直す）
```

| 種別 | 見るもの |
|---|---|
| `closed-pr-open-issue` | `Closes/Fixes/Resolves #N` を含む PR が MERGED なのに Issue #N が OPEN |
| `closed-issue-not-done` | Issue が CLOSED なのに Status が Done でない |
| `open-issue-done` | Issue が OPEN なのに Status が Done |
| `not-on-board` | Issue がボードに載っていない |
| `inprogress-no-trace` | **ボードが `In Progress` なのに作業の痕跡が無い**（#809。**列挙するだけ。`--fix` では直さない**） |

**守っていること**（`scripts/po/test/board-audit.test.sh` が 29 本で固定している。うち 5 規則が 21 本、台帳（#919）が 8 本）:

- **`Closes` / `Fixes` / `Resolves` + `#N` の形に限る。** **本文に `#N` が出るだけの PR は拾わない**——
  #763 の検索には無関係な #450 / #698 / #461 が引っかかった
  （検査名: `audit: 本文に #N が出るだけの PR は拾わない`）。
- **PR が MERGED であることを `gh pr view` で個別に確かめてから閉じる**
  （**squash なので `git merge-base --is-ancestor` は使えない**——#535）
  （検査名: `audit: PR が MERGED でなければ Issue を閉じない`）。
- **既定は読むだけ。`--fix` を付けたときだけ書く**
  （検査名: `audit: 既定は 4 種類とも列挙するだけで何も書かない`）。
- **`OPEN` なのに `Done` は `--fix` でも自動で戻さない**——どの Status に戻すかは機械には分からない
  （検査名: `audit: --fix でも OPEN/Done は自動で戻さない`）。
- **母数を必ず出し、`gh` が空を返したら「全部きれい」と報告せず異常終了する**（#757）
  （検査名: `audit: gh が空を返したら『全部きれい』と報告しない`）。

**規則 1 が見られる範囲は半分である**（実測 2026-09-13: マージ済み 300 本のうち
閉じる語があるのは **150 本**）。**実際 #770（→#763）と #776（→#771）は閉じる語を書いていなかった。**
**それでも語を緩めない**——**間違って閉じる方が、閉じ漏れより気づきにくい**（#569）。
**代わりに、見えていない本数を毎回出す**（検査名: `audit: 規則1が見ていない PR の本数を出す（閉じる語が無い PR）`）。
**PR に `Closes #N` を書けば、この規則が見てくれる。**

### 5 つ目: `In Progress` なのに誰も居ない（2026-09-14。#809）

**#781（熊本の測定）を起票してボードを `In Progress` にしたまま、担当者を立て忘れた。**
**規則 1〜4 はどれもこれを見つけない**——**Issue は OPEN、ボードは `In Progress` で、矛盾していない。**
**「正しく矛盾していない」まま、誰も作業していなかった。**

**「痕跡が無い = 誰も居ない」ではない**（実測 2026-09-14。worktree の無い 4 件は**4 件とも偽陽性**だった:
起票直後 / `monitor` が自動で開いた Issue / この Issue 自身 / 優先度を下げたもの）。**だから 2 つで絞る**:

| 絞り方 | 中身 |
|---|---|
| **時間の閾値** | ボードの Status を `In Progress` にしてから `STALE_HOURS`（既定 **24**）時間経ったものだけ |
| **`monitor` ラベルを外す** | `#821` `#547`。**監視が自動で開き自動で閉じる。担当者は要らない** |

**Status を変えた時刻は GraphQL の `fieldValueByName.updatedAt` で取れる**（実測で確かめた）。

**既定 24 時間の根拠**（実測 2026-09-14、マージ済み PR 50 本の「Issue 起票 → PR 作成」）:
**p50 = 125 分、50 本中 40 本が 6 時間以内。** 6 時間を超える 10 本は **3.7 日〜7 日前に起票され
後から着手されたもの**で、その間ボードは `Backlog` だった。**24 時間は p50 の 11 倍**で、
**始めた直後を鳴らさない側に倒してある。**

**痕跡はリモートで見えるものだけを使う**（`git worktree list` は **PO の手元にしか無く、CI では常に 0 件**）。
**どれか 1 つでもあれば「作業中」**: リモートの枝 `<type>/<番号>-...` ／ 同じ形の head を持つ PR ／
`Closes/Fixes/Resolves #N` を含む PR（state を問わない。**作業はあった**）。

**`blocked` は外さない。** **`docs/ops/board.md` は `blocked` を `Backlog` に置くと決めてあるので、
`In Progress` に居ること自体が別の食い違いである。** 黙らせずに鳴らす側に残す。

**`--fix` の対象にしない**（検査名: `audit: --fix でも In Progress の痕跡無しは直さない (#809)`）。
**担当者を立てるのは PO の判断**であり、**誰を立てるか／そもそも立てるべきかは機械に決められない**
（**`OPEN` なのに `Done` を自動で戻さない**のと同じ理由）。

**まず数えて出すだけにしてある**（#801「捨てる前に本数を出す。止めない」と同じ形）。
**毎回の出力に `In Progress N 件（痕跡あり / monitor / 閾値未満 の内訳）` が付く**ので、
**鳴らすかどうかは何日か数えてから決めればよい。**

### `--fix` は自分がやったことを台帳に残す（2026-09-20。#919）

**Sprint 28 の締めで、「この回で `board-audit.sh` が何回食い違いを捕まえたか」を書こうとして、書けなかった。**
**`--fix` が直すたびに食い違いが消えるので、後から正確な回数を出せない。**
**PO は「9 回」と書きかけて、測っていない数字だったのでやめ、
`docs/sprints/sprint-28.md` には「数えていない」と理由つきで書いた。**

**道具が効いた証拠が、道具自身によって失われていた。**
**これは #757 の裏返しである**——**#757 は「母数を書かない検算は、0 件を見て緑になっても同じ顔をする」。
こちらは「直した件数を残さない道具は、効いていても効いていなくても同じ顔をする」。**

**`--fix` は `docs/ops/board-audit-log.tsv` に追記する**（`BOARD_AUDIT_LOG` で移せる。テストは `$TMP` に向ける）。
**追記だけで、行は消さない。**

| 列 | 中身 |
|---|---|
| 1 | 時刻（UTC の ISO8601） |
| 2 | `run` / `fixed` / `left` |
| 3 | Issue 番号（`run` は `-`） |
| 4 | 直す前（`run` は `-`） |
| 5 | 直した後（`left` は `(人が決める)`、`run` は `-`） |
| 6 | `run` は母数 `issues=N board=N prs=N findings=N fixed=N left=N`、他は食い違いの種別 |

**1 回の `--fix` が必ず 1 本の `run` 行を書く**（**直した件数が 0 でも書く**）。
**走らせた回数が母数だから**——**「直した 9 件」だけ残ると、
それが 1 回で出たのか 30 回走らせて出たのかが分からない。**

**誰がどこで読むか**: **PO がスプリントの締めに、この 2 行を叩いて振り返りに書く。**

```sh
awk -F'\t' '$2=="fixed"' docs/ops/board-audit-log.tsv | wc -l   # 直した延べ件数
awk -F'\t' '$2=="run"'   docs/ops/board-audit-log.tsv | wc -l   # --fix を走らせた回数
```

**守っていること**（`scripts/po/test/board-audit.test.sh` が 8 本で固定している）:

- **`--fix` を付けずに読んだだけなら 1 バイトも書かない**——**ファイルを作りもしない**
  （検査名: `ledger: --fix を付けずに読んだだけなら台帳に何も書かない (#919)`）。
  **読んだだけで「直した」が増えたら、この台帳は数えるためではなく騙すために在ることになる。**
- **行数と件数が合わない台帳は書かずに落ちる**（exit 5。#757）
  （検査名: `ledger: 行数と件数が合わない台帳は書かない (#919/#757)`）。
- **台帳に書くのは番号と Status と種別だけ。** **Issue や PR のタイトル・本文は書かない**
  ——**OSS 公開前提で、タイトルに何が入るか分からない**（調査中のホスト名や URL が入りうる）
  （検査名: `ledger: 台帳に自由文を書かない（番号と Status と種別だけ）(#919)`）。
- **台帳に書けなければ「直した」と報告しない**（exit 5）
  （検査名: `ledger: 台帳に書けなければ成功と報告しない (#919)`）。

**Sprint 28 以前の回数は復元しない**——**できない。** **「ここから先は数えられる」にしただけである。**

**引っかかっても、それだけでは閉じてよいとは限らない**——
#537 / #610 / #654 / #543 は「文書だけ進んで人間の作業が残っている」ので **open が正しい**。
**PR が何をマージしたのかを読んでから判断すること**（だから `--fix` は既定ではない）。

**迷ったら「これは誰かに渡せる仕事か」で決める。** **渡せるなら PBI、渡せないなら PR だけ。**

## 一度に大量に登録するとレート制限に当たる（2026-09-09 に実際に当たった）

**Issue 261 件をボードに登録し直したあと、`board-set.sh` が
`GraphQL: API rate limit already exceeded` で止まった。**

```
$ gh api rate_limit
  core:    4999/5000    ← 余裕がある
  graphql: 5000/5000    ← 余裕がある
```

**通常のレート制限には余裕があるのに止まる。**
**GitHub Projects の書き込みには別枠の制限があり、`rate_limit` API には出てこない。**

**止まるのは GraphQL を使うものだけ**（2026-09-09 に実測）:

```
gh api repos/uonoko1/giinrecord     → 動く（REST）
gh project item-edit                 → 止まる（GraphQL）
gh pr create                         → 止まる（GraphQL）
git push                             → 動く（git プロトコル）
```

**`gh pr create` も止まるので、PR を作れなくなる。**
**push は通るので、枝は残る**——**待ってから PR を作ればよい。**

**やること**:
- **一度に大量に登録するときは、途中で止まる前提で進める**（**どこまで登録できたかを
  毎回確かめる**——`gh project item-list` で数える）
- **止まったら待つ。** **通常のレート制限のリセット時刻（`gh api rate_limit` の `reset`）は
  当てにならない**——別枠なので
- **急ぎでないなら、その日のうちに全部やらない。** **PBI ごとに起票と同時に載せていれば、
  一度に大量に登録する必要は起きない**（これが本来の運用）

## スクリプト

すべて `bash`、`set -euo pipefail`、`gh`（認証済み）だけに依存する。JSON は `gh --jq` で読む（jq 本体は不要）。
破壊的な操作は `merge-when-green.sh` の「指定した PR の squash マージ（＋ head ブランチ削除）」だけ。

| コマンド | すること | 終了コード |
|---|---|---|
| `scripts/po/merge-when-green.sh [--allow-nonrequired-red] <pr>` | OPEN かつ非 draft を確認 → BEHIND なら `gh pr update-branch` → `gh pr checks` を 20 秒ごと最大 60 回（20 分）見て、全部 pass/skipping になったら `gh pr merge --squash --delete-branch`。**必須の検査**（`check` / `gitleaks` / `forbidden-patterns` / `audit` / `pr-closes`）が 1 つでも赤なら何もせず終了（`--allow-nonrequired-red` があっても）。**必須でない検査**（`stale-base` / `docker-web`）だけが赤いときは、何がどう赤いかと**その job のログの URL**を出したうえで既定では終了し、`--allow-nonrequired-red` があるときだけ読み上げてからマージする（#858）。一覧に無い名前は必須として扱い、そのことを言う。赤いまま通した場合は「all N checks green」とは言わない。head が `data/refresh` のときだけ、待っている間に `action_required` の run を承認する（他のブランチでは承認しない）。`gh pr merge` が非ゼロで返っても PR の state を読み直し、検査した HEAD がそのまま MERGED なら成功として終わる（#434。UNKNOWN のときマージ成功でも非ゼロが返る／`--delete-branch` のローカル削除が worktree に阻まれる） | 0 マージ済 / 1 失敗・タイムアウト / 2 引数エラー |
| `scripts/po/board-set.sh <issue> <Backlog\|Ready\|In Progress\|In Review\|Done>` | Issue のボード上の item を探し（無ければ追加し）、Status を設定 | 0 / 1 / 2 |
| `scripts/po/verify-site.sh [production\|staging\|all]` | `ssh $VPS_SSH_HOST`（既定 `giinops`）で VPS 内から主要 URL（`/`, `/about/`, `/terms`, `/privacy`, `/members/`, `/rollcalls/`, `/assemblies/`, `/data/meta.json`, `/sitemap.xml`）の HTTP コードと `<title>` を一覧する（読み取りのみ。PO 手元の curl が 000 を返す問題の回避、#182）。production は `curl --resolve giinrecord.jp:443:127.0.0.1`（証明書検証あり）。staging は host nginx が Cloudflare 以外を 403 にする（#163）ので、コンテナのポート `127.0.0.1:8083` に `Host: staging.giinrecord.jp` で当てる（デプロイ済みビルドの確認であり、Access の確認ではない） | 0 = 全部 200 / 1 = 200 以外あり（行末に `NG`）/ 2 引数エラー |
| `scripts/po/board-audit.sh [--fix]` | ボードと Issue と PR の食い違いを 5 種類列挙する（既定は読むだけ）。`Closes/Fixes/Resolves #N` の形に限り、`gh pr view` で MERGED を個別に確認してから閉じる。母数（Issue / ボード項目 / マージ済み PR の件数と、閉じる語がある PR の本数、`In Progress` の内訳）を必ず出す。`inprogress-no-trace`（#809）は**列挙するだけで `--fix` でも直さない**（`STALE_HOURS` 既定 24）。**`--fix` は直したことを `docs/ops/board-audit-log.tsv` に追記する**（#919。`BOARD_AUDIT_LOG` で移せる） | 0 = 食い違い 0 / 1 = 食い違いあり（`--fix` なら残ったものあり）/ 2 引数エラー / 4 母数が 0（読めていない）/ 5 台帳に書けなかった |
| `scripts/po/etl-verify.sh` | 最新の ETL (daily) run の結論、`data/refresh` の最新 PR の番号と state、最新 Deploy run を 3 行で出す（読み取りのみ）。`docs/ops/etl.md` の PO チェックリストに対応 | 0 = ETL success かつ data PR が MERGED（または無し）かつ Deploy success / 1 = どれかが違う |

環境変数：`POLL_INTERVAL`（秒）、`POLL_MAX`（回数）、`PO_REPO`（`owner/name`。未指定ならカレントの checkout から `gh repo view`）、`VPS_SSH_HOST`（verify-site の ssh 先、既定 `giinops`）、`STAGING_PORT`（既定 8083）。

## テスト

```
bash scripts/po/test/run.sh          # 全部
bash scripts/po/test/run.sh merge    # 名前でフィルタ
shellcheck -x scripts/po/*.sh scripts/po/test/run.sh scripts/po/test/fake-bin/* scripts/po/test/*.test.sh
```

- `scripts/po/test/fake-bin/gh` を PATH の先頭に置いて本物の `gh` を置き換える。各テストは `handle()` 関数（引数列 `$*` で case 分岐）で API の返答（JSON）を決め、
  `-q/--jq` は本物の `jq -r` で適用する（テストには jq が要る。CI の ubuntu-latest には入っている）。
- `verify-site.sh` は `fake-bin/ssh`（最後の引数を手元で `bash -c` 実行、stdin はそのまま）と `fake-bin/curl`（`curl_handle <url>` が「コード＋本文」を返す）で、
  VPS 側で動くスクリプト本体も含めて手元で検証する。記録は `ssh<TAB>…` / `curl<TAB>…` の行。
- 呼び出しは 1 行 1 呼び出し（タブ区切り）で記録され、「どの gh コマンドをどの引数で何回呼んだか」を assert する。
  マージしていないこと・承認を試みていないことも、この記録で確認する。
- 学び：`IFS=$'\t' read` はタブが連続すると 1 つに潰す（whitespace IFS）。空のフィールドがあると後ろの列がずれるので、
  jq 側で空を `-` に置き換えてから `@tsv` にしている（`gh run list` の in_progress な run は `conclusion` が `""`）。
