import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #537: **一次資料の取得と再公開の方針**（2026-09-13、人間が「案 3」を選んだ）。
 *
 * ## なぜ検査するか
 *
 * **`docs/research/local-assemblies.md`（#128）は「ETL 化する議会には事前に事務局へ問い合わせる」と
 * 定めていたのに、既存 7 県はいずれも問い合わせずに実装され、本番で公開されていた**——
 * **自分たちで書いたルールが、書いただけで守られていなかった**（#537 が起票した事実）。
 *
 * **今回はその逆をやる**——**「照会しない」と決めたので、その根拠を文書に残す。**
 * **根拠が消えると「なぜ照会していないのか」を誰も説明できなくなり、#537 が再発する。**
 *
 * ## 何を検査するか（と、しないか）
 *
 * **検査するのは「根拠が書かれていること」だけである。**
 * **法的な正しさは検査できない**——それは人間が決めたことで、機械が確かめられるものではない。
 *
 * **「取得の作法」の側も見る**——**この決定は作法を緩めるものではない。**
 * **「照会は要らない」だけが残って「robots.txt を読む」が消えると、決定の意味が変わる。**
 *
 * ## なぜ etl の node:test に置くか
 *
 * #513 / #662 / #682 と同じ。**検査対象と同じディレクトリに置いた見張りは、対象ごと消せる。**
 * `docs/` の中に置くと、`docs/` を触る PR がそれごと消せてしまう。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const CONTRACT = "docs/DATA_CONTRACT.md";
const RESEARCH = "docs/research/local-assemblies.md";
const PENDING = "docs/ops/pending-decisions.md";

test("#537 DATA_CONTRACT に方針の節があり、4 つの根拠が全部書いてある", () => {
  const md = read(CONTRACT);
  assert.match(md, /一次資料の取得と再公開/, `${CONTRACT} に #537 の節が無い`);

  // **根拠を 1 つでも落とすと、残りだけでは説明が成り立たない**ので 4 つとも要求する。
  const grounds: [string, RegExp][] = [
    ["賛否は著作物でない（2条1項1号）", /2\s*条\s*1\s*項\s*1\s*号|思想又は感情を創作的に表現/],
    ["表現を再現していない", /表現.*再現していない|再現しない/],
    // **条文番号そのものを要求する。**「情報解析」という語だけでは、どの条文かが分からない
    // （M1 の変異で実際に通ってしまった: 条番号を伏せても「情報解析」が残れば緑だった）。
    ["30条の4（条番号そのもの）", /30\s*条\s*の\s*4/],
    ["実測で禁止されていない", /robots\.txt/],
  ];
  const missing = grounds.filter(([, re]) => !re.test(md)).map(([name]) => name);
  assert.deepEqual(missing, [], `${CONTRACT} の #537 の節から根拠が落ちている。
**根拠が消えると「なぜ照会していないのか」を誰も説明できなくなる**（#537 が再発する）。
方針そのものを変えるなら、**人間が決め直してから**この検査も直すこと。`);
});

test("#537 方針は取得の作法を緩めていない（「照会は要らない」だけが残っていない）", () => {
  // **「それでも守ること」の節だけを見る。**
  // 文書全体を見ると、チェックリスト側に同じ語が残っているだけで通ってしまう
  // （M2 の変異で実際に起きた: 作法の節から消してもチェックリストの「1 秒以上」で緑だった）。
  const whole = read(CONTRACT);
  const from = whole.indexOf("それでも守ること");
  const to = whole.indexOf("新しい議会を足すときのチェックリスト");
  assert.ok(from > 0 && to > from, `${CONTRACT} の「それでも守ること」の節が見つからない`);
  const md = whole.slice(from, to);
  const manners: [string, RegExp][] = [
    ["robots.txt を読み、Disallow の下に行かない", /Disallow/],
    ["1 秒以上の間隔", /1\s*秒以上/],
    ["UA を名乗る", /UA を名乗/],
    ["一次資料リンクを全行に付ける", /一次資料リンク/],
    ["PDF の表現を再現しない", /表現を再現しない/],
  ];
  const missing = manners.filter(([, re]) => !re.test(md)).map(([name]) => name);
  assert.deepEqual(missing, [], `${CONTRACT} から取得の作法が落ちている。
**この決定は「照会しない」であって「何をしてもよい」ではない。**
作法が消えると、決定の意味が変わる。`);
});

test("#537 新しい議会を足すときのチェックリストがある（満たせない議会は実装しない）", () => {
  const md = read(CONTRACT);
  assert.match(md, /チェックリスト/, `${CONTRACT} にチェックリストが無い`);
  // チェックボックスの数まで見る（節名だけ残して中身を消すのを防ぐ）
  const boxes = (md.match(/^- \[ \] /gm) ?? []).length;
  assert.ok(boxes >= 6, `チェックリストの項目が ${boxes} 個しかない（6 個以上あったはず）`);
});

test("#537 古い「事前に事務局へ問い合わせる」に訂正が付いている（矛盾したまま残さない）", () => {
  const md = read(RESEARCH);
  // 元の一文は**消さない**（当時の記録なので）。訂正が隣にあることを見る。
  assert.match(md, /事前に事務局へ問い合わせる/, `${RESEARCH} から元の記述が消えている（記録は残すこと）`);
  assert.match(md, /#537 の決定（2026-09-13）/, `${RESEARCH} に #537 の訂正ブロックが無い`);
  assert.match(md, /撤回された/, `${RESEARCH} の訂正が「撤回された」と明示していない`);
});

test("#537 pending-decisions から人間待ちとして外れている", () => {
  const md = read(PENDING);
  assert.match(md, /#537/, `${PENDING} に #537 の記載が無い`);
  // **「決まった」と書いてあること。** 決まったのに人間待ちの一覧に残っていると、
  // PO が「まだ動けない」と読んで 9 県に着手しない（#537 の被害がそのまま続く）。
  // **見出し行だけを見る。** 本文に「照会はしない」が残っていても、見出しが
  // 「#537 …の事前照会」のままなら、目次を読んだ人は人間待ちだと思う
  // （M5 の変異で実際に起きた: 見出しを「検討中」にしても本文で緑だった）。
  const heading = md.split("\n").find((l) => l.startsWith("## ") && l.includes("#537"));
  assert.ok(heading, `${PENDING} に #537 の見出しが無い`);
  assert.match(heading!, /決まった|照会はしない/,
    `${PENDING} の #537 の見出しが「まだ人間待ち」に見える（見出し: ${heading}）。
**決まったことを見出しに書くこと。** 本文にだけ書くと、目次を読んだ人は動けないと思う。`);
});
