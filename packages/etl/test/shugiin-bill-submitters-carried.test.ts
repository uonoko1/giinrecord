import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bill, Member } from "@seiji-kiroku/shared";
import { matchShugiinBills, unattestedBillMatches } from "../src/match-shugiin-bills.ts";
import { normalizeName } from "../src/match-votes.ts";
import { addShugiinBillPage } from "../src/sources/shugiin-bills.ts";

/**
 * **#1236: `submitters` / `supporters` が前回出力（carried）から残る経路。**
 *
 * **#1232（= #1218 の修正）が重ね合わせにしたので、後のページが書いていない欄は前の値が残る。**
 * **これは正しい**（各経過ページは「その回次に起きたこと」の部分的な記録なので、
 * 空欄で前の事実を消してはいけない）。
 * **だが `submitters` / `supporters` はページに載らない**——`matchShugiinBills` が
 * 氏名から名寄せして**後から付ける派生の欄**である。
 *
 * ```
 * submitterNames   一次資料から毎回取り直す（氏名＝事実）
 * submitters       名寄せの結果（ID＝派生）。carried から残りうる
 * ```
 *
 * **氏名が書き換わる**（改名・表記ゆれの訂正・一次資料の訂正）**と名寄せが外れるが、
 * `resolve` が `undefined` を返したときに古い `submitters` を上書きしないので残る。**
 *
 * ## 倒れる向き（実測。`data/bills/` 1,941 件 + 実名簿 464 人で測った）
 *
 * **「古い ID が残る」= stale であって「別人の ID になる」ではない。**
 * `submitters` は氏名との位置対応を持たない ID の集合なので、
 * **消えた氏名の人の ID がそのまま残る**（他人の ID に化ける経路は無い）。
 *
 * **ただし利用者から見ると、これは「別人の記録が出る」と同じ形になる**:
 * **ID が残った議員の個人ページには、その議員が提出者として記録されていない議案が出る。**
 * `Bill.submitters` の型定義は **「名簿に名寄せできた人だけ」**（`packages/shared`）と
 * 書いているので、残った ID はその定義に反する。
 *
 * ## 倒した向き
 *
 * **`submitters` は派生なので、入力（氏名）より長生きさせない。**
 * **名簿がその回次を覆っていて名寄せを走らせたなら、`submitters` は
 * その名寄せの結果そのものにする**（carried から残らない）。
 * **名簿が覆わない回次は名寄せを走らせない**ので（衆院は「現在」の名簿しか無い。#71）、
 * **carried の ID が唯一の記録であり、落とさない**（「記録が出ない」側に倒さない）。
 */

const KEIKA = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika";
const member = (id: string, name: string, house: Member["house"] = "shugiin", group = "立憲"): Member => ({
  id, name, kana: "", house,
  terms: [{ house, group, district: "東京1区", from: "", sessionFrom: 221 }],
  sourceUrl: "https://www.shugiin.go.jp/internet/itdb_giinprof.nsf/html/profile/top.htm",
});
const bill = (b: Partial<Bill> & { id: string }): Bill => ({
  session: 221, kind: "衆法", number: 1, title: `法案 ${b.id}`, house: "shugiin", sourceUrl: `${KEIKA}/1DE153E.htm`, ...b,
});

describe("#1236 carried の submitters / supporters は氏名より長生きしない", () => {
  test("食い違いを実測で作る: carried の個票を previous に、氏名だけ書き換えたページを next に重ねると、重ね合わせの時点では古い ID が残る（これが経路）", () => {
    const carried = bill({ id: "221-衆法-1", submitterNames: ["落合貴之", "中野洋昌"], submitters: ["s_1", "s_2"] });
    const page = bill({ id: "221-衆法-1", submitterNames: ["別人太郎"] });
    const bills = new Map<string, Bill>([[carried.id, carried]]);
    assert.equal(addShugiinBillPage(bills, page), true);
    const merged = bills.get("221-衆法-1");
    // **重ね合わせそのものは変えない**（#1218 の修正。ページに無い欄で上書きしないのが正しい）。
    assert.deepEqual(merged?.submitterNames, ["別人太郎"], "氏名は一次資料から毎回取り直すので新しいページの値になる");
    assert.deepEqual(merged?.submitters, ["s_1", "s_2"], "ID はページに載らないので carried の値がここでは残る（これが #1236 の経路）");
  });

  test("名寄せを走らせたら、氏名から引けない carried の ID は落ちる（名寄せの結果そのものになる）", () => {
    const members = [member("s_1", "落合 貴之"), member("s_2", "中野 洋昌")];
    const stale = bill({ id: "221-衆法-1", submitterNames: ["別人太郎"], submitters: ["s_1", "s_2"] });
    const { bills, unmatched } = matchShugiinBills([stale], members);
    assert.equal(bills[0]?.submitters, undefined, "氏名が 1 件も引けないなら submitters は無い（古い ID を残さない）");
    assert.deepEqual(bills[0]?.submitterNames, ["別人太郎"], "氏名（事実）はそのまま残る");
    assert.deepEqual(unmatched, [{ kind: "bill", nameText: "別人太郎", group: "", billId: "221-衆法-1" }]);
  });

  test("一部だけ引けたときは #1232 より前から安全だった（`resolve` が非 undefined を返すので配列ごと差し替わる）。**この修正で変わらない**", () => {
    // **発火の条件を取り違えないために残す。** `resolve` は **1 件も当たらなかったときだけ** `undefined` を返す
    // （`return ids.length ? ids : undefined`）。1 件でも当たれば配列ごと差し替わるので、古い ID は元から残らない。
    // **#1236 が効くのは「全部外れた」場合だけ**である（下の 3 件）。
    const members = [member("s_1", "落合 貴之"), member("s_2", "中野 洋昌")];
    const stale = bill({ id: "221-衆法-1", submitterNames: ["落合貴之", "別人太郎"], submitters: ["s_1", "s_2"] });
    const { bills } = matchShugiinBills([stale], members);
    assert.deepEqual(bills[0]?.submitters, ["s_1"], "s_2 は新しい氏名から引けないので落ちる");
  });

  test("supporters も同じ（submitters だけ直すと対の側が残る）", () => {
    const members = [member("s_1", "落合 貴之"), member("s_3", "赤羽 一嘉")];
    const stale = bill({ id: "221-衆法-1", supporterNames: ["別人太郎"], supporters: ["s_3"] });
    const { bills } = matchShugiinBills([stale], members);
    assert.equal(bills[0]?.supporters, undefined, "supporters も氏名より長生きさせない");
  });

  test("氏名の欄がページから消えた（undefined）場合も ID は残らない", () => {
    const members = [member("s_1", "落合 貴之")];
    const stale = bill({ id: "221-衆法-1", submitters: ["s_1"] });
    const { bills } = matchShugiinBills([stale], members);
    assert.equal(bills[0]?.submitters, undefined, "氏名が無いのに ID だけ在る形を出さない");
  });

  test("名寄せが当たっている carried は変わらない（この修正で正しい記録を落としていない）", () => {
    const members = [member("s_1", "落合 貴之"), member("s_2", "中野 洋昌")];
    const ok = bill({ id: "221-衆法-1", submitterNames: ["落合貴之", "中野洋昌"], submitters: ["s_1", "s_2"] });
    const { bills } = matchShugiinBills([ok], members);
    assert.deepEqual(bills[0]?.submitters, ["s_1", "s_2"]);
  });

  test("名簿が覆わない回次は名寄せを走らせないので carried の ID を落とさない（「記録が出ない」側に倒さない）", () => {
    // 衆院は「現在」の名簿しか無い（#71）。過去回次の氏名は今の名簿に無いのが正常でも誤りでも区別できないので
    // 名寄せを試みない。**その回次の carried の ID は、名簿が覆っていた頃の名寄せの結果で、唯一の記録である。**
    const members = [member("s_1", "落合 貴之")]; // term は sessionFrom: 221 だけ
    const past = bill({ id: "217-衆法-1", session: 217, submitterNames: ["旧姓の氏名"], submitters: ["s_9"] });
    const { bills, unmatched } = matchShugiinBills([past], members);
    assert.deepEqual(bills[0]?.submitters, ["s_9"], "覆わない回次の carried は落とさない");
    assert.deepEqual(unmatched, [], "名簿が覆わない回次は unmatched にも出さない");
  });

  test("衆院の名簿がまだ無い（衆院議員 0 人）なら名寄せを走らせないので carried の ID を落とさない", () => {
    const members = [member("m_1", "落合 貴之", "sangiin")];
    const past = bill({ id: "221-衆法-1", submitterNames: ["別人太郎"], submitters: ["s_1"] });
    const { bills } = matchShugiinBills([past], members);
    assert.deepEqual(bills[0]?.submitters, ["s_1"]);
  });
});

describe("#1236 unattestedBillMatches: 食い違いを数える計器（母数つき）", () => {
  test("食い違いを捕まえる（ID が氏名から引けない）", () => {
    const members = [member("s_1", "落合 貴之"), member("s_2", "中野 洋昌")];
    const report = unattestedBillMatches([bill({ id: "221-衆法-1", submitterNames: ["別人太郎"], submitters: ["s_1", "s_2"] })], members);
    assert.equal(report.checked, 1, "母数: 名寄せを走らせる回次で ID を持つ欄の数");
    assert.equal(report.rows.length, 1);
    assert.deepEqual(report.rows[0], { billId: "221-衆法-1", field: "submitters", names: 1, ids: 2, attested: 0, unattested: ["s_1", "s_2"] });
  });

  test("供給元の氏名から全部引けていれば 0 件（**ただし母数は 0 ではない**。母数が消えて緑になる形を塞ぐ）", () => {
    const members = [member("s_1", "落合 貴之"), member("s_3", "赤羽 一嘉")];
    const report = unattestedBillMatches([bill({ id: "221-衆法-1", submitterNames: ["落合貴之"], submitters: ["s_1"], supporterNames: ["赤羽一嘉"], supporters: ["s_3"] })], members);
    assert.equal(report.checked, 2, "submitters と supporters の 2 欄");
    assert.deepEqual(report.rows, []);
  });

  test("名簿が覆わない回次の欄は母数に数えない（名寄せを走らせていないので食い違いを判定できない）", () => {
    const members = [member("s_1", "落合 貴之")];
    const report = unattestedBillMatches([bill({ id: "217-衆法-1", session: 217, submitterNames: ["旧姓"], submitters: ["s_9"] })], members);
    assert.equal(report.checked, 0);
    assert.equal(report.skippedUncovered, 1, "数えなかった欄の数も返す（「0 件」と「数えていない」を区別する）");
    assert.deepEqual(report.rows, []);
  });

  test("衆院の名簿が 0 人なら 1 欄も数えない（skipped で言う）", () => {
    const members = [member("m_1", "落合 貴之", "sangiin")];
    const report = unattestedBillMatches([bill({ id: "221-衆法-1", submitterNames: ["落合貴之"], submitters: ["s_1"] })], members);
    assert.equal(report.checked, 0);
    assert.equal(report.skippedUncovered, 1);
  });

  test("matchShugiinBills を通した出力は必ず 0 件になる（この性質が実装の目的である）", () => {
    const members = [member("s_1", "落合 貴之"), member("s_2", "中野 洋昌")];
    const input = [
      bill({ id: "221-衆法-1", submitterNames: ["別人太郎"], submitters: ["s_1", "s_2"] }),
      bill({ id: "221-衆法-2", submitterNames: ["落合貴之", "別人太郎"], submitters: ["s_1", "s_2"] }),
      bill({ id: "221-衆法-3", supporterNames: ["別人太郎"], supporters: ["s_2"] }),
    ];
    const before = unattestedBillMatches(input, members);
    assert.equal(before.checked, 3, "母数 3 欄");
    assert.equal(before.rows.length, 3, "直す前は 3 欄すべて食い違う");
    const after = unattestedBillMatches(matchShugiinBills(input, members).bills, members);
    assert.equal(after.checked, 1, "名寄せ後に ID が残るのは 221-衆法-2 の 1 欄だけ（他は ID が無くなるので母数から外れる）");
    assert.deepEqual(after.rows, []);
  });
});

/**
 * **いま 0 件であることを、母数つきで `data/bills/` の実物に対して言う**（受け入れ条件 3）。
 * **「0 件だから clean」にしない**（#1056）ので、**母数が 0 なら落とす。**
 */
describe("#1236 data/bills/ の実物に食い違いが無いこと（母数つき）", () => {
  test("submitters / supporters の ID は、同じ個票の氏名から名簿で引ける", async () => {
    const root = new URL("../../../data", import.meta.url).pathname;
    // **`index.json` から辿る**（公開データの契約であり、個票を全部読むより速い。
    // ディレクトリを全走査すると 26.2 秒かかり、この検査 1 件で etl のテストが目に見えて遅くなる。
    // 実測 3.9 秒。**同じ答えが出ることを確かめた**: 母数 68 欄 / 不整合 0 件 / 衆院名簿 464 人 / 議案 1,941 件）。
    const memberIndex = JSON.parse(await readFile(join(root, "members", "index.json"), "utf8")) as { id: string; house: string }[];
    const members: Member[] = [];
    for (const m of memberIndex) {
      if (m.house !== "shugiin") continue;
      members.push(JSON.parse(await readFile(join(root, "members", `${m.id}.json`), "utf8")) as Member);
    }
    const billIndex = JSON.parse(await readFile(join(root, "bills", "index.json"), "utf8")) as { id: string; session: number }[];
    const bills: Bill[] = [];
    for (const s of billIndex) bills.push(JSON.parse(await readFile(join(root, "bills", String(s.session), `${s.id}.json`), "utf8")) as Bill);
    assert.ok(members.length > 0, `衆院の名簿が 0 人。母数が消えている（読んだ議案 ${bills.length} 件）`);
    assert.ok(bills.length > 0, "議案が 0 件。母数が消えている");
    const report = unattestedBillMatches(bills, members);
    // **母数が 0 なら「clean」ではなく「測れていない」。** 検査ごと落とす（#1056）。
    assert.ok(report.checked > 0, `ID を持つ欄が 0 件。検査が何も見ていない（議案 ${bills.length} 件 / 衆院名簿 ${members.length} 人 / 覆わず数えなかった欄 ${report.skippedUncovered} 件）`);
    assert.deepEqual(report.rows, [], `氏名から引けない ID が在る（母数 ${report.checked} 欄 / 議案 ${bills.length} 件）: ${JSON.stringify(report.rows)}`);
  });

  /**
   * **氏名を手で突き合わせると「壊れている」と誤読する**（#1236 のレビューで PO と実装者が別々に踏んだ）。
   *
   * **名簿は `重徳 和彦`、議案の個票は `重徳和彦`** で、**同じ人なのに文字列が違う。**
   * `resolveMember` は内部で `normalizeName`（空白除去・NFKC・異体字）を通すので正しく引けるが、
   * **`names.includes(member.name)` のように素で比べると 0 件に見える。**
   *
   * **実測（`221-決議-1`、書き換えていない `data/` の値）**:
   * ```
   * 正規化なしで一致  0 / 5   ← ここで止めると「ID が全部ずれている」と読める
   * 正規化ありで一致  5 / 5   ← 正しい
   * ```
   * **「0 件」はこの PBI の検査の正常値でもある**ため、**誤読した 0 と正しい 0 が見分けられない。**
   * **だから差が実在することを検査で固定する**（散文に書くだけでは、測り直す人がまた踏む）。
   */
  test("素の文字列比較は使えない（名簿は `姓 名`、個票は `姓名`）。正規化の有無で数が変わることを固定する", async () => {
    const root = new URL("../../../data", import.meta.url).pathname;
    const memberIndex = JSON.parse(await readFile(join(root, "members", "index.json"), "utf8")) as { id: string; name: string }[];
    const byId = new Map(memberIndex.map((m) => [m.id, m]));
    const bill = JSON.parse(await readFile(join(root, "bills", "221", "221-決議-1.json"), "utf8")) as Bill;
    const names = bill.submitterNames ?? [];
    const ids = bill.submitters ?? [];
    assert.ok(ids.length > 0, "母数が消えている（この議案は submitters を持つ前提の検査）");
    const rawHits = ids.filter((id) => names.includes(byId.get(id)?.name ?? " "));
    const normHits = ids.filter((id) => names.map(normalizeName).includes(normalizeName(byId.get(id)?.name ?? " ")));
    assert.equal(normHits.length, ids.length, `正規化すれば全件一致するはず（母数 ${ids.length} 件）`);
    assert.equal(rawHits.length, 0, `素の比較は 1 件も当たらない（母数 ${ids.length} 件）。この差が「0 件」の誤読の正体である`);
  });
});
