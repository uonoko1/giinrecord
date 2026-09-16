import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionTally } from "../src/sources/local/session-tally.ts";

// Issue #895。**落としたことが出る形**の最小の単位。
// **母数（seen）は「採った ＋ 落とした」であって、どちらか片方ではない**（#757）。

test("#895 SessionTally: 採った数・落とした数・母数が一致する", () => {
  const t = new SessionTally();
  t.take();
  t.take();
  t.drop("次のページ", "not-a-candidate");
  assert.equal(t.taken, 2);
  assert.equal(t.dropped.length, 1);
  assert.equal(t.seen, 3);
  assert.equal(t.seen, t.taken + t.dropped.length);
});

test("#895 SessionTally: 落とした理由と原文が残る（「黙って落とす」を残さない）", () => {
  const t = new SessionTally();
  t.drop("令和元年11月定例会（第370回）", "not-a-session");
  t.drop("平成28年9月定例会(第357回）", "not-a-session");
  t.drop("平成20年2月定例会（第317回）", "no-vote-link");
  assert.deepEqual(t.reasons(), { "not-a-session": 2, "no-vote-link": 1 });
  assert.deepEqual(t.dropped.map((d) => d.text), [
    "令和元年11月定例会（第370回）",
    "平成28年9月定例会(第357回）",
    "平成20年2月定例会（第317回）",
  ]);
});

test("#895 SessionTally: 空の母数は空の行になる（0 を「落ちていない」と読み違えない）", () => {
  const t = new SessionTally();
  assert.equal(t.seen, 0);
  assert.deepEqual(t.reasons(), {});
  assert.equal(t.line(), "候補 0 / 採った 0 / 落とした 0");
});

test("#895 SessionTally: line() に理由ごとの件数が出る", () => {
  const t = new SessionTally();
  t.take();
  t.drop("x", "no-vote-link");
  assert.equal(t.line(), "候補 2 / 採った 1 / 落とした 1（no-vote-link 1）");
});

test("#895 SessionTally: absorb で段をまたいで足せる（佐賀・秋田・滋賀はページが複数ある）", () => {
  const a = new SessionTally();
  a.take();
  a.drop("x", "not-a-candidate");
  const b = new SessionTally();
  b.take();
  b.drop("y", "not-a-session");
  a.absorb(b);
  assert.equal(a.seen, 4);
  assert.equal(a.taken, 2);
  assert.deepEqual(a.reasons(), { "not-a-candidate": 1, "not-a-session": 1 });
});
