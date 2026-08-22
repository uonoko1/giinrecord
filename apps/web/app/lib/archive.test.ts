/**
 * data-archive.zip の仕様：決定的（同じ入力→同じバイト列）、エントリはパス順、
 * 更新時刻は固定、標準の ZIP として展開できる。
 */
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ARCHIVE_NAME, ARCHIVE_PATH, archiveReadme, buildZip, readZipDirectory } from "./archive";

const entries = [
  { path: "rollcalls/index.json", data: Buffer.from("[]") },
  { path: "LICENSE", data: Buffer.from("CC BY 4.0\n") },
  { path: "members/index.json", data: Buffer.from(JSON.stringify([{ id: "m_1" }])) },
];

describe("buildZip", () => {
  it("同じ入力から同じバイト列を作る（決定的）", () => {
    expect(buildZip(entries).equals(buildZip([...entries].reverse()))).toBe(true);
  });

  it("エントリをパスの昇順（バイト順）で並べ、更新時刻を固定する", () => {
    const dir = readZipDirectory(buildZip(entries));
    expect(dir.map((e) => e.path)).toEqual(["LICENSE", "members/index.json", "rollcalls/index.json"]);
    for (const e of dir) {
      expect(e.dosTime).toBe(0);
      expect(e.dosDate).toBe(0x21); // 1980-01-01
    }
  });

  it("各エントリは deflate で展開すると元のバイト列に戻り、サイズが一致する", () => {
    const zip = buildZip(entries);
    for (const e of readZipDirectory(zip)) {
      const original = entries.find((x) => x.path === e.path)!.data;
      const raw = zip.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
      const restored = e.method === 8 ? inflateRawSync(raw) : raw;
      expect(restored.equals(original)).toBe(true);
      expect(e.uncompressedSize).toBe(original.length);
    }
  });

  it("空のエントリ一覧でも有効な ZIP（エントリ 0 件）になる", () => {
    expect(readZipDirectory(buildZip([]))).toEqual([]);
  });

  it("重複パスとディレクトリを抜けるパスは拒否する", () => {
    expect(() => buildZip([entries[0], entries[0]])).toThrow(/duplicate/);
    expect(() => buildZip([{ path: "../x", data: Buffer.alloc(0) }])).toThrow(/path/);
    expect(() => buildZip([{ path: "/abs", data: Buffer.alloc(0) }])).toThrow(/path/);
  });
});

describe("archiveReadme", () => {
  const meta = {
    fetchedAt: "2026-08-22T13:49:50.028Z",
    sessions: [217, 221],
    sources: [{ name: "参議院 本会議投票結果", url: "https://www.sangiin.go.jp/x", fetchedAt: "2026-08-22T13:49:50.028Z" }],
  };

  it("ライセンス・出典・帰属表示・取得時刻を書く", () => {
    const text = archiveReadme(meta);
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(text).toContain("政治記録 (seiji-kiroku)");
    expect(text).toContain("https://github.com/uonoko1/seiji-kiroku");
    expect(text).toContain("参議院 本会議投票結果");
    expect(text).toContain("https://www.sangiin.go.jp/x");
    expect(text).toContain("2026-08-22T13:49:50.028Z");
    expect(text).toContain("217");
  });

  it("meta が無くてもライセンスと帰属表示は書く", () => {
    const text = archiveReadme(undefined);
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("政治記録 (seiji-kiroku)");
  });

  it("評価語を含まない", () => {
    for (const w of ["おすすめ", "ランキング", "一致率"]) expect(archiveReadme(meta)).not.toContain(w);
  });
});

describe("定数", () => {
  it("配布パスは /data/ 配下の data-archive.zip", () => {
    expect(ARCHIVE_NAME).toBe("data-archive.zip");
    expect(ARCHIVE_PATH).toBe("/data/data-archive.zip");
  });
});
