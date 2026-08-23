import { REPO_URL } from "../lib/dataset";
import { InstallLink } from "./InstallLink";
import "../styles/pages.css";

/**
 * 各ページ末尾のサイト共通フッター（Issue 167）。ページ固有の出典行（SourceLine 等）はそのまま残し、<main> の後ろに置く。
 * 内部リンクは MemberPage と同じく素の <a>（ルーター文脈なしでも描画できる。遷移先はプリレンダー済み）。
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav className="site-footer__links" aria-label="サイト情報">
        <a href="/about">このデータについて</a>
        <a href="/terms">利用規約</a>
        <a href="/privacy">プライバシーポリシー</a>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        {/* Issue 191: 対応ブラウザでマウント後にだけ描画される。プリレンダー HTML には出ない */}
        <InstallLink />
      </nav>
      <p className="site-footer__note">議会ログ ・ コード: MIT ・ データ: CC BY 4.0</p>
    </footer>
  );
}
