import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Diagram } from "@arn/ai-core";
import type { Decision, Project, Requirement } from "./store.js";

/**
 * 要件定義書。いったん構造化（Spec）し、Markdown / Word / PDF の3形式に描き分ける。
 *   Word: docx（MIT） / PDF: pdfmake（MIT）＋ Noto Sans CJK（SIL OFL 1.1）
 */

export type SpecFormat = "md" | "docx" | "pdf";

export interface Spec {
  title: string;
  date: string;
  purpose: string;
  counts: { requirements: number; decisions: number };
  sections: Array<{ title: string; rows: Requirement[] }>;
  diagrams: Diagram[];
  decisions: Decision[];
}

/** 画面で描画した図の画像（PNG）。title で図と対応づける */
export interface SpecImage {
  title: string;
  png: Buffer;
  width: number;
  height: number;
}

const SECTIONS: Array<[string, Requirement["type"]]> = [
  ["1. 目的", "BR"],
  ["2. 利用者", "AC"],
  ["3. 機能要件", "FR"],
  ["4. 非機能要件", "NFR"],
  ["5. 制約条件", "CN"],
];
const PRIORITY: Record<string, string> = { must: "必須", should: "推奨", could: "任意" };
const bodyOf = (r: Requirement) => (r.description ? `${r.title}：${r.description}` : r.title);
const mapping = (d: Decision) =>
  Object.entries(d.mapping)
    .map(([l, p]) => `${l}=${p}`)
    .join(" / ");

export function buildSpec(project: Project, reqs: Requirement[], decisions: Decision[], diagrams: Diagram[], date = new Date()): Spec {
  return {
    title: `${project.name} 要件定義書`,
    date: date.toISOString().slice(0, 10),
    purpose: project.purpose,
    counts: { requirements: reqs.length, decisions: decisions.length },
    sections: SECTIONS.map(([title, type]) => ({ title, rows: reqs.filter((r) => r.type === type) })),
    diagrams,
    decisions,
  };
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(spec: Spec): string {
  const out: string[] = [`# ${spec.title}`, ""];
  out.push(`作成日: ${spec.date}　要件: ${spec.counts.requirements}件　決定: ${spec.counts.decisions}回`, "");
  if (spec.purpose) out.push(`> ${spec.purpose}`, "");
  for (const s of spec.sections) {
    out.push(`## ${s.title}`, "");
    if (!s.rows.length) {
      out.push("（未確定）", "");
      continue;
    }
    out.push("| ID | 内容 | 優先度 | 根拠 |", "| --- | --- | --- | --- |");
    for (const r of s.rows) out.push(`| ${r.code} | ${cell(bodyOf(r))} | ${PRIORITY[r.priority] ?? r.priority} | ${cell(r.source)} |`);
    out.push("");
  }
  out.push("## 6. UML", "");
  for (const d of spec.diagrams) {
    out.push(`### ${d.title}`, "", "```mermaid", d.mermaid, "```", "");
    out.push("<details><summary>PlantUML</summary>", "", "```plantuml", d.plantuml, "```", "", "</details>", "");
  }
  out.push("## 7. 決定記録", "");
  if (!spec.decisions.length) out.push("（まだありません）");
  for (const d of spec.decisions) {
    const m = mapping(d);
    out.push(`- ${d.createdAt.slice(0, 10)} ${d.pick}を採用：${d.reason || "（理由未入力）"}${m ? `（${m}）` : ""}`);
  }
  out.push("");
  return out.join("\n");
}

/** 互換用: Markdown を直接作る */
export function buildSpecMarkdown(project: Project, reqs: Requirement[], decisions: Decision[], diagrams: Diagram[] = [], date = new Date()): string {
  return renderMarkdown(buildSpec(project, reqs, decisions, diagrams, date));
}

/** 画像を本文幅に収める */
function fitSize(img: SpecImage, maxW: number, maxH: number) {
  const r = Math.min(1, maxW / img.width, maxH / img.height);
  return { width: Math.round(img.width * r), height: Math.round(img.height * r) };
}

/* ------------------------------------------------------------------ */
/* Word (.docx)                                                        */
/* ------------------------------------------------------------------ */

export async function renderDocx(spec: Spec, images: SpecImage[] = []): Promise<Buffer> {
  const d = await import("docx");
  const FONT = { ascii: "Yu Gothic", eastAsia: "Yu Gothic", hAnsi: "Yu Gothic", cs: "Yu Gothic" };
  const MONO = { ascii: "Consolas", eastAsia: "MS Gothic", hAnsi: "Consolas", cs: "Consolas" };
  const imgByTitle = new Map(images.map((i) => [i.title, i]));
  const p = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
    new d.Paragraph({ children: [new d.TextRun({ text, ...opts })] });
  const h = (text: string, level: (typeof d.HeadingLevel)[keyof typeof d.HeadingLevel]) => new d.Paragraph({ text, heading: level });
  const tcell = (text: string, header = false, pct = 0) =>
    new d.TableCell({
      children: [new d.Paragraph({ children: [new d.TextRun({ text, bold: header, size: 19 })] })],
      shading: header ? { type: d.ShadingType.CLEAR, fill: "E8EEF4", color: "auto" } : undefined,
      width: pct ? { size: pct, type: d.WidthType.PERCENTAGE } : undefined,
    });
  const code = (text: string) =>
    new d.Paragraph({
      shading: { type: d.ShadingType.CLEAR, fill: "F3F5F7", color: "auto" },
      children: text.split("\n").map((line, i) => new d.TextRun({ text: line, font: MONO, size: 15, break: i ? 1 : 0 })),
    });

  const children: Array<InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>> = [
    new d.Paragraph({ text: spec.title, heading: d.HeadingLevel.TITLE }),
    p(`作成日: ${spec.date}　要件: ${spec.counts.requirements}件　決定: ${spec.counts.decisions}回`, { color: "55636F" }),
  ];
  if (spec.purpose) children.push(p(spec.purpose));

  for (const s of spec.sections) {
    children.push(h(s.title, d.HeadingLevel.HEADING_1));
    if (!s.rows.length) {
      children.push(p("（未確定）", { color: "55636F" }));
      continue;
    }
    children.push(
      new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE },
        rows: [
          new d.TableRow({
            tableHeader: true,
            children: [tcell("ID", true, 12), tcell("内容", true, 60), tcell("優先度", true, 10), tcell("根拠", true, 18)],
          }),
          ...s.rows.map(
            (r) =>
              new d.TableRow({
                children: [tcell(r.code), tcell(bodyOf(r)), tcell(PRIORITY[r.priority] ?? r.priority), tcell(r.source)],
              }),
          ),
        ],
      }),
    );
  }

  children.push(h("6. UML", d.HeadingLevel.HEADING_1));
  for (const dg of spec.diagrams) {
    children.push(h(dg.title, d.HeadingLevel.HEADING_2));
    const img = imgByTitle.get(dg.title);
    if (img) {
      // A4縦の本文幅（約16cm）≒ 600px に収める
      const size = fitSize(img, 600, 800);
      children.push(new d.Paragraph({ children: [new d.ImageRun({ type: "png", data: img.png, transformation: size })] }));
    } else {
      children.push(p("図のソース（Mermaid）。画面の「仕様書」から出力すると図の画像が入ります。", { size: 18, color: "55636F" }));
      children.push(code(dg.mermaid));
    }
  }

  children.push(h("7. 決定記録", d.HeadingLevel.HEADING_1));
  if (!spec.decisions.length) children.push(p("（まだありません）"));
  for (const dc of spec.decisions) {
    const m = mapping(dc);
    children.push(
      new d.Paragraph({
        bullet: { level: 0 },
        children: [new d.TextRun(`${dc.createdAt.slice(0, 10)} ${dc.pick}を採用：${dc.reason || "（理由未入力）"}${m ? `（${m}）` : ""}`)],
      }),
    );
  }

  const doc = new d.Document({
    creator: "要件ナビ",
    title: spec.title,
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{ children }],
  });
  return d.Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

type FontDescriptor = string | [string, string];
export interface PdfFont {
  normal: FontDescriptor;
  bold: FontDescriptor;
}

/** 日本語を表示できるフォントを探す。PDF_FONT_PATH（TTF/OTF）で明示もできる */
export function findPdfFont(env = process.env): PdfFont | null {
  if (env.PDF_FONT_PATH && existsSync(env.PDF_FONT_PATH)) {
    const bold = env.PDF_FONT_BOLD_PATH && existsSync(env.PDF_FONT_BOLD_PATH) ? env.PDF_FONT_BOLD_PATH : env.PDF_FONT_PATH;
    return { normal: env.PDF_FONT_PATH, bold };
  }
  // Noto Sans CJK（SIL OFL 1.1）。Alpine: font-noto-cjk / Debian・Ubuntu: fonts-noto-cjk
  const reg = findFile(env.FONT_DIR ?? "/usr/share/fonts", "NotoSansCJK-Regular.ttc", 4);
  if (reg) {
    const boldPath = join(reg, "..", "NotoSansCJK-Bold.ttc");
    return {
      normal: [reg, "NotoSansCJKjp-Regular"],
      bold: existsSync(boldPath) ? [boldPath, "NotoSansCJKjp-Bold"] : [reg, "NotoSansCJKjp-Regular"],
    };
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth < 0 || !existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = findFile(join(dir, e.name), name, depth - 1);
      if (hit) return hit;
    }
  } catch {
    /* 読めないディレクトリは飛ばす */
  }
  return null;
}

let fontCache: PdfFont | null | undefined;
/** 起動中は結果を使い回す */
export function cachedPdfFont(): PdfFont | null {
  if (fontCache === undefined) fontCache = findPdfFont();
  return fontCache;
}

export class PdfFontMissingError extends Error {
  constructor() {
    super("PDF出力に使う日本語フォントがありません。Noto Sans CJK をインストールするか PDF_FONT_PATH を設定してください");
    this.name = "PdfFontMissingError";
  }
}

export async function renderPdf(spec: Spec, images: SpecImage[] = [], font: PdfFont | null = cachedPdfFont()): Promise<Buffer> {
  if (!font) throw new PdfFontMissingError();
  const mod: any = await import("pdfmake");
  const PdfPrinter = mod.default ?? mod;
  const printer = new PdfPrinter({ JP: { normal: font.normal, bold: font.bold, italics: font.normal, bolditalics: font.bold } });
  const imgByTitle = new Map(images.map((i) => [i.title, i]));

  const content: any[] = [
    { text: spec.title, style: "title" },
    { text: `作成日: ${spec.date}　要件: ${spec.counts.requirements}件　決定: ${spec.counts.decisions}回`, style: "meta" },
  ];
  if (spec.purpose) content.push({ text: spec.purpose, margin: [0, 0, 0, 8] });

  for (const s of spec.sections) {
    content.push({ text: s.title, style: "h1" });
    if (!s.rows.length) {
      content.push({ text: "（未確定）", style: "meta" });
      continue;
    }
    content.push({
      table: {
        headerRows: 1,
        widths: [48, "*", 36, 64],
        body: [
          ["ID", "内容", "優先度", "根拠"].map((t) => ({ text: t, bold: true, fillColor: "#E8EEF4" })),
          ...s.rows.map((r) => [r.code, bodyOf(r), PRIORITY[r.priority] ?? r.priority, r.source]),
        ],
      },
      layout: "lightHorizontalLines",
      fontSize: 9,
    });
  }

  content.push({ text: "6. UML", style: "h1", pageBreak: "before" });
  for (const dg of spec.diagrams) {
    content.push({ text: dg.title, style: "h2" });
    const img = imgByTitle.get(dg.title);
    if (img) {
      // A4の本文幅 515pt に収める
      content.push({ image: `data:image/png;base64,${img.png.toString("base64")}`, fit: [515, 640], margin: [0, 0, 0, 8] });
    } else {
      content.push({ text: "図のソース（Mermaid）。画面の「仕様書」から出力すると図の画像が入ります。", style: "meta" });
      content.push({ text: dg.mermaid, fontSize: 7, color: "#333333", background: "#F3F5F7", margin: [0, 0, 0, 8], preserveLeadingSpaces: true });
    }
  }

  content.push({ text: "7. 決定記録", style: "h1" });
  content.push(
    spec.decisions.length
      ? {
          ul: spec.decisions.map((dc) => {
            const m = mapping(dc);
            return `${dc.createdAt.slice(0, 10)} ${dc.pick}を採用：${dc.reason || "（理由未入力）"}${m ? `（${m}）` : ""}`;
          }),
          fontSize: 9,
        }
      : { text: "（まだありません）", style: "meta" },
  );

  const docDefinition = {
    info: { title: spec.title, creator: "要件ナビ" },
    pageSize: "A4",
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: "JP", fontSize: 10, lineHeight: 1.3 },
    styles: {
      title: { fontSize: 18, bold: true, margin: [0, 0, 0, 4] },
      meta: { fontSize: 9, color: "#55636F", margin: [0, 0, 0, 8] },
      h1: { fontSize: 14, bold: true, margin: [0, 14, 0, 6] },
      h2: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
    },
    footer: (page: number, pages: number) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 8, color: "#55636F" }),
    content,
  };

  const pdf = printer.createPdfKitDocument(docDefinition);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.end();
  });
}

export const CONTENT_TYPE: Record<SpecFormat, string> = {
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};
