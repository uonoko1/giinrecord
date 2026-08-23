import { ARCHIVE_PATH } from "../../lib/archive-path";
import { REPO_URL } from "../../lib/dataset";

/** 節「検証する」。ソースコード・データ一括取得・誤り報告へのリンクとライセンス。 */
export function VerifySection() {
  return (
    <section className="section" aria-labelledby="verify-heading">
      <h2 id="verify-heading" className="section__title">
        検証する
      </h2>
      <p className="body">取得プログラムと整形済みデータはすべて公開しています。間違いを見つけたら、該当行の出典と一緒にお知らせください。</p>
      <div className="links">
        <a href={REPO_URL} rel="noreferrer">
          ソースコード
        </a>
        <a href={ARCHIVE_PATH} download>
          データ一括取得
        </a>
        <a href={`${REPO_URL}/tree/main/data`} rel="noreferrer">
          GitHub のデータ
        </a>
        <a href={`${REPO_URL}/issues/new`} rel="noreferrer">
          誤りを報告
        </a>
      </div>
      <p className="note">毎日更新。CC BY 4.0。出典として「議会ログ」と一次資料（参議院・衆議院・国立国会図書館）を明記してください。個人・非営利・商用いずれも同じ条件です。</p>
    </section>
  );
}
