import { REPO_URL } from "../lib/dataset";
import { InstallLink } from "./InstallLink";
import { ThemeToggle } from "./ThemeToggle";
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
        <a href="/coverage">収録範囲</a>
        <a href="/terms">利用規約</a>
        <a href="/privacy">プライバシーポリシー</a>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        {/* Issue 191: 対応ブラウザでマウント後にだけ描画される。プリレンダー HTML には出ない */}
        <InstallLink />
      </nav>
      {/* Issue 365: ThemeToggle は Issue 16 で実装されていたが、どのページにも描かれていなかった
          （保存済みテーマを読む init は root.tsx にあるのに、保存する手段が無かった）。
          ヘッダはページごとに作りが違い CoverBrand の意匠を崩すので、全ページ共通のここに置く。 */}
      <div className="site-footer__theme">
        <ThemeToggle />
      </div>
      <p className="site-footer__note">議員レコード ・ コード: MIT ・ データ: CC BY 4.0</p>
    </footer>
  );
}
