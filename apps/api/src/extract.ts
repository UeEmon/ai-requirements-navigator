/**
 * 取り込んだ資料から本文のテキストを取り出す。
 * - テキスト（.txt / .md / .csv / .tsv）: UTF-8。読めない文字が多ければ Shift_JIS として読む
 * - Word（.docx）: ZIP を自前で読み、word/document.xml の本文を取り出す（追加の依存なし）
 * - PDF（.pdf）: pdfjs-dist（Apache-2.0）。画像だけのPDF（スキャン）は文字を取り出せない
 * 展開後の大きさに上限を設け、ZIP爆弾などで負荷がかからないようにする。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

export class ExtractError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

export type DocumentFormat = "text" | "docx" | "pdf";

/** 取り込める資料の上限 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;
/** 保存する本文の上限（文字） */
export const MAX_TEXT_CHARS = 300_000;

export function formatOf(name: string, mime = ""): DocumentFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith(".docx") || mime.includes("wordprocessingml")) return "docx";
  if (n.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (/\.(txt|md|markdown|csv|tsv|log)$/.test(n) || mime.startsWith("text/")) return "text";
  return null;
}

export async function extractText(name: string, data: Buffer, mime = ""): Promise<{ text: string; format: DocumentFormat; truncated: boolean }> {
  if (data.length > MAX_UPLOAD_BYTES) throw new ExtractError(`ファイルが大きすぎます（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`, 413);
  const format = formatOf(name, mime);
  if (!format) throw new ExtractError("この形式は取り込めません。テキスト（.txt / .md / .csv）、Word（.docx）、PDF（.pdf）に対応しています", 415);
  let text = format === "docx" ? docxText(data) : format === "pdf" ? await pdfText(data) : decodeText(data);
  text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) {
    throw new ExtractError(format === "pdf" ? "PDFから文字を取り出せませんでした（画像だけのPDFは取り込めません。文字を選択できるPDFにしてください）" : "本文が空です");
  }
  const truncated = text.length > MAX_TEXT_CHARS;
  return { text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, format, truncated };
}

/** UTF-8 で読み、文字化けが多ければ Shift_JIS で読み直す */
export function decodeText(data: Buffer): string {
  const utf8 = new TextDecoder("utf-8").decode(data).replace(/^﻿/, "");
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad === 0) return utf8;
  try {
    const sjis = new TextDecoder("shift_jis").decode(data);
    if ((sjis.match(/�/g) ?? []).length < bad) return sjis;
  } catch {
    /* Shift_JIS が使えない環境ではそのまま */
  }
  return utf8;
}

/* ------------------------------------------------------------------ */
/* ZIP（.docx）                                                         */
/* ------------------------------------------------------------------ */

/** ZIPの中の1ファイルを取り出す（中央ディレクトリを読む。暗号化・ZIP64は対象外） */
export function unzipEntry(zip: Buffer, entryName: string): Buffer | null {
  const min = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractError("Wordファイルとして読めません（ZIP形式ではありません）");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new ExtractError("Wordファイルが壊れています");
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== entryName) continue;
    if (size > MAX_UNZIPPED_BYTES) throw new ExtractError("Wordファイルの本文が大きすぎます", 413);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new ExtractError("Wordファイルが壊れています");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(body);
    if (method === 8) {
      try {
        return inflateRawSync(body, { maxOutputLength: MAX_UNZIPPED_BYTES });
      } catch {
        throw new ExtractError("Wordファイルの本文を展開できませんでした");
      }
    }
    throw new ExtractError("対応していない圧縮形式です");
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (XML_ENTITIES[e] ?? m),
  );

/** word/document.xml の段落・表を、改行とタブで区切ったテキストにする（表は1行＝1行、セルはタブ区切り） */
export function docxText(data: Buffer): string {
  const xml = unzipEntry(data, "word/document.xml");
  if (!xml) throw new ExtractError("Wordファイルに本文がありません");
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<w:tc[\s>]|<\/w:tc>|<\/w:tr>|<\/w:p>/g;
  let out = "";
  let cell = 0;
  for (const m of xml.toString("utf8").matchAll(re)) {
    const tag = m[0];
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (tag === "<w:tab/>") out += "\t";
    else if (tag.startsWith("<w:br")) out += "\n";
    else if (tag.startsWith("<w:tc")) cell++;
    else if (tag === "</w:tc>") {
      cell = Math.max(0, cell - 1);
      out = out.replace(/ $/, "") + "\t";
    } else if (tag === "</w:tr>") out = out.replace(/\t$/, "") + "\n";
    // セルの中の段落は空白でつなぐ
    else out += cell ? " " : "\n";
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/** PDF の文字を取り出す（ページごとに改行。行の区切りは文字の位置から判断） */
export async function pdfText(data: Buffer): Promise<string> {
  let pdfjs: any;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    throw new ExtractError("PDFの読み込み部品（pdfjs-dist）がありません", 501);
  }
  // 日本語のPDFは CMap が必要
  let base = "";
  try {
    base = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  } catch {
    /* 見つからなければ CMap なしで読む */
  }
  const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      cMapUrl: base ? `${join(base, "cmaps")}/` : undefined,
      cMapPacked: true,
      standardFontDataUrl: base ? `${join(base, "standard_fonts")}/` : undefined,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
  const doc = await task.promise.catch(async (e: Error) => {
    await task.destroy?.();
    throw new ExtractError(/password/i.test(e.message) ? "パスワード付きのPDFは取り込めません" : "PDFとして読めません");
  });
  const pages: string[] = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, 300); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      let lastY: number | null = null;
      const lines: string[] = [];
      for (const it of content.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>) {
        const y = it.transform?.[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 2 && line) {
          lines.push(line);
          line = "";
        }
        line += it.str;
        lastY = y;
        if (it.hasEOL) {
          lines.push(line);
          line = "";
          lastY = null;
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
    }
  } finally {
    await task.destroy?.();
  }
  return pages.join("\n\n");
}
