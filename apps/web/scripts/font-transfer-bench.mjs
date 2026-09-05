/**
 * フォント転送量の実測（#477）。**手で実行する。CI では走らない。**
 *
 *   pnpm --filter web build                       # 測る対象のビルドを作る
 *   node scripts/font-transfer-bench.mjs <buildDir> <ラベル> > out.json
 *
 * ビルド 2 本（差し替え前・後）をそれぞれ測って突き合わせる。
 * **`docs/ops/fonts.md` の実測表は、このスクリプトで出した数字である。**
 *
 * ## 測り方の約束（`docs/WORKING_AGREEMENT.md`）
 *
 * - 390px・**ページごとに新しいコンテキスト**（＝初回訪問）
 * - woff2 は `response` ハンドラで **`await r.body()` してから**記録する
 *   （woff2 は nginx でも gzip されないので body 長 = 転送量）
 * - **測る前に `CSS.getPlatformFontsForNode` のフォールバックが 0 になるまで待つ。**
 *   `networkidle` + `document.fonts.ready` だけでは足りず、3 回に 1 回
 *   `/members` が **1,950 KB ではなく 268 KB**（フォールバック 231 件）になった。
 *   **転送量だけ見れば「−86%」という嘘の成果**になる
 * - **3 回一致するまでやり直す。食い違ったら多数決ではなく捨ててやり直す。試行回数も出す**
 * - **`<summary>` の開閉マーカー ▶ は必ずシステム書体**（ブラウザ UI のグリフ）。
 *   数えると収束が**永久に来ない**ので除外するが、**`marker=N` として必ず出す**（黙って 0 にしない）
 *
 * ## 二重起動を拒否する
 *
 * **並行実行は測定を壊す**（CPU の取り合い＋出力の混ざり）。#477 では 3 回壊し、
 * 3 回目は**古いモニタが自動で二重起動**して 2 プロセスが同じ出力に書いた。
 * **「気をつける」では止まらなかった**ので、ビルドごとに lock を置いて **exit 3 で拒否**する。
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const buildDir = process.argv[2];
/**
 * **同じ測定を 2 つ同時に走らせない。**（2026-09-06 に実際に起こした）
 * 古いモニタが残っていて **baseline を二重起動**し、2 プロセスが**同じ出力ファイルに書いた**。
 * 並行実行は測定そのものを壊す（CPU の取り合い）うえ、出力が混ざって
 * **「3 回一致」が嘘になる**。**気をつけるのではなく、起動できない形にする。**
 */
{
  const { existsSync, writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
  const lock = `${buildDir.replace(/\/+$/, "")}.measure.lock`;
  if (existsSync(lock)) {
    // **空の lock を「生きている」と読まないこと。**（#520 のレビュー中に実際に踏んだ）
    //
    // 前回が **PID を書く前に殺される**と、0 バイトの lock が残る。`Number("") === 0` になり、
    // **POSIX の `kill(2)` は pid が 0 のとき「呼び出し元と同じプロセスグループ全体」宛て**なので、
    // `process.kill(0, 0)` は**必ず成功する**（存在確認の 0 シグナルでも同じ）。
    // つまり「pid 0 は生きている」と読めてしまい、**以後この lock は永久に自分を締め出す**。
    // `Number.parseInt` で数値になることと **pid > 0** を確かめてから存在確認する。
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
    if (alive) { console.error(`measure: すでに pid ${pid} が同じビルドを測っている。二重起動を拒否する（${lock}）`); process.exit(3); }
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid));
  const clean = () => { try { unlinkSync(lock); } catch {} };
  process.on("exit", clean); process.on("SIGINT", () => { clean(); process.exit(130); }); process.on("SIGTERM", () => { clean(); process.exit(143); });
}
const PROGRESS = process.env.PROGRESS_LOG ?? "/dev/stderr";
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".xml": "application/xml", ".zip": "application/zip", ".txt": "text/plain", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(buildDir, p);
  try { if ((await stat(file)).isDirectory()) file = path.join(file, "index.html"); }
  catch { try { await stat(`${file}.html`); file = `${file}.html`; } catch { res.writeHead(404).end("nf"); return; } }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "content-length": buf.length });
    res.end(buf);
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

/** `/sources` と `/compare` は実在しない（routes.ts に無い／prerender されない）ので測れない。#477 で PO 承認済み */
const PAGES = ["/", "/about", "/coverage", "/assemblies", "/members", "/rollcalls", "/terms", "/privacy", "/members/m_014002", "/members/m_003005",
  // `/rollcalls/:session?` は**一覧**ルート。`/rollcalls/217` も一覧である（#520 のレビュー指摘）。
  // **採決詳細 `/rollcalls/:session/:id` は別のページ種別**で、`.rollcall-group-name` などで明朝700 を 69 字使う
  "/rollcalls/217", "/rollcalls/221/221-0323-v001",
  "/assemblies/pref-04"];
const SEL = ".members-item__name, .assembly-member__name, .tag, .section__title, .zip__title, .members-row-heading, .members-count, .member-position, .member-stamp, .member-est-label, .rollcall-group-name, .rollcall-tally, .member-date, .member-tabcat, .member-session-head, .member-count dd, .coverage-assembly__name, .assemblies-legend dt, .assemblies-table caption, .cover__brand, .member-name, .rollcall-title, .cover__title, .figure__num";

const browser = await chromium.launch();

async function measure(url, expand) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const fonts = [];
  page.on("response", (r) => { const u = r.url(); if (u.endsWith(".woff2")) fonts.push(r.body().then((b) => ({ name: u.split("/").pop(), bytes: b.length })).catch(() => null)); });
  const resp = await page.goto(origin + url, { waitUntil: "networkidle" });
  const status = resp?.status();
  if (expand) {
    const btn = page.locator("button", { hasText: /さらに表示/ }).first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(1500); }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle").catch(() => {});
  // 議員ページの `.member-name`（明朝800）は描画が落ち着くまで 4 秒近くかかる（実測）。
  // 短いと fbGlyph=5 のまま「未収束」になり、**正しい回まで捨ててしまう**。
  await page.waitForTimeout(4000);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  let { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: SEL });

  // 測る前に、測るのと同じ道具でフォールバックが 0 になるまで待つ（#477 の教訓）
  /**
   * **`<summary>`（`.member-session-head`）の開閉マーカー ▶ は、必ずシステム書体で描かれる。**
   * ブラウザ UI のグリフで、web フォントからは来ない。**ベースラインでも 1 グリフずつ同じに出る**
   * （実測 2026-09-05、両ビルドでバイト単位に同一の出力）。
   * これを数えると「収束」が**永久に来ない**ので、正しい回まで捨て続ける（実測: 12 回 × 56 秒の空回り）。
   * **除外するのは「サブセットのせいではないと両ビルドで確かめた」ものだけ。**
   * 除外した件数は `markerGlyphs` に残す（黙って 0 にしない）。
   */
  const isMarker = async (nodeId) => {
    try { return (await cdp.send("DOM.describeNode", { nodeId })).node.localName === "summary"; } catch { return false; }
  };
  let markerGlyphs = 0;
  const countFb = async () => {
    let n = 0; markerGlyphs = 0;
    for (const nodeId of nodeIds) {
      let r; try { r = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }); } catch { continue; }
      let bad = 0;
      for (const f of r.fonts ?? []) if (!f.isCustomFont && f.glyphCount > 0) bad += f.glyphCount;
      if (bad === 0) continue;
      if (await isMarker(nodeId)) markerGlyphs += bad; else n += bad;
    }
    return n;
  };
  let settled = nodeIds.length === 0;
  for (let i = 0; i < 25 && !settled; i++) {
    if ((await countFb()) === 0) settled = true;
    else { await page.waitForTimeout(1500); ({ nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: SEL })); }
  }

  const faces = new Map(); const fallbacks = []; let markers = 0;
  for (const nodeId of nodeIds) {
    let r; try { r = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }); } catch { continue; }
    const marker = await isMarker(nodeId);
    for (const f of r.fonts ?? []) {
      faces.set(`${f.familyName}${f.isCustomFont ? "(custom)" : "(SYSTEM)"}`, (faces.get(`${f.familyName}${f.isCustomFont ? "(custom)" : "(SYSTEM)"}`) ?? 0) + f.glyphCount);
      if (!f.isCustomFont && f.glyphCount > 0) { if (marker) markers += f.glyphCount; else fallbacks.push({ face: f.familyName, glyphs: f.glyphCount }); }
    }
  }
  const w = (await Promise.all(fonts)).filter(Boolean);
  const sum = (pre) => +(w.filter((f) => f.name.startsWith(pre)).reduce((a, b) => a + b.bytes, 0) / 1024).toFixed(1);
  await ctx.close();
  return { url, status, settled, woff2Count: w.length, woff2KB: +(w.reduce((a, b) => a + b.bytes, 0) / 1024).toFixed(1),
    m700Count: w.filter((f) => f.name.startsWith("shippori-mincho-700")).length, m700KB: sum("shippori-mincho-700"),
    m800Count: w.filter((f) => f.name.startsWith("shippori-mincho-800")).length, m800KB: sum("shippori-mincho-800"),
    bizKB: sum("biz-udpgothic"), nodes: nodeIds.length, markerGlyphs: markers, faces: Object.fromEntries(faces), fallbackGlyphs: fallbacks.reduce((a, b) => a + b.glyphs, 0) };
}

async function measure3(url, expand) {
  let good = []; let attempts = 0;
  for (; attempts < 12 && good.length < 3; attempts++) {
    const t = Date.now(); const r = await measure(url, expand);
    const why = !r.settled ? "未収束(捨てる)" : good.length && good[0].woff2KB !== r.woff2KB ? `食い違い ${good[0].woff2KB}!=${r.woff2KB}(やり直し)` : "採用";
    appendFileSync(PROGRESS, `  ${url}${expand ? "(展開)" : ""} 試行${attempts + 1}: ${r.woff2KB}KB ${r.woff2Count}件 m700=${r.m700KB}KB m800=${r.m800KB}KB fbGlyph=${r.fallbackGlyphs} marker=${r.markerGlyphs} ${why} ${((Date.now() - t) / 1000).toFixed(0)}s\n`);
    if (!r.settled) continue;
    if (good.length && good[0].woff2KB !== r.woff2KB) good = [];
    good.push(r);
  }
  if (good.length !== 3) { const r = await measure(url, expand); r.agreed = false; r.attempts = attempts; return [r]; }
  for (const r of good) { r.attempts = attempts; r.agreed = true; }
  return good;
}

const out = {};
for (const p of PAGES) out[p] = await measure3(p, false);
out["/members(expanded)"] = await measure3("/members", true);
console.log(JSON.stringify({ label: process.argv[3], out }, null, 1));
await browser.close(); server.close();
