/**
 * UML の生成。
 * - ユースケース図・アクティビティ図（簡易）は、要件から規則的に作る
 * - クラス図・シーケンス図・状態遷移図・アクティビティ図は、AIが出した設計モデル（JSON）から作る
 * AIに図の記法を直接書かせず、検証済みのモデルからプログラムで Mermaid / PlantUML に変換する。
 * これにより構文エラーで図が壊れることを防ぐ（Mermaid: MIT。PlantUML はテキスト出力のみ）。
 */
import { z } from "zod";
import { extractJson } from "./json.js";
import type { AIProvider, Usage } from "./types.js";

export interface UmlRequirement {
  code: string;
  type: string;
  title: string;
}

export type DiagramKind = "usecase" | "class" | "sequence" | "state" | "activity";

export interface Diagram {
  kind: DiagramKind;
  title: string;
  mermaid: string;
  plantuml: string;
  /** rule: 要件から規則的に作成 / ai: AIの設計モデルから作成 */
  source: "rule" | "ai";
}

/* ------------------------------------------------------------------ */
/* 設計モデル（AIの出力）                                               */
/* ------------------------------------------------------------------ */

const name = z.string().min(1).max(80);
export const UmlModel = z.object({
  classes: z
    .array(
      z.object({
        name,
        label: z.string().max(80).optional(),
        attributes: z.array(z.object({ name, type: z.string().max(40).default("string") })).default([]),
        operations: z.array(z.string().max(80)).default([]),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        from: name,
        to: name,
        kind: z.enum(["association", "composition", "aggregation", "inheritance", "dependency"]).default("association"),
        fromMultiplicity: z.string().max(10).optional(),
        toMultiplicity: z.string().max(10).optional(),
        label: z.string().max(60).optional(),
      }),
    )
    .default([]),
  sequences: z
    .array(
      z.object({
        title: z.string().max(80),
        participants: z.array(z.object({ id: name, label: z.string().max(60), actor: z.boolean().default(false) })),
        messages: z.array(z.object({ from: name, to: name, text: z.string().max(120), reply: z.boolean().default(false) })),
      }),
    )
    .default([]),
  stateMachines: z
    .array(
      z.object({
        entity: z.string().max(80),
        states: z.array(z.string().max(60)).min(1),
        initial: z.string().max(60),
        finals: z.array(z.string().max(60)).default([]),
        transitions: z.array(z.object({ from: z.string(), to: z.string(), event: z.string().max(60).default("") })),
      }),
    )
    .default([]),
  activities: z
    .array(
      z.object({
        title: z.string().max(80),
        steps: z.array(z.object({ id: name, label: z.string().max(80), kind: z.enum(["action", "decision"]).default("action") })).min(1),
        edges: z.array(z.object({ from: name, to: name, label: z.string().max(40).optional() })),
      }),
    )
    .default([]),
});
export type UmlModel = z.infer<typeof UmlModel>;

/** 存在しない要素への参照を取り除き、図が壊れないようにする */
export function normalizeUmlModel(m: UmlModel): { model: UmlModel; dropped: number } {
  let dropped = 0;
  const keep = <T>(arr: T[], ok: (x: T) => boolean) =>
    arr.filter((x) => {
      const r = ok(x);
      if (!r) dropped++;
      return r;
    });
  const classes = m.classes.filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i);
  const cn = new Set(classes.map((c) => c.name));
  const relations = keep(m.relations, (r) => cn.has(r.from) && cn.has(r.to));
  const sequences = m.sequences
    .map((s) => {
      const ids = new Set(s.participants.map((p) => p.id));
      return { ...s, messages: keep(s.messages, (x) => ids.has(x.from) && ids.has(x.to)) };
    })
    .filter((s) => s.participants.length && s.messages.length);
  const stateMachines = m.stateMachines.map((sm) => {
    const st = new Set(sm.states);
    return {
      ...sm,
      initial: st.has(sm.initial) ? sm.initial : sm.states[0]!,
      finals: sm.finals.filter((f) => st.has(f)),
      transitions: keep(sm.transitions, (t) => st.has(t.from) && st.has(t.to)),
    };
  });
  const activities = m.activities.map((a) => {
    const ids = new Set(a.steps.map((s) => s.id));
    return { ...a, edges: keep(a.edges, (e) => ids.has(e.from) && ids.has(e.to)) };
  });
  return { model: { classes, relations, sequences, stateMachines, activities }, dropped };
}

/* ------------------------------------------------------------------ */
/* 文字列の整形                                                         */
/* ------------------------------------------------------------------ */

/** 図のラベルとして安全な文字列にする（引用符や構文記号を除く） */
const txt = (s: string) => s.replace(/["[\]{}<>#;|`]/g, "").replace(/\s+/g, " ").trim();
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** 識別子（英数字と _ のみ）。使えない名前は番号つきの代替名にする */
function idMap(names: string[], prefix: string): Map<string, string> {
  const m = new Map<string, string>();
  names.forEach((n, i) => {
    const id = /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `${prefix}${i}`;
    m.set(n, [...m.values()].includes(id) ? `${prefix}${i}` : id);
  });
  return m;
}

/* ------------------------------------------------------------------ */
/* ユースケース図（規則）                                               */
/* ------------------------------------------------------------------ */

function actorsOf(reqs: UmlRequirement[]): string[] {
  const acs = reqs.filter((r) => r.type === "AC").map((r) => txt(r.title.split(/[：:]/)[0] ?? r.title));
  return acs.length ? acs : ["利用者"];
}
const actorIndex = (actors: string[], title: string) => {
  const i = actors.findIndex((a) => title.includes(a));
  return i < 0 ? 0 : i;
};

export function toMermaidUseCase(systemName: string, reqs: UmlRequirement[]): string {
  const actors = actorsOf(reqs);
  const frs = reqs.filter((r) => r.type === "FR");
  const lines = ["flowchart LR"];
  actors.forEach((a, i) => lines.push(`  A${i}(["${a}"])`));
  lines.push(`  subgraph SYS["${txt(systemName)}"]`);
  if (!frs.length) lines.push(`    U0(("機能要件は未確定"))`);
  frs.forEach((f, i) => lines.push(`    U${i}(("${f.code} ${short(txt(f.title))}"))`));
  lines.push("  end");
  frs.forEach((f, i) => lines.push(`  A${actorIndex(actors, f.title)} --- U${i}`));
  return lines.join("\n");
}

export function toPlantUmlUseCase(systemName: string, reqs: UmlRequirement[]): string {
  const actors = actorsOf(reqs);
  const frs = reqs.filter((r) => r.type === "FR");
  const lines = ["@startuml", "left to right direction"];
  actors.forEach((a, i) => lines.push(`actor "${a}" as A${i}`));
  lines.push(`rectangle "${txt(systemName)}" {`);
  frs.forEach((f, i) => lines.push(`  usecase "${f.code} ${short(txt(f.title))}" as U${i}`));
  lines.push("}");
  frs.forEach((f, i) => lines.push(`A${actorIndex(actors, f.title)} --> U${i}`));
  lines.push("@enduml");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* クラス図                                                             */
/* ------------------------------------------------------------------ */

const MM_REL: Record<string, string> = { association: "-->", composition: "*--", aggregation: "o--", dependency: "..>" };

export function toMermaidClass(m: UmlModel): string {
  const ids = idMap(m.classes.map((c) => c.name), "C");
  const lines = ["classDiagram", "  direction LR"];
  for (const c of m.classes) {
    const id = ids.get(c.name)!;
    lines.push(`  class ${id}["${txt(c.label ?? c.name)}"]`);
    for (const a of c.attributes) lines.push(`  ${id} : +${txt(a.name)} ${txt(a.type)}`);
    for (const o of c.operations) lines.push(`  ${id} : +${txt(o).replace(/\(.*$/, "")}()`);
  }
  for (const r of m.relations) {
    const f = ids.get(r.from)!;
    const t = ids.get(r.to)!;
    const label = r.label ? ` : ${txt(r.label)}` : "";
    if (r.kind === "inheritance") {
      lines.push(`  ${t} <|-- ${f}${label}`);
      continue;
    }
    const fm = r.fromMultiplicity ? ` "${txt(r.fromMultiplicity)}"` : "";
    const tm = r.toMultiplicity ? ` "${txt(r.toMultiplicity)}"` : "";
    lines.push(`  ${f}${fm} ${MM_REL[r.kind]}${tm} ${t}${label}`);
  }
  return lines.join("\n");
}

const PU_REL: Record<string, string> = { association: "-->", composition: "*--", aggregation: "o--", dependency: "..>" };

export function toPlantUmlClass(m: UmlModel): string {
  const ids = idMap(m.classes.map((c) => c.name), "C");
  const lines = ["@startuml", "left to right direction"];
  for (const c of m.classes) {
    lines.push(`class "${txt(c.label ?? c.name)}" as ${ids.get(c.name)} {`);
    for (const a of c.attributes) lines.push(`  +${txt(a.name)} : ${txt(a.type)}`);
    for (const o of c.operations) lines.push(`  +${txt(o).replace(/\(.*$/, "")}()`);
    lines.push("}");
  }
  for (const r of m.relations) {
    const f = ids.get(r.from)!;
    const t = ids.get(r.to)!;
    const label = r.label ? ` : ${txt(r.label)}` : "";
    if (r.kind === "inheritance") {
      lines.push(`${f} --|> ${t}${label}`);
      continue;
    }
    const fm = r.fromMultiplicity ? ` "${txt(r.fromMultiplicity)}"` : "";
    const tm = r.toMultiplicity ? ` "${txt(r.toMultiplicity)}"` : "";
    lines.push(`${f}${fm} ${PU_REL[r.kind]}${tm} ${t}${label}`);
  }
  lines.push("@enduml");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* シーケンス図                                                         */
/* ------------------------------------------------------------------ */

type Seq = UmlModel["sequences"][number];

export function toMermaidSequence(s: Seq): string {
  const ids = idMap(s.participants.map((p) => p.id), "P");
  const lines = ["sequenceDiagram", "  autonumber"];
  for (const p of s.participants) lines.push(`  ${p.actor ? "actor" : "participant"} ${ids.get(p.id)} as ${txt(p.label)}`);
  for (const m of s.messages) lines.push(`  ${ids.get(m.from)}${m.reply ? "-->>" : "->>"}${ids.get(m.to)}: ${txt(m.text) || " "}`);
  return lines.join("\n");
}

export function toPlantUmlSequence(s: Seq): string {
  const ids = idMap(s.participants.map((p) => p.id), "P");
  const lines = ["@startuml", "autonumber"];
  for (const p of s.participants) lines.push(`${p.actor ? "actor" : "participant"} "${txt(p.label)}" as ${ids.get(p.id)}`);
  for (const m of s.messages) lines.push(`${ids.get(m.from)} ${m.reply ? "-->" : "->"} ${ids.get(m.to)} : ${txt(m.text)}`);
  lines.push("@enduml");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 状態遷移図                                                           */
/* ------------------------------------------------------------------ */

type Sm = UmlModel["stateMachines"][number];

function smLines(sm: Sm, arrow: string): string[] {
  const id = new Map(sm.states.map((s, i) => [s, `S${i}`]));
  const out = sm.states.map((s) => `state "${txt(s)}" as ${id.get(s)}`);
  out.push(`[*] ${arrow} ${id.get(sm.initial)}`);
  for (const t of sm.transitions) out.push(`${id.get(t.from)} ${arrow} ${id.get(t.to)}${t.event ? ` : ${txt(t.event)}` : ""}`);
  for (const f of sm.finals) out.push(`${id.get(f)} ${arrow} [*]`);
  return out;
}

export function toMermaidState(sm: Sm): string {
  return ["stateDiagram-v2", ...smLines(sm, "-->").map((l) => `  ${l}`)].join("\n");
}

export function toPlantUmlState(sm: Sm): string {
  return ["@startuml", ...smLines(sm, "-->"), "@enduml"].join("\n");
}

/* ------------------------------------------------------------------ */
/* アクティビティ図                                                     */
/* ------------------------------------------------------------------ */

type Act = UmlModel["activities"][number];

function startsAndEnds(a: Act) {
  const hasIn = new Set(a.edges.map((e) => e.to));
  const hasOut = new Set(a.edges.map((e) => e.from));
  const starts = a.steps.filter((s) => !hasIn.has(s.id));
  const ends = a.steps.filter((s) => !hasOut.has(s.id));
  return { starts: starts.length ? starts : a.steps.slice(0, 1), ends };
}

export function toMermaidActivity(a: Act): string {
  const ids = idMap(a.steps.map((s) => s.id), "N");
  const lines = ["flowchart TD", "  START((開始))", "  END((終了))"];
  for (const s of a.steps) {
    const l = txt(s.label);
    lines.push(s.kind === "decision" ? `  ${ids.get(s.id)}{"${l}"}` : `  ${ids.get(s.id)}["${l}"]`);
  }
  const { starts, ends } = startsAndEnds(a);
  for (const s of starts) lines.push(`  START --> ${ids.get(s.id)}`);
  for (const e of a.edges) lines.push(`  ${ids.get(e.from)} -->${e.label ? `|${txt(e.label)}|` : ""} ${ids.get(e.to)}`);
  for (const s of ends) lines.push(`  ${ids.get(s.id)} --> END`);
  return lines.join("\n");
}

/** PlantUML の旧アクティビティ記法（任意のグラフを表せる） */
export function toPlantUmlActivity(a: Act): string {
  const label = new Map<string, string>();
  for (const s of a.steps) {
    let l = txt(s.label) + (s.kind === "decision" ? "？" : "");
    while ([...label.values()].includes(l)) l += " ";
    label.set(s.id, l);
  }
  const { starts, ends } = startsAndEnds(a);
  const lines = ["@startuml"];
  for (const s of starts) lines.push(`(*) --> "${label.get(s.id)}"`);
  for (const e of a.edges) lines.push(`"${label.get(e.from)}" -->${e.label ? ` [${txt(e.label)}]` : ""} "${label.get(e.to)}"`);
  for (const s of ends) lines.push(`"${label.get(s.id)}" --> (*)`);
  lines.push("@enduml");
  return lines.join("\n");
}

/** AIのモデルがない場合の簡易アクティビティ図: 機能要件を順に並べる */
export function activityFromRequirements(reqs: UmlRequirement[]): Act | null {
  const frs = reqs.filter((r) => r.type === "FR").slice(0, 12);
  if (!frs.length) return null;
  return {
    title: "業務の流れ（機能要件の順）",
    steps: frs.map((f, i) => ({ id: `N${i}`, label: `${f.code} ${short(f.title, 28)}`, kind: "action" as const })),
    edges: frs.slice(1).map((_, i) => ({ from: `N${i}`, to: `N${i + 1}` })),
  };
}

/* ------------------------------------------------------------------ */
/* まとめて生成                                                         */
/* ------------------------------------------------------------------ */

export function buildDiagrams(systemName: string, reqs: UmlRequirement[], model?: UmlModel | null): Diagram[] {
  const out: Diagram[] = [
    {
      kind: "usecase",
      title: "ユースケース図",
      mermaid: toMermaidUseCase(systemName, reqs),
      plantuml: toPlantUmlUseCase(systemName, reqs),
      source: "rule",
    },
  ];
  if (model?.classes.length) {
    out.push({ kind: "class", title: "クラス図（ドメインモデル）", mermaid: toMermaidClass(model), plantuml: toPlantUmlClass(model), source: "ai" });
  }
  for (const s of model?.sequences ?? []) {
    out.push({ kind: "sequence", title: `シーケンス図：${txt(s.title)}`, mermaid: toMermaidSequence(s), plantuml: toPlantUmlSequence(s), source: "ai" });
  }
  for (const sm of model?.stateMachines ?? []) {
    out.push({ kind: "state", title: `状態遷移図：${txt(sm.entity)}`, mermaid: toMermaidState(sm), plantuml: toPlantUmlState(sm), source: "ai" });
  }
  const acts = model?.activities.length ? model.activities : [];
  for (const a of acts) {
    out.push({ kind: "activity", title: `アクティビティ図：${txt(a.title)}`, mermaid: toMermaidActivity(a), plantuml: toPlantUmlActivity(a), source: "ai" });
  }
  if (!acts.length) {
    const a = activityFromRequirements(reqs);
    if (a) out.push({ kind: "activity", title: `アクティビティ図：${a.title}`, mermaid: toMermaidActivity(a), plantuml: toPlantUmlActivity(a), source: "rule" });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AIによる設計モデルの生成                                             */
/* ------------------------------------------------------------------ */

export const UML_SYSTEM = `あなたはソフトウェア設計者です。確定した要件から、概要設計のUMLモデルを作ります。
- 要件に書かれていないものを作り込まない。主要な概念・流れに絞る
- classes.name と participants.id と steps.id は英数字の識別子（例: Reservation）。画面に出す名前は label に日本語で書く
- relations / messages / transitions / edges は、同じJSON内に定義した名前だけを参照する
- sequences は主要な業務の流れを1〜2本、stateMachines は状態を持つ主要な概念を1〜2個、activities は業務フローを1本
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{
  "classes": [{ "name": "Reservation", "label": "予約", "attributes": [{ "name": "日時", "type": "datetime" }], "operations": ["キャンセルする"] }],
  "relations": [{ "from": "Customer", "to": "Reservation", "kind": "association|composition|aggregation|inheritance|dependency", "fromMultiplicity": "1", "toMultiplicity": "*", "label": "予約する" }],
  "sequences": [{ "title": "予約登録", "participants": [{ "id": "customer", "label": "顧客", "actor": true }], "messages": [{ "from": "customer", "to": "system", "text": "予約を申し込む", "reply": false }] }],
  "stateMachines": [{ "entity": "予約", "states": ["仮予約", "確定"], "initial": "仮予約", "finals": ["確定"], "transitions": [{ "from": "仮予約", "to": "確定", "event": "承認" }] }],
  "activities": [{ "title": "来店までの流れ", "steps": [{ "id": "s1", "label": "予約を受け付ける", "kind": "action|decision" }], "edges": [{ "from": "s1", "to": "s2", "label": "任意" }] }]
}`;

export function buildUmlPrompt(projectName: string, purpose: string, reqs: UmlRequirement[]): string {
  return `# プロジェクト
名称: ${projectName}
目的: ${purpose || "（未記入）"}

# 確定済みの要件
${reqs.map((r) => `- ${r.code} ${r.title}`).join("\n") || "（まだありません）"}

上の要件から UML モデルを作ってください。`;
}

export interface UmlGenerationResult {
  model: UmlModel;
  providerId: string;
  usage: Usage;
  dropped: number;
  failures: Array<{ providerId: string; reason: string }>;
}

/** 指定順にAIを試し、最初に検証を通ったモデルを返す */
export async function generateUmlModel(
  providers: AIProvider[],
  projectName: string,
  purpose: string,
  reqs: UmlRequirement[],
  timeoutMs = 90_000,
): Promise<UmlGenerationResult> {
  const failures: Array<{ providerId: string; reason: string }> = [];
  const prompt = buildUmlPrompt(projectName, purpose, reqs);
  for (const p of providers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await p.complete({
        system: UML_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        json: true,
        maxTokens: 8000,
        signal: ctrl.signal,
      });
      const { model, dropped } = normalizeUmlModel(UmlModel.parse(extractJson(res.text)));
      return { model, providerId: p.id, usage: res.usage, dropped, failures };
    } catch (e) {
      failures.push({ providerId: p.id, reason: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error("UMLモデルを生成できませんでした") as Error & { failures: typeof failures };
  err.failures = failures;
  throw err;
}
