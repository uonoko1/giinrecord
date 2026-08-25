import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HTML_INTERVAL_MS, sleep } from "../../fetch.ts";

const UA = "gikailog-etl/0.1 (+https://github.com/uonoko1/gikailog)";
const CACHE_DIR = new URL("../../../.cache/", import.meta.url);

/**
 * バイナリ（zip・PDF）向けの丁寧な fetch（Issue #111）。`fetchText` と同じ UA・キャッシュ置き場・取得間隔（`HTML_INTERVAL_MS`。#231 で 0.5 → 1 秒）。
 * 月次データと HTML は `noCache` で毎回取得し、総務省の PDF（URL が固定）だけキャッシュする。
 */
export async function fetchBytes(url: string, opts: { noCache?: boolean } = {}): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = new URL(`${createHash("sha1").update(url).digest("hex")}.bin`, CACHE_DIR);
  if (!opts.noCache) {
    try { return await readFile(file); } catch { /* miss */ }
  }
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  await sleep(HTML_INTERVAL_MS);
  return buf;
}
