import { test } from "node:test";
import assert from "node:assert/strict";
import type { LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { normalizeTitle } from "../src/sources/local/title-normalize.ts";
import { buildLocalAssembly, SHIMANE_ASSEMBLY } from "../src/local-assemblies.ts";

// #648: 島根の表決 PDF の文字層は「長」を康熙部首 ⾧（U+2FA7）で持っており、本番の議案名が
// 「議⾧辞職の件（日程追加）」と出ていた。件名だけ 長（U+9577）に畳む。
// 氏名（岡﨑 哲也 の 﨑 U+FA11）と vote.raw（「議⾧」）は原文のまま。

const KANGXI_CHO = "⾧"; // ⾧
const CJK_CHO = "長"; // 長
const CJK_COMPAT_SAKI = "﨑"; // 﨑（岡﨑 哲也。実在の議員の氏名）

test("#648 normalizeTitle: 件名の ⾧（U+2FA7）を 長（U+9577）にする", () => {
  assert.equal(normalizeTitle(`議${KANGXI_CHO}辞職の件（日程追加）`), "議長辞職の件（日程追加）");
  assert.equal(normalizeTitle(`副議${KANGXI_CHO}辞職の許可`), "副議長辞職の許可");
  assert.equal(normalizeTitle(`島根県教育委員会教育${KANGXI_CHO}任命の同意について`), "島根県教育委員会教育長任命の同意について");
  // 出力に U+2FA7 が 1 つも残らない
  assert.equal([...normalizeTitle(`議${KANGXI_CHO}辞職の許可`)].filter((c) => c === KANGXI_CHO).length, 0);
  // 入れ替わった先は U+9577 であって、別の異体字ではない
  assert.equal(normalizeTitle(KANGXI_CHO).codePointAt(0), 0x9577);
});

test("#648 normalizeTitle: 表に無い字は 1 文字も変えない（NFKC を掛けない証拠）", () => {
  // すでに普通の「長」を含む件名はそのまま
  assert.equal(normalizeTitle(`議${CJK_CHO}辞職の許可`), `議${CJK_CHO}辞職の許可`);
  // NFKC なら変わる字（全角英数・合字・半角カナ・丸数字）。件名の原文なので変えない
  for (const s of ["ＩＴ推進に関する条例", "㈱の取扱いについて", "ｱｲｳ", "①号議案", "Ⅲ期計画", "㎡あたりの単価"]) {
    assert.equal(normalizeTitle(s), s, `${s} は NFKC なら変わるが、件名では変えない`);
    assert.notEqual(s.normalize("NFKC"), s, `${s} は NFKC で変わる字を含む前提（fixture の自己検査）`);
  }
  // 氏名で使う字は畳まない（件名に混ざっても）
  assert.equal(normalizeTitle(`岡${CJK_COMPAT_SAKI}哲也`), `岡${CJK_COMPAT_SAKI}哲也`);
  assert.equal(normalizeTitle("髙橋 𠮷德"), "髙橋 𠮷德");
  // 空文字・該当なし
  assert.equal(normalizeTitle(""), "");
  assert.equal(normalizeTitle("令和8年度島根県一般会計予算"), "令和8年度島根県一般会計予算");
});

const member = (id: string, name: string): LocalMember => ({
  id, assemblyId: "pref-32", name, kana: "かな", group: "自民党議員連盟", district: "松江市", profileUrl: "https://www.pref.shimane.lg.jp/gikai/x.html",
  current: true, asOf: "2026-04-01", sourceUrl: "https://www.pref.shimane.lg.jp/gikai/meibo.html", counts: { rollcalls: 0 },
});
const PDF = "https://www.pref.shimane.lg.jp/gikai/ugoki/gikai_kako/r0806/index.data/r0806_giinbetu_kekka.pdf";
const CHAIR_VOTE = { raw: `議${KANGXI_CHO}`, legend: "議長", mapped: "投票なし" as const };

test("#648 buildLocalAssembly: rollCalls / rollCallIndex / timeline の件名すべてが正規化され、vote.raw と氏名は原文のまま", () => {
  const members = [member("p_32_1", `岡${CJK_COMPAT_SAKI} 哲也`), member("p_32_2", "池田 一")];
  const rc: LocalRollCall = {
    id: "pref-32-r0806-20260710-知事提出議案-第1号", assemblyId: "pref-32", sessionId: "r0806",
    sessionLabel: "令和8年6月定例会", date: "2026-07-10", kind: "知事提出議案", number: "第1号",
    title: `議${KANGXI_CHO}辞職の件（日程追加）`, result: "可決", counts: { yes: 1, no: 0 },
    votes: [
      { memberId: "p_32_1", nameText: `岡${CJK_COMPAT_SAKI}哲也`, group: "自民党議員連盟", value: { raw: "○", legend: "賛成", mapped: "賛成" } },
      { memberId: "p_32_2", nameText: "池田一", group: "自民党議員連盟", value: CHAIR_VOTE },
    ],
    page: 1, sourceUrl: PDF,
  };
  const built = buildLocalAssembly({ assembly: SHIMANE_ASSEMBLY, members, rollCalls: [rc], fetchedAt: "2026-09-08T00:00:00.000Z", rosterAsOf: "2026-04-01", sources: [], sessions: [] });

  // 件名は 3 か所に出る（rollcalls/{id}.json、rollcalls/index.json、members/{id}.json の timeline）
  assert.equal(built.rollCalls[0].title, "議長辞職の件（日程追加）", "rollcalls/{id}.json");
  assert.equal(built.rollCallIndex[0].title, "議長辞職の件（日程追加）", "rollcalls/index.json");
  const chair = built.details.find((d) => d.id === "p_32_2")!;
  assert.equal(chair.timeline[0].title, "議長辞職の件（日程追加）", "members/{id}.json の timeline");

  // vote.raw は原文のまま（判と凡例が「PDF にこう書いてあった」を見せる根拠。畳むと事実が消える）
  assert.equal(built.rollCalls[0].votes[1].value.raw, `議${KANGXI_CHO}`, "vote.raw の ⾧ は残す");
  assert.equal(chair.timeline[0].vote.raw, `議${KANGXI_CHO}`, "timeline の vote.raw の ⾧ は残す");

  // 氏名は原文のまま（岡﨑 哲也 の 﨑 は本人の名前）
  assert.equal(built.rollCalls[0].votes[0].nameText, `岡${CJK_COMPAT_SAKI}哲也`, "votes[].nameText の 﨑 は残す");
  assert.equal(built.index[0].name, `岡${CJK_COMPAT_SAKI} 哲也`, "members/index.json の name の 﨑 は残す");
  assert.equal(built.details[0].name, `岡${CJK_COMPAT_SAKI} 哲也`, "members/{id}.json の name の 﨑 は残す");

  // 出力全体を JSON にしても ⾧ は raw のぶんだけ（件名のぶんは 0）で、﨑 は減っていない
  const dumped = JSON.stringify(built);
  assert.equal([...dumped].filter((c) => c === KANGXI_CHO).length, 2, "⾧ は votes[].value.raw と timeline[].vote.raw の 2 か所だけ");
  // index の name / details の name / rollCalls の votes[].nameText の 3 か所（rollCallIndex は votes を落とすので 0）
  assert.equal([...dumped].filter((c) => c === CJK_COMPAT_SAKI).length, 3, "﨑 は 3 か所すべて残る");
});

test("#648 buildLocalAssembly: 名寄せできなかった票の nameText も原文のまま unmatched に載る", () => {
  const rc: LocalRollCall = {
    id: "pref-32-r0806-20260710-知事提出議案-第2号", assemblyId: "pref-32", sessionId: "r0806",
    sessionLabel: "令和8年6月定例会", date: "2026-07-10", kind: "知事提出議案", number: "第2号",
    title: `副議${KANGXI_CHO}辞職の許可`, result: "可決", counts: { yes: 0, no: 0 },
    votes: [{ memberId: "", nameText: `岡${CJK_COMPAT_SAKI}哲也`, group: "自民党議員連盟", value: CHAIR_VOTE }],
    page: 1, sourceUrl: PDF,
  };
  const built = buildLocalAssembly({ assembly: SHIMANE_ASSEMBLY, members: [], rollCalls: [rc], fetchedAt: "2026-09-08T00:00:00.000Z", rosterAsOf: "2026-04-01", sources: [], sessions: [] });
  assert.equal(built.rollCalls[0].title, "副議長辞職の許可");
  assert.equal(built.unmatched[0].nameText, `岡${CJK_COMPAT_SAKI}哲也`, "unmatched.json の氏名は原文のまま");
});
