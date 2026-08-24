import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnmatched, sessionOfUnmatched, shardUnmatched, writeUnmatched, UNMATCHED_DIR } from "../src/unmatched.ts";
import { stableJson } from "../src/json.ts";

/**
 * `unmatched.json` の回次別分割（Issue #219）。
 * 第142〜199回は全票が未突合になるので（回次別の参院名簿が第216回以降にしか無い）、単一ファイルでは
 * 58回次 × 約200〜260票 × 採決数十〜200件＝百万行規模になる。回次で引ける行は `unmatched/{session}.json` に分け、
 * 回次が引けない行（発言 speechId・委員会出席 meetingId は NDL の id で回次を含まない）だけ `unmatched.json` に残す。
 * 契約（上限を設けない・氏名だけから Member を作らない）は変えない。変えるのはファイルの持ち方だけ。
 */
const vote = (session: number, n: string) => ({ nameText: n, group: "自由民主党", rollCallId: `${session}-0114-v001` });
const speech = (n: string) => ({ nameText: n, group: "自由民主党", speechId: "114215254X00219980114_001" });
const attendee = (n: string) => ({ kind: "attendance" as const, nameText: n, group: "", meetingId: "114215254X00219980114" });
const billProposer = (session: number, n: string) => ({ nameText: n, group: "", billId: `${session}-参法-16` });
const question = (session: number, n: string) => ({ kind: "question" as const, nameText: n, group: "", questionId: `${session}-sangiin-12` });

describe("sessionOfUnmatched: 行から回次を引く（id の先頭が回次）", () => {
  test("票（rollCallId）・参法の発議者（billId）・質問（questionId）は回次が引ける", () => {
    assert.equal(sessionOfUnmatched(vote(142, "阿部 正俊")), 142);
    assert.equal(sessionOfUnmatched(billProposer(221, "山田 太郎")), 221);
    assert.equal(sessionOfUnmatched(question(221, "山田 太郎")), 221);
  });

  test("発言（speechId）・委員会出席（meetingId）は NDL の id で回次を含まないので引けない", () => {
    assert.equal(sessionOfUnmatched(speech("寺澤 芳男")), undefined);
    assert.equal(sessionOfUnmatched(attendee("寺澤 芳男")), undefined);
  });

  test("回次に読めない id（表記が変わった等）は引けない扱いにして落とさない", () => {
    assert.equal(sessionOfUnmatched({ nameText: "x", group: "", rollCallId: "unknown-v001" }), undefined);
  });
});

describe("shardUnmatched: 回次で分け、引けない行は残す", () => {
  const rows = [vote(142, "A"), vote(142, "B"), vote(221, "C"), speech("D"), attendee("E"), billProposer(221, "F")];
  const { bySession, rest } = shardUnmatched(rows);

  test("回次ごとにまとまる", () => {
    assert.deepEqual([...bySession.keys()].sort((a, b) => a - b), [142, 221]);
    assert.equal(bySession.get(142)?.length, 2);
    assert.equal(bySession.get(221)?.length, 2);
  });

  test("回次の引けない行だけが rest に残る（捨てない）", () => {
    assert.deepEqual(rest.map((r) => r.nameText), ["D", "E"]);
  });

  test("1行も失わない", () => {
    const total = [...bySession.values()].reduce((n, xs) => n + xs.length, 0) + rest.length;
    assert.equal(total, rows.length);
  });
});

describe("writeUnmatched / readUnmatched: ファイルの持ち方", () => {
  const rows = [vote(142, "A"), vote(199, "B"), speech("C")];
  let dir: string;
  const setup = async () => {
    dir = mkdtempSync(join(tmpdir(), "seiji-unmatched-"));
    await writeUnmatched(dir, rows);
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  test("回次別のファイルを書き、unmatched.json には回次の引けない行だけ残す", async () => {
    await setup();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, UNMATCHED_DIR, "142.json"), "utf-8")), [rows[0]]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, UNMATCHED_DIR, "199.json"), "utf-8")), [rows[1]]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "unmatched.json"), "utf-8")), [rows[2]]);
    cleanup();
  });

  test("すべて stableJson（キーソート・末尾改行）で書く", async () => {
    await setup();
    for (const rel of ["unmatched.json", `${UNMATCHED_DIR}/142.json`, `${UNMATCHED_DIR}/199.json`]) {
      const text = readFileSync(join(dir, rel), "utf-8");
      assert.equal(text, stableJson(JSON.parse(text)), rel);
    }
    cleanup();
  });

  test("readUnmatched は分割ファイルと unmatched.json を合わせて全行返す（検証と運用が全体を見られる）", async () => {
    await setup();
    const all = await readUnmatched(dir);
    assert.equal(all.length, rows.length);
    assert.deepEqual(all.map((r) => r.nameText).sort(), ["A", "B", "C"]);
    cleanup();
  });

  test("前回実行で書いた回次のファイルは、その回次に未突合が無くなれば消える（残骸を残さない）", async () => {
    await setup();
    await writeUnmatched(dir, [vote(142, "A")]);
    assert.ok(existsSync(join(dir, UNMATCHED_DIR, "142.json")));
    assert.equal(existsSync(join(dir, UNMATCHED_DIR, "199.json")), false, "未突合の無くなった回次のファイルが残っている");
    cleanup();
  });

  test("未突合が 1 件も無ければ unmatched.json は空配列（ファイルは消さない。運用と監視が読む）", async () => {
    dir = mkdtempSync(join(tmpdir(), "seiji-unmatched-"));
    await writeUnmatched(dir, []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "unmatched.json"), "utf-8")), []);
    cleanup();
  });

  test("#219 より前の出力（回次別ファイルが無く unmatched.json に票が入っている）もそのまま読める", async () => {
    dir = mkdtempSync(join(tmpdir(), "seiji-unmatched-"));
    writeFileSync(join(dir, "unmatched.json"), stableJson([vote(142, "A"), speech("C")]));
    const all = await readUnmatched(dir);
    assert.equal(all.length, 2);
    cleanup();
  });

  test("回次別ファイルに混ざった別回次の行も readUnmatched は落とさない（検証は行の中身で行う）", async () => {
    dir = mkdtempSync(join(tmpdir(), "seiji-unmatched-"));
    mkdirSync(join(dir, UNMATCHED_DIR), { recursive: true });
    writeFileSync(join(dir, UNMATCHED_DIR, "142.json"), stableJson([vote(199, "X")]));
    writeFileSync(join(dir, "unmatched.json"), stableJson([]));
    assert.deepEqual((await readUnmatched(dir)).map((r) => r.nameText), ["X"]);
    cleanup();
  });
});
