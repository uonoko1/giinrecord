import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import iconv from "iconv-lite";

const UA = "gikailog-etl/0.1 (+https://github.com/uonoko1/gikailog)";
const CACHE_DIR = new URL("../.cache/", import.meta.url);

/** Polite fetch with on-disk cache. Government sites are slow; never hammer them. */
export async function fetchText(url: string, encoding: "utf-8" | "shift_jis" = "utf-8", opts: { noCache?: boolean } = {}): Promise<string> {
  const text = await fetchTextOr404(url, encoding, opts);
  if (text === undefined) throw new Error(`HTTP 404 ${url}`);
  return text;
}

/**
 * fetchText と同じだが、404 だけは例外にせず undefined を返す（#103）。
 * 参院の回次ごとの議員名簿 giin/{N}/giin.htm は第216回以降しか公開されておらず（第215回以前は 404）、
 * 古い回次を処理するときに「名簿が無い」のは正常。他のステータス（5xx・timeout）は障害なので例外のまま。
 * 404 はキャッシュしない（公開されたら次回から取れる）。
 */
export async function fetchTextOr404(url: string, encoding: "utf-8" | "shift_jis" = "utf-8", opts: { noCache?: boolean } = {}): Promise<string | undefined> {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex");
  const file = new URL(`${key}.html`, CACHE_DIR);
  if (!opts.noCache) {
    try { return await readFile(file, "utf-8"); } catch { /* miss */ }
  }
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 404) {
    await sleep(500);
    return undefined;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = encoding === "shift_jis" ? iconv.decode(buf, "Shift_JIS") : buf.toString("utf-8");
  await writeFile(file, text, "utf-8");
  await sleep(500);
  return text;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
