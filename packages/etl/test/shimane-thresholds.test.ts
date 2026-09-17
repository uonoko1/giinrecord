import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkReferredOffset, checkTitleOffset, parseResultsPdf, parseVotePdf } from "../src/sources/local/shimane/votes-pdf.ts";
import { parseSessionPage } from "../src/sources/local/shimane/sessions.ts";

/**
 * 島根県議会の表決 PDF の **閾値 3 つ** と **議決結果一覧 PDF の URL の作り方** を見張る（Issue #896）。
 *
 * ## **なぜ足したか**
 *
 * **#874 が 14 本を全部開いて、3 つの閾値がどれも「今のフィクスチャでしか通らない」ことを実測した。**
 * **どれも「今は表面化していない」が、会期を広げた瞬間に効く:**
 *
 * | | 直す前 | 実測 | 直した後 |
 * |---|---|---|---|
 * | `MAX_TITLE_OFFSET` | **8** | **2024-09 で −12.36pt の偽陽性**（ETL が `throw` で止まる） | **15** |
 * | `HEADER_GAP` | **6** | **2023-11 / 2023-06 で 9.15pt あり本文に漏れる**。**2026-06 の余裕は 0.12pt** | **閾値をやめ、PDF のヘッダの字から引く** |
 * | `BLOCK_GAP` | **13** | **13 本中 12 本で「同じ議案の中」と「別の議案の間」の隙間が重なる** | **閾値をやめ、件名と同じ切り分けに変える** |
 *
 * **加えて「議決結果一覧」PDF の URL を文字列置換で組み立てていたのが 14 本中 4 本で外れ、
 * うち 1 本は HTTP 200 で「表決 PDF そのもの」が返っていた**（＝**議決日を誤った資料から読む経路**）。
 *
 * ## **このファイルが主張するのは「読める」であって「出す」ではない**
 *
 * **`data/` は 1 行も変えていない。** **新しく読めるようになった本を本番に出すかは別の PBI で決める。**
 */
const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));
const html = (name: string): string => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url), "utf8");

/* ==================== 1. MAX_TITLE_OFFSET ==================== */

/**
 * **2024-09 は、直す前は `件名 is -12.4pt off the row centre (max 8)` で止まっていた。**
 * **#874 が座標で確かめたとおり、`splitTitleCells` の割り当ては正しい**——
 * **請願第14号の件名が 25 行の請願本文そのもので、その塊の中心を PDF が行の中心ぴったりに置いていないだけである。**
 */
test("#896 2024-09 は読める（直す前は MAX_TITLE_OFFSET=8 の偽陽性で ETL が止まっていた）", async () => {
  const pdf = await parseVotePdf(fixture("r0609_giinbetu_kekka.pdf"));
  assert.equal(pdf.rows.length, 35);
  // **偽陽性を起こしていた行が、いま正しく 1 議案に収まっている**
  const petition = pdf.rows.find((r) => r.number === "請願第14号");
  assert.ok(petition, "請願第14号");
  assert.equal(petition.titleOffset.toFixed(2), "-12.36", "#874 が測った値そのもの");
  // **件名は請願本文そのもの**（字数で見張らない。**68 字 1 セルも 610 字 1 セルも正しい**）
  assert.ok([...petition.title].length > 500, `請願第14号の件名は ${[...petition.title].length} 字`);
  // **隣の議案の件名が混ざっていない**——請願第15号・第16号が別の行として立っている
  assert.ok(pdf.rows.some((r) => r.number === "請願第15号"), "請願第15号が別の行として立っている");
  // **他の 34 行は 0.30pt 以下**（＝大きくずれているのはこの 1 行だけ）
  const others = pdf.rows.filter((r) => r.number !== "請願第14号").map((r) => Math.abs(r.titleOffset));
  assert.equal(others.length, 34, "残りの行数");
  // **浮動小数の端数があるので小数 2 桁で比べる**（実測値は 0.3000000000000682）
  assert.equal(Math.max(...others).toFixed(2), "0.30", "残り 34 行の最大");
});

/**
 * **緩めた側で誤りが通らないことを確かめる**（#896 の「必ず守ること」）。
 *
 * **14 本の実測で、正しい側と壊れている側は二山に分かれている:**
 *
 * | | 正しい側（8 本・320 行） | 壊れている側（同じ 8 本・210 行） |
 * |---|---|---|
 * | 最大 | **12.36pt** | **47.15pt** |
 * | **最小（0.30pt より大きいもの）** | 5.16 | **17.88pt** |
 * | **12.36 と 17.88 の間にある行** | **0 行** | **0 行** |
 *
 * **`15` はその間にある。** **8 〜 17 のどの値でも、壊れている側で落ちる行は 210 行中 10 行で変わらない。**
 */
test("#896 MAX_TITLE_OFFSET=15: 正しい側の最大 12.36 は通り、壊れている側の最小 17.88 は落ちる", () => {
  // **通る側**: 14 本の実測で正しいと確かめた値
  assert.doesNotThrow(() => { checkTitleOffset(3, "請願第14号", "本年7月10日…", -12.36); }, "2024-09 請願第14号（#874 が座標で正しいと確かめた）");
  assert.doesNotThrow(() => { checkTitleOffset(3, "請願第30号", "平成25年6月議会で…", 5.16); }, "2026-06 請願第30号");
  // **境界そのもの**（`>` であって `>=` ではない）
  assert.doesNotThrow(() => { checkTitleOffset(1, "第1号", "x", 15); });
  assert.throws(() => { checkTitleOffset(1, "第1号", "x", 15.1); }, /off the row centre/);
  // **落ちる側**: 壊れている側の最小と最大
  assert.throws(() => { checkTitleOffset(3, "請願第14号", "x", 17.88); }, /off the row centre \(max 15\)/, "壊れている側の最小");
  assert.throws(() => { checkTitleOffset(3, "請願第２号", "x", -47.15); }, /off the row centre/, "壊れている側の最大");
  // **#866 が直した 5 件は、緩めた後もすべて落ちる**（緩めて壊れ方が戻っていないこと）
  for (const o of [-31.6, -27.4, 27.35, -27.35, 30.78]) {
    assert.throws(() => { checkTitleOffset(5, "承認第２号", "x", o); }, /off the row centre/, `#866 の ${o}pt`);
  }
});

/* ==================== 2. HEADER_GAP ==================== */

/**
 * **2023-06 は、直す前は `賛成/反対 "成35"/"対0" is not a number` で止まっていた。**
 * **機序**: ヘッダ「賛 成」「反 対」の 2 文字目が `付託委員会` の y から **9.15pt** 下にあり、
 * **一律 `6pt` の境目より下＝本文の側に落ちる。**
 * **直した後はヘッダの字の位置から境目を引くので、本によって距離が違っても関係ない。**
 */
test("#896 2023-06 は読める（直す前は HEADER_GAP=6 を 9.15pt が超えて「成35」になっていた）", async () => {
  const pdf = await parseVotePdf(fixture("r0506_giinbetu_kekka.pdf"));
  assert.equal(pdf.rows.length, 27);
  // **「成35」ではなく、数として読めている**
  const first = pdf.rows[0];
  assert.equal(first.number, "第73号");
  assert.equal(first.counts.yes + first.counts.no > 0, true, `賛成 ${first.counts.yes} / 反対 ${first.counts.no}`);
  // **全行で賛成・反対が数になっている**（1 行でも「成35」が残っていれば parseVotePdf が落ちるが、母数を書く）
  assert.equal(pdf.rows.filter((r) => Number.isInteger(r.counts.yes) && Number.isInteger(r.counts.no)).length, 27);
  // **ヘッダの「成」「対」が本文に紛れ込んでいない**——件名にその字だけの行が無い
  assert.equal(pdf.rows.filter((r) => r.title === "成" || r.title === "対").length, 0);
});

/**
 * **本番に出ている 2026-06 の余裕は 0.12pt しか無かった**（#874 の実測 5.88pt に対し閾値 6）。
 * **「いま通っているから大丈夫」ではない、ということをこのテストが固定する。**
 */
test("#896 2026-06 の「賛成の 2 文字目」は付託委員会の 5.88pt 下——一律 6pt では余裕が 0.12pt しか無かった", async () => {
  const { readPages } = await import("../src/sources/local/pdf-table.ts");
  const pages = await readPages(fixture("r0806_giinbetu_kekka.pdf"));
  for (const [pi, page] of pages.entries()) {
    const head = page.items.find((i) => i.str === "付託委員会");
    assert.ok(head, `page ${pi + 1} の 付託委員会`);
    const sei = page.items.find((i) => i.str === "成" && i.y < head.y && head.y - i.y < 26);
    assert.ok(sei, `page ${pi + 1} の 成`);
    assert.equal((head.y - sei.y).toFixed(2), "5.88", `page ${pi + 1}: 付託委員会 から 成 までの距離`);
  }
});

/* ==================== 3. BLOCK_GAP ==================== */

/**
 * **2025-06 は、直す前は `付託委員会 is empty` で止まっていた。**
 * **機序**（#874 が座標で確かめた）: **同じ議案の中の隙間 10.08pt と、別の議案の間の隙間 10.08pt が同じ。**
 * **`BLOCK_GAP` をどの値にしても分けられない。**
 */
test("#896 2025-06 は読める（同じ議案の中と別の議案の間の隙間がどちらも 10.08pt で、閾値では分けられない本）", async () => {
  const pdf = await parseVotePdf(fixture("r0706_giinbetu_kekka.pdf"));
  assert.equal(pdf.rows.length, 35);
  // **付託委員会が 1 つも空でない**（母数を書く）
  assert.equal(pdf.rows.filter((r) => r.referredCommittees.length > 0).length, 35);
  // **4 つ付託された議案・3 つ付託された議案がそれぞれ正しく分かれている**
  const n81 = pdf.rows.find((r) => r.number === "第81号");
  assert.deepEqual(n81?.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  const n82 = pdf.rows.find((r) => r.number === "第82号");
  assert.deepEqual(n82?.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会"]);
  // **隣り合う 2 議案の付託が 1 つに繋がっていない**——第83号は 1 つだけ
  assert.deepEqual(pdf.rows.find((r) => r.number === "第83号")?.referredCommittees, ["防災地域建設委員会"]);
  // **委員会名が件名に食い込んでいない**（#874 が「例外を握り潰すとこうなる」と書いた壊れ方）
  assert.equal(pdf.rows.filter((r) => /委員会.*委員会/.test(r.title)).length, 0);
});

/**
 * **閾値をやめた代わりに置いた見張り**（#569: 曖昧なまま通さない）。
 *
 * **14 本の実測**（読めた 7 本・**274 行**）:
 *
 * | | 正しい側 | 切り分けをやめた側 |
 * |---|---|---|
 * | ずれの最大 | **0.30pt** | **13.81pt** |
 * | **0.5pt を超える行** | **0 / 274** | **16 / 274**（最小 **4.44pt**） |
 */
test("#896 MAX_REFERRED_OFFSET=2: 正しい側の最大 0.30 は通り、壊れている側の最小 4.44 は落ちる", () => {
  assert.doesNotThrow(() => { checkReferredOffset(1, "第1号", ["総務委員会"], 0.30); }, "正しい側の最大");
  assert.doesNotThrow(() => { checkReferredOffset(1, "第1号", ["総務委員会"], -0.30); });
  assert.doesNotThrow(() => { checkReferredOffset(1, "第1号", ["総務委員会"], 2); }, "境界ちょうどは通る");
  assert.throws(() => { checkReferredOffset(1, "第1号", ["総務委員会"], 2.1); }, /off the row centre/);
  assert.throws(
    () => { checkReferredOffset(1, "第127号", ["総務委員会", "環境厚生委員会"], 4.44); },
    /page 1 第127号: 付託委員会 is 4\.4pt off the row centre \(max 2\) — 隣の行の付託委員会が混ざっている疑い: 総務委員会／環境厚生委員会/,
    "壊れている側の最小。**どの議案がどれだけずれたかを名指しする**（#569）",
  );
  assert.throws(() => { checkReferredOffset(1, "第74号", ["総務委員会", "防災地域建設委員会"], 13.81); }, /off the row centre/, "壊れている側の最大");
});

/**
 * **付託委員会の塊の中心は、行の中心にきわめてよく揃っている**——**件名より遥かに揃っている。**
 * **この事実が、閾値をやめて切り分けに変えられた理由である。**
 */
test("#896 読める 4 本すべてで、付託委員会の塊の中心は行の中心から 0.30pt 以内", async () => {
  const books = ["r0806_giinbetu_kekka.pdf", "r0802_giinbetu_kekka.pdf", "r0706_giinbetu_kekka.pdf", "r0609_giinbetu_kekka.pdf"];
  let rows = 0;
  let max = 0;
  for (const b of books) {
    const pdf = await parseVotePdf(fixture(b));
    for (const r of pdf.rows) { rows++; max = Math.max(max, Math.abs(r.referredOffset)); }
  }
  // **母数を検算に入れる**（#757）。**この 4 本で 182 行**
  assert.equal(rows, 182, "突き合わせた行");
  // **浮動小数の端数があるので小数 2 桁で比べる**（実測値は 0.3000015000000076）
  assert.equal(max.toFixed(2), "0.30", "付託委員会のずれの最大");
});

/* ==================== 4. 議決結果一覧 PDF の URL ==================== */

/**
 * ## **いちばん危ない 1 本**——**HTTP 200 で「別のファイル」が返る**（#896）
 *
 * **2023-09 の表決 PDF は `r0509_giketsu_kekka_giinnbetsu.pdf`**（**綴りが `giinnbetsu`**）。
 * **直す前の組み立て（`/_giinbetu_kekka\.pdf$/` を置換）はこれに当たらないので、
 * 置換が空振りして URL が元のまま返っていた。**
 *
 * **実測（2026-09-17 取得）**: **その URL は HTTP 200 を返し、中身は表決 PDF そのもの**
 * （**975,505 バイト。md5 が表決 PDF と一致**）。
 * **404 なら止まるが、200 で返るので「間違った PDF から議決日を読んでも気づけない。」**
 *
 * **会期ページに貼られている本当の議決結果一覧は `r0509_giketsu_kekka.pdf`**（**110,328 バイト**）。
 */
test("#896 2023-09: 議決結果一覧の URL を、表決 PDF の URL から組み立てない（組み立てると表決 PDF 自身が返る）", () => {
  const page = parseSessionPage(html("r0509.html"), "https://www.pref.shimane.lg.jp/gikai/ugoki/gikai_kako/r0509/", { sessionLabel: "令和5年9月定例会" });
  assert.equal(page.pdfUrls.length, 1);
  const votePdfUrl = page.pdfUrls[0];
  assert.ok(votePdfUrl.endsWith("/r0509_giketsu_kekka_giinnbetsu.pdf"), votePdfUrl);

  // **直す前の組み立て方を、ここで再現する**（実装から消したので、壊れ方をテストの側に残す）
  const built = votePdfUrl.replace(/_giinbetu_kekka\.pdf$/, "_giketu_kekka.pdf");
  // **置換が空振りして、表決 PDF の URL がそのまま返る**——**これが「HTTP 200 で別のファイル」の正体**
  assert.equal(built, votePdfUrl, "組み立ては空振りし、表決 PDF の URL のままになる");

  // **直した後は、会期ページのリンクから拾うので別のファイルを指す**
  assert.ok(page.resultsPdfUrl, "議決結果一覧のリンクが拾えている");
  assert.ok(page.resultsPdfUrl.endsWith("/r0509_giketsu_kekka.pdf"), page.resultsPdfUrl);
  assert.notEqual(page.resultsPdfUrl, votePdfUrl, "**議決結果一覧が表決 PDF と同じ URL になっていない**");
});

/**
 * **残る 3 本は HTTP 404 になっていた**（実測）。**404 なら止まるが、止まる＝その会期が読めない。**
 */
test("#896 綴りが違う 3 会期でも、会期ページのリンクから正しい議決結果一覧を拾う", () => {
  const cases: { file: string; slug: string; label: string; want: string; built: string }[] = [
    // 末尾に `_` が付く（組み立てると 404）
    { file: "r0611.html", slug: "r0611", label: "令和6年11月定例会", want: "r0611_giketu_kekka_.pdf", built: "r0611_giketu_kekka.pdf" },
    // `giketsu`（組み立ては `giketu`。404）
    { file: "r0602.html", slug: "r0602", label: "令和6年2月定例会", want: "r0602_giketsu_kekka.pdf", built: "r0602_giketu_kekka.pdf" },
    // `_` が無い（404）
    { file: "r0511.html", slug: "r0511", label: "令和5年11月定例会", want: "r0511_giketsukekka.pdf", built: "r0511_giketu_kekka.pdf" },
  ];
  for (const c of cases) {
    const base = `https://www.pref.shimane.lg.jp/gikai/ugoki/gikai_kako/${c.slug}/`;
    const page = parseSessionPage(html(c.file), base, { sessionLabel: c.label });
    assert.ok(page.resultsPdfUrl?.endsWith(`/${c.want}`), `${c.slug}: ${page.resultsPdfUrl}`);
    // **組み立てでは別の名前になっていた**（＝この 3 本は 404 だった）
    const built = page.pdfUrls[0].replace(/_giinbetu_kekka\.pdf$/, "_giketu_kekka.pdf");
    assert.ok(built.endsWith(`/${c.built}`), `${c.slug} の組み立て: ${built}`);
    assert.notEqual(built.split("/").pop(), c.want, `${c.slug}: 組み立てとリンクが食い違う`);
  }
});

/**
 * **拾った議決結果一覧が、本当に議決結果一覧として読めること**（URL が合っているだけでは足りない）。
 * **2024-09 と 2025-06 の 2 本で、議案番号・議決日・議決結果が取れることを確かめる。**
 */
test("#896 拾った議決結果一覧は parseResultsPdf で読める（議決日がそこから来る）", async () => {
  const sep = await parseResultsPdf(fixture("r0609_giketu_kekka.pdf"));
  assert.equal(sep.size, 33);
  assert.deepEqual(sep.get("第103号"), { date: "2024-10-09", result: "原案可決" });
  const jun = await parseResultsPdf(fixture("r0706_giketu_kekka.pdf"));
  assert.equal(jun.size, 26);
  assert.deepEqual(jun.get("第81号"), { date: "2025-07-02", result: "原案可決" });
});

/**
 * **会期ページに「議決結果一覧」が 2 本あったら、どちらが議決日か決められないので落とす**（#569）。
 * **14 本すべてでこれは 1 本だったが、「1 本しか無い」に寄りかからず、2 本のときの振る舞いを決めておく。**
 */
test("#896 議決結果一覧が 2 本ある会期ページは、黙ってどちらかを選ばず落ちる", () => {
  const two = html("r0509.html").replace(
    '<li><a href="/gikai/ugoki/gikai_kako/r0509/index.data/r0509_giketsu_kekka.pdf">',
    '<li><a href="/gikai/ugoki/gikai_kako/r0509/index.data/r0509_giketsu_kekka2.pdf">第４８７回島根県議会（令和５年９月定例会）議決結果一覧（別）（PDF:1KB)</a></li>\n<li><a href="/gikai/ugoki/gikai_kako/r0509/index.data/r0509_giketsu_kekka.pdf">',
  );
  assert.throws(
    () => parseSessionPage(two, "https://www.pref.shimane.lg.jp/gikai/ugoki/gikai_kako/r0509/", { sessionLabel: "令和5年9月定例会" }),
    /expected 1 議決結果一覧 PDF, got 2/,
  );
});

/* ==================== 5. 直した前後で、本数がどう変わったか ==================== */

/**
 * ## **母数を検算に入れる**（#757）
 *
 * **14 本すべてに対して、変更の前後で何本読めるかを数えた**（#896 の「必ず守ること」）。
 * **このテストはフィクスチャにある 6 本ぶんを固定する**（14 本すべてをリポジトリに入れると 8.5MB になるため）。
 *
 * | | 直す前 | 直した後 |
 * |---|---|---|
 * | **表決 PDF が読めた** | **3 / 14** | **7 / 14** |
 * | **表決と議決結果一覧の両方が読めた** | 測っていない | **6 / 14** |
 *
 * **新しく読めるようになった 4 本**: **2024-09**（`MAX_TITLE_OFFSET`）・**2023-06**（`HEADER_GAP`）・
 * **2025-06 / 2025-09**（`BLOCK_GAP`）。
 *
 * **読めないままの 7 本と、その理由**（**どれもこの PBI の範囲外**）:
 * 2025-02 / 2024-11（件名の欄の境目）・2025-05-rinji（議案番号が無い行）・
 * **2025-11（委員会名が中央揃え）**・2024-02（注記の文言）・2023-11（委員長報告の節）・
 * **2023-09（文字層が無い。すべてベクタの輪郭）**。
 */
test("#896 フィクスチャにある本の読める／読めないが、直した後の実測どおりである", async () => {
  const readable = ["r0806_giinbetu_kekka.pdf", "r0802_giinbetu_kekka.pdf", "r0606_giinbetu_kekka.pdf", "r0609_giinbetu_kekka.pdf", "r0706_giinbetu_kekka.pdf", "r0506_giinbetu_kekka.pdf"];
  let ok = 0;
  for (const b of readable) { await parseVotePdf(fixture(b)); ok++; }
  assert.equal(ok, 6, "フィクスチャにある読める本");
  // **2025-11 は読めないままである**（委員会名が中央揃え。#896 では直していない）——
  // **「読めるようにした」つもりで例外を握り潰していないことの確認**
  await assert.rejects(() => parseVotePdf(fixture("r0711_giinbetu_kekka.pdf")), /付託委員会 is 4\.2pt off the row centre/);
});

/**
 * **会期ページに「議決結果一覧」のリンクが無かったら、黙って進まずに落ちる**（Issue #896）。
 *
 * **議決日はこの PDF からしか取れない。**
 * **リンクが無いのに進むと、議決日の無いまま採決を作ることになる**——
 * **`data/` に「日付の無い採決」が出るより、止まるほうがよい**（#569）。
 *
 * **直す前は URL を組み立てていたので「リンクが無い」という状態が存在しなかった。**
 * **リンクから拾うようにした以上、無いときの振る舞いを決めておく必要がある。**
 */
test("#896 会期ページに議決結果一覧のリンクが無ければ、議決日を取れないので落ちる", async () => {
  const { runShimane } = await import("../src/sources/local/shimane/index.ts");
  const { DISTRICT_PAGES } = await import("../src/sources/local/shimane/roster.ts");
  const origin = "https://www.pref.shimane.lg.jp";
  const session = `${origin}/gikai/ugoki/saikin/r0806/`;
  // **議決結果一覧のリンクだけを消した会期ページ**（表決 PDF のリンクはそのまま）
  const stripped = html("r0806.html").replace(/<a[^>]*r0806_giketu_kekka\.pdf[^>]*>[\s\S]*?<\/a>/g, "");
  assert.ok(!stripped.includes("r0806_giketu_kekka.pdf"), "議決結果一覧のリンクが消えている");
  assert.ok(stripped.includes("r0806_giinbetu_kekka.pdf"), "表決 PDF のリンクは残っている");

  const files: Record<string, string> = {
    [`${origin}/gikai/gaido/meibo/tiku.html`]: "meibo-tiku.html",
    [`${origin}/gikai/ugoki/saikin/`]: "saikin.html",
    [`${origin}/gikai/ugoki/gikai_kako/`]: "gikai_kako.html",
  };
  for (const d of DISTRICT_PAGES) files[`${origin}${d.path}`] = `meibo-${d.slug}.html`;
  const fetcher = {
    text: async (url: string): Promise<string> => {
      if (url === session) return stripped;
      const f = files[url];
      if (!f) throw new Error(`unexpected fetch ${url}`);
      return readFileSync(new URL(`./fixtures/shimane/${f}`, import.meta.url), "utf8");
    },
    bytes: async (url: string): Promise<Buffer> => { throw new Error(`should not fetch bytes: ${url}`); },
  };
  await assert.rejects(
    () => runShimane({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher }),
    /議決結果一覧 PDF link not found \(議決日 comes from it\)/,
    "**議決日が取れないまま進まない**",
  );
});
