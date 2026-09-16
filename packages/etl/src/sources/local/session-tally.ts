/**
 * **会期の一覧を読むときの母数**（Issue #895）。
 *
 * ## なぜ要るか
 * **会期 index を読む実装は、条件に合わない行を例外ではなく `continue` で飛ばしていた。**
 * **その結果「読めない」ではなく「見えていない」会期が生まれ、誰も気づかない。**
 * **#871 が宮城で 7 本、#873 が鳥取で 25 会期を実測した**——
 * **どちらも例外は 1 つも出ておらず、テストも緑のままだった。**
 *
 * **「記録が出ない」と「別の記録が出る」を区別するのが本サイトの原則だが、
 * この形は第 3 の状態である**——**そもそも記録が在ることに気づいていない。**
 *
 * ## 何をするか
 * **落とすこと自体は禁じない**（表決の公開が無い会期・ページ送りのリンク・アンカーだけの `<a>` は
 * 事実として落とす必要がある）。**禁じるのは「落としたことが出ない」ことである。**
 *
 * **`SessionTally` は「何本の候補を見て、何本を採り、何本を、どの理由で落としたか」を持つ。**
 * **理由ごとの件数が固定されるので、`continue` が 1 本増えれば数が動き、テストが赤になる。**
 *
 * ## 使い方（既存の戻り値は変えない）
 * **各県の index パーサは `tally` を**任意の**引数で受け、あれば書き込む。**
 * **渡さなければ今までと 1 バイトも変わらない**ので、既存の呼び出し側・出力は影響を受けない。
 */

/** **落とした理由**。**「その他」は無い**——新しい形が出たら、ここに名前を足して初めて落とせる。 */
export type DropReason =
  /** 会期の見出し・リンク文言の形に当たらない（**宮城の `令和元年` と ASCII `(` はここに落ちていた**） */
  | "not-a-session"
  /** 会期ではあるが、賛否・表決の資料へのリンクがこのページに無い（公表が無い会期・会期中） */
  | "no-vote-link"
  /** 会期ではあるが、個人別ではないと分かっている範囲（青森の第275回より前） */
  | "before-personal-votes"
  /** ページ送り・アンカーだけの `<a>` など、会期の候補ですらない飾り */
  | "not-a-candidate";

export interface DroppedCandidate {
  /** 落とした行の原文（見出し・リンク文言。**推定はしない**） */
  readonly text: string;
  readonly reason: DropReason;
}

/** **1 つの index ページ（または 1 段）ぶんの母数。** */
export class SessionTally {
  /** 見た候補の数（採った ＋ 落とした） */
  #seen = 0;
  #taken = 0;
  readonly #dropped: DroppedCandidate[] = [];

  /** 候補を 1 本採った。 */
  take(): void {
    this.#seen++;
    this.#taken++;
  }

  /** 候補を 1 本落とした。**理由が要る。** */
  drop(text: string, reason: DropReason): void {
    this.#seen++;
    this.#dropped.push({ text, reason });
  }

  get seen(): number {
    return this.#seen;
  }

  get taken(): number {
    return this.#taken;
  }

  get dropped(): readonly DroppedCandidate[] {
    return this.#dropped;
  }

  /** 理由ごとの件数（**0 の理由は載せない**）。テストが固定するのはこれ。 */
  reasons(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of this.#dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
    return out;
  }

  /** ログの 1 行（`候補 92 / 採った 76 / 落とした 16（no-vote-link 16）`）。 */
  line(): string {
    const r = this.reasons();
    const detail = Object.keys(r).length === 0 ? "" : `（${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ")}）`;
    return `候補 ${this.#seen} / 採った ${this.#taken} / 落とした ${this.#dropped.length}${detail}`;
  }

  /** 別の段の母数を足し込む（佐賀・秋田・滋賀のようにページが複数ある県で使う）。 */
  absorb(other: SessionTally): void {
    this.#seen += other.seen;
    this.#taken += other.taken;
    this.#dropped.push(...other.dropped);
  }
}
