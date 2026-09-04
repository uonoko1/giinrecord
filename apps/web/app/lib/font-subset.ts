/**
 * 明朝 700 の**実測サブセット**（#477）。純粋関数だけ。
 * `pyftsubset` の実行と `data/` の読み取りは `scripts/font-subset.ts` が行う。
 *
 * **なぜ差し替えるのか。** Google の unicode-range 分割は「1 字のために 66 KB」を実在させる。
 * `/members` の展開後（997 名）は 1 字しか使わないスライスが 20 件・1,033 KB で、
 * 明朝 700 の転送量の約半分（#468 の実測、`docs/research/font-subset-member-names.md` §2）。
 * 出る字だけの 1 面に置き換えると、ページによらず 1 面しか引かない。
 *
 * **増えるページもある。** `/` は明朝 700 を 26 字しか使わないので、
 * 今は 8 スライス 114 KB で済んでいるものが 1 面ぶん引かれる。
 * **減る側と増える側の両方がある案**であり、PO は `/members` の減りと釣り合うと判断している（#477）。
 */

/** 差し替える face。#453 の判断（議員名は明朝のまま）に従い、家族もウェイトも変えない。 */
export const SUBSET_FAMILY = "Shippori Mincho";
export const SUBSET_WEIGHT = 700;
/** `sliceFileName({family, weight, slice: "subset"})` と同じ名前。fonts.css と public/fonts/ の両方で使う。 */
export const SUBSET_FILE = "shippori-mincho-700.subset.woff2";
/** サブセットが収録する字の一覧（リポジトリにコミットする）。 */
export const SUBSET_CHARS_FILE = "shippori-mincho-700.subset.txt";

function codePoints(chars: Iterable<string>): number[] {
  const out = new Set<number>();
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) out.add(cp);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 収録する字を `unicode-range` にする。連続するコードポイントは範囲にまとめる。
 * 範囲を書くのは、**サブセットに無い字がこの face を落としてこない**ようにするため
 * （無い字は明朝を諦めてシステムの明朝に落ちる。#468 §4-1 の実測どおり**名前は消えない**）。
 */
export function subsetUnicodeRange(chars: Iterable<string>): string {
  const cps = codePoints(chars);
  if (cps.length === 0) return "";
  const hex = (n: number) => `U+${n.toString(16).toUpperCase()}`;
  const parts: string[] = [];
  let start = cps[0]!;
  let prev = start;
  for (const cp of cps.slice(1)) {
    if (cp === prev + 1) {
      prev = cp;
      continue;
    }
    parts.push(start === prev ? hex(start) : `${hex(start)}-${prev.toString(16).toUpperCase()}`);
    start = cp;
    prev = cp;
  }
  parts.push(start === prev ? hex(start) : `${hex(start)}-${prev.toString(16).toUpperCase()}`);
  return parts.join(", ");
}

/**
 * コミットする字の一覧の本文。**コードポイント順**に並べるので、
 * 集める順序が変わっても同じ本文になる（＝再生成が冪等で、md5 が一致する）。
 */
export function formatSubsetChars(chars: Iterable<string>): string {
  return `${codePoints(chars)
    .map((cp) => String.fromCodePoint(cp))
    .join("")}\n`;
}

/** `formatSubsetChars` の逆。末尾の改行は字として数えない。 */
export function parseSubsetChars(text: string): Set<string> {
  const out = new Set<string>();
  for (const ch of text) if (ch !== "\n") out.add(ch);
  return out;
}

/** fonts.css に置く 1 面。`renderFontsCss` がそのまま並べられる形にする。 */
export function subsetFace(chars: Iterable<string>) {
  return {
    family: SUBSET_FAMILY,
    weight: SUBSET_WEIGHT,
    slice: "subset",
    unicodeRange: subsetUnicodeRange(chars),
    sourceUrl: "",
  };
}
