import type { MetaArgs } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { REPO_URL } from "../lib/site";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";

/** このポリシーの最終更新日（YYYY-MM-DD）。本文を変えたら更新する。 */
export const PRIVACY_UPDATED = "2026-09-02";

const ISSUES_URL = `${REPO_URL}/issues`;

/**
 * 第三者送信の注記。フォントは自サイト配信（#168）のため現在は該当なし（null）。
 * フォントの自サイト配信（#168）が完了したら、この値を `null` にする（それだけで本文から消える）。
 */
const THIRD_PARTY_FONT_NOTE: string | null = null; // #168 でフォントを自サイト配信にしたため第三者送信なし

export function meta({ location }: MetaArgs) {
  return seoMeta({
    title: "プライバシーポリシー",
    description: "議員レコードのプライバシーポリシー。Cookie を使わず、IP アドレスとブラウザの種類を記録しません。計測はページ・参照元・日付の集計だけです。",
    pathname: location.pathname,
  });
}

/** プライバシーポリシー（#167）。何を記録し、何を記録しないかを事実として書く。 */
export default function Privacy() {
  return (
    <>
      <main className="page">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">プライバシーポリシー</h1>
          <p className="cover__lead">
            更新日 <time dateTime={PRIVACY_UPDATED}>{PRIVACY_UPDATED}</time>
          </p>
        </header>

        <section className="section" aria-labelledby="privacy-none">
          <h2 id="privacy-none" className="section__title">
            記録しないもの
          </h2>
          <ul className="plain">
            <li>Cookie は使いません。</li>
            <li>IP アドレスは記録しません。サーバー（nginx）のアクセスログは IP アドレスを書かない形式にしています。</li>
            <li>ブラウザの種類（User-Agent）も記録しません。</li>
            <li>計測用のスクリプトや外部の解析サービスは置いていません。</li>
          </ul>
          <p className="body">
            例外として、接続に失敗したとき（暗号化通信の確立に失敗したときなど）のエラー時の診断ログには、接続元 IP
            アドレスが短期間残ることがあります。このログは閲覧の記録には使わず、ログローテーションで削除されます。
          </p>
        </section>

        <section className="section" aria-labelledby="privacy-analytics">
          <h2 id="privacy-analytics" className="section__title">
            計測について
          </h2>
          <p className="body">
            閲覧数を知るために、サーバーのアクセスログを1日1回集計しています。記録するのは「日付・ページ・リファラ（リンク元のサイト名）・ページビュー数」だけです。リファラはサイト名までに縮め、検索語などは残しません。集計結果は公開していません。
          </p>
        </section>

        <section className="section" aria-labelledby="privacy-third-party">
          <h2 id="privacy-third-party" className="section__title">
            第三者への送信
          </h2>
          <p className="body">このサイトは、閲覧者の情報を第三者に送りません。</p>
          {THIRD_PARTY_FONT_NOTE ? <p className="body">{THIRD_PARTY_FONT_NOTE}</p> : null}
        </section>

        <section className="section" aria-labelledby="privacy-storage">
          <h2 id="privacy-storage" className="section__title">
            ブラウザに保存するもの
          </h2>
          <p className="body">
            比較ページで選んだ議員の一覧と、表示テーマ（明・暗）の設定を、ブラウザの localStorage に保存します。これらは閲覧者の端末内にだけあり、サーバーには送られません。ブラウザのサイトデータを消せばなくなります。
          </p>
          {/* Issue 380: 節の見出しが「ブラウザに保存するもの」なのに、実際に保存されている
              sessionStorage の記述が無かった。中身が無害でも、書いていないものが保存されている状態にしない。 */}
          <p className="body">
            ページを移動したときにスクロール位置を戻すため、その位置（画面の何ピクセル目か）を sessionStorage
            に保存します。閲覧したページの名前や URL は残らず、タブを閉じると消えます。これもサーバーには送られません。
          </p>
        </section>

        <section className="section" aria-labelledby="privacy-contact">
          <h2 id="privacy-contact" className="section__title">
            連絡先と変更
          </h2>
          <p className="body">
            このポリシーについての質問や指摘は、
            <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
              GitHub Issues
            </a>
            で受け付けます。内容を変更した場合は、このページと冒頭の更新日を改めます。広告を入れるときは、Cookie
            の記述と同意バナーをこのページと同時に更新します。
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
