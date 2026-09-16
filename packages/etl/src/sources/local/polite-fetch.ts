import { mkdir, readFile, writeFile } from "node:fs/promises";
import iconv from "iconv-lite";
import { createHash } from "node:crypto";
import { POLITENESS_FLOOR_MS, sleep } from "../../fetch.ts";

/**
 * 地方議会サイト向けの丁寧な取得（Issue #157）。
 * - 取得先は呼び出し側が渡す許可ホストだけ（それ以外は例外）。
 * - UA を明記し、同じホストへの取得は ≥ 1 秒空ける。
 * - robots.txt を読み、このパスが User-agent: * か giinrecord-etl に対して Disallow なら取得しない（404 なら制限なし）。
 * - PDF（URL 固定）だけ .cache/ にキャッシュする。HTML は毎回取得。
 */
const UA = "giinrecord-etl/0.1 (+https://github.com/uonoko1/giinrecord)";
/** 値と根拠は `fetch.ts`。#231 で国会側も同じ下限に揃えた。 */
const MIN_INTERVAL_MS = POLITENESS_FLOOR_MS;
const CACHE_DIR = new URL("../../../.cache/", import.meta.url);

export interface RobotsRules {
  /** このホストで取得してはいけないパスの接頭辞（User-agent: * と giinrecord-etl の Disallow の和。Allow は見ない＝保守的） */
  disallow: string[];
}

/** robots.txt の最小限の読み方。該当 User-agent ブロックの Disallow を集める。空の Disallow は無視。 */
export function parseRobots(text: string, agent = "giinrecord-etl"): RobotsRules {
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

/**
 * `Disallow` の値を照合用の正規表現にする（RFC 9309 §2.2.2 の `*` と `$`。#894）。
 *
 * **直す前は `prefix.replace(/\*$/, "")` で末尾の `*` しか剥がしておらず、途中の `*` を
 * ただの文字として扱っていた。** そのため `/koujisoutatu*.pdf`（鳥取に実在する）のとき
 * `/koujisoutatu2024.pdf` を **許可** と判定していた——
 * **「取ってはいけない」と書かれた URL を「取ってよい」と言う、危険側の誤りだった。**
 *
 * - `*` は 0 文字以上の任意の並び。
 * - **末尾の `$` だけ**が行末への固定（途中の `$` はただの文字。RFC 9309 の書き方に合わせた）。
 * - **それ以外の文字はすべてリテラル**。`.` や `(` を正規表現のメタ文字として扱うと、
 *   当たらないはずの URL まで拒否になる（**厳しすぎる側にも外さない**）。
 */
function disallowPattern(rule: string): RegExp {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  // `*` で切って、間をリテラルとしてエスケープし、`*` を `[\s\S]*` に戻す
  const source = body.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

/** 規則ごとの正規表現は同じ文字列で何度も引くので覚えておく（robots.txt は 1 ホストで 1 回読むが、URL ごとに全規則を当てる）。 */
const patternCache = new Map<string, RegExp>();

function patternFor(rule: string): RegExp {
  let re = patternCache.get(rule);
  if (re === undefined) {
    re = disallowPattern(rule);
    patternCache.set(rule, re);
  }
  return re;
}

/**
 * この URL を取りに行ってよいか。**`Disallow` に 1 つでも当たれば取りに行かない**（`Allow` は見ない＝保守的）。
 *
 * **照合する対象はパスとクエリ**（RFC 9309 は path を「path + query」と定める）。
 * **URL として読めないものは「拒否」に倒す**——判断が付かないときに取りに行かないのが安全側である。
 */
export function isAllowedByRobots(rules: RobotsRules, url: string): boolean {
  let target: string;
  try {
    const u = new URL(url);
    target = `${u.pathname}${u.search}`;
  } catch {
    return false;
  }
  return !rules.disallow.some((rule) => patternFor(rule).test(target));
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

  /**
   * HTML（Shift_JIS）。毎回取得。**滋賀県議会（#741）のサイトは `charset=shift_jis`** で、
   * UTF-8 として読むと氏名も会派名も文字化けする。
   * 衆議院の名簿（`shugiin-members.ts`）と同じ `iconv-lite` で復号する（依存は増えない）。
   */
  async textShiftJis(url: string): Promise<string> {
    return iconv.decode(await this.get(url), "Shift_JIS");
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
