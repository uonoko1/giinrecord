/**
 * `data/` 配下の JSON 書式（docs/DATA_CONTRACT.md）: キーは再帰的に辞書順、インデント1、末尾改行。
 * 差分を小さくするため、data/ に書くものはすべてこれを通す。
 *
 * #1226: 以前は `JSON.stringify(value, sortKeys, 1)` の replacer で
 * `Object.fromEntries(Object.entries(v).sort(…))` を返していた。
 * **`Object.fromEntries` は整数様キー（`"1000000"`）を数値昇順に並べ替えるので、
 * `.sort()` の結果がその場で捨てられていた**（`"0010000"` は整数様でないので挿入順のまま後ろに残る）。
 * その結果 `data/districts/by-zip.json`（120,720 鍵）は辞書順ではなかった。
 * `text === stableJson(JSON.parse(text))` という自己確認は**両辺が同じ壊れ方を再生する**ので恒真だった。
 * さらに `JSON.parse` 自体が整数様キーを並べ替えるため、パース後の `Object.keys` も証拠にならない。
 * いまは object のキーを自前で並べて直列化するので、キーの形に関係なく辞書順が出る。
 */
export function stableJson(value: unknown): string {
  return write(value, "") + "\n";
}

/** 辞書順（UTF-16 コード単位の比較）。`Array.prototype.sort` の既定と同じだが、意図を明示するため自前で書く。 */
const byKey = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `JSON.stringify(value, null, 1)` と同じ出力を、object のキーだけ辞書順にして返す。
 * スカラ・文字列のエスケープ・`toJSON`・`undefined` / 関数の扱いは `JSON.stringify` に委ねる
 * （自前で書くとエスケープの取りこぼしが起きる）。
 */
function write(value: unknown, indent: string): string {
  const v = toJson(value);
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  const inner = indent + " ";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    // 配列の要素は undefined / 関数が null になる（JSON.stringify と同じ）
    return `[\n${v.map((e) => inner + writeElement(e, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>)
    .map(([k, e]) => [k, toJson(e)] as const)
    .filter(([, e]) => serializable(e))
    .sort(byKey);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, e]) => `${inner}${JSON.stringify(k)}: ${write(e, inner)}`).join(",\n")}\n${indent}}`;
}

/** 配列の要素: `undefined` / 関数 / symbol は `null` になる（`JSON.stringify` と同じ）。 */
const writeElement = (e: unknown, indent: string) => (serializable(toJson(e)) ? write(e, indent) : "null");

const serializable = (v: unknown) => v !== undefined && typeof v !== "function" && typeof v !== "symbol";

/** `toJSON()` を持つ値（Date など）は、それを返した物として扱う（`JSON.stringify` と同じ）。 */
function toJson(value: unknown): unknown {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return (value as { toJSON: () => unknown }).toJSON();
  }
  return value;
}

/**
 * JSON のテキストを読み、object のキーが辞書順の厳密増加になっていない箇所を列挙する（#1226）。
 * 空なら合格。
 *
 * **`JSON.parse` を通さないのが要点**: parse した瞬間に整数様キーの並びは数値昇順に化けるので、
 * パースした物の `Object.keys` ではキーの並びを観測できない。
 * `stableJson` を一切呼ばないので、`stableJson` の出力をこれに通す照合は恒真にならない
 * （期待値と実測が別の実装から来る）。
 */
export function jsonKeyOrderViolations(text: string): string[] {
  const violations: string[] = [];
  /** 入れ子ごとの「直前のキー」。object に入るとき push、出るとき pop。配列の枠では undefined。 */
  const prev: (string | undefined)[] = [];
  let i = 0;
  const n = text.length;
  /** 文字列リテラルを読み、エスケープを解いた中身と、閉じ引用符の次の位置を返す。 */
  const readString = (at: number): { value: string; end: number } => {
    let out = "";
    let j = at + 1; // 開きの " の次
    while (j < n) {
      const c = text[j];
      if (c === '"') return { value: out, end: j + 1 };
      if (c === "\\") {
        const e = text[j + 1];
        if (e === "u") { out += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16)); j += 6; continue; }
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : e;
        j += 2;
        continue;
      }
      out += c;
      j++;
    }
    return { value: out, end: n };
  };
  while (i < n) {
    const c = text[i];
    if (c === "{") { prev.push(undefined); i++; continue; }
    if (c === "[") { prev.push(undefined); i++; continue; }
    if (c === "}" || c === "]") { prev.pop(); i++; continue; }
    if (c === '"') {
      const { value, end } = readString(i);
      // 次に来る非空白が ':' ならキー。そうでなければ値（＝順序を見ない）。
      let k = end;
      while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === ":") {
        const last = prev[prev.length - 1];
        if (last !== undefined && !(last < value)) violations.push(`keys out of order: "${last}" before "${value}"`);
        prev[prev.length - 1] = value;
        i = k + 1;
      } else {
        i = end;
      }
      continue;
    }
    i++;
  }
  return violations;
}
