import { Link } from "react-router";
import { InstallLink } from "../InstallLink";

/**
 * 節「規約とプライバシー」。計測の説明は /privacy に置く（#166, #167）。
 * 末尾の InstallLink（#191）は対応ブラウザでマウント後にだけ描画され、プリレンダー HTML は変わらない。
 */
export function PoliciesSection() {
  return (
    <section id="policies" className="section" aria-labelledby="policies-heading">
      <h2 id="policies-heading" className="section__title">
        規約とプライバシー
      </h2>
      <p className="body">利用の条件と、閲覧時に記録する情報の範囲は、次のページに書いています。</p>
      <div className="links">
        <Link to="/terms">利用規約</Link>
        <Link to="/privacy">プライバシーポリシー</Link>
      </div>
      <InstallLink />
    </section>
  );
}
