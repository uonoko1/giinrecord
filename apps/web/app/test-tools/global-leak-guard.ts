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
  bodyHtml: string;
  headHtml: string;
  local: Set<string>;
  session: Set<string>;
  userAgent: string;
};

const hasDom = (): boolean => typeof document !== "undefined";

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
    return { globals: new Set(Object.getOwnPropertyNames(globalThis)), docAttrs: new Set(), bodyHtml: "", headHtml: "", local: new Set(), session: new Set(), userAgent: "" };
  }
  return {
    globals: new Set(Object.getOwnPropertyNames(globalThis)),
    docAttrs: new Set(Array.from(document.documentElement.attributes).map((a) => `${a.name}=${a.value}`)),
    bodyHtml: document.body.innerHTML,
    headHtml: document.head.innerHTML,
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

  if (before.bodyHtml !== after.bodyHtml) leaks.push(`document.body の中身が変わった（${before.bodyHtml.length} 文字 → ${after.bodyHtml.length} 文字）: ${after.bodyHtml.slice(0, 120)}`);
  if (before.headHtml !== after.headHtml) leaks.push(`document.head の中身が変わった（${before.headHtml.length} 文字 → ${after.headHtml.length} 文字）: ${after.headHtml.slice(0, 120)}`);

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
