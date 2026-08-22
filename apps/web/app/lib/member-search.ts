/**
 * /members の純粋ロジック（ブラウザで動く。Node API は使わない）。
 * 五十音の行分け・部分一致の絞り込み・任期満了の表記。評価や並び替えの「重み」は一切持たない。
 */
import type { MemberSummary } from "./data-contract";

export const KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ"] as const;
export const OTHER_ROW = "その他";
export type KanaRow = (typeof KANA_ROWS)[number] | typeof OTHER_ROW;

/** 行の先頭の清音（ひらがな）。「や」「わ」行は飛び石なので個別に持つ。 */
const ROW_HEADS: [KanaRow, string][] = [
  ["あ", "あいうえお"],
  ["か", "かきくけこ"],
  ["さ", "さしすせそ"],
  ["た", "たちつてと"],
  ["な", "なにぬねの"],
  ["は", "はひふへほ"],
  ["ま", "まみむめも"],
  ["や", "やゆよ"],
  ["ら", "らりるれろ"],
  ["わ", "わゐゑをん"],
];

/** 先頭1文字を「ひらがな・清音・大書き」に正規化する */
function normalizeHead(ch: string): string {
  // NFD で濁点・半濁点（結合文字）を分離して捨てる
  let base = ch.normalize("NFD").replace(/[゙゚]/g, "");
  const code = base.codePointAt(0) ?? 0;
  // カタカナ → ひらがな
  if (code >= 0x30a1 && code <= 0x30f6) base = String.fromCodePoint(code - 0x60);
  // 小書き → 大書き
  const small = "ぁぃぅぇぉっゃゅょゎ";
  const large = "あいうえおつやゆよわ";
  const i = small.indexOf(base);
  return i >= 0 ? large[i] : base;
}

export function kanaRow(kana: string): KanaRow {
  const first = [...kana][0];
  if (!first) return OTHER_ROW;
  const head = normalizeHead(first);
  for (const [row, chars] of ROW_HEADS) if (chars.includes(head)) return row;
  return OTHER_ROW;
}

export interface KanaGroup {
  row: KanaRow;
  members: MemberSummary[];
}

const collator = new Intl.Collator("ja");

/** 五十音の行順にグループ化。行内はかな順。かなで始まらない議員は末尾の「その他」。 */
export function groupByKanaRow(members: MemberSummary[]): KanaGroup[] {
  const map = new Map<KanaRow, MemberSummary[]>();
  for (const m of members) {
    const row = kanaRow(m.kana);
    const list = map.get(row);
    if (list) list.push(m);
    else map.set(row, [m]);
  }
  return [...KANA_ROWS, OTHER_ROW as KanaRow]
    .filter((row) => map.has(row))
    .map((row) => ({ row, members: [...(map.get(row) ?? [])].sort((a, b) => collator.compare(a.kana, b.kana)) }));
}

export interface MemberFilter {
  query?: string;
  group?: string;
  district?: string;
}

/**
 * 照合用の正規化。NFKC（半角カナ→全角、全角英数→半角）→ カタカナ→ひらがな → 空白除去。
 * 入力側と氏名・かな側の両方に同じ関数をかける。
 */
export function normalizeForSearch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint((ch.codePointAt(0) ?? 0) - 0x60))
    .replace(/[\s　]+/g, "");
}

export function filterMembers(members: MemberSummary[], filter: MemberFilter): MemberSummary[] {
  const q = normalizeForSearch(filter.query ?? "");
  return members.filter(
    (m) =>
      (!filter.group || m.group === filter.group) &&
      (!filter.district || m.district === filter.district) &&
      (q === "" || normalizeForSearch(m.name).includes(q) || normalizeForSearch(m.kana).includes(q)),
  );
}

/** 2028-07-25 → 〜2028.07 */
export function formatTermEnd(iso: string | undefined): string | undefined {
  const m = iso && /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `〜${m[1]}.${m[2]}` : undefined;
}
