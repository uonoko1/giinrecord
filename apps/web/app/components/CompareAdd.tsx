import { useEffect, useState } from "react";
import { COMPARE_MAX, readStoredCompareIds, toggleCompareId, writeStoredCompareIds } from "../lib/compare";

/**
 * 議員ページの「比較に追加」（Issue #104）。選んだ id を localStorage（try/catch、Cookie 不使用）に最大 COMPARE_MAX 名まで保存し、
 * /compare?m=… へのリンクを出す。プリレンダー時は保存値を読めないので、マウント後に読む。
 * 議員ページ（member.tsx）と同じく素の <a>（Router 文脈に依存しない）。
 */
export function CompareAdd({ memberId }: { memberId: string }) {
  const [ids, setIds] = useState<string[]>([]);
  const [full, setFull] = useState(false);

  useEffect(() => {
    setIds(readStoredCompareIds());
  }, []);

  const selected = ids.includes(memberId);
  const toggle = () => {
    const r = toggleCompareId(ids, memberId);
    setFull(r.full === true);
    if (r.full) return;
    setIds(r.ids);
    writeStoredCompareIds(r.ids);
  };

  return (
    <div className="compare-add">
      <button type="button" className="compare-add-button" aria-pressed={selected} onClick={toggle}>
        {selected ? "比較から外す" : "比較に追加"}
      </button>
      {ids.length > 0 && (
        <a className="compare-add-link" href={`/compare?m=${ids.join(",")}`}>
          並べて見る（{ids.length}名）
        </a>
      )}
      {full && <span className="compare-add-note">比較は{COMPARE_MAX}名までです。追加済みの議員のページで「比較から外す」を押してから追加してください。</span>}
    </div>
  );
}
