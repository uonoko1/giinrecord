import { describe, expect, it } from "vitest";
import { memberSources } from "./member-sources";
import type { DatasetSource, MemberDetail, TimelineEntry } from "./data-contract";
import meta from "../test-fixtures/meta";

/**
 * #339: 議員ページの出典は「そのページが実際に使ったもの」だけ。
 *
 * 検査は **allowlist（出るべき集合と完全一致）** で行う（#333 の学び）。
 * 「参院の出典が出ない」という denylist だと、絞り込みが弱くなる変更を素通しする。
 */
const names = (list: DatasetSource[]) => list.map((s) => s.name).sort();

const member = (house: "sangiin" | "shugiin", timeline: Partial<TimelineEntry>[] = []): MemberDetail =>
  ({ id: "x", name: "テスト 議員", kana: "てすと ぎいん", house, terms: [], sourceUrl: "https://example.invalid/", timeline } as unknown as MemberDetail);

const entry = (kind: string): Partial<TimelineEntry> => ({ kind } as Partial<TimelineEntry>);

describe("memberSources: そのページが実際に使った出典だけを出す（#339）", () => {
  it("参院議員・記録なし → 参院の議員一覧だけ（衆院の出典は1件も出ない）", () => {
    expect(names(memberSources(meta.sources, member("sangiin"), 0))).toEqual(["参議院 議員一覧"]);
  });

  it("衆院議員・記録なし → 衆院の議員一覧だけ", () => {
    expect(names(memberSources(meta.sources, member("shugiin"), 0))).toEqual(["衆議院 議員一覧"]);
  });

  it("参院議員・投票あり → 議員一覧＋本会議投票結果（衆院側は出ない）", () => {
    const got = memberSources(meta.sources, member("sangiin", [entry("vote")]), 0);
    expect(names(got)).toEqual(["参議院 本会議投票結果", "参議院 議員一覧"].sort());
  });

  it("会派の態度（stance・推定）の出典は議案情報。衆院議員なので衆院の議案情報が出る", () => {
    const got = memberSources(meta.sources, member("shugiin", [entry("stance")]), 0);
    expect(names(got)).toEqual(["衆議院 議員一覧", "衆議院 議案情報"].sort());
  });

  it("発言があるときだけ会議録（speech）の出典が出る。その院のものだけ", () => {
    const none = memberSources(meta.sources, member("sangiin"), 0);
    expect(names(none)).not.toContain("国会会議録検索システム（参議院 本会議・委員会）");

    const got = memberSources(meta.sources, member("sangiin"), 3);
    expect(names(got)).toEqual(["参議院 議員一覧", "国会会議録検索システム（参議院 本会議・委員会）"].sort());
  });

  it("委員会の役職・出席は committee の出典を呼ぶ", () => {
    const role = memberSources(meta.sources, member("shugiin", [entry("committeeRole")]), 0);
    expect(names(role)).toEqual(["衆議院 議員一覧", "国会会議録検索システム（衆議院 委員会の出席委員欄）"].sort());

    const att = memberSources(meta.sources, member("sangiin", [entry("attendance")]), 0);
    expect(names(att)).toEqual(["参議院 議員一覧", "国会会議録検索システム（参議院 委員会の出席委員欄）"].sort());
  });

  it("質問主意書は question の出典を呼ぶ", () => {
    const got = memberSources(meta.sources, member("sangiin", [entry("question")]), 0);
    expect(names(got)).toEqual(["参議院 議員一覧", "参議院 質問主意書"].sort());
  });

  it("記録が揃った参院議員 → 参院の全種別が出て、衆院の出典は1件も混ざらない", () => {
    const got = memberSources(
      meta.sources,
      member("sangiin", [entry("vote"), entry("bill"), entry("question"), entry("attendance")]),
      5,
    );
    expect(names(got)).toEqual(
      [
        "参議院 本会議投票結果",
        "参議院 議員一覧",
        "参議院 議案情報",
        "参議院 質問主意書",
        "国会会議録検索システム（参議院 本会議・委員会）",
        "国会会議録検索システム（参議院 委員会の出席委員欄）",
      ].sort(),
    );
    // 院の分離は、この機能の一番の目的なので明示的にも見る
    expect(got.every((s) => s.house === "sangiin")).toBe(true);
  });

  it("house: both の出典は院に関わらず残る（院をまたぐ出典のため）", () => {
    const both: DatasetSource = { name: "両院 共通", url: "https://www.shugiin.go.jp/both", fetchedAt: "x", house: "both", kind: "roster" };
    expect(names(memberSources([...meta.sources, both], member("sangiin"), 0))).toContain("両院 共通");
    expect(names(memberSources([...meta.sources, both], member("shugiin"), 0))).toContain("両院 共通");
  });

  it("国会議員が localVote を持っていても、国会の出典は呼ばない（種別の対応が無い）", () => {
    const got = memberSources(meta.sources, member("sangiin", [entry("localVote")]), 0);
    expect(names(got)).toEqual(["参議院 議員一覧"]);
  });

  // #339 の実装で見つけたバグ: 地方議員は house を持たず記録も localVote だけなので、
  // 院でも種別でも一致せず**出典が空**になっていた（実データで 285名 / 1,057名）。
  // 出典欄を空にするのは「絞る」より悪い。地方議員は絞らない。
  it("地方議会の議員は絞らない（出典を空にしない）", () => {
    const local = { id: "p_04_x", name: "地方 議員", kana: "ちほう ぎいん", assemblyId: "pref-04", terms: [], sourceUrl: "https://example.invalid/", timeline: [{ kind: "localVote" }] } as unknown as MemberDetail;
    const got = memberSources(meta.sources, local, 0);
    expect(got).toHaveLength(meta.sources.length);
    expect(got.length).toBeGreaterThan(0);
  });
  // #339 の移行期: 属性を持たない古い meta.json でも「出典が空」にはしない
  it("house / kind を持たない古い出典が混ざっていたら、絞らず全件出す（空にしない）", () => {
    const legacy = [
      { name: "参議院 議員一覧（第216回）", url: "https://www.sangiin.go.jp/x", fetchedAt: "x" },
      { name: "衆議院 議案情報（第221回）", url: "https://www.shugiin.go.jp/y", fetchedAt: "x" },
    ] as unknown as DatasetSource[];
    // 参院議員でも衆院の出典が残る = 絞り込みを諦めている。出典ゼロよりはるかにまし
    expect(memberSources(legacy, member("sangiin"), 0)).toHaveLength(2);
  });

  // 条件式の「どの部分が効いているか」を固定する。両方欠けたケースだけでは
  // `||`→`&&`、`some`→`every`、片方しか見ない、のどれもが素通りした（レビュー指摘）
  it("house だけ欠けていてもフォールバックする", () => {
    const half = [
      { name: "参議院 議員一覧", url: "https://www.sangiin.go.jp/x", fetchedAt: "x", kind: "roster" },
      ...meta.sources,
    ] as unknown as DatasetSource[];
    expect(memberSources(half, member("sangiin"), 0)).toHaveLength(half.length);
  });

  it("kind だけ欠けていてもフォールバックする", () => {
    const half = [
      { name: "参議院 議員一覧", url: "https://www.sangiin.go.jp/x", fetchedAt: "x", house: "sangiin" },
      ...meta.sources,
    ] as unknown as DatasetSource[];
    expect(memberSources(half, member("sangiin"), 0)).toHaveLength(half.length);
  });

  it("全件が属性を持っていれば、ちゃんと絞る（フォールバックに落ちない）", () => {
    // `some`→`every` にすると、実データのように全件が属性を持つとき絞り込みが死ぬ。
    // 「絞れている」ことをここで固定する
    const got = memberSources(meta.sources, member("sangiin"), 0);
    expect(got.length).toBeLessThan(meta.sources.length);
    expect(names(got)).toEqual(["参議院 議員一覧"]);
  });
});
