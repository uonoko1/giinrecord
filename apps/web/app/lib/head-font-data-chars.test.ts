/**
 * `data/` の中身のうち、**見出し家族 700 で描かれる欄**の字（#477）。
 *
 * ビルド済み HTML を舐めるだけでは足りない。**折りたたみの向こう側が HTML に無い**からである（実測）:
 *
 * | 欄 | どこに出るか | プリレンダーされる HTML に入っているか |
 * |---|---|---|
 * | 議員名 `.members-item__name` | `/members` | **229 名だけ**（#340 の 200 件折りたたみ。全体は 1,057 名） |
 * | 発言の役職 `.member-position` | 議員ページの発言タブ | **入らない**（#242 で本文は焼き込まない。タブも折りたたみ） |
 * | 地方議会の判 `.member-stamp` | 議員ページの表決タブ | 折りたたみの向こう |
 * | 会派名 `.rollcall-group-name` | 採決ページ | 入る（が、ここでも数える） |
 *
 * #468 の調査は議員ページを **20 件のサンプル**しか見ていない。1,057 名ぶんの発言の役職は
 * 実測 **137 字**あり、うち **68 字**は氏名・会派・選挙区のどれにも出てこない。
 * **サンプルでは絶対に集まらない。**
 */
import { describe, expect, it } from "vitest";
import { dataHeadChars } from "./head-font-data-chars";

describe("dataHeadChars（data/ のうち明朝700 で描かれる欄の字）", () => {
  it("議員の 氏名・会派・選挙区 を全部取る（一覧の折りたたみの向こうも）", () => {
    const chars = dataHeadChars({
      members: [
        { name: "阿達 雅志", group: "自由民主党", district: "比例" },
        { name: "青木 愛", group: "立憲民主党", district: "千葉県" },
      ],
    });
    expect(chars.has("阿")).toBe(true);
    expect(chars.has("葉")).toBe(true); // 選挙区にしか出ない字
    expect(chars.has("憲")).toBe(true); // 会派にしか出ない字
  });

  it("全角空白を落とさない（調査の失敗2。218 名が 1 グリフだけフォールバックした）", () => {
    expect(dataHeadChars({ members: [{ name: "阿達　雅志", group: "", district: "" }] }).has("　")).toBe(true);
  });

  it("発言の役職（会議録の原文）を取る — HTML には出てこない欄", () => {
    const chars = dataHeadChars({ speakerPositions: ["国土交通大臣", "議長"] });
    expect(chars.has("臣")).toBe(true);
    expect(chars.has("議")).toBe(true);
  });

  it("採決の会派名を取る", () => {
    expect(dataHeadChars({ rollCallGroups: ["各派に属しない議員"] }).has("属")).toBe(true);
  });

  it("地方議会の判の原文（○×議欠－棄白）を取る", () => {
    const chars = dataHeadChars({ localVoteMarks: ["○", "×", "欠"] });
    expect([...chars].sort()).toEqual(["×", "○", "欠"]);
  });

  it("欄が無いデータでも落ちない（ETL 前・古いデータ）", () => {
    expect(dataHeadChars({}).size).toBe(0);
    expect(dataHeadChars({ members: [{ name: "名" }] }).has("名")).toBe(true);
  });

  it("重複を数えない（異なり字だけ返す）", () => {
    expect(dataHeadChars({ members: [{ name: "同" }, { name: "同" }, { name: "同" }] }).size).toBe(1);
  });
});
