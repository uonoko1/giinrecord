/**
 * Browser check (Issue #194): the URL-mode smoke only looks at status codes and headers, so a CSP that
 * blocks the inline <script> tags React Router emits (hydration context, themeInit) went unnoticed and
 * production shipped with no working client-side JS. This script opens a few served pages in headless
 * Chromium and fails on anything the header checks cannot see:
 *   - any console error or uncaught page error
 *   - any `securitypolicyviolation` event (CSP)
 *   - the members search really filters (typing reduces the number of rows -> hydration happened)
 * Usage: pnpm --filter web browser-check -- --url http://127.0.0.1:8081
 * Requires a Chromium for Playwright: `pnpm --filter web exec playwright install --with-deps chromium` (CI: docker-web job).
 * PO: run the same command against https://giinrecord.jp once the VPS has picked up the new site.conf.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type ConsoleMessage, type Page } from "playwright";
import { defaultDataDir } from "../app/lib/data-files";

const urlFlag = process.argv.indexOf("--url");
const baseUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : undefined;
if (!baseUrl) {
  console.error("browser-check: --url <origin> is required, e.g. --url http://127.0.0.1:8081");
  process.exit(2);
}
const origin = baseUrl.replace(/\/$/, "");

/** one member page to open: the first id of data/members/index.json (null when no data is built) */
async function firstMemberId(): Promise<string | null> {
  try {
    const index = JSON.parse(await readFile(path.join(defaultDataDir(), "members", "index.json"), "utf8")) as { id: string }[];
    return index[0]?.id ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/** CSP_LISTENER がページ側に用意するヘルパ（#260）。waitForFunction の中からだけ呼ぶ。 */
declare function assemblySelectValue(): string | null;

interface PageResult {
  url: string;
  consoleErrors: string[];
  pageErrors: string[];
  cspViolations: string[];
}

/** Installed before any script of the page runs, so violations from the inline <script> tags are caught too. */
const CSP_LISTENER = `
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspViolations.push(e.violatedDirective + " blocked " + (e.blockedURI || "inline") + " at " + e.sourceFile + ":" + e.lineNumber);
  });
  // #260: 待ち条件から議会の select の「いま描画されている値」を読むための共通ヘルパ。
  // URL は History API で即座に変わるが、select は React の再描画を待たないと追随しない。
  window.assemblySelectValue = () => document.querySelector("select.members-select")?.value ?? null;
`;

async function visit(page: Page, url: string, run?: (page: Page) => Promise<void>): Promise<PageResult> {
  const r: PageResult = { url, consoleErrors: [], pageErrors: [], cspViolations: [] };
  const onConsole = (m: ConsoleMessage) => {
    if (m.type() === "error") r.consoleErrors.push(m.text());
  };
  const onPageError = (e: Error) => r.pageErrors.push(e.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    if (!res || res.status() !== 200) r.pageErrors.push(`status ${res?.status() ?? "none"} (expected 200)`);
    if (run) await run(page);
  } catch (err) {
    r.pageErrors.push(err instanceof Error ? err.message : String(err));
  } finally {
    // read even when goto/run threw: the violations are the diagnosis
    r.cspViolations = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []).catch(() => []);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
  return r;
}

/** The members search narrows the list only after hydration: rows before typing must be > rows after. */
async function membersSearchFilters(page: Page): Promise<void> {
  const rows = () => page.locator("li.members-item").count();
  const before = await rows();
  if (before === 0) throw new Error("members: no rows rendered (li.members-item)");
  await page.locator("input[type=search].members-input").fill("ふじかわ");
  await page
    .waitForFunction((n) => document.querySelectorAll("li.members-item").length < n, before, { timeout: 5_000 })
    .catch(() => undefined);
  const after = await rows();
  if (!(after < before)) throw new Error(`members search did not filter: ${before} rows before typing, ${after} after (hydration blocked?)`);
  console.log(`browser-check: members search ${before} -> ${after} rows`);
}

/**
 * #239: 議会で絞り込むと URL に ?assembly= が入り、その URL をリロードすると同じ状態に戻る。
 * 見出し・<title>・description はそのときの絞り込みを指し、プリレンダーのクエリ無しの meta が
 * 残って二重にならない（title は 1 つ、description は 1 つ）。
 */
async function membersFilterGoesToUrl(page: Page): Promise<void> {
  const assembly = page.locator("select.members-select").first();
  const options = await assembly.locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  const pick = options.find((v) => v !== "");
  if (!pick) throw new Error("members: 議会の select に「すべて」以外の選択肢が無い");

  await assembly.selectOption(pick);
  // #260: URL だけを待って DOM を読むと、History API の更新と React の再描画の競合で稀に落ちる。
  // 待つべきは「URL と、それに追随した DOM の両方」なので、select が期待値になるところまで待つ。
  await page.waitForFunction((v) => new URL(location.href).searchParams.get("assembly") === v && assemblySelectValue() === v, pick, { timeout: 10_000 });

  const heading = (await page.locator("h1").textContent())?.trim() ?? "";
  const label = (await assembly.locator(`option[value="${pick}"]`).textContent())?.trim() ?? "";
  if (heading !== `${label}の現職議員`) throw new Error(`members: 見出しが絞り込みと合わない: 議会=${label} なのに h1="${heading}"`);

  // リロード（＝ブックマークからの直接アクセスと同じ）で復元されること
  const url = page.url();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("li.members-item").length > 0, null, { timeout: 10_000 });
  // #260: 見出しだけでなく select も期待値になるまで待つ（読むのは select なので、待つ対象も select）
  await page.waitForFunction(
    ([h, v]) => document.querySelector("h1")?.textContent?.trim() === h && assemblySelectValue() === v,
    [heading, pick] as const,
    { timeout: 10_000 },
  );
  const restored = await page.locator("select.members-select").first().inputValue();
  if (restored !== pick) throw new Error(`members: リロードで絞り込みが復元されない: ${url} なのに議会の select は "${restored}"`);

  const head = await page.evaluate(() => ({
    titles: [...document.querySelectorAll("title")].map((t) => t.textContent?.trim() ?? ""),
    descs: [...document.querySelectorAll('meta[name="description"]')].map((m) => m.getAttribute("content") ?? ""),
  }));
  if (head.titles.length !== 1) throw new Error(`members: <title> が ${head.titles.length} 個ある: ${head.titles.join(" / ")}`);
  if (head.descs.length !== 1) throw new Error(`members: description が ${head.descs.length} 個ある: ${head.descs.join(" / ")}`);
  if (!head.titles[0].startsWith(heading)) throw new Error(`members: <title>「${head.titles[0]}」が見出し「${heading}」と合わない`);
  if (!head.descs[0].startsWith(`${label}の現職議員`)) throw new Error(`members: description「${head.descs[0]}」が絞り込み（${label}）と合わない`);

  console.log(`browser-check: members filter -> ${new URL(url).search} restored on reload (h1="${heading}")`);

  // 戻るで絞り込み前に戻ること
  await page.goBack();
  // #260: ここが元のフレークの発生源。goBack() は URL を先に変え、select は次の再描画で「すべて」に戻る。
  // URL だけを待って select を読むとその隙間に入り込むので、select が空になるところまで待つ。
  await page.waitForFunction(() => new URL(location.href).searchParams.get("assembly") === null && assemblySelectValue() === "", null, { timeout: 10_000 });
  const back = await page.locator("select.members-select").first().inputValue();
  if (back !== "") throw new Error(`members: 戻るで絞り込みが解けない: 議会の select は "${back}"`);
  console.log("browser-check: members filter -> back button clears the filter");
}

/**
 * #239: 名簿に無い会派名・選挙区名をクエリで渡しても、見出し・<title>・OGP には出さない。
 * 出してしまうと「存在しない会派の議員」という見出しの下に「該当する議員はいません」が並び、
 * その URL を共有すると議員レコードのブランドで架空の会派名の OGP カードが出る。
 */
async function membersRejectsUnknownFilters(page: Page): Promise<void> {
  const fake = "存在しない会派X9Z";
  await page.goto(`${origin}/members/?group=${encodeURIComponent(fake)}&district=${encodeURIComponent(fake)}`);
  // #260: 行が出ただけでは足りない。検査するのは会派の select と見出しなので、ハイドレーションが
  // クエリを select に反映し終える（＝無効な会派名を捨てたと分かる）ところまで待ってから読む。
  await page.waitForFunction(
    () => document.querySelectorAll("li.members-item").length > 0 && document.querySelectorAll("select.members-select").length >= 2,
    null,
    { timeout: 10_000 },
  );

  const seen = await page.evaluate(() => ({
    h1: document.querySelector("h1")?.textContent?.trim() ?? "",
    title: document.title,
    metas: [...document.querySelectorAll("meta")].map((m) => m.getAttribute("content") ?? ""),
    group: (document.querySelectorAll("select.members-select")[1] as HTMLSelectElement | undefined)?.value ?? "",
  }));
  for (const [where, text] of [["h1", seen.h1] as const, ["title", seen.title] as const, ["meta", seen.metas.join(" ")] as const]) {
    if (text.includes(fake)) throw new Error(`members: 名簿に無い会派名が ${where} に出た: "${text}"`);
  }
  if (seen.group !== "") throw new Error(`members: 名簿に無い会派名が select に入った: "${seen.group}"`);
  console.log(`browser-check: members unknown ?group/?district ignored (h1="${seen.h1}")`);
}

/**
 * 議員ページのタブ（#238）: カテゴリ分けしたタブがハイドレーション後に実際に切り替わり、
 * スマホ幅でページ本体が横スクロールしないことを実機で確かめる。
 * 件数 0 のタブも押せる（「無い」ことが情報なので隠さない）ことをここで確認する。
 */
async function memberTabsSwitch(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 800 });
  const tabs = page.locator('[role="tab"]');
  await tabs.first().waitFor({ timeout: 10_000 });
  const count = await tabs.count();
  if (count < 2) throw new Error(`member tabs: タブが ${count} 個しかない`);

  // 全タブに件数が出ている（ヘッダの数値と整合することは vitest 側で検査する）
  for (let i = 0; i < count; i++) {
    const text = (await tabs.nth(i).innerText()).replace(/\s+/g, " ");
    if (!/\d件$/.test(text)) throw new Error(`member tabs: 件数の無いタブがある: "${text}"`);
  }

  // ハイドレーション後にタブが切り替わる: 選択中のタブが変わり、tabpanel の aria-labelledby も追随する
  const before = await page.locator('[role="tab"][aria-selected="true"]').innerText();
  await tabs.nth(1).click();
  // #260: 選択中のタブが変わっただけでなく、この後で読む tabpanel の aria-labelledby が
  // その新しいタブを指すところまで待つ（読む対象を待つ）。
  await page.waitForFunction(
    (prev) => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      if (!tab || tab.textContent?.replace(/\s+/g, " ") === prev) return false;
      return document.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby") === tab.id;
    },
    before.replace(/\s+/g, " "),
    { timeout: 10_000 },
  );
  const selected = await page.locator('[role="tab"][aria-selected="true"]');
  const selectedId = await selected.getAttribute("id");
  const labelledBy = await page.locator('[role="tabpanel"]').getAttribute("aria-labelledby");
  if (selectedId !== labelledBy) throw new Error(`member tabs: tabpanel の aria-labelledby=${labelledBy} が選択中のタブ ${selectedId} と合わない`);

  // スマホ幅でページ本体が横スクロールしない（タブ列の中だけがスクロールする）
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    strips: [...document.querySelectorAll(".member-tabs")].map((e) => [e.scrollWidth, e.clientWidth] as const),
  }));
  if (overflow.doc > 0) throw new Error(`member tabs: 375px でページが横に ${overflow.doc}px はみ出す`);
  console.log(`browser-check: member tabs ${count} tabs, switched to ${selectedId}, no page overflow at 375px (strips ${JSON.stringify(overflow.strips)})`);
}

const memberId = await firstMemberId();
const targets: { url: string; run?: (page: Page) => Promise<void> }[] = [
  { url: `${origin}/` },
  { url: `${origin}/members/`, run: membersSearchFilters },
  { url: `${origin}/members/`, run: membersFilterGoesToUrl },
  { url: `${origin}/members/`, run: membersRejectsUnknownFilters },
  { url: `${origin}/rollcalls/` },
  // #251: /coverage は loader を持つようになった（議案の氏名の数え上げ）。ハイドレーション時に .data を引くので、
  // その取得が壊れていないことをここで見る（loader 無しのページでは起きない失敗）
  { url: `${origin}/coverage/` },
  ...(memberId ? [{ url: `${origin}/members/${memberId}/` }, { url: `${origin}/members/${memberId}/`, run: memberTabsSwitch }] : []),
];

const browser = await chromium.launch();
const failures: string[] = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(CSP_LISTENER);
  const page = await context.newPage();
  for (const t of targets) {
    const r = await visit(page, t.url, t.run);
    for (const e of r.cspViolations) failures.push(`${r.url}: CSP violation: ${e}`);
    for (const e of r.consoleErrors) failures.push(`${r.url}: console error: ${e}`);
    for (const e of r.pageErrors) failures.push(`${r.url}: ${e}`);
    console.log(`browser-check: ${r.url} csp=${r.cspViolations.length} console=${r.consoleErrors.length} errors=${r.pageErrors.length}`);
  }
} finally {
  await browser.close();
}
if (failures.length > 0) {
  console.error(`browser-check: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`browser-check: ok (${targets.length} pages)`);
