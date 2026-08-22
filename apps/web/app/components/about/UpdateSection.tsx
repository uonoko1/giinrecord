import type { Dataset } from "../../lib/dataset";
import { formatDateTime } from "../../lib/format";

/** 節「更新」。出典ごとの取得時刻を出す。meta が無ければ「取得前です。」。 */
export function UpdateSection({ meta }: { meta: Dataset["meta"] }) {
  return (
    <section className="section" aria-labelledby="update-heading">
      <h2 id="update-heading" className="section__title">
        更新
      </h2>
      {meta ? (
        <div className="rows">
          {meta.sources.map((s) => (
            <div key={s.url} className="row">
              <span>{s.name}</span>
              <span>{formatDateTime(s.fetchedAt)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="note">取得前です。</p>
      )}
      <p className="note">会議録は国立国会図書館での公開まで約1か月かかります。</p>
    </section>
  );
}
