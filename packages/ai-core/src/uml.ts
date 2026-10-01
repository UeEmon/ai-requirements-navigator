/** 要件からUMLのテキストを生成する（Mermaid: MIT、PlantUMLはテキスト出力のみでライブラリ非依存） */
export interface UmlRequirement {
  code: string;
  type: string;
  title: string;
}

const clean = (s: string) => s.replace(/["[\]{}()<>#;|]/g, "").replace(/\s+/g, " ").trim();
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);

function actorsOf(reqs: UmlRequirement[]): string[] {
  const acs = reqs.filter((r) => r.type === "AC").map((r) => clean(r.title.split(/[：:]/)[0] ?? r.title));
  return acs.length ? acs : ["利用者"];
}

export function toMermaidUseCase(systemName: string, reqs: UmlRequirement[]): string {
  const actors = actorsOf(reqs);
  const frs = reqs.filter((r) => r.type === "FR");
  const lines = ["flowchart LR"];
  actors.forEach((a, i) => lines.push(`  A${i}(["${a}"])`));
  lines.push(`  subgraph SYS["${clean(systemName)}"]`);
  if (!frs.length) lines.push(`    U0(("機能要件は未確定"))`);
  frs.forEach((f, i) => lines.push(`    U${i}(("${f.code} ${short(clean(f.title))}"))`));
  lines.push("  end");
  frs.forEach((f, i) => {
    const idx = actors.findIndex((a) => f.title.includes(a));
    lines.push(`  A${idx < 0 ? 0 : idx} --- U${i}`);
  });
  return lines.join("\n");
}

export function toPlantUmlUseCase(systemName: string, reqs: UmlRequirement[]): string {
  const actors = actorsOf(reqs);
  const frs = reqs.filter((r) => r.type === "FR");
  const lines = ["@startuml", "left to right direction"];
  actors.forEach((a, i) => lines.push(`actor "${a}" as A${i}`));
  lines.push(`rectangle "${clean(systemName)}" {`);
  frs.forEach((f, i) => lines.push(`  usecase "${f.code} ${short(clean(f.title))}" as U${i}`));
  lines.push("}");
  frs.forEach((f, i) => {
    const idx = actors.findIndex((a) => f.title.includes(a));
    lines.push(`A${idx < 0 ? 0 : idx} --> U${i}`);
  });
  lines.push("@enduml");
  return lines.join("\n");
}
