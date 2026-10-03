import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PHASE_BOUNDARY, RULE_KINDS, type BusinessRule, type Diagram, type Table } from "@arn/ai-core";
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
  /** 確定版の表示（例: 確定版 v2） */
  baseline?: string;
  /** 決定記録の後に続く節（画面一覧・申し送り・変更履歴など） */
  extras?: SpecExtra[];
  umlTitle?: string;
  decisionsTitle?: string;
}

/** 決定記録の後に続く節。箇条書き（lines）と表（tables） */
export interface SpecExtra {
  title: string;
  lines: string[];
  tables?: Table[];
}

/** 画面で描画した図の画像（PNG）。title で図と対応づける */
export interface SpecImage {
  title: string;
  png: Buffer;
  width: number;
  height: number;
}

const SECTIONS: Array<[string, Requirement["type"]]> = [
  ["目的", "BR"],
  ["利用者", "AC"],
  ["機能要件", "FR"],
  ["業務ルール", "RL"],
  ["非機能要件", "NFR"],
  ["制約条件", "CN"],
];
const PRIORITY: Record<string, string> = { must: "必須", should: "推奨", could: "任意" };
/** 業務ルールは種類と具体例も載せる */
const ruleText = (rule: BusinessRule | null | undefined) =>
  rule ? `［${RULE_KINDS[rule.kind]}］${rule.examples.length ? ` 具体例：${rule.examples.map((e) => `${e.given} → ${e.expected}`).join("／")}` : ""}` : "";
const bodyOf = (r: Requirement) => [r.title, r.description, r.type === "RL" ? ruleText(r.rule) : ""].filter(Boolean).join("：");
/** 「8. 画面一覧」のような番号を外す（番号は描くときに振り直す） */
const unnumber = (t: string) => t.replace(/^\d+\.\s*/, "");

/** この要件定義書で決めていること（工程の線引き） */
export const SCOPE_TABLE: Table = {
  head: ["区分", "この要件定義書で決めていること", "設計工程で決めること", "テスト工程で決めること"],
  rows: PHASE_BOUNDARY.map((b) => [b.area, b.requirements, b.design, b.test]),
};
const mapping = (d: Decision) =>
  Object.entries(d.mapping)
    .map(([l, p]) => `${l}=${p}`)
    .join(" / ");

export function buildSpec(
  project: Project,
  reqs: Requirement[],
  decisions: Decision[],
  diagrams: Diagram[],
  date = new Date(),
  more: { baseline?: string; extras?: Spec["extras"] } = {},
): Spec {
  // 番号は節の並びで振る（モジュールごとの節があったりなかったりしても飛ばない）
  const sections = SECTIONS.map(([title, type], i) => ({ title: `${i + 1}. ${title}`, rows: reqs.filter((r) => r.type === type) }));
  let n = sections.length;
  const umlTitle = `${++n}. UML`;
  const decisionsTitle = `${++n}. 決定記録`;
  const extras = (more.extras ?? []).map((x) => ({ ...x, title: `${++n}. ${unnumber(x.title)}` }));
  return {
    ...more,
    extras,
    title: `${project.name} 要件定義書`,
    date: date.toISOString().slice(0, 10),
    purpose: project.purpose,
    counts: { requirements: reqs.length, decisions: decisions.length },
    sections,
    umlTitle,
    decisionsTitle,
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
  out.push(`作成日: ${spec.date}　要件: ${spec.counts.requirements}件　決定: ${spec.counts.decisions}回${spec.baseline ? `　${spec.baseline}` : ""}`, "");
  if (spec.purpose) out.push(`> ${spec.purpose}`, "");
  out.push("## この要件定義書の範囲", "", "要件定義では「何を・どの条件で・何を満たせばよいか」を決め、「どう作るか」は設計工程、「どう確かめるか」はテスト工程で決めます。", "");
  out.push(`| ${SCOPE_TABLE.head.join(" | ")} |`, `| ${SCOPE_TABLE.head.map(() => "---").join(" | ")} |`, ...SCOPE_TABLE.rows.map((r) => `| ${r.join(" | ")} |`), "");
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
  out.push(`## ${spec.umlTitle ?? "UML"}`, "");
  for (const d of spec.diagrams) {
    out.push(`### ${d.title}`, "", "```mermaid", d.mermaid, "```", "");
    out.push("<details><summary>PlantUML</summary>", "", "```plantuml", d.plantuml, "```", "", "</details>", "");
  }
  out.push(`## ${spec.decisionsTitle ?? "決定記録"}`, "");
  if (!spec.decisions.length) out.push("（まだありません）");
  for (const d of spec.decisions) {
    const m = mapping(d);
    out.push(`- ${d.createdAt.slice(0, 10)} ${d.pick}を採用：${d.reason || "（理由未入力）"}${m ? `（${m}）` : ""}`);
  }
  out.push("");
  for (const ex of spec.extras ?? []) {
    out.push(`## ${ex.title}`, "");
    const tables = ex.tables ?? [];
    if (!ex.lines.length && !tables.length) out.push("（まだありません）", "");
    if (ex.lines.length) out.push(...ex.lines.map((l) => `- ${l}`), "");
    for (const t of tables) {
      if (t.caption) out.push(`**${t.caption}**`, "");
      out.push(`| ${t.head.map(cell).join(" | ")} |`, `| ${t.head.map(() => "---").join(" | ")} |`);
      for (const r of t.rows) out.push(`| ${r.map((x) => cell(x || " ")).join(" | ")} |`);
      out.push("");
    }
  }
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
    p(`作成日: ${spec.date}　要件: ${spec.counts.requirements}件　決定: ${spec.counts.decisions}回${spec.baseline ? `　${spec.baseline}` : ""}`, { color: "55636F" }),
  ];
  if (spec.purpose) children.push(p(spec.purpose));
  children.push(h("この要件定義書の範囲", d.HeadingLevel.HEADING_1));
  children.push(p("要件定義では「何を・どの条件で・何を満たせばよいか」を決め、「どう作るか」は設計工程、「どう確かめるか」はテスト工程で決めます。"));
  children.push(
    new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      rows: [new d.TableRow({ tableHeader: true, children: SCOPE_TABLE.head.map((x) => tcell(x, true)) }), ...SCOPE_TABLE.rows.map((r) => new d.TableRow({ children: r.map((x) => tcell(x)) }))],
    }),
  );

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

  children.push(h(spec.umlTitle ?? "UML", d.HeadingLevel.HEADING_1));
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

  children.push(h(spec.decisionsTitle ?? "決定記録", d.HeadingLevel.HEADING_1));
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
  for (const ex of spec.extras ?? []) {
    children.push(h(ex.title, d.HeadingLevel.HEADING_1));
    const tables = ex.tables ?? [];
    if (!ex.lines.length && !tables.length) children.push(p("（まだありません）"));
    for (const line of ex.lines) children.push(new d.Paragraph({ bullet: { level: 0 }, children: [new d.TextRun(line)] }));
    for (const t of tables) {
      if (t.caption) children.push(p(t.caption, { bold: true, size: 19 }));
      children.push(
        new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          rows: [
            new d.TableRow({ tableHeader: true, children: t.head.map((x) => tcell(x, true)) }),
            ...t.rows.map((r) => new d.TableRow({ children: r.map((x) => tcell(x)) })),
          ],
        }),
      );
    }
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
    { text: `作成日: ${spec.date}　要件: ${spec.counts.requirements}件　決定: ${spec.counts.decisions}回${spec.baseline ? `　${spec.baseline}` : ""}`, style: "meta" },
  ];
  if (spec.purpose) content.push({ text: spec.purpose, margin: [0, 0, 0, 8] });
  content.push({ text: "この要件定義書の範囲", style: "h1" });
  content.push({ text: "要件定義では「何を・どの条件で・何を満たせばよいか」を決め、「どう作るか」は設計工程、「どう確かめるか」はテスト工程で決めます。", fontSize: 9, margin: [0, 0, 0, 4] });
  content.push({
    table: { headerRows: 1, widths: [50, "*", "*", "*"], body: [SCOPE_TABLE.head.map((t) => ({ text: t, bold: true, fillColor: "#E8EEF4" })), ...SCOPE_TABLE.rows] },
    layout: "lightHorizontalLines",
    fontSize: 8,
  });

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

  content.push({ text: spec.umlTitle ?? "UML", style: "h1", pageBreak: "before" });
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

  content.push({ text: spec.decisionsTitle ?? "決定記録", style: "h1" });
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
  for (const ex of spec.extras ?? []) {
    content.push({ text: ex.title, style: "h1" });
    const tables = ex.tables ?? [];
    if (ex.lines.length) content.push({ ul: ex.lines, fontSize: 9 });
    else if (!tables.length) content.push({ text: "（まだありません）", style: "meta" });
    for (const t of tables) {
      if (t.caption) content.push({ text: t.caption, bold: true, fontSize: 9, margin: [0, 6, 0, 2] });
      content.push({
        table: {
          headerRows: 1,
          widths: t.head.map(() => "*"),
          body: [t.head.map((x) => ({ text: x, bold: true, fillColor: "#E8EEF4" })), ...t.rows.map((r) => r.map((x) => x || " "))],
        },
        layout: "lightHorizontalLines",
        fontSize: t.head.length > 6 ? 7 : 8,
        margin: [0, 0, 0, 8],
      });
    }
  }

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
