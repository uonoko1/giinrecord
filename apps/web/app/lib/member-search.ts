/**
 * /members の純粋ロジック（ブラウザで動く。Node API は使わない）。
 * 五十音の行分け・部分一致の絞り込み・任期満了の表記。評価や並び替えの「重み」は一切持たない。
 */
import type { Assembly, AssemblyId } from "@seiji-kiroku/shared";
import { DIET_ASSEMBLY_IDS, type MemberSummary } from "./data-contract";

/** 議員の所属議会。assemblyId が無い（#156 より前の）データは国会の院から `diet-{house}` を補う。 */
export function memberAssemblyId(m: Pick<MemberSummary, "house" | "assemblyId">): AssemblyId {
  return m.assemblyId ?? DIET_ASSEMBLY_IDS[m.house];
}

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
  /** 議会（`assemblies/index.json` の id。国会は diet-sangiin / diet-shugiin）。未指定・空文字はすべての議会 */
  assemblyId?: AssemblyId | "";
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
      (!filter.assemblyId || memberAssemblyId(m) === filter.assemblyId) &&
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

/**
 * #239: /members の絞り込みは URL のクエリ（?assembly=&group=&district=）に持つ。
 * 見出し・説明・title・OGP はこの値から作るので、ページの文言と表示内容が必ず一致する。
 * 識別子（pref-32 / diet-sangiin など）は現行のまま使う（#240 で別途調査）。
 */
export interface MembersScope {
  /** 議会 id。空文字はすべての議会 */
  assemblyId: AssemblyId | "";
  /** 議会 id に対応する名前（assemblies/index.json の原文）。未選択・未知の id は undefined */
  assemblyName: string | undefined;
  group: string;
  district: string;
}

/** 見出し・説明に並べる条件（議会名・会派・選挙区）。選ばれたものだけを名簿の表記のまま返す。 */
function scopeLabels(scope: Pick<MembersScope, "assemblyName" | "group" | "district">): string[] {
  return [scope.assemblyName, scope.group, scope.district].filter((v): v is string => Boolean(v));
}

/**
 * <h1> の文言。絞り込み無しは「すべての議会の議員」（このページは国会と地方議会の両方を含むため
 * 「国会議員」とは書かない）。条件があれば「徳島県議会・自由民主党の議員」のように名簿の表記を並べる。
 */
export function membersHeading(scope: Pick<MembersScope, "assemblyName" | "group" | "district">): string {
  const labels = scopeLabels(scope);
  return labels.length === 0 ? "すべての議会の議員" : `${labels.join("・")}の議員`;
}

/** リード文・<meta name="description">・OGP の説明。見出しと同じ条件を並べる。評価語は入れない。 */
export function membersDescription(scope: Pick<MembersScope, "assemblyName" | "group" | "district">): string {
  const labels = scopeLabels(scope);
  const subject = labels.length === 0 ? "国会（参議院・衆議院）と地方議会の議員" : `${labels.join("・")}の議員`;
  return `${subject}を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。`;
}

/** URL のクエリ → 絞り込み。assemblies/index.json に無い議会 id は無視する（すべての議会として扱う）。 */
export function membersScopeFromQuery(params: URLSearchParams, assemblies: readonly Assembly[]): MembersScope {
  const assembly = assemblies.find((a) => a.id === params.get("assembly"));
  return {
    assemblyId: assembly?.id ?? "",
    assemblyName: assembly?.name,
    group: params.get("group") ?? "",
    district: params.get("district") ?? "",
  };
}

/** 絞り込み → URL のクエリ文字列（"?" は付けない）。選ばれていないものは書かないので、初期状態は `/members` のまま。 */
export function membersQueryString(scope: Pick<MembersScope, "assemblyId" | "group" | "district">): string {
  const params = new URLSearchParams();
  if (scope.assemblyId) params.set("assembly", scope.assemblyId);
  if (scope.group) params.set("group", scope.group);
  if (scope.district) params.set("district", scope.district);
  return params.toString();
}
