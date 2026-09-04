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
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";
import { defaultDataDir, readMemberDetail, readRollCallIndex } from "../app/lib/data-files";
import { checkNoJs, type NoJsExpectation, type NoJsSnapshot } from "../app/lib/nojs";

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

async function visit(page: Page, url: string, run?: (page: Page) => Promise<void>, expectStatus = 200): Promise<PageResult> {
  const r: PageResult = { url, consoleErrors: [], pageErrors: [], cspViolations: [] };
  // #325: 404 を期待して開くページでは、ブラウザ自身が文書の 404 を
  // "Failed to load resource: … 404 (Not Found)" として console error に流す。それは期待どおりの応答であって
  // ページの不具合ではないので、その 1 行だけ除く（他の 404 — 壊れたアセット等 — は今までどおり失敗にする）。
  const ownStatusNoise = expectStatus !== 200 ? new RegExp(`status of ${expectStatus}\\b`) : null;
  const onConsole = (m: ConsoleMessage) => {
    if (m.type() === "error" && !(ownStatusNoise?.test(m.text()) && m.location().url === url)) r.consoleErrors.push(m.text());
    // #325: React Router の既定フォールバックは console.log（error ではない）で
    // `💿 Hey developer 👋 …` を本番の利用者のコンソールに出していた。error だけ見ていると気づけない。
    if (m.text().includes("Hey developer")) r.pageErrors.push(`React Router の既定フォールバックのメッセージがコンソールに出た: ${m.text()}`);
  };
  const onPageError = (e: Error) => r.pageErrors.push(e.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    if (!res || res.status() !== expectStatus) r.pageErrors.push(`status ${res?.status() ?? "none"} (expected ${expectStatus})`);
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

  // テーマ切替（Issue 365）。docs/ops/deploy.md は CSP 障害の症状として「テーマ切替が動かない」を
  // 挙げているが、**押して確かめる検査が無かった**（切替 UI 自体が長らく描画されていなかった）。
  // 押して data-theme が付き、リロードしても保たれるところまで見る。
  await page.locator("footer .site-footer__theme input[value=dark]").click();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", null, { timeout: 5_000 });
  await page.reload();
  // themeInit（root.tsx の inline script）がハイドレーション前に付け直す。CSP に遮断されるとここで落ちる
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", null, { timeout: 5_000 });
  const paper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
  if (!paper) throw new Error("theme: --paper が読めない（tokens.css が当たっていない）");
  await page.locator("footer .site-footer__theme input[value=system]").click();
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-theme"), null, { timeout: 5_000 });
  console.log(`browser-check: theme toggle -> dark (--paper=${paper}) survives reload, system clears it`);

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

/**
 * #325: 存在しない URL。nginx が 404 で SPA shell を返し、catch-all ルートが「見つかりません」を描く。
 * ステータスが 404 であることは smoke / deploy/test/nginx-404.test.sh が見るが、
 * **その 404 の本文でクライアント JS が動き、画面が出るか**はブラウザでしか分からない
 * （404 の本文だとアセットの相対解決や CSP が違う、という壊れ方がありうる）。
 * 開発者向けの `💿 Hey developer` が出ないことも、ここが唯一の実測点。
 */
async function notFoundScreenRenders(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("見つかりません") ?? false, null, { timeout: 10_000 });
  const seen = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "",
    hrefs: [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? ""),
  }));
  if (seen.lang !== "ja") throw new Error(`404: <html lang="${seen.lang}">（ja であること）`);
  if (!seen.title.includes("見つかりません")) throw new Error(`404: <title>「${seen.title}」が 404 を指していない`);
  if (!seen.robots.includes("noindex")) throw new Error(`404: robots="${seen.robots}"（noindex であること）`);
  if (!seen.hrefs.includes("/coverage")) throw new Error(`404: /coverage への導線が無い: ${seen.hrefs.join(" ")}`);
  console.log(`browser-check: 404 screen rendered (lang=${seen.lang}, title="${seen.title}", robots=${seen.robots})`);
}

/**
 * #479: **JS を切っても記録が読めること。**
 *
 * このサイトは `ssr: false` + `prerender`（react-router.config.ts）で、**本番にサーバは無い**。
 * 利用者に届くのは**ビルド時に書き出した HTML 1 枚**なので、そこに中身が入っていなければ
 * JS を切った利用者にも、検索エンジンのクローラにも、アーカイブにも**何も残らない**。
 * `prerender` の設定を1つ間違えると（`prerenderPaths` が空を返す、`ssr` を変える）
 * その HTML は**静かに空の SPA shell になる**——ビルドは通り、`smoke` も通る
 * （`smoke` が見るのは **HTML ファイルが在ること**で、**中身が在ること**ではない）。
 *
 * 上の検査はすべて **JS 有効**なので、shell が返っていてもハイドレーションが中身を描いて緑になる。
 * **JS を切って初めて、プリレンダーが書いたものだけが見える。**
 *
 * 見るのは代表的な 4 ページだけ（CI を重くしない）。**文字数は見ない**——
 * 期待値は `data/` から取り、**そのページの記録がそのとおり出ているか**を見る（app/lib/nojs.ts）。
 */
async function noJsExpectations(dataDir: string, id: string | null): Promise<NoJsExpectation[]> {
  const rollcalls = await readRollCallIndex(dataDir);
  const rc = rollcalls[0] ?? null;
  const detail = id ? await readMemberDetail(dataDir, id) : null;
  const out: NoJsExpectation[] = [];

  // 一覧: 先頭の採決の議案名と日付が出ていて、その詳細ページへ**リンクで辿れる**
  // （JS 無効では「もっと見る」は押せないので、折り返し前に出ているものだけを期待する）
  if (rc) {
    out.push({
      path: "/rollcalls/",
      label: "採決一覧",
      texts: [rc.title],
      times: [rc.date],
      links: [`/rollcalls/${rc.session}/${rc.id}`],
      source: false, // 一覧の出典は各詳細ページ側にある
    });
    // 詳細: 議案名・日付・**一次資料への出典リンク**（全行に一次資料リンク、が原則）
    out.push({
      path: `/rollcalls/${rc.session}/${rc.id}/`,
      label: "採決ページ",
      // 議案名と、**その採決の票数**（`totals`。ページは index.json の `result` の文言ではなく
      // 賛否の数を描く）。数が出ていれば、そのページに焼かれたのが**この採決の記録**だと分かる
      texts: [rc.title, `賛成 ${rc.totals.yes}`, `反対 ${rc.totals.no}`],
      times: [rc.date],
      source: true,
    });
  }

  // 議員一覧: 先頭の議員の氏名が出ていて、その議員ページへリンクで辿れる
  if (detail) {
    out.push({ path: "/members/", label: "議員一覧", texts: [detail.name], links: [`/members/${detail.id}`], source: false });
    // 議員ページ（動的ルート）: **一覧だけ通って詳細が空**という壊れ方をここで捕まえる。
    // 氏名・かな・所属議会の出典リンクまで見るので、別人の HTML が焼かれていても落ちる。
    out.push({ path: `/members/${detail.id}/`, label: "議員ページ", texts: [detail.name, detail.kana], source: true });
  }
  return out;
}

/** JS 無効で開いて、描画されている本文・リンク・日付だけを読む。 */
async function noJsSnapshot(browser: Browser, url: string): Promise<NoJsSnapshot> {
  // JS 無効の context。ここが検査の要点なので、他の検査と context を共有しない
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    // #479: JS 無効では networkidle が来ないことがある。待つのは DOM が出来たところまで
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await page.evaluate(() => ({
      url: location.href,
      // innerText: **描画されている**文字だけ（display:none の中身を数えない）
      text: document.body?.innerText ?? "",
      hrefs: [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href),
      times: [...document.querySelectorAll("time[datetime]")].map((t) => t.getAttribute("datetime") ?? ""),
    }));
  } finally {
    await context.close();
  }
}

const memberId = await firstMemberId();
const targets: { url: string; run?: (page: Page) => Promise<void>; status?: number }[] = [
  { url: `${origin}/` },
  { url: `${origin}/members/`, run: membersSearchFilters },
  { url: `${origin}/members/`, run: membersFilterGoesToUrl },
  { url: `${origin}/members/`, run: membersRejectsUnknownFilters },
  { url: `${origin}/rollcalls/` },
  // #251: /coverage は loader を持つようになった（議案の氏名の数え上げ）。ハイドレーション時に .data を引くので、
  // その取得が壊れていないことをここで見る（loader 無しのページでは起きない失敗）
  { url: `${origin}/coverage/` },
  ...(memberId ? [{ url: `${origin}/members/${memberId}/` }, { url: `${origin}/members/${memberId}/`, run: memberTabsSwitch }] : []),
  // #325: 存在しない URL は 404 を返し、その本文で catch-all ルートが描かれる
  { url: `${origin}/__browser-check-no-such-page__/`, run: notFoundScreenRenders, status: 404 },
  // #104: プリレンダーしない実在ルート。#325 の =404 で壊しやすいので、200 で JS が動くことを実機で見る
  ...(memberId ? [{ url: `${origin}/compare?m=${memberId}` }] : []),
];

const browser = await chromium.launch();
const failures: string[] = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(CSP_LISTENER);
  const page = await context.newPage();
  for (const t of targets) {
    const r = await visit(page, t.url, t.run, t.status ?? 200);
    for (const e of r.cspViolations) failures.push(`${r.url}: CSP violation: ${e}`);
    for (const e of r.consoleErrors) failures.push(`${r.url}: console error: ${e}`);
    for (const e of r.pageErrors) failures.push(`${r.url}: ${e}`);
    console.log(`browser-check: ${r.url} csp=${r.cspViolations.length} console=${r.consoleErrors.length} errors=${r.pageErrors.length}`);
  }

  // #479: JS 無効。同じ browser を使い回すので起動は 1 回のまま（ページを 4 枚開くだけ）
  const expectations = await noJsExpectations(defaultDataDir(), memberId);
  if (expectations.length === 0) {
    // data/ が読めないと期待値が作れない。「検査するものが無いから緑」を作らない
    failures.push("no-js: data/ から期待値が 1 つも作れなかった（JS 無効の検査が何も見ていない）");
  } else {
    const got = new Map<string, NoJsSnapshot>();
    for (const e of expectations) {
      try {
        got.set(e.path, await noJsSnapshot(browser, `${origin}${e.path}`));
      } catch (err) {
        failures.push(`no-js: ${e.path} を開けなかった: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const report = checkNoJs(got, expectations, origin);
    for (const f of report.failures) failures.push(`no-js: ${f}`);
    for (const e of expectations) {
      const snap = got.get(e.path);
      if (snap) console.log(`browser-check: no-js ${e.path} (${e.label}) text=${snap.text.length}chars links=${snap.hrefs.length} time=${snap.times.length}`);
    }
    console.log(`browser-check: no-js ${report.checked} page(s) checked, ${report.failures.length} failure(s)`);
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
