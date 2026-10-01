import { toMermaidUseCase, toPlantUmlUseCase } from "@arn/ai-core";
import type { Decision, Project, Requirement } from "./store.js";

const SECTIONS: Array<[string, Requirement["type"]]> = [
  ["1. 目的", "BR"],
  ["2. 利用者", "AC"],
  ["3. 機能要件", "FR"],
  ["4. 非機能要件", "NFR"],
  ["5. 制約条件", "CN"],
];
const PRIORITY: Record<string, string> = { must: "必須", should: "推奨", could: "任意" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** 要件定義書をMarkdownで生成する（Word/PDFへの変換は docx・pdfmake などMITライブラリで行う想定） */
export function buildSpecMarkdown(project: Project, reqs: Requirement[], decisions: Decision[], date = new Date()): string {
  const out: string[] = [];
  out.push(`# ${project.name} 要件定義書`, "");
  out.push(`作成日: ${date.toISOString().slice(0, 10)}　要件: ${reqs.length}件　決定: ${decisions.length}回`, "");
  if (project.purpose) out.push(`> ${project.purpose}`, "");
  for (const [title, type] of SECTIONS) {
    const rows = reqs.filter((r) => r.type === type);
    out.push(`## ${title}`, "");
    if (!rows.length) {
      out.push("（未確定）", "");
      continue;
    }
    out.push("| ID | 内容 | 優先度 | 根拠 |", "| --- | --- | --- | --- |");
    for (const r of rows) {
      const body = r.description ? `${r.title}：${r.description}` : r.title;
      out.push(`| ${r.code} | ${cell(body)} | ${PRIORITY[r.priority] ?? r.priority} | ${cell(r.source)} |`);
    }
    out.push("");
  }
  const uml = reqs.map((r) => ({ code: r.code, type: r.type, title: r.title }));
  out.push("## 6. UML", "", "### ユースケース図", "", "```mermaid", toMermaidUseCase(project.name, uml), "```", "");
  out.push("<details><summary>PlantUML</summary>", "", "```plantuml", toPlantUmlUseCase(project.name, uml), "```", "", "</details>", "");
  out.push("## 7. 決定記録", "");
  if (!decisions.length) out.push("（まだありません）");
  for (const d of decisions) {
    const map = Object.entries(d.mapping)
      .map(([l, p]) => `${l}=${p}`)
      .join(" / ");
    out.push(`- ${d.createdAt.slice(0, 10)} ${d.pick}を採用：${d.reason || "（理由未入力）"}${map ? `（${map}）` : ""}`);
  }
  out.push("");
  return out.join("\n");
}
