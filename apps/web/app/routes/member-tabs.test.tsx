import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { MemberDetail, TimelineEntry } from "../lib/data-contract";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMember from "../test-fixtures/assemblies/member-local.json";
import sangiinMember from "../test-fixtures/member.json";
import sangiinSpeeches from "../test-fixtures/member-speeches.json";
import shugiinMember from "../test-fixtures/member-shugiin.json";
import shugiinSpeeches from "../test-fixtures/member-shugiin-speeches.json";
import meta from "../test-fixtures/meta";
import { MemberPage, groupTabs } from "./member";

/** 分類のラベルは事実だけを述べる。評価・比較の語を入れない（他ページと同じガード） */
const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "遅れ", "不十分", "優れ", "充実", "網羅", "積極", "熱心", "怠", "少ない", "多い"];

const sangiin = sangiinMember as MemberDetail;
const shugiin = shugiinMember as MemberDetail;
/** 発言は #242 で timeline から members/{id}/speeches.json に移った。件数はビルド時に数えて渡す */
const sangiinSpeechCount = sangiinSpeeches.speeches.length;
const shugiinSpeechCount = shugiinSpeeches.speeches.length;
const local = localMember as MemberDetail;
const miyagi = (assembliesFixture as Assembly[])[2]!;

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const tabByLabel = (label: string) => screen.getByRole("tab", { name: new RegExp(`^${label}`) });

describe("議員ページのタブのカテゴリ（#238）: 衆院", () => {
  it("「本人の記録」と「所属会派の記録（推定）」の 2 つのカテゴリに分かれる", () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    const headings = [...document.querySelectorAll(".member-tabcat")].map((h) => h.textContent);
    expect(headings).toEqual(["本人の記録", "所属会派の記録（推定）本人の投票ではありません"]);
  });

  it("会派の態度は「所属会派の記録（推定）」の側にあり、本人の記録のタブ列には入らない", () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    const selfList = screen.getByRole("tablist", { name: "本人の記録" });
    const groupList = screen.getByRole("tablist", { name: /所属会派の記録（推定）/ });
    expect(within(selfList).getAllByRole("tab").map((t) => t.textContent)).toEqual(["提出法案2件", "質問主意書1件", "発言1件", "委員会の役職0件"]);
    expect(within(groupList).getAllByRole("tab").map((t) => t.textContent)).toEqual(["会派の態度2件"]);
    // 推定のタブ列は判・冒頭の注記と同じ est の見た目で、本人の記録と地続きに見えない
    expect(groupList.closest(".member-tabgroup")).toHaveAttribute("data-category", "group");
  });

  it("「すべて」はどちらのカテゴリにも入らない（本人の記録と会派の記録の両方を含むため）", () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    const selfList = screen.getByRole("tablist", { name: "本人の記録" });
    expect(within(selfList).queryByRole("tab", { name: /^すべて/ })).not.toBeInTheDocument();
    const allTab = tabByLabel("すべて");
    expect(allTab.closest(".member-tabgroup")).toHaveAttribute("data-category", "all");
    // 「すべて」の件数は timeline の全件（提出2 + 会派2 + 質問1）。発言は timeline に無い（#242）
    expect(allTab).toHaveTextContent("5件");
  });

  it("カテゴリの見出しとタブのラベルに評価語を含まない", () => {
    const { container } = render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    for (const word of EVALUATIVE_WORDS) expect(container.textContent).not.toContain(word);
  });
});

describe("議員ページのタブのカテゴリ（#238）: 参院・地方はカテゴリが 1 つなので見出しを出さない", () => {
  it("参院はカテゴリ見出しが無く、タブ列は 1 本のまま", () => {
    render(<MemberPage detail={sangiin} meta={meta} speechCount={sangiinSpeechCount} />);
    expect(document.querySelectorAll(".member-tabcat")).toHaveLength(0);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    // 「すべて」は timeline の件数。発言は timeline に無い（#242）ので含まれない
    expect(tabNames()).toEqual(["すべて5件", "採決2件", "提出法案2件", "質問主意書1件", "発言4件", "委員会の役職0件"]);
  });

  it("地方はカテゴリ見出しが無く、表決だけ（過剰な装飾をしない）", () => {
    render(<MemberPage detail={local} meta={meta} assembly={miyagi} />);
    expect(document.querySelectorAll(".member-tabcat")).toHaveLength(0);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(tabNames()).toEqual(["すべて4件", "表決4件"]);
  });
});

describe("議員ページのタブの件数（#238）", () => {
  it("タブの件数は表紙の件数帯と一致する（同じ数え方）", () => {
    render(<MemberPage detail={sangiin} meta={meta} speechCount={sangiinSpeechCount} />);
    const cover = screen.getByRole("banner");
    for (const [coverLabel, tabLabel] of [
      ["記名採決", "採決"],
      ["提出法案", "提出法案"],
      ["質問主意書", "質問主意書"],
      ["発言", "発言"],
    ] as const) {
      const n = within(cover).getByText(coverLabel, { selector: "dt" }).nextElementSibling!.textContent;
      expect(tabByLabel(tabLabel)).toHaveTextContent(`${n}件`);
    }
  });

  it("衆院も表紙の件数帯とタブの件数が一致する（提出法案は提出者・賛成者の合計）", () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    const cover = screen.getByRole("banner");
    const submitted = Number(within(cover).getByText("提出法案", { selector: "dt" }).nextElementSibling!.textContent);
    const supported = Number(within(cover).getByText("賛同法案", { selector: "dt" }).nextElementSibling!.textContent);
    expect(tabByLabel("提出法案")).toHaveTextContent(`${submitted + supported}件`);
    for (const [coverLabel, tabLabel] of [
      ["質問主意書", "質問主意書"],
      ["発言", "発言"],
    ] as const) {
      const n = within(cover).getByText(coverLabel, { selector: "dt" }).nextElementSibling!.textContent;
      expect(tabByLabel(tabLabel)).toHaveTextContent(`${n}件`);
    }
  });

  it("件数 0 のタブは隠さず、淡色（data-empty）で出す。「無い」ことが事実だから", async () => {
    // 発言・質問主意書が 1 件も無い衆院議員（実データではよくある）。発言は speechCount 0 で表す（#242）
    const noSpeech: MemberDetail = { ...shugiin, timeline: shugiin.timeline.filter((e) => e.kind !== "question") };
    render(<MemberPage detail={noSpeech} meta={meta} speechCount={0} />);
    const speech = tabByLabel("発言");
    expect(speech).toBeInTheDocument();
    expect(speech).toHaveTextContent("0件");
    expect(speech).toHaveAttribute("data-empty", "true");
    expect(speech).toBeEnabled();
    // 押せて、空であることが本文で分かる
    await userEvent.click(speech);
    expect(within(screen.getByRole("tabpanel")).getByText("記録はありません。")).toBeInTheDocument();
  });

  it("件数が 1 件以上のタブには data-empty を付けない", () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    expect(tabByLabel("提出法案")).not.toHaveAttribute("data-empty");
  });
});

describe("議員ページのタブのキーボード操作（#238）", () => {
  it("選択中のタブだけが tabindex=0（ロービングタブインデックス）", () => {
    render(<MemberPage detail={sangiin} meta={meta} speechCount={sangiinSpeechCount} />);
    expect(tabByLabel("すべて")).toHaveAttribute("tabindex", "0");
    expect(tabByLabel("採決")).toHaveAttribute("tabindex", "-1");
  });

  it("右矢印で次のタブへ移り、内容も切り替わる", async () => {
    render(<MemberPage detail={sangiin} meta={meta} speechCount={sangiinSpeechCount} />);
    tabByLabel("すべて").focus();
    await userEvent.keyboard("{ArrowRight}");
    const vote = tabByLabel("採決");
    expect(vote).toHaveAttribute("aria-selected", "true");
    expect(vote).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-vote");
  });

  it("左矢印は端で反対の端へ回り、End は最後・Home は最初へ移る", async () => {
    render(<MemberPage detail={sangiin} meta={meta} speechCount={sangiinSpeechCount} />);
    tabByLabel("すべて").focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(tabByLabel("委員会の役職")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Home}");
    expect(tabByLabel("すべて")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{End}");
    expect(tabByLabel("委員会の役職")).toHaveAttribute("aria-selected", "true");
  });

  it("衆院は矢印キーがカテゴリ内で完結する（本人の記録から会派の記録へ飛び移らない）", async () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    tabByLabel("委員会の役職").focus(); // 「本人の記録」の最後のタブ
    await userEvent.keyboard("{ArrowRight}");
    expect(tabByLabel("提出法案")).toHaveAttribute("aria-selected", "true"); // 同じカテゴリの先頭に回る
    expect(tabByLabel("会派の態度")).toHaveAttribute("aria-selected", "false");
  });
});

describe("groupTabs（#238）", () => {
  const tab = (id: string, category: "all" | "self" | "group") =>
    ({ id, label: id, category, kind: null }) as Parameters<typeof groupTabs>[0][number];

  it("名前のあるカテゴリが 1 つなら、タブ列を 1 本にまとめて見出しを出さない", () => {
    const groups = groupTabs([tab("all", "all"), tab("vote", "self"), tab("bill", "self")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.labelled).toBe(false);
    expect(groups[0]!.tabs.map((t) => t.id)).toEqual(["all", "vote", "bill"]);
  });

  it("名前のあるカテゴリが 2 つなら、すべて／本人／会派の 3 本に分けて見出しを出す", () => {
    const groups = groupTabs([tab("all", "all"), tab("bill", "self"), tab("stance", "group")]);
    expect(groups.map((g) => [g.category, g.labelled, g.tabs.map((t) => t.id)])).toEqual([
      ["all", false, ["all"]],
      ["self", true, ["bill"]],
      ["group", true, ["stance"]],
    ]);
  });
});

describe("タブを切り替えても記録の中身が入れ替わらない（#238 で分類しても行の対応は変わらない）", () => {
  it("参院: 採決タブに出る件名は timeline の vote 行の件名と同じ", async () => {
    render(<MemberPage detail={sangiin} meta={meta} speechCount={sangiinSpeechCount} />);
    await userEvent.click(tabByLabel("採決"));
    const expected = sangiin.timeline.filter((e): e is Extract<TimelineEntry, { kind: "vote" }> => e.kind === "vote").map((e) => e.title);
    const table = screen.getByRole("table");
    for (const title of expected) expect(within(table).getByText(title)).toBeInTheDocument();
    // 他の kind の件名は出ない（分類がずれていれば落ちる）
    for (const e of sangiin.timeline.filter((x) => x.kind === "speech")) {
      expect(within(table).queryByText((e as Extract<TimelineEntry, { kind: "speech" }>).excerpt)).not.toBeInTheDocument();
    }
  });

  it("衆院: 会派の態度タブに出るのは stance 行だけで、提出法案タブには stance 行が出ない", async () => {
    render(<MemberPage detail={shugiin} meta={meta} speechCount={shugiinSpeechCount} />);
    await userEvent.click(tabByLabel("会派の態度"));
    let panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    for (const li of within(panel).getAllByRole("listitem")) expect(li).toHaveAttribute("data-estimated", "true");

    await userEvent.click(tabByLabel("提出法案"));
    panel = screen.getByRole("tabpanel");
    expect(panel.querySelectorAll('[data-estimated="true"]')).toHaveLength(0);
  });
});

/**
 * #361: 既定の「すべて」タブが折りたたまれていなかった。**開いて最初に見えるのがここ**なので、
 * 折りたたみが無いと最初の描画がそのまま最大になる。実データで国会議員182名・地方議員47名が200件超、
 * 最大394件（本番のスマホ幅で DOM 3,062・26画面）。
 */
describe("「すべて」タブの折りたたみ（#361）", () => {
  const many = (n: number): MemberDetail => ({
    ...shugiin,
    timeline: Array.from({ length: n }, (_, i) => ({
      ...(shugiin.timeline[0] as object),
      billId: `221-衆法-${i}`,
      title: `法律案 ${i}`,
    })),
  }) as MemberDetail;
  const rows = () => screen.getAllByRole("listitem").length;

  it("200 件を超えたら折りたたみ、残り件数を出す", () => {
    render(<MemberPage detail={many(394)} meta={meta} speechCount={0} />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("すべて");
    expect(rows()).toBe(200);
    expect(screen.getByRole("button", { name: "さらに表示（残り194件）" })).toBeInTheDocument();
  });

  it("「さらに表示」で全件出る", async () => {
    render(<MemberPage detail={many(394)} meta={meta} speechCount={0} />);
    await userEvent.click(screen.getByRole("button", { name: /さらに表示/ }));
    expect(rows()).toBe(394);
  });

  it("200 件以下なら折りたたまない（境界）", () => {
    render(<MemberPage detail={many(200)} meta={meta} speechCount={0} />);
    expect(rows()).toBe(200);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).not.toBeInTheDocument();
  });
});
