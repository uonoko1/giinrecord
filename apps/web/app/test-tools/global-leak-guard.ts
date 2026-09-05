/**
 * テストファイル間の状態漏れを、漏らした**その場**で落とす（Issue #512）。
 *
 * ## 何が起きていたか
 *
 * `PoliciesSection.test.tsx` と `SiteFooter.test.tsx` は本物の `beforeinstallprompt` を
 * `window.dispatchEvent` する。`useInstallPrompt` のリスナはそれを
 * `window.__giinrecordInstallPrompt` に**保存する**が、どちらのファイルも
 * 後始末が `vi.unstubAllGlobals()` だけで、このキーを消していなかった。
 * `contrast.test.ts` は `document.body.innerHTML` にタブの HTML を敷いたまま終わっていた。
 *
 * 実行順が変われば、後から走るファイルが**他人の残骸**を見る。実測（#512）:
 *
 *     seed=3（PoliciesSection が先） → InstallLink.test.tsx が 1 failed
 *     seed=1,2,4,5,6（InstallLink が先） → 8 passed
 *
 * **落ちるのは漏らした側ではなく、後ろに並んだ無関係なファイル**なので、
 * 失敗メッセージからは原因に辿り着けない。だからここで、
 * **漏らしたテストそのものを名指しで落とす**。
 *
 * ## なぜ「無いこと」ではなく「基準と同じであること」を見るか
 *
 * 禁止リスト（`__giinrecordInstallPrompt` が無いこと）にすると、**次に増える別のキー**を
 * 取り逃がす（#333 の denylist の教訓）。ここでは**テストが 1 つも走る前の姿を基準に採り**、
 * それとの差分をすべて挙げる。**知らない名前でも落ちる。**
 *
 * ## 基準を採る時点
 *
 * このモジュールは `setupFiles` から**トップレベルで**読まれるので、
 * ここで採る `PRISTINE` は「そのファイルの最初のテストが走る前」の姿である。
 * jsdom の環境はテストファイルごとに作り直されないことがある（`singleFork` など）ので、
 * **前のファイルが残した物も基準に混ざりうる**。混ざったらそれは別のファイルの
 * 後始末漏れであり、`vitest.setup.ts` の側で**ファイル冒頭にも**照合を置いている。
 */
import { afterEach, beforeAll, expect } from "vitest";

/** DOM の無い環境（`// @vitest-environment node`）では何も見ない */
const HAS_DOM = typeof window !== "undefined" && typeof document !== "undefined";

type Snapshot = {
  windowKeys: string[];
  navigatorKeys: string[];
  documentElementAttrs: string[];
  bodyHTML: string;
  headHTML: string;
  localStorage: string;
  sessionStorage: string;
  userAgent: string;
};

/**
 * 見張りの対象から外す `window` のキー。**テストが置いたものは 1 つも入れない。**
 *
 * `IS_REACT_ACT_ENVIRONMENT` は @testing-library/react の `act` 互換層が
 * `render` のたびに `globalThis` へ書く**ライブラリ自身のフラグ**で、
 * テストのデータではないし、後始末する API も無い（`asyncWrapper` が付け外しする）。
 * これを漏れとして数えると、**描画するテスト全部が落ちて見張りが使い物にならない**。
 *
 * **この集合そのものを `global-leak-guard.test.ts` が固定している**（#484 の学び。
 * 「通してよいもの」を広げたら落ちる）。
 */
export const IGNORED_WINDOW_KEYS: readonly string[] = ["IS_REACT_ACT_ENVIRONMENT"];

/**
 * 見張りの対象から外す `navigator` のキー。**テストが置いたものは 1 つも入れない。**
 *
 * `clipboard` は @testing-library/user-event が `userEvent.setup()` で
 * `navigator` に差し込むスタブ。ライブラリ自身が後始末を持っているが、
 * その登録は `globalThis.afterEach` / `globalThis.afterAll` が**在るときだけ**行われる
 * （`dist/esm/utils/dataTransfer/Clipboard.js` 末尾）。
 * このリポジトリは `globals: true` を使っていないので**どちらも undefined**（実測で確認）で、
 * 後始末は一度も登録されない。外す関数は `dist/` の奥にあり、パッケージの入口から
 * export されていない（実測: `dist/esm/index.js` に名前が出てこない）ので、**呼びに行かない。**
 *
 * **残るのはスタブの存在だけでなく、中身もである**: `attachClipboardStubToView` は
 * 既にスタブが付いていれば早期 return するので、`userEvent.setup()` を呼び直しても作り直されない。
 * ただし**このリポジトリはクリップボードを読み書きするコードを持たない**
 * （実測: `app/` に `navigator.clipboard` / `writeText` / `userEvent.copy` の出現 0 件）ので、
 * 中身は常に空のまま。**書くコードが入ったらこの allowlist を外して、外し方を決め直すこと。**
 *
 * **この集合そのものを `global-leak-guard.test.ts` が固定している**（#484 の学び）。
 */
export const IGNORED_NAVIGATOR_KEYS: readonly string[] = ["clipboard"];

function ownKeys(o: object): string[] {
  return [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o).map((s) => s.toString())].sort();
}

function windowKeys(): string[] {
  return ownKeys(window).filter((k) => !IGNORED_WINDOW_KEYS.includes(k));
}

function navigatorKeys(): string[] {
  return ownKeys(navigator).filter((k) => !IGNORED_NAVIGATOR_KEYS.includes(k));
}

function storageDump(s: Storage): string {
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) out[k] = s.getItem(k) ?? "";
  }
  return JSON.stringify(Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function snapshotGlobals(): Snapshot {
  return {
    windowKeys: windowKeys(),
    // `Object.defineProperty(navigator, …)` は navigator 自身に own プロパティを生やす。
    // `vi.unstubAllGlobals()` では戻らないので、ここで数える（`standalone` など）。
    navigatorKeys: navigatorKeys(),
    documentElementAttrs: Array.from(document.documentElement.attributes)
      .map((a) => `${a.name}=${a.value}`)
      .sort(),
    bodyHTML: document.body.innerHTML,
    headHTML: document.head.innerHTML,
    localStorage: storageDump(localStorage),
    sessionStorage: storageDump(sessionStorage),
    userAgent: navigator.userAgent,
  };
}

/**
 * 2 つのスナップショットの差を、人が読める行にして返す。差が無ければ空配列。
 * **「何件違う」ではなく「どれが違う」を出す**（#485 の学び）。
 */
export function describeDrift(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  const added = after.windowKeys.filter((k) => !before.windowKeys.includes(k));
  const removed = before.windowKeys.filter((k) => !after.windowKeys.includes(k));
  for (const k of added) out.push(`window に増えた: ${k}`);
  for (const k of removed) out.push(`window から消えた: ${k}`);
  for (const k of after.navigatorKeys.filter((k) => !before.navigatorKeys.includes(k))) out.push(`navigator に増えた: ${k}`);
  for (const k of before.navigatorKeys.filter((k) => !after.navigatorKeys.includes(k))) out.push(`navigator から消えた: ${k}`);
  const attrAdded = after.documentElementAttrs.filter((a) => !before.documentElementAttrs.includes(a));
  const attrRemoved = before.documentElementAttrs.filter((a) => !after.documentElementAttrs.includes(a));
  for (const a of attrAdded) out.push(`<html> に増えた属性: ${a}`);
  for (const a of attrRemoved) out.push(`<html> から消えた属性: ${a}`);
  if (before.bodyHTML !== after.bodyHTML) out.push(`document.body が残っている（${after.bodyHTML.length} 文字）: ${after.bodyHTML.slice(0, 120)}`);
  if (before.headHTML !== after.headHTML) out.push(`document.head が残っている（${after.headHTML.length} 文字）: ${after.headHTML.slice(0, 120)}`);
  if (before.localStorage !== after.localStorage) out.push(`localStorage: ${before.localStorage} → ${after.localStorage}`);
  if (before.sessionStorage !== after.sessionStorage) out.push(`sessionStorage: ${before.sessionStorage} → ${after.sessionStorage}`);
  if (before.userAgent !== after.userAgent) out.push(`navigator.userAgent: ${before.userAgent} → ${after.userAgent}`);
  return out;
}

const HINT =
  "テストが後始末していないグローバル状態があります。" +
  "そのテスト（または describe）の afterEach で元に戻してください。" +
  "残すと、実行順が変わったときに**別のファイル**が落ちます（#512）。";

/**
 * `setupFiles` から呼ぶ。基準はこの関数を呼んだ時点で採る。
 *
 * @param cleanup 各テストの後に呼ぶ後始末（RTL の `cleanup`）。
 *   **基準を採る前には呼ばない**（描画物は基準に入れない）。
 */
export function installGlobalLeakGuard(cleanup: () => void): void {
  if (!HAS_DOM) {
    afterEach(() => cleanup());
    return;
  }
  let pristine: Snapshot | null = null;
  // 基準はファイルの最初のテストが走る**前**に採る。
  // トップレベルで採ると、`setupFiles` の並びやテストファイルの import 副作用より
  // 前後してしまう（import は beforeAll より先に走る）ので、beforeAll で採る。
  beforeAll(() => {
    pristine = snapshotGlobals();
  });
  afterEach(() => {
    cleanup();
    if (pristine === null) return;
    const drift = describeDrift(pristine, snapshotGlobals());
    expect(drift, HINT).toEqual([]);
  });
}
