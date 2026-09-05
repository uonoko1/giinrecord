/**
 * JS 無効でも記録が読めることの検査（Issue #479）。純粋関数だけ。ページを開くのは
 * scripts/browser-check.ts（`javaScriptEnabled: false` の context）。
 *
 * ## なぜ要るか
 *
 * このサイトは `ssr: false` + `prerender`（react-router.config.ts）である。**サーバは無い**ので、
 * 利用者に届く HTML は**ビルド時に書き出した1枚**がすべてで、そこに本文が入っていなければ
 * JS を切った利用者にも、検索エンジンのクローラにも、アーカイブにも**何も残らない**。
 * `prerender` の設定を1つ間違えれば（`prerenderPaths` が空を返す、`ssr` を変える）
 * その HTML は**静かに空の SPA shell になる**——ビルドは通り、`smoke` も通る。
 * `smoke` が見ているのは **HTML ファイルが在ること**であって、**中身が在ること**ではない。
 *
 * 「記録が読めない」は、このプロジェクトでは「記録が出ない」と同じ重さである。
 *
 * ## どこまでが**ビルドに守られていて**、どこからがここの担当か（#479 で実測）
 *
 * `prerender` の壊し方には、**ビルドが自分で止めるもの**と**黙って通るもの**がある:
 *
 *   - `prerender: false` / `prerenderPaths` から**loader を持つルート**（`/members/{id}`,
 *     `/rollcalls/{s}/{id}`, `/rollcalls`）を外す
 *     → **ビルドが落ちる**（"Invalid route exports found when prerendering with `ssr:false`"）。
 *       ここまで来ない
 *   - `prerenderPaths` が**空を返す**
 *     → **ビルドは通る**（SPA Mode に落ちる）。全ページが 2.5 KB の shell になる
 *   - `prerenderPaths` から**loader の無いルート**（`/members` 一覧）だけを外す
 *     → **ビルドは通る**。その 1 ページだけが静かに消える
 *   - プリレンダー済み HTML から**本文だけ**が失われる（`.data` と inline script は残る）
 *     → **ビルドも通り、200 で返る**
 *
 * 後ろ 3 つが、この検査の担当である。
 * なお最後の 2 つは JS 有効の検査も**巻き添えで**落ちる（ハイドレーションの不一致 = React #418、
 * `.data` の欠落 = "No result found for routeId"）が、**落ちる理由が「記録が読めない」ではない**ので、
 * 直す人に何が起きたかが伝わらない。ここは**読めないこと自体**を、そう書いて落とす。
 *
 * ## 何を見るか（文字数は見ない）
 *
 * 「本文が N 文字以上」は**閾値を決める根拠が無い**。ここで見るのは
 * **記録として意味のあるもの**が、そのページの `data/` の中身と**一致して**出ていること:
 *
 *   - 議員ページ  … その議員の**氏名**（`members/{id}.json` の `name`）と、`sourceUrl` への出典リンク
 *   - 採決ページ  … その採決の**議案名**と**日付**（`<time datetime>`）と `sourceUrl` への出典リンク
 *   - 一覧ページ  … 先頭の項目の**中身**と、詳細ページへの内部リンク
 *
 * `data/` から取った期待値と突き合わせるので、**空の shell はもちろん、
 * 「別のページの内容が焼かれている」形でも落ちる**。
 *
 * ## 一次資料リンク（このプロジェクトの原則）
 *
 * 「全行に一次資料リンク」なので、**出典リンクが JS 無効で消える**のは
 * 本文が消えるのと同じくらい悪い（出典の無い記録は、このサイトが出さないと決めているもの）。
 * だから本文とは別に、**議会の公式ドメインへのリンクが在ること**を独立して見る。
 */

/**
 * 出典として期待するホストは**手書きしない**。`data/` の `sourceUrl` から取る（#479 のレビュー指摘）。
 *
 * 最初は `["www.sangiin.go.jp", "www.shugiin.go.jp"]` を allowlist として書いていたが、
 * **実測すると全 1,057 名のうち 285 名（27%）は地方議会の 7 ホスト**
 * （`www.pref.miyagi.jp`, `www.pref.mie.lg.jp`, `www.pref.nara.lg.jp`, `www.pref.tokushima.lg.jp`,
 * `gikai.pref.kochi.lg.jp`, `www.pref.tottori.lg.jp`, `www.pref.shimane.lg.jp`）である。
 * 検査が開く議員は `members/index.json` の先頭で、**この index は id 順ではない**ので、
 * ETL の並び順が変われば先頭が地方議員になりうる。そのとき allowlist 方式は
 * **記録が完全に読めているのに落ちる**（実測: `/members/p_04_amasita/` はリンク 176 本、
 * その中に `https://www.pref.miyagi.jp/...` が実在するのに「出典リンクが無い」と落ちた）。
 * **偽陽性は `docker-web` を赤くして、正常な本番リリースを止める。**
 *
 * さらに allowlist は**それ自体が固定されていない**（#484 の再発）:
 * `SOURCE_HOSTS` に `cdn.example.net` を足しても検査は 12/12 緑のままだった。
 *
 * なので**そのページが出典として持っているはずの URL**（`detail.sourceUrl` /
 * `rollCall.sourceUrl`）のホストを期待値にする。地方議会にも自動で追随し、
 * 「別のどこかへのリンクで代用する」形も通らない。
 */

/** ページから読み取った、JS 無効時の DOM の要点。scripts/browser-check.ts が集める。 */
export interface NoJsSnapshot {
  /** 検査したページの URL */
  url: string;
  /** `document.body.innerText`（描画されている本文。`textContent` と違い `display:none` を含まない） */
  text: string;
  /** ページ内のすべての `<a href>`（絶対 URL に解決済み） */
  hrefs: string[];
  /** `<time datetime="...">` の datetime 属性 */
  times: string[];
}

/** そのページに出ていることを求めるもの。`data/` から作る（#479: 期待値を手で書かない）。 */
export interface NoJsExpectation {
  /** site-relative なパス（`/members/m_1/`） */
  path: string;
  /** 何のページか。失敗メッセージに出る */
  label: string;
  /**
   * 本文に**そのまま**出ていること。`data/` から取った文字列（議員の氏名、議案名…）。
   * 空配列は許さない（何も見ていない検査になる）。
   */
  texts: string[];
  /** `<time datetime>` に出ていること（採決の日付など）。無ければ空でよい */
  times?: string[];
  /** この site-relative なパスへの内部リンクが在ること（一覧 → 詳細の導線） */
  links?: string[];
  /**
   * このページが出典として指しているはずの URL（`data/` の `sourceUrl` そのもの）。
   * `null` なら出典リンクを求めない（一覧ページ。出典は各詳細ページ側にある）。
   * **ホストを手書きしない**ので、国会でも地方議会でも同じ検査が効く。
   */
  sourceUrl: string | null;
}

/** `hrefs` の絶対 URL のうち、この origin のものを site-relative なパスに直す */
function internalPaths(hrefs: string[], origin: string): string[] {
  const out: string[] = [];
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href, origin);
    } catch {
      continue;
    }
    if (u.origin === new URL(origin).origin) out.push(u.pathname);
  }
  return out;
}

/** 末尾の `/` の有無を吸収して比べる（`/members/m_1` と `/members/m_1/` は同じページ） */
const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * `sourceUrl` と**同じホスト**を指すリンクだけを返す。
 * ホストの厳密一致で見る（`new URL(href).host`）ので、
 * `https://evil.example/?u=www.sangiin.go.jp` のような「文字列として含む」形は弾かれる。
 */
export function sourceLinks(hrefs: string[], sourceUrl: string): string[] {
  let want: string;
  try {
    want = new URL(sourceUrl).host;
  } catch {
    return [];
  }
  return hrefs.filter((href) => {
    try {
      return new URL(href).host === want;
    } catch {
      return false;
    }
  });
}

/**
 * 検査するページ数は**この数に固定する**（#479 のレビュー指摘）。
 *
 * 最初は「期待値が 0 個なら落とす」だけを守っていたが、それでは**足りなかった**:
 * 期待値は `rc`（採決）と `detail`（議員）の 2 つの `if` で作られるので、
 * `data/rollcalls/index.json` が `[]` になると**採決の 2 ページが黙って消え**、
 * 残り 2 ページだけで `0 failure` = 緑になる（レビュアーの実測:
 * `no-js 2 page(s) checked, 0 failure(s)`）。
 *
 * **#451「検査器自身のテストが無いと、検査が死んでも緑」と同じ形**であり、
 * 自分が塞いだ穴（`texts.length === 0`）の**一段上に同じ穴**が残っていた。
 * 「検査するものが無いから緑」を作らない、という方針をこの層にも当てる。
 */
export const NOJS_PAGE_COUNT = 4;

export interface NoJsReport {
  checked: number;
  failures: string[];
}

/**
 * 集めた DOM と、`data/` から作った期待値を突き合わせる。
 * 落ちたときのメッセージには**何を期待して何が出ていたか**を入れる（#451: 落ちた理由を確かめられるように）。
 */
export function checkNoJs(got: Map<string, NoJsSnapshot>, expectations: NoJsExpectation[], origin: string): NoJsReport {
  const failures: string[] = [];
  let checked = 0;

  // 検査そのものが半分消えていないか。data/ の一部が欠けると期待値を作る `if` が
  // 素通りして、残ったページだけで緑になる（#451 と同じ形）
  if (expectations.length !== NOJS_PAGE_COUNT) {
    failures.push(
      `検査するページが ${expectations.length} ページしかない（${NOJS_PAGE_COUNT} ページであること）。` +
        `data/ の一部が読めておらず、検査が黙って縮んでいる: ${expectations.map((e) => e.label).join(", ") || "無し"}`,
    );
  }

  for (const e of expectations) {
    checked++;
    const snap = got.get(e.path);
    if (!snap) {
      failures.push(`${e.path}: 開けなかった（JS 無効）`);
      continue;
    }
    const where = `${e.path}（${e.label}）`;

    // 空振り防止: 期待値を 1 つも持たない検査は「通った」ことに意味が無い
    if (e.texts.length === 0) {
      failures.push(`${where}: 検査する文字列が 0 個（data/ から期待値が取れていない。検査が成立していない）`);
      continue;
    }

    // 本文。`prerender` が空の shell を書いていれば、ここが全部落ちる
    for (const t of e.texts) {
      if (!snap.text.includes(t)) {
        failures.push(`${where}: JS 無効で本文に「${t}」が出ていない（本文 ${snap.text.length} 文字。プリレンダーが中身を書いていない）`);
      }
    }

    for (const t of e.times ?? []) {
      if (!snap.times.includes(t)) {
        failures.push(`${where}: JS 無効で <time datetime="${t}"> が出ていない（出ている datetime: ${snap.times.slice(0, 5).join(", ") || "無し"}）`);
      }
    }

    const paths = internalPaths(snap.hrefs, origin).map(normalize);
    for (const link of e.links ?? []) {
      if (!paths.includes(normalize(link))) {
        failures.push(`${where}: JS 無効で ${link} への内部リンクが無い（内部リンク ${paths.length} 本）`);
      }
    }

    // 一次資料リンク（全行に一次資料リンク、が原則）。
    // 期待するホストは data/ の sourceUrl から取るので、地方議会のページでも偽陽性にならない
    if (e.sourceUrl && sourceLinks(snap.hrefs, e.sourceUrl).length === 0) {
      const host = (() => {
        try {
          return new URL(e.sourceUrl).host;
        } catch {
          return e.sourceUrl;
        }
      })();
      failures.push(`${where}: JS 無効で一次資料（${host}）への出典リンクが 1 本も無い（リンク ${snap.hrefs.length} 本）`);
    }
  }

  return { checked, failures };
}
