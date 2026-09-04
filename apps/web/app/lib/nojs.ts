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

/** 出典として認める一次資料のホスト。議会自身の公表ページだけ。 */
export const SOURCE_HOSTS = ["www.sangiin.go.jp", "www.shugiin.go.jp"];

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
   * 一次資料への出典リンクが在ることを求めるか。`true` なら SOURCE_HOSTS の
   * いずれかへのリンクが 1 本以上必要。
   */
  source: boolean;
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

/** 一次資料（議会の公式ページ）へのリンクだけを返す */
export function sourceLinks(hrefs: string[]): string[] {
  return hrefs.filter((href) => {
    try {
      return SOURCE_HOSTS.includes(new URL(href).host);
    } catch {
      return false;
    }
  });
}

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

    // 一次資料リンク（全行に一次資料リンク、が原則）
    if (e.source && sourceLinks(snap.hrefs).length === 0) {
      failures.push(`${where}: JS 無効で一次資料（${SOURCE_HOSTS.join(" / ")}）への出典リンクが 1 本も無い（リンク ${snap.hrefs.length} 本）`);
    }
  }

  return { checked, failures };
}
