/**
 * 用語集・受け入れ基準・確定版の差分（機能 F11）。
 *
 * - 用語集: 業務の言葉の定義と、言い換え（表記ゆれ）、コード上の名前。要件文の表記ゆれを検出する
 * - 受け入れ基準: 「何を満たせば受け入れるか」を要件定義で決め、テスト結果に照らして判定する
 * - 確定版の差分: 版どうしで、追加・変更・削除された要件を出す（後工程の作り直しの範囲）
 */
import { z } from "zod";
import { extractJson } from "./json.js";
import type { AIProvider, Usage } from "./types.js";
import type { UmlModel } from "./uml.js";

/* ------------------------------------------------------------------ */
/* 用語集                                                               */
/* ------------------------------------------------------------------ */

export const GlossaryTerm = z.object({
  term: z.string().min(1).max(60),
  definition: z.string().max(500).default(""),
  /** 同じ意味で使われがちな別の言い方（要件文では使わない） */
  synonyms: z.array(z.string().min(1).max(60)).max(10).default([]),
  /** コード上の名前（設計モデルのエンティティ・項目） */
  codeName: z.string().max(80).default(""),
  source: z.enum(["ai", "design", "manual"]).default("manual"),
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;

export const GlossaryContent = z.object({ terms: z.array(GlossaryTerm).max(200) });

/** 設計モデルのエンティティを用語の候補にする（定義は空） */
export function glossaryFromDesign(m: UmlModel | null | undefined): GlossaryTerm[] {
  return (m?.classes ?? [])
    .filter((c) => c.label && c.label !== c.name)
    .map((c) => ({ term: c.label!, definition: "", synonyms: [], codeName: c.name, source: "design" as const }));
}

/** 用語集をまとめる。人が書いた（manual）用語は上書きしない。定義・言い換え・コード上の名前は足りないものだけ補う */
export function mergeGlossary(current: GlossaryTerm[], incoming: GlossaryTerm[]): GlossaryTerm[] {
  const out = current.map((t) => ({ ...t, synonyms: [...t.synonyms] }));
  for (const n of incoming) {
    const hit = out.find((t) => t.term === n.term);
    if (!hit) {
      out.push({ ...n, synonyms: n.synonyms.filter((s) => s !== n.term) });
      continue;
    }
    if (hit.source === "manual") continue;
    if (!hit.definition && n.definition) hit.definition = n.definition;
    if (!hit.codeName && n.codeName) hit.codeName = n.codeName;
    for (const s of n.synonyms) if (s !== hit.term && !hit.synonyms.includes(s)) hit.synonyms.push(s);
    if (hit.source === "design" && n.source === "ai") hit.source = "ai";
  }
  return out.sort((a, b) => a.term.localeCompare(b.term, "ja"));
}

/** 要件文の表記ゆれ（用語集の言い換えを使っている箇所） */
export function termVariants(reqs: Array<{ code: string; title: string }>, terms: GlossaryTerm[]): Array<{ code: string; used: string; term: string }> {
  const out: Array<{ code: string; used: string; term: string }> = [];
  for (const r of reqs) {
    for (const t of terms) {
      for (const syn of t.synonyms) {
        // 正式な用語の一部として含まれる場合（例: 用語「予約者」と言い換え「予約」）は数えない
        const idx = r.title.indexOf(syn);
        if (idx < 0) continue;
        if (r.title.includes(t.term) && t.term.includes(syn)) continue;
        out.push({ code: r.code, used: syn, term: t.term });
      }
    }
  }
  return out;
}

export const GLOSSARY_SYSTEM = `あなたは要件定義の用語集の作成者です。要件と設計から、業務の言葉を定義します。
- 業務で使う名詞（人・もの・手続き・状態・帳票）を選ぶ。一般的な言葉（画面・ボタン・データなど）は入れない
- definition は、専門家でない人にも分かる1〜2文。要件に書かれていることだけで定義し、推測で広げない
- synonyms には、要件や会話で同じ意味に使われている別の言い方を入れる（表記ゆれを防ぐため、要件文では term だけを使う）
- codeName には、設計のエンティティ・項目のコード上の名前があれば書く
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "terms": [{ "term": "予約", "definition": "...", "synonyms": ["申込"], "codeName": "Reservation" }] }`;

export function buildGlossaryPrompt(projectName: string, reqs: Array<{ code: string; title: string }>, design: string, current: GlossaryTerm[]): string {
  return `# プロジェクト
${projectName}

# 要件
${reqs.map((r) => `- ${r.code} ${r.title}`).join("\n") || "（なし）"}
${design ? `\n# 設計（UML）\n${design}\n` : ""}
# いまの用語集
${current.map((t) => `- ${t.term}${t.definition ? `：${t.definition}` : ""}`).join("\n") || "（なし）"}

足りない用語を足し、定義のない用語には定義を書いてください。`;
}

/** 用語集をAIで作る（使えるAIを順に試す） */
export async function generateGlossary(
  providers: AIProvider[],
  input: { projectName: string; reqs: Array<{ code: string; title: string }>; design: string; current: GlossaryTerm[] },
  timeoutMs = 90_000,
): Promise<{ terms: GlossaryTerm[]; providerId: string; usage: Usage; failures: Array<{ providerId: string; reason: string }> }> {
  const failures: Array<{ providerId: string; reason: string }> = [];
  const prompt = buildGlossaryPrompt(input.projectName, input.reqs, input.design, input.current);
  for (const p of providers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await p.complete({ system: GLOSSARY_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 6000, signal: ctrl.signal });
      const c = GlossaryContent.parse(extractJson(res.text));
      return { terms: c.terms.map((t) => ({ ...t, source: "ai" as const })), providerId: p.id, usage: res.usage, failures };
    } catch (e) {
      failures.push({ providerId: p.id, reason: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error("用語集を作成できませんでした") as Error & { failures: typeof failures };
  err.failures = failures;
  throw err;
}

/* ------------------------------------------------------------------ */
/* 受け入れ基準                                                         */
/* ------------------------------------------------------------------ */

export const AcceptanceCriteria = z.object({
  /** 必須（must）の要件で、テストに合格していなければならない割合（%） */
  mustPassRate: z.number().int().min(0).max(100).default(100),
  /** 推奨（should）の要件の合格率（%） */
  shouldPassRate: z.number().int().min(0).max(100).default(80),
  /** 不合格のまま残してよいテストの数 */
  maxFailedTests: z.number().int().min(0).max(10_000).default(0),
  /** 非機能要件のテストをすべて実施していること */
  nfrAllRun: z.boolean().default(true),
  /** 開発からの質問がすべて回答済みであること */
  questionsClosed: z.boolean().default(true),
  /** 業務の担当者が確かめる条件（人が確認して印を付ける） */
  custom: z
    .array(
      z.object({
        id: z.string().min(1).max(20),
        text: z.string().min(1).max(300),
        checked: z.boolean().default(false),
        checkedBy: z.string().max(100).nullable().default(null),
        checkedAt: z.string().nullable().default(null),
      }),
    )
    .max(30)
    .default([]),
});
export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteria>;
export const DEFAULT_ACCEPTANCE: AcceptanceCriteria = AcceptanceCriteria.parse({
  custom: [
    { id: "C1", text: "業務の担当者が、主な業務の流れを本番と同じ手順で通しで実施できた" },
    { id: "C2", text: "運用の手順書（バックアップ・障害時の連絡）を受け取った" },
  ],
});

export interface AcceptanceItem {
  key: string;
  label: string;
  target: string;
  actual: string;
  ok: boolean;
}

/** 受け入れ基準を、いまのテスト結果・質問の状況に照らして判定する */
export function evaluateAcceptance(
  c: AcceptanceCriteria,
  rows: Array<{ code: string; type: string; priority?: string; tests: { total: number; status: string; failed: number } }>,
  openQuestions: number,
): { items: AcceptanceItem[]; accepted: boolean } {
  const target = rows.filter((r) => ["FR", "RL", "NFR"].includes(r.type));
  const rate = (pri: string) => {
    const xs = target.filter((r) => (r.priority ?? "should") === pri && r.tests.total > 0);
    const ok = xs.filter((r) => r.tests.status === "passed").length;
    return { n: xs.length, ok, pct: xs.length ? Math.floor((ok / xs.length) * 100) : 100 };
  };
  const must = rate("must");
  const should = rate("should");
  const failed = target.reduce((a, r) => a + r.tests.failed, 0);
  const nfr = target.filter((r) => r.type === "NFR");
  const nfrRun = nfr.filter((r) => r.tests.status !== "not_run").length;
  const items: AcceptanceItem[] = [
    { key: "must", label: "必須の要件のテスト合格率", target: `${c.mustPassRate}%以上`, actual: `${must.pct}%（${must.ok}/${must.n}）`, ok: must.pct >= c.mustPassRate },
    { key: "should", label: "推奨の要件のテスト合格率", target: `${c.shouldPassRate}%以上`, actual: `${should.pct}%（${should.ok}/${should.n}）`, ok: should.pct >= c.shouldPassRate },
    { key: "failed", label: "不合格のテスト", target: `${c.maxFailedTests}件以下`, actual: `${failed}件`, ok: failed <= c.maxFailedTests },
  ];
  if (c.nfrAllRun) items.push({ key: "nfr", label: "非機能要件のテストの実施", target: "すべて", actual: `${nfrRun}/${nfr.length}`, ok: nfrRun === nfr.length });
  if (c.questionsClosed) items.push({ key: "questions", label: "開発からの質問", target: "すべて回答済み", actual: `回答待ち ${openQuestions}件`, ok: openQuestions === 0 });
  for (const x of c.custom) items.push({ key: `custom:${x.id}`, label: x.text, target: "確認済み", actual: x.checked ? `確認済み（${x.checkedBy ?? ""}）` : "未確認", ok: x.checked });
  return { items, accepted: items.every((i) => i.ok) };
}

/* ------------------------------------------------------------------ */
/* 確定版の差分                                                         */
/* ------------------------------------------------------------------ */

export interface SnapshotItem {
  code: string;
  type: string;
  title: string;
  description: string;
  priority: string;
  version: number;
}

export interface RequirementDiff {
  added: SnapshotItem[];
  removed: SnapshotItem[];
  modified: Array<{ code: string; type: string; before: SnapshotItem; after: SnapshotItem; fields: Array<"title" | "description" | "priority" | "type" | "detail"> }>;
  unchanged: number;
}

/** 2つの確定版（または確定版といまの要件）の差分。版が上がっていて文が同じなら「detail」（EARS の構造や具体例の変更） */
export function diffSnapshots(before: SnapshotItem[], after: SnapshotItem[]): RequirementDiff {
  const b = new Map(before.map((x) => [x.code, x]));
  const a = new Map(after.map((x) => [x.code, x]));
  const out: RequirementDiff = { added: [], removed: [], modified: [], unchanged: 0 };
  for (const x of after) {
    const p = b.get(x.code);
    if (!p) {
      out.added.push(x);
      continue;
    }
    const fields = (["title", "description", "priority", "type"] as const).filter((f) => p[f] !== x[f]);
    if (!fields.length && p.version !== x.version) out.modified.push({ code: x.code, type: x.type, before: p, after: x, fields: ["detail"] });
    else if (fields.length) out.modified.push({ code: x.code, type: x.type, before: p, after: x, fields: [...fields] });
    else out.unchanged++;
  }
  for (const x of before) if (!a.has(x.code)) out.removed.push(x);
  return out;
}

/** 要件の内容の指紋（承認した後に要件が変わったかの判定に使う） */
export function snapshotFingerprint(items: Array<{ code: string; version: number }>): string {
  return [...items]
    .sort((x, y) => x.code.localeCompare(y.code))
    .map((x) => `${x.code}@${x.version}`)
    .join(",");
}
