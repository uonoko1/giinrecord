# shellcheck の版（#552）

**固定している版: 0.11.0**

版の実体は `scripts/ci/shellcheck.sh` の `SHELLCHECK_PINNED_VERSION` **1 か所だけ**にある。
CI（`.github/workflows/ci.yml`）は `bash scripts/ci/shellcheck.sh --pinned-version` を読んで
その版を入れるので、**この文書と CI に版番号を書き写していない**（写した番号は必ずずれる）。

## なぜ固定するか

**`ubuntu-latest` に入っている shellcheck を使うと、同じ木に対する答えが日によって変わる。**

#542 の担当者が実際に踏んだ: **手元 0.11.0 / CI 0.9.0** で、**0.9.0 だけが SC2015 を出して 1 回落ちた**
（指摘自体は正しく、`cd` の失敗を握り潰していた本物の欠陥だった）。

**版の違いは「うるさいかどうか」ではなく「見逃すかどうか」でもある。**
このリポジトリで実測した食い違い（2026-09-07、`linux.x86_64` の公式バイナリ）:

| 書いたもの | 0.9.0 | 0.10.0 | 0.11.0 |
| --- | --- | --- | --- |
| `i=0` のあとに `i+=1` | **無警告** | SC2324 | SC2324 |
| 呼ばれない関数 | SC2317 | SC2317 | **SC2329** |

**`i+=1` は文字列として "1" を連結する**（`i` は `01` になる）ので、SC2324 は本物の指摘である。
**CI が 0.9.0 のままなら、この欠陥は CI を素通りしていた。**

なお **2026-09-07 時点では、対象 64 本は 0.9.0 / 0.10.0 / 0.11.0 のいずれでも exit 0**（実測）。
つまり**いま直すべき指摘があるから固定するのではなく、答えが変わることそのものを止めるために固定する**。

## 版が違うとどうなるか

`scripts/ci/shellcheck.sh` は**固定した版以外では lint せずに exit 3 で止まる**。

```
$ bash scripts/ci/shellcheck.sh
shellcheck.sh: 版が違います。見つかった版=0.9.0 / 必要な版=0.11.0
  版が違うと指摘も違います（実測: `i+=1` は 0.9.0 では無警告、0.10.0 以降は SC2324）。
  違う版で通しても「通った」とは言えないので、ここで止めます。docs/ops/shellcheck.md を参照してください。
```

**通してから警告するのではなく、通さない。**
違う版の「通った」は**別の主張**であって、それを緑として受け取ると、
**固定した意味がなくなる**（作業合意「ローカルが緑は CI が緑の証明にならない」）。

## 手元に入れる

CI と同じものを入れる（`--pinned-version` から版を読むので、この手順は版を上げても書き換えない）。

```sh
v=$(bash scripts/ci/shellcheck.sh --pinned-version)
mkdir -p ~/.local/bin
curl -sSfL "https://github.com/koalaman/shellcheck/releases/download/v$v/shellcheck-v$v.linux.x86_64.tar.xz" \
  | tar -xJ --strip-components=1 -C ~/.local/bin "shellcheck-v$v/shellcheck"
shellcheck --version | sed -n '2p'     # → version: <上の $v と同じ>
```

`~/.local/bin` が `PATH` の先にあること。ディストリのパッケージ（`apt install shellcheck` 等）は
**版が古いことが多い**ので、そちらが先に見つかると exit 3 で止まる。

## 版を上げる手順

**版が古くなると、新しい指摘を受け取れない。** 上げるときは:

1. `scripts/ci/shellcheck.sh` の `SHELLCHECK_PINNED_VERSION` を新しい版にする。**ここだけ。**
2. 上の「手元に入れる」をもう一度実行して、新しい版を入れる。
3. `bash scripts/ci/shellcheck.sh --list | wc -l` で**対象の本数を数えてから**
   `bash scripts/ci/shellcheck.sh` を走らせ、**exit 0 を確認する**。
4. **新しい指摘が出たら、それは版を上げたことで見つかった本物の指摘である。**
   **`# shellcheck disable=` で黙らせない。** 直すか、直せないなら
   **なぜ黙らせるかを PR 本文とコードのコメントに書く。**
   （#542 は 0.9.0 の SC2015 を抑制せず、`cd` の失敗を握り潰していた構造のほうを直した。）
5. `bash scripts/ci/test/shellcheck.test.sh` を通す（この文書が新しい版を名指ししているかも見ている）。
6. **この文書の冒頭「固定している版」と、上の実測表の但し書きを更新する。**
7. PR に **`shellcheck --version` の出力と、`--list` の本数と、exit コード**を貼る。

## いつ上げるか

**期限は決めていない。** 決めても守られない（作業合意「気をつけるで守れる教訓は、守れない」）ので、
**上げる理由ができたときに上げる**:

- shellcheck に新しい版が出て、**その版が出す新しい指摘を受け取りたいとき**
- **固定した版のバイナリが手に入らなくなったとき**（配布が消える等。exit 3 で全員が気づく）
- 誰かが「この書き方は本当に安全か」を確かめたいとき

**放置しても静かに壊れることはない**（固定した版が動く限り、答えは変わらない）。
**危ないのは逆方向——固定を外して「その場にある版」に戻すこと**で、
それをすると `scripts/ci/test/shellcheck.test.sh` の
「ci.yml は版を書き写さず `--pinned-version` から読む」「`latest` を入れない」が落ちる。

## 対象

**64 本**（2026-09-07 時点。`bash scripts/ci/shellcheck.sh --list | wc -l`）。
対象の決め方は `scripts/ci/shellcheck.sh` の冒頭にある（#154）。

## actionlint

`ci.yml` の actionlint は **v1.7.7 に固定済み**（この Issue の前から）。
ただし版の実体が `ci.yml` の中に**2 か所**（URL と `bash -s 1.7.7`）あり、
`docs/ops/etl.md` にも**3 か所目**が書き写されている。**shellcheck と同じ「1 か所」にはなっていない。**
この Issue の範囲外（#552 は shellcheck の話）なので触っていない。
