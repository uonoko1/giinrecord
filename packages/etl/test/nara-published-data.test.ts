import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { NARA_HOST } from "../src/sources/local/nara/site.ts";

/**
 * **本番 `data/assemblies/pref-29/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出しが壊れたらここが落ちる。**
 *
 * **#864 の `published-data-validate.test.ts` とは重ならない**——あちらは**全県まとめて構造の不変条件**。
 *
 * ## **奈良は「PDF が集計を印刷していない」県**
 *
 * **125 / 125 本すべてに `counts` が無い**（三重・宮城・滋賀は全本にある）。
 * **つまり #529 の「○ の数 = 公表値」という検算が、奈良では 1 件も走らない。**
 * **共通の検算（`countMismatchesOf`）は「違反 0 件」を返すが、それは「1 件も見ていない」からである**
 * （#757 が `countChecked` を足した理由そのもの）。
 * **だから奈良では、代わりに別のものを見るしかない**——
 * **議決日ごとの列数・`議` の位置・名簿との突き合わせ。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-29");

const rollCalls = (): LocalRollCall[] => {
  const out: LocalRollCall[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== "index.json" && e.name.endsWith(".json")) out.push(JSON.parse(readFileSync(p, "utf-8")) as LocalRollCall);
    }
  };
  walk(join(DIR, "rollcalls"));
  return out;
};
const hasData = (() => { try { return statSync(join(DIR, "meta.json")).isFile(); } catch { return false; } })();
const meta = (): LocalAssemblyMeta => JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
const members = (): LocalMember[] =>
  (JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[]).filter((m) => m.assemblyId === "pref-29");

test("#865 本番 pref-29: 採決 125 × 議員 40 = 5,000 セル、未突合 0", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（令和8年2月定例会 88 本 + 令和8年6月定例会 37 本）
  assert.equal(m.counts.rollcalls, 125);
  assert.equal(m.counts.members, 40);
  assert.equal(m.counts.cells, 5_000);
  assert.equal(m.counts.unknownCells, 0, "**推定せず `不明` で残したセルは 0**");
  assert.equal(m.counts.unmatchedNames, 0, "**名簿に寄らなかった氏名は 0**");
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **125 × 40 の長方形**（**1 人静かに落ちても合計は合ってしまう**ので行ごとに見る。#705 が滋賀で踏んだ形）
  assert.deepEqual([...new Set(rcs.map((r) => r.votes.length))], [40], "採決ごとの票数");
  assert.equal(125 * 40, 5_000, "母数を式で残す");
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2026-02", 88], ["2026-06", 37]]);
  // **未突合 0 ＝ 5,000 票すべてに `memberId` がある**
  assert.deepEqual(JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")), []);
  assert.deepEqual(rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "").map((v) => v.nameText), []);
});

/**
 * ## **`counts` が 1 本も無い**——**「違反 0 件」と「1 件も見ていない」の区別**（#757）
 *
 * **共通の検算はここでは何も見ていない。** そのことを**数字で固定する**——
 * **もし将来 PDF が集計を載せ始めたら、この行が落ちて気づける**（今は黙って 0 件のまま通る）。
 */
test("#865 本番 pref-29: counts を持つ採決は 0 / 125 本（共通の検算はここでは 1 件も走らない）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 125, "母数");
  assert.deepEqual(rcs.filter((r) => r.counts !== undefined).map((r) => r.id), [], "`counts` を持つ採決");
  // **`countChecked` がそう言っている**（`noCounts` で 125 本ぶん外している）
  assert.deepEqual(meta().countChecked, { rows: 125, checked: 0, noCounts: 125, unreadableCells: 0 });
  assert.equal(meta().countMismatches, undefined, "突き合わせていないので食い違いも無い（省略される）");
  // **`unreadableCells` が 0 なのは「読めないセルが無い」からではない**——
  // **`mapped` の無い票は 17 ある**（`退` ＝ 表決を棄権）が、
  // **`countMismatchesOf` は `counts` の無い行を先に外すので、この 17 票はそこまで届かない。**
  // **`countChecked` の 2 つの欄は排他である**、という実装の形をここで固定する。
  assert.equal(rcs.flatMap((r) => r.votes).filter((v) => v.value.mapped === undefined).length, 17);
});

test("#865 本番 pref-29: 票 5,000 の内訳（○ 4652 / 欠 176 / 議 125 / × 28 / 退 17 / 除 2）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 5_000, "母数（減っていたら以下の内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort((a, b) => b[1] - a[1])),
    { "○": 4652, "欠": 176, "議": 125, "×": 28, "退": 17, "除": 2 });
  // **凡例は PDF の原文をそのまま持つ**——**`×` は「反対」ではなく
  // 「反対（起立採決において、起立しなかった議員）」**。**短く言い換えない**（#569）。
  assert.deepEqual(Object.fromEntries([...legend].sort((a, b) => b[1] - a[1])), {
    "賛成": 4652,
    "欠席": 176,
    "議長": 125,
    "反対（起立採決において、起立しなかった議員）": 28,
    "表決を棄権": 17,
    "除斥": 2,
  });
  assert.equal(raw.get("不明"), undefined, "`不明` の票");
  assert.equal(legend.get("抽出不能"), undefined, "`抽出不能` の票");
  // **`退`（表決を棄権）だけ `mapped` が無い**——**賛成でも反対でも「投票なし」でもない、と決めていない。**
  // **`欠` `議` `除` は `投票なし` に落ちる。`退` を勝手にそこへ入れない**（#569）。
  const noMapped = votes.filter((v) => v.value.mapped === undefined);
  assert.equal(noMapped.length, 17);
  assert.deepEqual([...new Set(noMapped.map((v) => v.value.raw))], ["退"]);
  assert.deepEqual(Object.fromEntries([...votes.reduce((m2, v) => m2.set(v.value.mapped ?? "(なし)", (m2.get(v.value.mapped ?? "(なし)") ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])), { "賛成": 4652, "投票なし": 176 + 125 + 2, "反対": 28, "(なし)": 17 });
});

/**
 * ## **`議` は 125 / 125 本で 1 人だが、同じ日の中で 2 本だけ別人に移る**（奈良の要点）
 *
 * **2026-07-02 の 37 本のうち 35 本は `田中惟允`、2 本だけ `乾浩之`**——
 * **議第68号（副知事の選任）と議第69号（監査委員の選任）**。
 * **その 2 本では `田中惟允` が `○` を出している**（議長席を降りて表決に加わっている）。
 *
 * **「議長は会期を通じて同じ 1 人」は佐賀（#768）と宮城では成り立つが、奈良では偽。**
 * **「議長は採決に加わらない」も奈良では偽。**
 * **`議` は行ごとに読む。推定しない**（`nara-votes-pdf.test.ts` が PDF 側で同じ 2 行を見ている。
 * **ここは書き出した `data/` 側で 125 本すべてを数えている**——**層が違う**）。
 */
test("#865 本番 pref-29: `議` は 125 本すべてで 1 人、うち 2 本だけ議長席が別人（議第68号・69号）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const byDate = new Map<string, Map<string, number>>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      assert.equal(v.value.legend, "議長", rc.id);
      assert.equal(v.value.mapped, "投票なし", rc.id);
      assert.notEqual(v.memberId, "", `${rc.id}: \`議\` が名簿に寄っていない`);
      const k = `${rc.sessionId}/${rc.date}`;
      const s = byDate.get(k) ?? new Map<string, number>();
      s.set(v.nameText, (s.get(v.nameText) ?? 0) + 1);
      byDate.set(k, s);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 125 }, "採決ごとの `議` の数（母数 125）");
  assert.deepEqual(
    Object.fromEntries([...byDate].map(([k, v]) => [k, Object.fromEntries([...v].sort())]).sort()),
    { "2026-02/2026-03-25": { "田中惟允": 88 }, "2026-06/2026-07-02": { "乾浩之": 2, "田中惟允": 35 } },
    "**議決日ごとに `議` が誰で何本か**",
  );
  // **`乾浩之` が `議` の 2 本は 人事案件**。**その 2 本で `田中惟允` は `○`**
  const swapped = rcs.filter((r) => r.votes.some((v) => v.value.raw === "議" && v.nameText === "乾浩之"));
  assert.deepEqual(swapped.map((r) => r.title).sort(), ["副知事の選任について", "監査委員の選任について"]);
  for (const r of swapped) {
    assert.equal(r.votes.find((v) => v.nameText === "田中惟允")!.value.raw, "○", `${r.id}: 田中惟允`);
  }
  // **逆に、ほかの 35 本では `乾浩之` が `○`**（同じ日に役が入れ替わっている）
  const normal = rcs.filter((r) => r.date === "2026-07-02" && !swapped.includes(r));
  assert.equal(normal.length, 35);
  assert.deepEqual([...new Set(normal.map((r) => r.votes.find((v) => v.nameText === "乾浩之")!.value.raw))], ["○"]);
  // **`除斥` の 2 票も同じ 議第69号**（人事案件で当事者が外れる）
  const jogaku = rcs.flatMap((r) => r.votes.filter((v) => v.value.raw === "除").map((v) => [r.title, v.nameText]));
  assert.deepEqual(jogaku.map(([t]) => t), ["監査委員の選任について", "監査委員の選任について"]);
});

/**
 * ## **`lossyNameMatches` が 2 件**——**字が落ちたまま名簿に寄った氏名**（#750 が青森で足した欄）
 *
 * **奈良の PDF は縦書きで、外字が文字層から落ちる列がある**（`nara/rollcalls.ts` の docblock）:
 *   - **`西川` ← `西川 均`**（`均` が落ちる。**125 本すべて**）
 *   - **`髙清友` ← `芦高 清友`**（`芦` が落ちる。**6月定例会の 37 本だけ**。`髙`/`高` は `ITAIJI` で寄る）
 *
 * **寄せ方は変えない**（#569）が、**「寄せた」という事実と「何が落ちたか」を残す**。
 * **このテストは「同一人物である」と主張していない**——
 * **ETL が部分列一致で寄せた、という事実と、その件数を固定しているだけ**（#796）。
 * **件数が増えたら、それは新しい欠落が起きたということ。**
 */
test("#865 本番 pref-29: 字が落ちたまま寄った氏名は 2 件（西川 125 本 / 髙清友 37 本）", { skip: !hasData }, () => {
  const lossy = meta().lossyNameMatches;
  assert.ok(lossy, "`lossyNameMatches` がある（奈良は省略されない）");
  assert.deepEqual(
    lossy!.map((l) => ({ nameText: l.nameText, memberId: l.memberId, rosterName: l.rosterName, rollCalls: l.rollCalls }))
      .sort((a, b) => a.memberId.localeCompare(b.memberId)),
    [
      { nameText: "髙清友", memberId: "p_29_52536", rosterName: "芦高 清友", rollCalls: 37 },
      { nameText: "西川", memberId: "p_29_52575", rosterName: "西川 均", rollCalls: 125 },
    ],
  );
  // **符号位置で機序が分かる**（推定ではなく、文字そのものが違う）
  assert.equal("髙".codePointAt(0), 0x9ad9, "PDF 側は `髙` U+9AD9");
  assert.equal("高".codePointAt(0), 0x9ad8, "名簿側は `高` U+9AD8");

  // **`data/` の実物と一致する**（meta だけを書き換えても落ちる）
  const rcs = rollCalls();
  const byMember = new Map<string, Map<string, number>>();
  for (const r of rcs) {
    for (const v of r.votes) {
      const s = byMember.get(v.memberId) ?? new Map<string, number>();
      s.set(v.nameText, (s.get(v.nameText) ?? 0) + 1);
      byMember.set(v.memberId, s);
    }
  }
  assert.deepEqual(Object.fromEntries(byMember.get("p_29_52575")!), { "西川": 125 });
  // **`芦高 清友` は PDF 側で 2 通りの書かれ方をする**（2月定例は `芦󠄀髙清友`、6月定例は `髙清友`）
  assert.deepEqual(Object.fromEntries([...byMember.get("p_29_52536")!].sort()),
    { "髙清友": 37, "芦\u{E0100}髙清友": 88 });
  // **2 通りに書かれる議員はこの 1 人だけ**（母数 40 人）
  assert.equal(byMember.size, 40, "票に出る議員");
  assert.deepEqual([...byMember].filter(([, v]) => v.size > 1).map(([k]) => k), ["p_29_52536"]);
});

/** **出典はすべて県の公式ホスト**（**採決 125 本 + meta の 6 出典 + 会期 2 本**）。 */
test("#865 本番 pref-29: sourceUrl はすべて www.pref.nara.lg.jp（PDF は 2 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  assert.equal(urls.length, 125 + 6 + (1 + 1 + 1) * 2, "**見た URL の本数**（0 本を「違反なし」と読み違えないため）");
  const bad = urls.filter((u) => new URL(u).host !== NARA_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  assert.deepEqual([...new Set(rcs.map((r) => r.sourceUrl))].sort(), [
    "https://www.pref.nara.lg.jp/documents/21459/20260325_giinbetsu_hyoketsu.pdf",
    "https://www.pref.nara.lg.jp/documents/24098/20260702_giinbetsu_hyoketsu.pdf",
  ]);
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 2, "meta の出典の PDF");
  assert.equal(m.unreadableSources, undefined, "読めなかった一次資料は無い（省略される）");
  assert.equal(m.rosterAsOf, "2026-04-24");
  // **全部の採決に日付と件名がある**（名の無い採決・日付の無い採決を出さない）
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  assert.deepEqual(rcs.filter((r) => r.title === "").map((r) => r.id), [], "件名が空の採決");
  assert.equal(new Set(rcs.map((r) => r.id)).size, 125, "id の重複");
});

/** **名簿 40 人**——**かな・選挙区・会派が全員にあり、全員が 125 本すべてに出る**（#632／#718）。 */
test("#865 本番 pref-29: 名簿 40 人・全員が 125 本すべてに出る", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 40, "母数");
  assert.deepEqual(ms.filter((m) => m.kana === "").map((m) => m.name), [], "かなが空の議員");
  assert.deepEqual(ms.filter((m) => m.district === "").map((m) => m.name), [], "選挙区が空の議員");
  assert.deepEqual(ms.filter((m) => m.group === "").map((m) => m.name), [], "会派が空の議員");
  assert.deepEqual(ms.filter((m) => !m.profileUrl.startsWith(`https://${NARA_HOST}/`)).map((m) => m.name), [], "別ホストの profileUrl");
  assert.equal(new Set(ms.map((m) => m.id)).size, 40, "id の重複");
  // **40 人全員がちょうど 125 本**（宮城・三重・滋賀はここが割れる。奈良は割れない）
  assert.deepEqual([...new Set(ms.map((m) => m.counts?.rollcalls))], [125], "議員ごとの採決数");
});
