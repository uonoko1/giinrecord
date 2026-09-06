import { describe, expect, it } from "vitest";
import { ALLOWED_DOC_ATTRS, ALLOWED_GLOBAL_KEYS, describeLeaks, type GlobalSnapshot } from "./global-leak-guard";

/**
 * **見張り自身の検査**（#512）。
 *
 * `vitest.setup.ts` の見張りは「漏れていたら落とす」形だが、
 * **allowlist を 1 行広げるだけで黙る**。実測でそれを確かめた:
 * `ALLOWED_GLOBAL_KEYS` に `"__giinrecordInstallPrompt"` を足し、同時に
 * `PoliciesSection.test.tsx` の後始末を戻すと、**4 passed（素通り）**になる。
 *
 * だから **allowlist の中身そのものを、ここで名指しで固定する**
 * （#484「通すものの集合を固定しないと、緩めても気づけない」／
 *  #499「個数ではなく要素そのものを固定する」）。
 * 期待値はハードコードする。検査対象から生成すると自己参照になり、対象が太れば期待値も太る。
 */
describe("グローバルの見張りの allowlist", () => {
  it("見逃してよいグローバルは IS_REACT_ACT_ENVIRONMENT だけ（増やすなら理由を書くこと）", () => {
    expect([...ALLOWED_GLOBAL_KEYS]).toEqual(["IS_REACT_ACT_ENVIRONMENT"]);
  });

  it("<html> に残してよい属性は無い", () => {
    expect([...ALLOWED_DOC_ATTRS]).toEqual([]);
  });
});

/** 何も持っていない基準。ここから 1 つずつ足して、見張りが名指しするか見る。 */
function emptySnapshot(): GlobalSnapshot {
  return { globals: new Set(), docAttrs: new Set(), bodyShape: "", headShape: "", local: new Set(), session: new Set(), userAgent: "jsdom" };
}

function withChange(change: (s: GlobalSnapshot) => void): GlobalSnapshot {
  const s = emptySnapshot();
  change(s);
  return s;
}

/**
 * **漏れの形ごとに、その形だけが効く見本を置く**（#506「枝ごとに、その枝だけが効く見本を置く」）。
 * 見張りが見る経路は 6 本ある（globalThis / <html> の属性 / body / head / storage / userAgent）。
 * **1 本ずつ落として、それぞれが落ちること**をここで固定する。
 */
describe("見張りは漏れの形を1つずつ名指しする", () => {
  const cases: readonly [name: string, after: GlobalSnapshot, expectedSubstring: string][] = [
    ["globalThis に残す", withChange((s) => s.globals.add("__giinrecordInstallPrompt")), "globalThis.__giinrecordInstallPrompt が残っている"],
    ["<html> の属性に残す", withChange((s) => s.docAttrs.add("data-theme=dark")), "<html> の属性 data-theme=dark が残っている"],
    ["document.body に残す", withChange((s) => (s.bodyShape = "1 要素: div.member-tabgroup")), "document.body の中身が変わった"],
    ["document.head に残す", withChange((s) => (s.headShape = "1 要素: style")), "document.head の中身が変わった"],
    ["localStorage に残す", withChange((s) => s.local.add("seiji-kiroku:theme")), 'localStorage["seiji-kiroku:theme"] が残っている'],
    ["sessionStorage に残す", withChange((s) => s.session.add("x")), 'sessionStorage["x"] が残っている'],
    ["navigator.userAgent を戻さない", withChange((s) => (s.userAgent = "Mozilla/5.0 (Linux; Android 14) Chrome/128")), "navigator.userAgent が変わったままになっている"],
  ];

  it.each(cases)("%s と落ちる", (_name, after, expectedSubstring) => {
    const leaks = describeLeaks(emptySnapshot(), after);
    expect(leaks.join("\n")).toContain(expectedSubstring);
  });

  it("何も変わっていなければ、何も言わない（偽陽性を出さない）", () => {
    expect(describeLeaks(emptySnapshot(), emptySnapshot())).toEqual([]);
  });

  it("IS_REACT_ACT_ENVIRONMENT は通す（RTL が render のたびに立てる旗）", () => {
    expect(describeLeaks(emptySnapshot(), withChange((s) => s.globals.add("IS_REACT_ACT_ENVIRONMENT")))).toEqual([]);
  });

  /**
   * **「消えた」も漏れとして言う。** 前のファイルが残したものを次のファイルが消すと、
   * 差分は「消したほう」に出る。そこを黙らせると、
   * **漏らした側が最後のファイルだったときだけ鳴る**という当てにならない見張りになる。
   */
  it("前のテストが残したものを消した側も名指しする", () => {
    const before = withChange((s) => s.globals.add("__giinrecordInstallPrompt"));
    const leaks = describeLeaks(before, emptySnapshot());
    expect(leaks.join("\n")).toContain("globalThis.__giinrecordInstallPrompt が消えた");
  });
});
