/**
 * 日付・日時の表示用整形。文字列操作のみで、タイムゾーン変換はしない（記録の値をそのまま見せる）。
 * どのページでもここを使う（rollcall.ts / dataset.ts / member.tsx に重複させない）。
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

/** 2026-07-24 → 2026.07.24。日時付きでも日付だけ。日付でなければそのまま返す */
export function formatDate(iso: string): string {
  const m = ISO.exec(iso);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : iso;
}

/** 2026-08-22T06:00:00+09:00 → 2026.08.22 06:00。時刻が無ければ日付だけ。日付でなければそのまま返す */
export function formatDateTime(iso: string): string {
  const m = ISO.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return h ? `${y}.${mo}.${d} ${h}:${mi}` : `${y}.${mo}.${d}`;
}

/** 2028-07-25 → 2028.07。日付でなければそのまま返す */
export function formatYearMonth(iso: string): string {
  const m = ISO.exec(iso);
  return m ? `${m[1]}.${m[2]}` : iso;
}
