import type { House, Member, MemberId } from "@seiji-kiroku/shared";
import { indexByName, normalizeName, resolveMember, tenureVerified, type NameIndex, type RecordAt } from "./match-votes.ts";
import type { CabinetPost, CabinetPostKind } from "./sources/kantei-cabinet.ts";

/**
 * 首相官邸の閣僚等名簿を衆参の名簿に名寄せする（Issue #1140。調査は #1135）。
 *
 * ## どう決めるか（2 段。**どちらでも決まらなければ紐づけない**）
 *
 * 1. **氏名 + 所属院**。判定は `match-votes.ts` の `resolveMember` をそのまま使う
 *    （正規化・在職の確認・同姓同名の扱いを 2 か所に書かない）。名簿は**その院のもの**だけを渡す。
 *    実測 2026-09-30: **76 件のうち 71 件**がここで決まる。
 * 2. **ふりがな + 所属院**（1 で候補が 0 件だったときだけ）。**在職を確認できた候補が
 *    ちょうど 1 人のときだけ**採る。実測 2026-09-30: **5 件**。
 *
 * ## なぜ 2 が要るか（**氏名が名簿に存在しない 5 件がある**）
 *
 * - **外字 4 件は、官邸の名簿が氏名を画像に置き換えている。** 本文テキストに漢字が無い:
 *   `<img src="…png" alt="はなし やすひろ" class="externalCharacter gaiji size-reg">`
 *   **`alt` にはかなしか入っていないので、漢字は取れない。**
 *   葉梨 康弘 / 尾崎 正直 / 高木 啓 / 高橋 祐介。
 * - **異体字 1 件**: 官邸側は `𠮷井 章` の `𠮷`（U+20BB7、サロゲートペア）で、参院名簿は
 *   `吉`（U+5409）。**NFKC では吸収されない**（`['0x20bb7','0x4e95']` と `['0x5409','0x4e95']`）。
 *   **`normalizeName` の異体字表に足す形は採らない**——U+20BB7 は
 *   `match-votes.ts` の `VARIANTS`（採決ページと参院名簿で実際にぶれる文字だけ）の趣旨から外れ、
 *   足せば採決 38,096 件の名寄せまで挙動が動く。**ここだけの救済に閉じる。**
 *
 * ## 2 が危険な向き（**衝突したら「不明」に倒す**）
 *
 * **`かな + 所属院` は 771 人中 1 組で衝突する**——**伊藤 孝江 と 伊藤 孝恵**（ともに参院、
 * ともに `いとうたかえ`。#1135 の実測）。**今回の 5 件はこの組に当たらないが、
 * この 2 人のどちらかが入閣したら、かなでは絶対に割れない。**
 *
 * **そのときは「不明」にする。** 「**記録が出ない**」と「**別人の記録が出る**」は同じ重さではない
 * （#569）。後者は**利用者から検出できない虚偽**である。だから
 * **かなで 2 人以上に当たった行は `unresolved` に置き、議員には結びつけない。**
 *
 * ## 数えること（#757）
 *
 * **「0 件」と「数えていない」は違う。** `matchCabinetPosts` は
 * `{ total, byName, byKana, unresolved }` を返し、**合計が取得件数と一致することを自分で検算する**
 * （合わなければ例外。黙って足りない数を返さない）。
 */

/**
 * 名寄せできた閣僚等の役職 1 行（1 人 × 1 役職）。
 *
 * **1 人が複数の役職を同時に持つ**（兼務・特命担当）ので、名簿の 1 行から複数の行が出る。
 * **役職名は名簿の原文のまま**で、分類・要約はしない。
 */
export interface MatchedCabinetRole {
  memberId: MemberId;
  /** 名簿の氏名の原文。外字の行は氏名が画像なので、代わりにふりがなが入る。 */
  nameText: string;
  /** 名簿のふりがなの原文。 */
  kana: string;
  house: House;
  /** ページの区分（閣僚等 / 副大臣 / 大臣政務官）。 */
  kind: CabinetPostKind;
  /** 役職名の原文（例「内閣府特命担当大臣（金融）」「兼内閣府副大臣」）。 */
  role: string;
  /** 内閣の発足日（ISO）。**ページごとに違う**（閣僚 09-17 / 副大臣・政務官 09-18）。 */
  effectiveDate: string;
  /** 名簿の日付表記の原文（例「令和８年９月１７日発足」）。 */
  effectiveDateText: string;
  /** どちらのキーで決まったか。事実の記録（`byKana` は氏名が名簿に無かった行）。 */
  resolvedBy: "name" | "kana";
  /** 名簿ページの URL。**役職 1 件ごとに一次資料が付く。** */
  sourceUrl: string;
}

/**
 * 名寄せできなかった名簿の行（**議員には結びつけない**）。
 * 1 人 1 行（役職ごとには分けない。誰か分からないので役職に意味が付かない）。
 */
export interface UnresolvedCabinetPost {
  kind: "cabinet";
  /** 氏名の原文。外字の行は名簿に漢字が無いので空文字列。 */
  nameText: string;
  kana: string;
  house: House;
  /** 役職名の原文（全部）。 */
  roles: string[];
  /** なぜ決まらなかったか（候補 0 / かなで複数）。 */
  reason: "no-candidate" | "kana-ambiguous";
  /** かなで当たった候補の memberId（`kana-ambiguous` のときだけ。**結びつけではなく、運用者が見るための記録**）。 */
  candidates?: MemberId[];
  sourceUrl: string;
}

/** 母数の内訳（#757）。`byName + byKana + unresolved === total`。 */
export interface CabinetMatchTally {
  /** 名簿から取れた人数（所属院のある行）。 */
  total: number;
  /** 氏名 + 所属院 で決まった人数。 */
  byName: number;
  /** ふりがな + 所属院 で決まった人数。 */
  byKana: number;
  /** 決まらなかった人数。 */
  unresolved: number;
}

/** かなで引くための索引（`indexByName` と同じ形。かなは 1 人 1 つなので name / legalName の分岐は無い）。 */
export type KanaIndex = Map<string, Member[]>;

/**
 * ふりがなの索引。キーは `normalizeName`（空白除去 + NFKC）。
 * **`normalizeName` を使い回す**のは、官邸側が「はなし やすひろ」と半角空白、
 * 名簿側が「はなし　やすひろ」と全角空白のことがあり、空白の扱いを 2 か所に書きたくないため。
 */
export function indexByKana(members: readonly Member[]): KanaIndex {
  const map = new Map<string, Member[]>();
  for (const m of members) {
    if (m.kana === "") continue; // かなが無い議員はかなで引けない（推定しない）
    const key = normalizeName(m.kana);
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  return map;
}

/**
 * 名簿（`fetchCabinetPosts` の出力）を衆参の名簿に名寄せする純粋関数。
 *
 * `at` は在職の確認に使う文脈（`resolveMember` と同じ `RecordAt`）。
 * `session` は ETL が扱っている最新回次、`date` は**その行の内閣発足日**（ページごとに違う）。
 */
export function matchCabinetPosts(
  posts: readonly CabinetPost[],
  members: readonly Member[],
  at: { session: number },
): { entries: MatchedCabinetRole[]; unresolved: UnresolvedCabinetPost[]; tally: CabinetMatchTally } {
  const nameIdx: Partial<Record<House, NameIndex>> = {};
  const kanaIdx: Partial<Record<House, KanaIndex>> = {};
  const poolOf = (house: House): Member[] => members.filter((m) => m.house === house);
  const nameIndexFor = (house: House): NameIndex => (nameIdx[house] ??= indexByName(poolOf(house)));
  const kanaIndexFor = (house: House): KanaIndex => (kanaIdx[house] ??= indexByKana(poolOf(house)));

  const entries: MatchedCabinetRole[] = [];
  const unresolved: UnresolvedCabinetPost[] = [];
  const tally: CabinetMatchTally = { total: 0, byName: 0, byKana: 0, unresolved: 0 };

  for (const post of posts) {
    tally.total++;
    const recordAt: RecordAt = { session: at.session, date: post.effectiveDate };
    const resolved = resolvePost(post, nameIndexFor(post.house), kanaIndexFor(post.house), recordAt);
    if (resolved.member === undefined) {
      tally.unresolved++;
      unresolved.push({
        kind: "cabinet",
        nameText: post.name ?? "",
        kana: post.kana,
        house: post.house,
        roles: [...post.roles],
        reason: resolved.reason,
        ...(resolved.candidates === undefined ? {} : { candidates: resolved.candidates }),
        sourceUrl: post.sourceUrl,
      });
      continue;
    }
    if (resolved.by === "name") tally.byName++; else tally.byKana++;
    for (const role of post.roles) {
      entries.push({
        memberId: resolved.member.id,
        // 外字の行は名簿に漢字が無いので、原文として残せるのはふりがなだけ。
        nameText: post.name ?? post.kana,
        kana: post.kana,
        house: post.house,
        kind: post.kind,
        role,
        effectiveDate: post.effectiveDate,
        effectiveDateText: post.effectiveDateText,
        resolvedBy: resolved.by,
        sourceUrl: post.sourceUrl,
      });
    }
  }

  assertTallyConsistent(tally, entries, unresolved, posts.length);

  // 並びは memberId → 区分 → 役職名（取得順に依存させない）。`localeCompare` は使わない
  // （実行環境のロケールで日本語の並びが変わる。`match-committee.ts` と同じ理由）。
  entries.sort((a, b) => cmp(a.memberId, b.memberId) || cmp(a.kind, b.kind) || cmp(a.role, b.role));
  return { entries, unresolved, tally };
}

/**
 * **母数の検算**（#757）。合わないまま返すと、取り落としが「0 件」に化ける。
 *
 * **足し算だけでは足りない。** `total` を 1 行ごとに増やし、分類も 1 行ごとに増やす作りだと、
 * 「足すのを忘れた」以外の壊れ方（**行を読み飛ばす** / **同じ行を 2 回数える**）は
 * 合計が合ったまますり抜ける。だから**出力そのもの**と突き合わせる:
 *
 * 1. `byName + byKana + unresolved === total`（分類が漏れていない）
 * 2. `total === 入力の行数`（**読み飛ばした行が無い**）
 * 3. `unresolved の行数 === tally.unresolved`（不明の数と不明の行が一致する）
 * 4. `名寄せできた人数 === byName + byKana`（役職の行ではなく**人数**で数える）
 *
 * **4 が「別人の記録が出る」に直接効く**——同じ人に 2 回紐づけば人数が減って落ちる。
 *
 * 純粋関数にして export しているのは、**この検査自身を検査できるようにするため**
 * （変異で `throw` を消したとき、外から呼ぶテストが無いと 1 件も落ちなかった）。
 */
export function assertTallyConsistent(
  tally: CabinetMatchTally,
  entries: readonly MatchedCabinetRole[],
  unresolved: readonly UnresolvedCabinetPost[],
  inputRows: number,
): void {
  const sum = tally.byName + tally.byKana + tally.unresolved;
  if (sum !== tally.total) throw new Error(`cabinet tally mismatch: ${sum} !== total ${tally.total} (byName=${tally.byName} byKana=${tally.byKana} unresolved=${tally.unresolved})`);
  if (tally.total !== inputRows) throw new Error(`cabinet tally mismatch: total ${tally.total} !== input rows ${inputRows}（行を読み飛ばしている）`);
  if (unresolved.length !== tally.unresolved) throw new Error(`cabinet tally mismatch: unresolved rows ${unresolved.length} !== tally.unresolved ${tally.unresolved}`);
  const people = new Set(entries.map((e) => e.memberId)).size;
  if (people !== tally.byName + tally.byKana) throw new Error(`cabinet tally mismatch: resolved people ${people} !== byName+byKana ${tally.byName + tally.byKana}（同じ議員に 2 回紐づいた可能性）`);
}

type Resolution =
  | { member: Member; by: "name" | "kana"; reason?: undefined; candidates?: undefined }
  | { member?: undefined; by?: undefined; reason: "no-candidate" | "kana-ambiguous"; candidates?: MemberId[] };

/**
 * 1 行を 1 人に決める。**氏名で決まらなければ、かなで引く。それでも 1 人にならなければ「不明」。**
 *
 * **かなに落ちるのは「氏名の候補が 0 件」のときだけである。** 氏名で 2 人以上に当たって
 * 絞れなかった行は**かなに落とさない**——氏名で割れないものがかなで割れることは無いし、
 * かなが 1 人に当たったからといって、氏名で当たった別の候補を消す根拠にはならない。
 */
function resolvePost(post: CabinetPost, nameIndex: NameIndex, kanaIndex: KanaIndex, at: RecordAt): Resolution {
  if (post.name !== undefined) {
    const byName = resolveMember(nameIndex, post.name, undefined, at);
    if (byName !== undefined) return { member: byName, by: "name" };
    // 氏名が名簿に**在る**のに絞れなかった（同姓同名で割れない）行は、かなでも割れない。
    if ((nameIndex.get(normalizeName(post.name)) ?? []).length > 0) return { reason: "no-candidate" };
  }
  // **在職を確認できた候補だけを数える**（`resolveMember` の 2 と同じ条件。#230）。
  const kanaHits = (kanaIndex.get(normalizeName(post.kana)) ?? []).filter((m) => tenureVerified(m, at));
  if (kanaHits.length === 1) return { member: kanaHits[0], by: "kana" };
  // **2 人以上に当たったら「不明」**（伊藤 孝江 / 伊藤 孝恵。推測で議員を紐づけない）。
  if (kanaHits.length > 1) return { reason: "kana-ambiguous", candidates: kanaHits.map((m) => m.id) };
  return { reason: "no-candidate" };
}

/** 文字列の比較（コードポイント順）。`localeCompare` は使わない（`match-committee.ts` と同じ）。 */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
