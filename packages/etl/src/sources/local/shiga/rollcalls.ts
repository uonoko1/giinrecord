import { createHash } from "node:crypto";
import type { LocalMember, LocalRollCall, LocalUnmatchedName, LocalVote, VoteValue } from "@seiji-kiroku/shared";
import { isoDate, SHIGA_ASSEMBLY } from "./site.ts";
import { legendOf, UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "./votes-pdf.ts";
// 氏名の突き合わせは 8 県で共通（#636）。滋賀の PDF はフルネーム（縦書き 1 文字 1 アイテム）。
import { localNameKey as nameKey, matchBySubsequence as matchName } from "../name-match.ts";

export { nameKey, matchName };

/**
 * 滋賀県議会の表決 PDF の行 → LocalRollCall（Issue #741）。
 *
 * - **名寄せ**: PDF の氏名（縦書きを結合）と名簿の氏名を、空白と異体字セレクタを除き
 *   字形違い（髙/高・﨑/崎・𠮷/吉）を寄せた完全一致で。完全一致が無いときだけ部分列一致で
 *   1 人に決まれば寄せる（`matchBySubsequence`。7 県と同じ）。2 人以上なら候補を列挙して
 *   `memberId: ""` のまま（**選ばない**）。
 * - **`unmatched.json` の理由**（`brokenGlyph` / `sourceConflict`）は `buildLocalAssembly` が付ける（#680／#711）。
 *   **滋賀は `brokenGlyph` が実データで立つ最初の議会**——`辻正隆` の `辻` が 2 本の PDF で
 *   `□`（U+25A1）に化ける（#680 が 147 本で数えて 2 本・3 個）。
 *   **`□` を `辻` に戻さない**（推定であり別人の記録を作る側。#569／#674）。
 * - **id**: `{assemblyId}-{sessionId}-{議決日 yyyymmdd}-{件名}`。滋賀の PDF には**議案番号の欄が無い**
 *   （議案等番号の欄に件名がそのまま入る。「議第105号から議第109号まで（人事案件）」のように
 *   複数の議案が 1 行にまとまることもある）ので、**番号を作らない**——件名から id を作り、
 *   同じ議決日で同じ件名の行が複数なら全部に `-1`, `-2` … を足す（徳島・奈良・高知と同じ規則）。
 * - **議決日**: PDF の本文の `8/10` と、見出しの `８月10日議決分`。**年は PDF に無い**ので会期の年から補う。
 *   **年またぎに注意**——11月定例会の議決が翌年 1 月になることがあるので、
 *   会期の月より 6 か月以上前の月なら翌年にする（docs/DATA_CONTRACT.md の規則。宮城と同じ）。
 * - **表決方法の欄は PDF に無い**ので `method` は書かない（推定しない）。
 * - **`mapped`**: **凡例の文言が下の表と完全一致するときだけ**（docs/DATA_CONTRACT.md）。
 *   **凡例の無い PDF では 1 つも付かない**（`legend` が `抽出不能` になる）。
 */

/**
 * 凡例の意味の原文 → 国会の値。**滋賀の凡例は 2 種類しかない**（#694 が 147 本から拾った実測）:
 *   `「○」は賛成を、「×」は反対を、「議」は議長（表決権なし）、「－」は表決に参加していないことを表す。`
 *   `「-」欠席を、「議」は議長（表決権なし）、「退」は退席を表す。`
 * **`-` の意味が会期で違う**（「表決に参加していない」／「欠席」）ので、**記号ではなく凡例の意味で引く。**
 * 記号で決め打つと、同じ `-` に違う意味を当てることになる。
 */
const MAPPED: Record<string, VoteValue> = {
  "賛成": "賛成",
  "反対": "反対",
  "議長（表決権なし）": "投票なし",
  "表決に参加していない": "投票なし",
  "欠席": "投票なし",
  "退席": "投票なし",
};

export function mapLegend(raw: string, legend: string): LocalVote {
  const mapped = raw === UNKNOWN_CELL || legend === UNKNOWN_LEGEND ? undefined : MAPPED[legend];
  return mapped ? { raw, legend, mapped } : { raw, legend };
}

export interface SessionInfo {
  sessionId: string;
  /** 年ページの h2 の原文（「令和８年　７月定例会議」） */
  sessionLabel: string;
  /** 会期の西暦（年またぎの判定に使う） */
  year: number;
  /** 会期の月（年またぎの判定に使う） */
  month: number;
}

export interface PdfSource {
  pdf: VotePdf;
  pdfUrl: string;
}

/**
 * PDF の議決日（月・日）と会期の年から ISO 日付。
 * **会期の月より 6 か月以上前の月は翌年**（11月定例会の 1月議決。docs/DATA_CONTRACT.md）。
 */
export function resolveDate(session: { year: number; month: number }, month: number, day: number): string {
  const year = session.month - month >= 6 ? session.year + 1 : session.year;
  return isoDate(year, month, day);
}

/** 議決日の欄の原文（「8/10」）→ 月・日。読めなければ undefined（推定しない）。 */
export function parseDateText(text: string): { month: number; day: number } | undefined {
  const m = text.normalize("NFKC").replace(/[\s　]/g, "").match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { month, day };
}

/** id に使えない文字（区切りと空白）を落とす。件名は原文のまま `title` に残る。 */
const idPart = (s: string): string => s.replace(/[\s　/\\]/g, "");

/**
 * ## 採決 id の長さの上限（#901）
 *
 * **id はそのままファイル名（`data/assemblies/pref-25/rollcalls/{sessionId}/{id}.json`）になる。**
 * **ほとんどのファイルシステムは 1 つの名前を 255 バイトまでしか持てない**（ext4 / APFS / NTFS）。
 *
 * **滋賀の PDF には議案番号の欄が無く、件名の欄が議案等番号を兼ねる**（上の docblock）ので、
 * **件名が「議案の列挙」そのものになる**——
 * `議第２号、議第９号、…および議第77号を可決すべきものとする各委員長報告ならびに請願第２号から…`。
 * **この 1 件で 576 バイト**（UTF-8。漢字 1 文字 3 バイト）。
 *
 * **実測（#901。`--sessions` を広げて数えた。母数を出す。#757）**:
 *
 * | | `--sessions 2`（本番に今出ている値） | **`--sessions 19`** |
 * |---|---:|---:|
 * | 採決（母数） | 14 | **163** |
 * | **255 バイト超え** | **0** | **15（9.2%）** |
 * | 最長 | **241B**（余裕 14B） | **576B** |
 *
 * **`--sessions 2` の窓には 1 件も無かったので、今まで見えていなかった。**
 * **余裕は漢字 4 文字ぶんしか無く、広げなくても次の会期で落ちうる形だった。**
 *
 * **落ち方が悪い**——`writeLocalAssembly` は `data/assemblies/{id}/` を**消してから書き直す**ので、
 * **途中で `ENAMETOOLONG` になると `meta.json` と `unmatched.json` が消えた半端な状態で残る**（実測）。
 */
const MAX_FILENAME_BYTES = 255;
/** `.json` のぶん */
const EXT_BYTES = 5;

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/**
 * **件名から作った id を、ファイル名が 255 バイトに収まるところで切る。**
 *
 * - **切るのは文字の境**（バイトで切ると UTF-8 の途中で切れて壊れた文字（U+FFFD）が出る）。
 * - **切った id には元の id の指紋（SHA-256 の先頭 8 桁）を `-h{8桁}` で足す。**
 *   **切り詰めだけだと、頭が同じで末尾だけ違う 2 件が同じ id になる**——
 *   **`buildLocalAssembly` の重複 id の検査で例外になり、県ぶんまるごと出せなくなる**
 *   （検査が無ければ後から書いたほうで上書きして**採決が 1 件黙って消える**）。
 * - **指紋は件名だけから決まる**ので、**取り直しても並び順が変わっても id が動かない**
 *   （連番にすると、県が件名を 1 つ足しただけで後ろの id が全部ずれる）。
 * - **収まる id は 1 バイトも変えない**——**本番に今出ている 14 件の id は動かない。**
 *
 * **件名の原文は `title` にそのまま残る。** **id は「場所の名前」であって記録ではない。**
 */
function capIdLength(id: string): string {
  if (byteLength(id) + EXT_BYTES <= MAX_FILENAME_BYTES) return id;
  // 指紋は**切る前の id 全体**から取る（同じ件名が別の会期・別の日付に出ても別の id になる）
  const fp = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
  const suffix = `-h${fp}`;
  const budget = MAX_FILENAME_BYTES - EXT_BYTES - byteLength(suffix);
  // **文字の境で切る**——1 文字ずつ足して予算を超えたら止める（サロゲートペアも壊さない）
  let out = "";
  let used = 0;
  for (const ch of id) {
    const n = byteLength(ch);
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + suffix;
}

export function toLocalRollCalls(sources: readonly PdfSource[], roster: readonly LocalMember[], session: SessionInfo): { rollCalls: LocalRollCall[]; unmatched: LocalUnmatchedName[] } {
  const rollCalls: LocalRollCall[] = [];
  const baseIds = new Map<string, number>();
  const matchOf = new Map<string, ReturnType<typeof matchName>>();
  for (const { pdf, pdfUrl } of sources) {
    const resolved = pdf.members.map((m) => {
      const hit = matchName(m.nameText, roster);
      matchOf.set(`${m.nameText}\t${m.group}`, hit);
      return hit;
    });
    for (const row of pdf.rows) {
      // 本文の議決日が読めなければ見出しの議決日（「８月10日議決分」）を使う。
      // **どちらも読めなければ例外**（日付の無い記録は出さない）
      const md = parseDateText(row.dateText) ?? { month: pdf.month, day: pdf.day };
      const date = resolveDate(session, md.month, md.day);
      if (row.title === "") throw new Error(`${pdfUrl}: page ${row.page}: 件名が空の行がある`);
      // **ファイル名が 255 バイトに収まるところで切る**（`capIdLength`。#901）。件名は `title` に原文のまま残る
      const base = capIdLength(`${SHIGA_ASSEMBLY.id}-${session.sessionId}-${date.replace(/-/g, "")}-${idPart(row.title)}`);
      baseIds.set(base, (baseIds.get(base) ?? 0) + 1);
      const votes: LocalRollCall["votes"] = row.cells.map((raw, i) => {
        const legend = legendOf(raw, pdf.legend.votes);
        const member = pdf.members[i];
        return { memberId: resolved[i].memberId, nameText: member.nameText, group: member.group, value: mapLegend(raw, legend) };
      });
      rollCalls.push({
        id: base,
        assemblyId: SHIGA_ASSEMBLY.id,
        sessionId: session.sessionId,
        sessionLabel: session.sessionLabel,
        date,
        // 滋賀の PDF に議案種別の欄は無い。**推定しない**ので、この議会が公表している単位
        // （「議案等」）をそのまま書く
        kind: "議案等",
        // 番号の欄が無い（件名の欄が議案等番号を兼ねる）。**番号を件名から切り出さない**——
        // 「議第105号から議第109号まで」のように範囲で書かれる行があり、1 つに丸めると嘘になる
        number: "",
        title: row.title,
        result: row.result,
        ...(row.counts ? { counts: { yes: row.counts.yes, no: row.counts.no, present: row.counts.present, voting: row.counts.voting } } : {}),
        votes,
        page: row.page,
        sourceUrl: pdfUrl,
      });
    }
  }
  // 同じ議決日で同じ件名の行が複数なら、出た順に全部へ -1, -2 … を足す（徳島・奈良・高知と同じ規則）
  const seen = new Map<string, number>();
  for (const rc of rollCalls) {
    if ((baseIds.get(rc.id) ?? 0) <= 1) continue;
    const n = (seen.get(rc.id) ?? 0) + 1;
    seen.set(rc.id, n);
    rc.id = `${rc.id}-${n}`;
  }
  // 名簿に寄せられなかった氏名
  const unmatched = new Map<string, LocalUnmatchedName>();
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      if (v.memberId !== "") continue;
      const key = `${v.nameText}\t${v.group}`;
      const u = unmatched.get(key) ?? { nameText: v.nameText, group: v.group, rollCallIds: [] };
      if (!u.rollCallIds.includes(rc.id)) u.rollCallIds.push(rc.id);
      unmatched.set(key, u);
    }
  }
  // **`reason` はここでは付けない**——`buildLocalAssembly` が 8 県すべてを通る 1 か所で付ける
  // （県ごとに書くと足し忘れが黙って落ちる。#680 の判断）。ここは候補だけ写す。
  const unmatchedList = [...unmatched.values()].map((u) => {
    const match = matchOf.get(`${u.nameText}\t${u.group}`);
    return { ...u, ...(match && match.candidates.length > 0 ? { candidates: match.candidates } : {}) };
  });
  return { rollCalls, unmatched: unmatchedList };
}
