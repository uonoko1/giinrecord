import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * PDF のテキスト抽出（Issue #111）。総務省の区域 PDF は本文がテキストなので pdfjs（Mozilla、純 JS）で読む。
 * 行の区切りは pdfjs の hasEOL、ページの区切りは空行。
 * フォントに Unicode 対応の無い外字（釜石市の「釜」、葛城市の「葛」、薩摩川内市の「薩」）は私用領域（U+E000–U+F8FF）の
 * コードで出てくる（pypdf でも同じ）。抽出器ごとの揺れを避けるため 〓（U+3013）に置き換える。
 * 照合側（resolve.ts）は 〓 を「任意の 1 文字」として扱い、候補が 1 つに絞れないときは失敗する（推定しない）。
 */
export const GAIJI = "〓";

export async function extractPdfText(bytes: Buffer): Promise<string> {
  // pdfjs-dist 6: `destroy()` lives on the loading task (PDFDocumentProxy.destroy was removed).
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      out += item.str.replace(/[\uE000-\uF8FF]/g, GAIJI);
      if (item.hasEOL) out += "\n";
    }
    out += "\n";
  }
  await task.destroy();
  return out;
}
