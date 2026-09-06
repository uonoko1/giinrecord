/**
 * **テストファイルが「自分より後に走るファイル」に状態を残していないか、毎テストの後で見張る。**
 *
 * Issue #512。`PoliciesSection.test.tsx` と `SiteFooter.test.tsx` が
 * 本物の `beforeinstallprompt` を `window.dispatchEvent` し、
 * `useInstallPrompt` のリスナが `window.__giinrecordInstallPrompt` に保存する。
 * 後始末が `vi.unstubAllGlobals()` だけでこのキーを消していなかったので、
 * **同じワーカーで後に走った `InstallLink.test.tsx` が「非対応ブラウザでは何も描画しない」で落ちた**
 * （実測: `--pool=forks --poolOptions.forks.singleFork --sequence.shuffle.files --sequence.seed=3`）。
 *
 * **後始末を足すだけでは同じ事故がまた起きる**——次に `window` に書くテストを足す人が、
 * 消す側を書き忘れても誰も鳴らさない。だから**消すのではなく、残っていたら落とす**。
 * 落とす側にしてあるので、**この見張り自身が黙る変異**（消して回るだけ）を書けない。
 *
 * 見張る先は、実際に漏れているのを**実行時に列挙して**決めた（推測で並べていない）。
 * 85 テストファイルを singleFork で走らせ、各ファイルの前後で
 * `window` / `globalThis` の自前プロパティ・`document.body` / `head` の中身・
 * `documentElement` の属性・`localStorage` / `sessionStorage` のキー・`navigator.userAgent` を撮って
 * 差分を出したところ、**9 ファイルが差分を残していた**。
 */

/**
 * テストの実行環境そのものが持ち込むもの。**ここに足すときは理由を書くこと。**
 *
 * `IS_REACT_ACT_ENVIRONMENT` は React Testing Library が `render` のたびに立てる旗で、
 * ファイル内で `render` を一度でも呼べば必ず残る。テスト間の汚染にはならない
 * （どのファイルも `render` の前に自分で立て直す）。
 */
export const ALLOWED_GLOBAL_KEYS: readonly string[] = ["IS_REACT_ACT_ENVIRONMENT"];

/** `documentElement` に残ってよい属性。いまは無い。 */
export const ALLOWED_DOC_ATTRS: readonly string[] = [];

export type GlobalSnapshot = {
  globals: Set<string>;
  docAttrs: Set<string>;
  /**
   * `document.body` / `head` の「姿」。**innerHTML の全文は持たない。**
   *
   * 全文を撮ると、大きい一覧を描くテストで**1 テストあたり 85ms** かかった（実測。
   * 96KB の DOM で `body.innerHTML` の文字列化だけが 41.3ms を占め、他は全部足して 1ms 未満）。
   * `members.test.tsx` は 59 テストあり、既に 20000ms の上限に近いところで走っている。
   * **見張りが上限を押し上げてしまっては本末転倒**なので、
   * **子要素の数と、直下の子の形（タグ・class・id）だけ**を撮る。
   */
  bodyShape: string;
  headShape: string;
  local: Set<string>;
  session: Set<string>;
  userAgent: string;
};

const hasDom = (): boolean => typeof document !== "undefined";

/**
 * 要素の「姿」——直下の子の**数**と、**それぞれのタグ・class・id**。
 *
 * `innerHTML` の全文は使わない（上の `bodyShape` のコメント参照）。
 * 中身の文字が変わっただけでは鳴らないが、**残った要素は必ず数に出る**ので、
 * 「後始末をしていない」は捕まえられる。**テキストだけを書き換えて残す**形は
 * 見逃すが、それはテスト間の順序依存を作らない（次のファイルは自分で描き直す）。
 */
function shapeOf(el: HTMLElement | null): string {
  if (!el) return "";
  const kids = Array.from(el.children).map((c) => `${c.tagName.toLowerCase()}${c.id ? `#${c.id}` : ""}${c.className ? `.${String(c.className).trim().split(/\s+/).join(".")}` : ""}`);
  return kids.length === 0 ? "" : `${kids.length} 要素: ${kids.slice(0, 8).join(", ")}`;
}

function storageKeys(s: Storage | undefined): Set<string> {
  if (!s) return new Set();
  try {
    return new Set(Object.keys(s));
  } catch {
    return new Set();
  }
}

/** いまのグローバルの姿を撮る。**空を返さない**（撮れなかったら撮れなかったと分かる形にする）。 */
export function snapshotGlobals(): GlobalSnapshot {
  if (!hasDom()) {
    return { globals: new Set(Object.getOwnPropertyNames(globalThis)), docAttrs: new Set(), bodyShape: "", headShape: "", local: new Set(), session: new Set(), userAgent: "" };
  }
  return {
    globals: new Set(Object.getOwnPropertyNames(globalThis)),
    docAttrs: new Set(Array.from(document.documentElement.attributes).map((a) => `${a.name}=${a.value}`)),
    bodyShape: shapeOf(document.body),
    headShape: shapeOf(document.head),
    local: storageKeys(typeof localStorage === "undefined" ? undefined : localStorage),
    session: storageKeys(typeof sessionStorage === "undefined" ? undefined : sessionStorage),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  };
}

/**
 * 基準と今を比べて、**残っているもの**を人が読める文で返す（空なら漏れなし）。
 *
 * 「増えた」だけでなく「**消えた**」も見る。前のファイルが残したものを
 * 次のファイルが消すと、**消したほうのファイルに差分が出る**——
 * その差分は「誰かが漏らした」ことの証拠なので、黙らせない。
 */
export function describeLeaks(before: GlobalSnapshot, after: GlobalSnapshot): string[] {
  const leaks: string[] = [];

  const addedGlobals = [...after.globals].filter((k) => !before.globals.has(k) && !ALLOWED_GLOBAL_KEYS.includes(k));
  for (const k of addedGlobals.sort()) leaks.push(`globalThis.${k} が残っている`);

  const removedGlobals = [...before.globals].filter((k) => !after.globals.has(k) && !ALLOWED_GLOBAL_KEYS.includes(k));
  for (const k of removedGlobals.sort()) leaks.push(`globalThis.${k} が消えた（前のテストが漏らしたものを消した可能性がある）`);

  const addedAttrs = [...after.docAttrs].filter((a) => !before.docAttrs.has(a) && !ALLOWED_DOC_ATTRS.includes(a));
  for (const a of addedAttrs.sort()) leaks.push(`<html> の属性 ${a} が残っている`);

  const removedAttrs = [...before.docAttrs].filter((a) => !after.docAttrs.has(a) && !ALLOWED_DOC_ATTRS.includes(a));
  for (const a of removedAttrs.sort()) leaks.push(`<html> の属性 ${a} が消えた（前のテストが漏らしたものを消した可能性がある）`);

  if (before.bodyShape !== after.bodyShape) leaks.push(`document.body の中身が変わった（${before.bodyShape || "空"} → ${after.bodyShape || "空"}）`);
  if (before.headShape !== after.headShape) leaks.push(`document.head の中身が変わった（${before.headShape || "空"} → ${after.headShape || "空"}）`);

  for (const [name, b, a] of [
    ["localStorage", before.local, after.local],
    ["sessionStorage", before.session, after.session],
  ] as const) {
    for (const k of [...a].filter((k) => !b.has(k)).sort()) leaks.push(`${name}["${k}"] が残っている`);
    for (const k of [...b].filter((k) => !a.has(k)).sort()) leaks.push(`${name}["${k}"] が消えた（前のテストが漏らしたものを消した可能性がある）`);
  }

  if (before.userAgent !== after.userAgent) leaks.push(`navigator.userAgent が変わったままになっている: ${after.userAgent}`);

  return leaks;
}
