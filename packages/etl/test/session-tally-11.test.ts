import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { SessionTally } from "../src/sources/local/session-tally.ts";
import * as miyagi from "../src/sources/local/miyagi/sessions.ts";
import * as tottori from "../src/sources/local/tottori/sessions.ts";
import * as kochi from "../src/sources/local/kochi/sessions.ts";
import * as nara from "../src/sources/local/nara/sessions.ts";
import * as shimane from "../src/sources/local/shimane/sessions.ts";
import * as mie from "../src/sources/local/mie/sessions.ts";
import * as tokushima from "../src/sources/local/tokushima/sessions.ts";
import * as aomori from "../src/sources/local/aomori/sessions.ts";
import * as shiga from "../src/sources/local/shiga/sessions.ts";
import * as saga from "../src/sources/local/saga/sessions.ts";
import * as akita from "../src/sources/local/akita/sessions.ts";
import { AOMORI_INDEX_URL } from "../src/sources/local/aomori/site.ts";
import { KOCHI_DECISION_URL } from "../src/sources/local/kochi/site.ts";
import { TOKUSHIMA_ORIGIN } from "../src/sources/local/tokushima/site.ts";
import { shigaYearUrl } from "../src/sources/local/shiga/site.ts";
import { SAGA_ORIGIN } from "../src/sources/local/saga/site.ts";
import { AKITA_HOST } from "../src/sources/local/akita/site.ts";

/**
 * **11 県の会期一覧の母数**（Issue #895）。
 *
 * ## このテストが守るもの
 * **会期の一覧を読む実装は、条件に合わない行を例外ではなく `continue` で飛ばす。**
 * **飛ばすこと自体は要る**（表決の公開が無い会期・ページ送り・飾りのリンク）。
 * **危ないのは「飛ばしたことが誰にも見えない」ことである**——
 * **#871 は宮城で 7 本、#873 は鳥取で 25 会期が黙って消えているのを見つけたが、
 * そのあいだテストはずっと緑だった。**
 *
 * **ここでは県ごとに「候補の数（母数）」「採った数」「落とした理由ごとの数」を固定する。**
 * **`continue` が 1 本増えれば数が動き、このテストが赤になる。**
 *
 * ## 数は**この worktree のフィクスチャ**に当てた実測である（2026-09-16）
 * **実物のサイトの今日の本数ではない。** **フィクスチャを取り直したら、この数も測り直すこと。**
 *
 * ## 母数の意味は県によって違う（**そろえていない。そろえると嘘になる**）
 * **高知・滋賀・佐賀はページ全体（またはページの本文全体）の `<a>` を候補にしているので、
 * ナビゲーションのリンクが母数に入る。** **宮城・三重・青森は会期の見出しだけが候補である。**
 * **「母数が大きい県ほど取りこぼしている」ではない。** **見ているのは「その県の数が動いたか」だけ。**
 */
const fx = (p: string): string => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8");
const sjis = (p: string): string => iconv.decode(readFileSync(new URL(`./fixtures/${p}`, import.meta.url)), "Shift_JIS");

interface Measured {
  /** 見た候補（採った ＋ 落とした） */
  seen: number;
  taken: number;
  /** 落とした理由ごとの件数（0 の理由は載らない） */
  reasons: Record<string, number>;
  /** パーサが実際に返した会期の本数（**`taken` と一致しなければ、母数の付け忘れである**） */
  returned: number;
}

/** 県ごとに、その県の index フィクスチャを読み切って母数を測る。 */
const MEASURE: Record<string, () => Measured> = {
  宮城: () => {
    const t = new SessionTally();
    const s = miyagi.parseSessionIndex(fx("miyagi/kakohonkaigi.html"), miyagi.sessionIndexUrl, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: s.length };
  },
  鳥取: () => {
    const t = new SessionTally();
    const s = tottori.parseSessionIndex(fx("tottori/87621.htm"), tottori.SESSION_INDEX_URL, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: s.length };
  },
  高知: () => {
    const t = new SessionTally();
    const s = kochi.parseSessionIndex(fx("kochi/decision.html"), KOCHI_DECISION_URL, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: s.length };
  },
  奈良: () => {
    const t = new SessionTally();
    const s = nara.parseSessionIndex(fx("nara/18579.html"), nara.SESSION_INDEX_URL, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: s.length };
  },
  島根: () => {
    // **index が 2 枚ある**（saikin ＝ 直近、gikai_kako ＝ 過去）。両方を 1 つの母数にまとめる
    const t = new SessionTally();
    const a = shimane.parseSessionIndex(fx("shimane/saikin.html"), shimane.SESSION_INDEX_URL, t);
    const b = shimane.parseSessionIndex(fx("shimane/gikai_kako.html"), shimane.SESSION_ARCHIVE_URL, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: a.length + b.length };
  },
  三重: () => {
    const t = new SessionTally();
    const s = mie.parseSessionIndex(fx("mie/07976009017.htm"), mie.SESSION_INDEX_URL, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: s.length };
  },
  徳島: () => {
    // **年ごとにページが分かれる**（今年 ＋ 令和7年）
    const t = new SessionTally();
    let returned = 0;
    for (const f of ["tokushima/gaiyou.html", "tokushima/gaiyou-r07.html"]) {
      returned += tokushima.parseSessionIndex(fx(f), `${TOKUSHIMA_ORIGIN}/gikai/honkaigi/gaiyou/`, t).sessions.length;
    }
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned };
  },
  青森: () => {
    const t = new SessionTally();
    const s = aomori.parseIndex(fx("aomori/katsudo-shinsakekka.html"), AOMORI_INDEX_URL, t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: s.length };
  },
  滋賀: () => {
    // **年ページは年度（fiscal）と暦年（calendar）の 2 通りある**（#741）。両方読む
    const t = new SessionTally();
    const a = shiga.parseYearPage(sjis("shiga/year-2026.html"), shigaYearUrl(2026, "fiscal"), t);
    const b = shiga.parseYearPage(sjis("shiga/year-2026-t0.html"), shigaYearUrl(2026, "calendar"), t);
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned: a.length + b.length };
  },
  佐賀: () => {
    // **種別ページ（定例会・臨時会）ごとに会期が並ぶ**
    const t = new SessionTally();
    let returned = 0;
    for (const [f, u] of [["saga/category-r8-teirei.html", "list06636.html"], ["saga/category-r8-rinji.html", "list06670.html"]] as const) {
      returned += saga.parseCategoryPage(fx(f), `${SAGA_ORIGIN}/gikai/${u}`, t).length;
    }
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned };
  },
  秋田: () => {
    // **会期の見出しは使えないので、年度ページの賛否 PDF リンクが会期の代わり**（#759）
    const t = new SessionTally();
    let returned = 0;
    for (const id of ["2026021300064", "2018051400043", "2018051400098"]) {
      returned += akita.parseYearPage(fx(`akita/year-${id}.html`), `https://${AKITA_HOST}/doc/${id}/`, t).length;
    }
    return { seen: t.seen, taken: t.taken, reasons: t.reasons(), returned };
  },
};

/**
 * **実測（2026-09-16、このリポジトリのフィクスチャ）。**
 * **`reasons` に `not-a-session` が残っている県は、「落ちているが、それは会期ではない」と
 * 中身を見て確かめたものだけである**（下の各行のコメント）。
 */
const EXPECTED: Record<string, Measured> = {
  // **#895 で 2 つのほころびを直したので `not-a-session` は 0 になった**（直す前は 7 本落ちていた）。
  // 残る 16 本は平成18年〜平成21年で、index に「各議員の表決状況」のリンクがそもそも無い（公表が無い）
  宮城: { seen: 92, taken: 76, reasons: { "no-vote-link": 16 }, returned: 76 },
  // `<a id="itemid…"></a>`（`href` の無いアンカーだけ）が 14 本、ページ送りの「次のページ」が 1 本
  鳥取: { seen: 88, taken: 73, reasons: { "not-a-candidate": 14, "not-a-session": 1 }, returned: 73 },
  // **ページ全体の `<a>` を候補にしている**ので、ヘッダ・サイドメニュー・フッタが母数に入る
  // （「ホーム」「サイトマップ」「Twitter」など。**会期の文言に似たものは 1 本も無い**——中身を見て確かめた）
  高知: { seen: 105, taken: 65, reasons: { "not-a-session": 40 }, returned: 65 },
  // `#tmp_contents` の中は会期のリンクしか無い
  奈良: { seen: 31, taken: 31, reasons: {}, returned: 31 },
  // `#page-content` の中は会期のリンクしか無い（saikin 1 本 ＋ gikai_kako 106 本）
  島根: { seen: 107, taken: 107, reasons: {}, returned: 107 },
  // 平成19年以前の 31 会期には「議員別の賛否等の状況」の節が無い（公表が無い）
  三重: { seen: 61, taken: 30, reasons: { "no-vote-link": 31 }, returned: 30 },
  // figcaption の無い `<figure>`（写真だけ）が 6 本
  徳島: { seen: 12, taken: 6, reasons: { "not-a-candidate": 6 }, returned: 6 },
  // 第275回より前は会派別で、個人票ではない（#529 が両方開いて確かめた）
  青森: { seen: 76, taken: 56, reasons: { "before-personal-votes": 20 }, returned: 56 },
  // 年ページの h2 にはナビの見出し（「議員の情報」「会議録」…）が混ざる。
  // `no-vote-link` 1 本は令和8年9月定例会議（**会期中でまだ賛否状況のリンクが無い**。#741 が確かめた）
  滋賀: { seen: 26, taken: 5, reasons: { "not-a-session": 20, "no-vote-link": 1 }, returned: 5 },
  // 種別ページの本文には会期のほかに「概要」「議事日程」「議案件名一覧表」などの記事リンクが並ぶ
  佐賀: { seen: 33, taken: 4, reasons: { "not-a-session": 29 }, returned: 4 },
  // サイドバーの SNS 運用方針 PDF が 1 本（賛否 PDF ではない）
  秋田: { seen: 14, taken: 13, reasons: { "not-a-candidate": 1 }, returned: 13 },
};

test("#895 11 県すべてで母数が測れる（測れない県が 1 つも無い）", () => {
  assert.deepEqual(Object.keys(MEASURE).sort(), Object.keys(EXPECTED).sort());
  assert.equal(Object.keys(MEASURE).length, 11, "11 県ある");
});

for (const [pref, measure] of Object.entries(MEASURE)) {
  test(`#895 ${pref}: index の候補・採った数・落とした理由が実測どおり（黙って落ちる行が増えれば赤になる）`, () => {
    const got = measure();
    assert.deepEqual(got, EXPECTED[pref], `${pref} の母数が動いた`);
    // **母数の検算**（#757）: 候補 ＝ 採った ＋ 落とした、かつ 採った ＝ 実際に返した本数
    assert.equal(got.seen, got.taken + Object.values(got.reasons).reduce((a, b) => a + b, 0), `${pref}: 候補 ≠ 採った + 落とした`);
    assert.equal(got.taken, got.returned, `${pref}: 採った数とパーサが返した本数が食い違う（母数の付け忘れ）`);
    // **母数が空なら、この県は何も測れていない**（測り忘れを緑にしない）
    assert.ok(got.seen > 0, `${pref}: 候補が 0 本（フィクスチャを読めていない）`);
  });
}

test("#895 11 県の合計（この PR が見ている母数の全体）", () => {
  let seen = 0, taken = 0, dropped = 0;
  for (const m of Object.values(MEASURE)) {
    const g = m();
    seen += g.seen;
    taken += g.taken;
    dropped += Object.values(g.reasons).reduce((a, b) => a + b, 0);
  }
  assert.deepEqual({ seen, taken, dropped }, { seen: 645, taken: 466, dropped: 179 });
  assert.equal(seen, taken + dropped);
});

/**
 * **奈良と島根は落とす行が 0 本である**（実測。上の EXPECTED を見よ）。
 * **だから「落としたことが出る仕組み」を壊しても、この 2 県のテストは赤にならない**
 * （**等価変異ではない。到達しないだけである**——変異テストで実際に生き残った）。
 * **この 2 県だけは「落ちる行が 1 本でも出たら赤になる」を別に固定する。**
 */
for (const [pref, measure] of [["奈良", MEASURE.奈良], ["島根", MEASURE.島根]] as const) {
  test(`#895 ${pref}: 落とす行は 0 本のまま（1 本でも落ちたら、その理由ごと赤になる）`, () => {
    const got = measure();
    assert.deepEqual(got.reasons, {}, `${pref}: 今まで 0 本だったのに落ちる行が出た`);
    assert.equal(got.seen, got.taken, `${pref}: 候補と採った数が食い違う`);
  });
}

/**
 * **宮城の 2 つのほころび**（#871 が実測、#895 で直した）。
 * **どちらも「読めなかった」ではなく「見えていなかった」**——例外は 1 つも出ていなかった。
 */
test("#895 宮城: `令和元年`（和暦の最初の年）が見える。直す前は `\\d+年` に当たらず黙って落ちていた", () => {
  const got = miyagi.parseSessionIndex(fx("miyagi/kakohonkaigi.html"), miyagi.sessionIndexUrl);
  assert.deepEqual(
    got.filter((s) => s.sessionLabel.includes("令和元年")).map((s) => `${s.sessionId} ${s.sessionLabel}`),
    ["370 令和元年11月定例会（第370回）", "369 令和元年9月定例会（第369回）", "368 令和元年6月定例会（第368回）"],
  );
});

test("#895 宮城: 開き括弧だけが ASCII の `(` の見出しが見える。直す前は 4 本が黙って落ちていた", () => {
  const got = miyagi.parseSessionIndex(fx("miyagi/kakohonkaigi.html"), miyagi.sessionIndexUrl);
  // **ラベルは原文のまま**（括弧をそろえない。**推定しない**）
  assert.deepEqual(
    got.filter((s) => s.sessionLabel.includes("(")).map((s) => `${s.sessionId} ${s.sessionLabel}`),
    [
      "357 平成28年9月定例会(第357回）",
      "356 平成28年6月定例会(第356回）",
      "355 平成28年2月定例会(第355回）",
      "354 平成27年11月定例会(第354回）",
    ],
  );
});

/** **鳥取の文言**（#873 が実測、#895 で直した）。**完全一致だと 73 会期のうち 47 会期しか当たらない。** */
test("#895 鳥取: 会期ページの議決結果リンクは `議決結果` でも `議案等の議決結果` でも当たる", () => {
  const base = "https://www.pref.tottori.lg.jp/328133.htm";
  // フィクスチャ（実物）は `議案等の議決結果`
  assert.equal(tottori.parseSessionPage(fx("tottori/328133.htm"), base), "https://www.pref.tottori.lg.jp/328150.htm");
  // **#873 が実測した古い会期の文言**（フィクスチャに実物が無いので、文言だけを組んで確かめる）
  assert.equal(
    tottori.parseSessionPage('<html><body><a href="/1.htm">議決結果</a></body></html>', base),
    "https://www.pref.tottori.lg.jp/1.htm",
  );
  // **別物には当たらない**（賛否の PDF ページ・日程）
  assert.equal(tottori.parseSessionPage('<html><body><a href="/2.htm">議員別の賛否の状況</a><a href="/3.htm">日程</a></body></html>', base), undefined);
});
