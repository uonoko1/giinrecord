import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sleep } from "../../fetch.ts";

/**
 * 地方議会サイト向けの丁寧な取得（Issue #157）。
 * - 取得先は呼び出し側が渡す許可ホストだけ（それ以外は例外）。
 * - UA を明記し、同じホストへの取得は ≥ 1 秒空ける。
 * - robots.txt を読み、このパスが User-agent: * か gikailog-etl に対して Disallow なら取得しない（404 なら制限なし）。
 * - PDF（URL 固定）だけ .cache/ にキャッシュする。HTML は毎回取得。
 */
const UA = "gikailog-etl/0.1 (+https://github.com/uonoko1/gikailog)";
const MIN_INTERVAL_MS = 1000;
const CACHE_DIR = new URL("../../../.cache/", import.meta.url);

export interface RobotsRules {
  /** このホストで取得してはいけないパスの接頭辞（User-agent: * と gikailog-etl の Disallow の和。Allow は見ない＝保守的） */
  disallow: string[];
}

/** robots.txt の最小限の読み方。該当 User-agent ブロックの Disallow を集める。空の Disallow は無視。 */
export function parseRobots(text: string, agent = "gikailog-etl"): RobotsRules {
  const disallow: string[] = [];
  let applies = false;
  let sawAgentLine = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      // 連続する User-agent 行は同じブロック
      if (!sawAgentLine) applies = false;
      sawAgentLine = true;
      const ua = value.toLowerCase();
      if (ua === "*" || agent.toLowerCase().startsWith(ua)) applies = true;
      continue;
    }
    sawAgentLine = false;
    if (key === "disallow" && applies && value !== "") disallow.push(value);
  }
  return { disallow };
}

export function isAllowedByRobots(rules: RobotsRules, url: string): boolean {
  const path = new URL(url).pathname;
  return !rules.disallow.some((prefix) => path.startsWith(prefix.replace(/\*$/, "")));
}

export class PoliteFetcher {
  private lastFetch = 0;
  private robots: Promise<RobotsRules> | undefined;
  readonly fetched: { url: string; fetchedAt: string }[] = [];

  constructor(private readonly host: string) {}

  private check(url: string): URL {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.host !== this.host) throw new Error(`fetch refused (host not allowed): ${url}`);
    return u;
  }

  private async wait(): Promise<void> {
    const gap = Date.now() - this.lastFetch;
    if (gap < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - gap);
    this.lastFetch = Date.now();
  }

  private async loadRobots(): Promise<RobotsRules> {
    await this.wait();
    const res = await fetch(`https://${this.host}/robots.txt`, { headers: { "User-Agent": UA } });
    if (res.status === 404) return { disallow: [] };
    if (!res.ok) throw new Error(`robots.txt: HTTP ${res.status}`);
    const text = await res.text();
    // HTML が返る（404 ページを 200 で返すサイト）なら robots.txt は無いものとして扱う
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) return { disallow: [] };
    return parseRobots(text);
  }

  private async guard(url: string): Promise<void> {
    this.check(url);
    this.robots ??= this.loadRobots();
    if (!isAllowedByRobots(await this.robots, url)) throw new Error(`fetch refused by robots.txt: ${url}`);
  }

  private async get(url: string): Promise<Buffer> {
    await this.guard(url);
    await this.wait();
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    this.fetched.push({ url, fetchedAt: new Date().toISOString() });
    return Buffer.from(await res.arrayBuffer());
  }

  /** HTML（UTF-8）。毎回取得。 */
  async text(url: string): Promise<string> {
    return (await this.get(url)).toString("utf-8");
  }

  /** PDF などのバイナリ。URL が固定なので .cache/ にキャッシュする。 */
  async bytes(url: string): Promise<Buffer> {
    this.check(url);
    await mkdir(CACHE_DIR, { recursive: true });
    const file = new URL(`${createHash("sha1").update(url).digest("hex")}.bin`, CACHE_DIR);
    try { return await readFile(file); } catch { /* miss */ }
    const buf = await this.get(url);
    await writeFile(file, buf);
    return buf;
  }
}
