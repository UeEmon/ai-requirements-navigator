/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * コーディング・テスト工程への引き継ぎの API（機能 F9）。
 * - テスト仕様: EARS の要件・非機能要件シート・ストーリーの受け入れ条件からテストケースを作る（AIなし）
 * - 設計の表: 設計モデルからデータ項目定義・権限表・外部とのやり取りの一覧を作る
 * - 着手前チェック: 引き渡せる状態かを点検し、足りないものと直す場所を示す
 * - 引き継ぎパッケージ: 要件・非機能要件・設計・画面・タスク・テストを1つのJSONにまとめる
 *   （開発者のツールやAIコーディングツールにそのまま渡せる形）
 */
import {
  assessReadiness,
  batchTable,
  crudMatrix,
  dataDictionary,
  lintRule,
  outputTable,
  screenItemTable,
  stateTable,
  deriveTestCases,
  entityTable,
  evaluateNfr,
  interfaceTable,
  NFR_ITEMS,
  NFR_VERIFY,
  PHASE_BOUNDARY,
  TEST_KINDS,
  TEST_LEVELS,
  testCasesCsv,
  traceTests,
  type ReadinessReport,
  type Table,
  type TestCase,
  type TestRequirement,
  type TestStory,
} from "@arn/ai-core";
import type { Hono } from "hono";
import { changedSince, type ImplementationContext } from "./implementation.js";
import type { Project, Requirement } from "./store.js";

export const HANDOFF_FORMAT = "arn-handoff/1";

export interface ScopeAccess {
  glossary: (p: Project) => Promise<{ terms: unknown[]; variants: Array<{ code: string; used: string; term: string }> }>;
  acceptance: (p: Project) => Promise<{ defined: boolean; criteria: unknown; evaluation: { accepted: boolean; items: unknown[] } }>;
  approval: (p: Project) => Promise<{ required: boolean; status: "approved" | "pending" | "rejected" | "stale" | "none" }>;
}

export function handoff(ctx: ImplementationContext, deps: { scope?: () => ScopeAccess } = {}) {
  const { store } = ctx;

  /** 非機能要件シートから作った要件に、シートの項目を結びつける */
  async function testRequirements(p: Project, reqs: Requirement[]): Promise<TestRequirement[]> {
    const sheet = await store.getNfrSheet(p.id);
    const keyOf = new Map<string, string>();
    for (const [key, d] of Object.entries(sheet?.decisions ?? {})) if (d.requirementId) keyOf.set(d.requirementId, key);
    return reqs.map((r) => ({ code: r.code, type: r.type, title: r.title, ears: r.ears, rule: r.rule ?? null, priority: r.priority, nfrKey: keyOf.get(r.id) }));
  }

  async function storiesOf(p: Project): Promise<TestStory[]> {
    const plan = await store.latestTaskPlan(p.id);
    return (plan?.plan.epics ?? []).flatMap((e) => e.stories.map((s) => ({ key: s.key, title: s.title, acceptanceCriteria: s.acceptanceCriteria, requirementCodes: s.requirementCodes })));
  }

  async function tests(p: Project) {
    const reqs = await store.listRequirements(p.id);
    const treqs = await testRequirements(p, reqs);
    const stories = await storiesOf(p);
    const cases = deriveTestCases(treqs, stories);
    const trace = traceTests(treqs, cases, stories);
    const count = <K extends string>(key: (c: TestCase) => K) => cases.reduce<Record<string, number>>((a, c) => ((a[key(c)] = (a[key(c)] ?? 0) + 1), a), {});
    return { cases, trace, counts: { total: cases.length, byLevel: count((c) => c.level), byKind: count((c) => c.kind) }, reqs, treqs, stories };
  }

  async function designTables(p: Project) {
    const rec = await store.latestUmlModel(p.id);
    const m = rec?.model ?? null;
    const screens = await store.latestScreens(p.id);
    const items = screenItemTable(screens?.model, m);
    return {
      model: m,
      createdAt: rec?.createdAt ?? null,
      entities: entityTable(m),
      data: dataDictionary(m),
      crud: crudMatrix(m),
      interfaces: interfaceTable(m),
      states: stateTable(m),
      outputs: outputTable(m),
      batches: batchTable(m),
      screenItems: { head: items.head, rows: items.rows } as Table,
      screenItemIssues: { unbound: items.unbound, unknown: items.unknown },
    };
  }

  async function openQuestions(p: Project): Promise<string[]> {
    const out: string[] = [];
    for (const g of await store.latestGuides(p.id)) for (const m of g.missing) out.push(`［ヒアリング］観点「${m}」がまだ確認できていません`);
    const sheet = await store.getNfrSheet(p.id);
    for (const item of NFR_ITEMS) {
      const d = sheet?.decisions[item.key];
      if (d?.status === "deferred") out.push(`［非機能要件］「${item.name}」は保留中です（決める人：${d.owner || "未定"}）`);
    }
    for (const f of await store.listScreenFeedback(p.id)) {
      if (f.status === "open" && f.level !== "detail") out.push(`［画面の意見］「${f.text.slice(0, 60)}」がまだ反映されていません`);
    }
    for (const q of (await store.listQuestions(p.id)).reverse()) {
      if (q.status === "open") out.push(`［開発からの質問］${q.code}${q.requirementCode ? `（${q.requirementCode}）` : ""}「${q.text.slice(0, 80)}」に回答していません`);
    }
    return out;
  }

  async function readiness(p: Project): Promise<ReadinessReport & { openQuestions: string[] }> {
    const t = await tests(p);
    const sheet = await store.getNfrSheet(p.id);
    const ev = sheet ? evaluateNfr(sheet.profile, sheet.decisions) : null;
    const screens = await store.latestScreens(p.id);
    const plan = await store.latestTaskPlan(p.id);
    const changes = await store.listChangeRequests(p.id);
    const oq = await openQuestions(p);
    const access = sheet?.decisions["sc.access"];
    const stale: string[] = [];
    if (screens) {
      const ch = changedSince(screens, t.reqs).filter((c) => c.startsWith("FR"));
      if (ch.length) stale.push(`画面一覧（${ch.slice(0, 5).join("、")}${ch.length > 5 ? " ほか" : ""}が変更）`);
    }
    if (plan) {
      const ch = changedSince(plan, t.reqs).filter((c) => /^N?FR/.test(c));
      if (ch.length) stale.push(`タスク分解（${ch.slice(0, 5).join("、")}${ch.length > 5 ? " ほか" : ""}が変更）`);
    }
    const frs = t.trace.rows.filter((r) => r.type === "FR");
    const report = assessReadiness({
      requirements: t.reqs.map((r) => ({ code: r.code, type: r.type, title: r.title, ears: r.ears })),
      nfr: sheet && ev ? { coverage: ev.coverage, errors: ev.findings.filter((f) => f.severity === "error").length, undecided: NFR_ITEMS.filter((i) => (sheet.decisions[i.key]?.status ?? "undecided") === "undecided").map((i) => i.name) } : null,
      uml: (await store.latestUmlModel(p.id))?.model ?? null,
      screens: screens ? { uncovered: screens.model.uncovered } : null,
      tasks: plan ? { uncovered: plan.plan.uncovered, stories: plan.plan.epics.reduce((a, e) => a + e.stories.length, 0) } : null,
      tests: {
        untested: t.trace.untested,
        methodUndecided: t.trace.methodUndecided,
        methodGuessed: t.trace.rows.filter((r) => r.methodGuessed).map((r) => r.code),
        withoutAcceptance: plan ? frs.filter((r) => !r.acceptance.length).map((r) => r.code) : [],
      },
      openQuestions: oq,
      baselined: !!(await store.latestBaseline(p.id)),
      pendingChanges: changes.filter((c) => c.status === "open" || c.status === "analyzed").map((c) => c.code),
      accessControl: access?.status === "decided" && !!access.level && access.level !== "L1",
      stale,
      ...(await scopeInputs(p, t.reqs)),
    });
    return { ...report, openQuestions: oq };
  }

  /** 要件定義の補足（業務ルール・用語集・受け入れ基準・承認・画面の項目・保存期間）の点検に渡す値 */
  async function scopeInputs(p: Project, reqs: Requirement[]) {
    const rules = reqs.filter((r) => r.type === "RL");
    const sheet = await store.getNfrSheet(p.id);
    const law = sheet?.decisions["ev.law"];
    const personalData = (sheet?.profile.data ?? 0) >= 1 || (law?.status === "decided" && !!law.level && law.level !== "L1");
    const d = await designTables(p);
    const out = {
      rules: { count: rules.length, issues: rules.filter((r) => !lintRule(r.title, r.rule).ok).map((r) => r.code) },
      screenItems: (await store.latestScreens(p.id)) && d.model ? d.screenItemIssues : undefined,
      personalData,
    };
    const sc = deps.scope?.();
    if (!sc) return out;
    const g = await sc.glossary(p);
    const a = await sc.acceptance(p);
    return {
      ...out,
      glossary: { terms: g.terms.length, variants: g.variants.map((v) => `${v.code}（${v.used} → ${v.term}）`) },
      acceptance: a.defined,
      approval: await sc.approval(p),
    };
  }

  /** 引き継ぎパッケージ（JSON） */
  async function bundle(p: Project) {
    const t = await tests(p);
    const sheet = await store.getNfrSheet(p.id);
    const design = await designTables(p);
    const screens = await store.latestScreens(p.id);
    const plan = await store.latestTaskPlan(p.id);
    const baseline = await store.latestBaseline(p.id);
    const nfrKey = new Map(t.treqs.map((r) => [r.code, r.nfrKey]));
    return {
      format: HANDOFF_FORMAT,
      generatedAt: new Date().toISOString(),
      project: { name: p.name, purpose: p.purpose },
      baseline: baseline ? { version: baseline.version, createdAt: baseline.createdAt, reason: baseline.reason } : null,
      howToUse: [
        "requirements の title は EARS 記法の要件文です。ears に文型ごとの構造（trigger / state / feature / response）があります。",
        "tests.cases の requirementCode で要件と、storyKey で tasks のストーリーと対応します。テストのIDは要件が変わらない限り同じです。",
        "design.model はクラス・シーケンス・状態遷移・権限・外部とのやり取りの設計モデル、design.tables はそれを表にしたものです。",
        "要件にない機能は作らず、不明な点は readiness.openQuestions と readiness.checks を確認してください。",
        "scope は工程の線引きです。requirements 列は決まっていること、design 列は設計工程で決めてよいこと、test 列はテスト工程で決めることです。",
        "業務ルール（type が RL）は rule.examples の具体例をそのまま単体テストにしてください。glossary の用語を使い、synonyms の言い換えは使わないでください。",
      ],
      requirements: t.reqs.map((r) => ({ code: r.code, type: r.type, title: r.title, description: r.description, priority: r.priority, ears: r.ears, rule: r.rule ?? null, source: r.source, version: r.version, nfrKey: nfrKey.get(r.code) ?? null })),
      nfr: {
        profile: sheet?.profile ?? {},
        items: NFR_ITEMS.map((i) => {
          const d = sheet?.decisions[i.key];
          const lv = i.levels.find((l) => l.id === d?.level);
          return { key: i.key, category: i.category, name: i.name, status: d?.status ?? "undecided", level: d?.level ?? null, levelLabel: lv?.label ?? null, value: d?.value ?? "", rationale: d?.rationale ?? "", verification: NFR_VERIFY[i.key] ?? null };
        }),
      },
      design: {
        model: design.model,
        tables: { entities: design.entities, data: design.data, crud: design.crud, interfaces: design.interfaces, states: design.states, outputs: design.outputs, batches: design.batches, screenItems: design.screenItems },
      },
      glossary: deps.scope ? (await deps.scope().glossary(p)).terms : [],
      acceptance: deps.scope ? await deps.scope().acceptance(p) : null,
      approval: deps.scope ? await deps.scope().approval(p) : null,
      scope: PHASE_BOUNDARY,
      screens: screens?.model ?? null,
      tasks: plan?.plan ?? null,
      tests: { cases: t.cases, trace: t.trace.rows, coverage: t.trace.coverage },
      readiness: await readiness(p),
    };
  }

  const tableIf = (t: Table, caption?: string) => (t.rows.length ? [{ ...t, ...(caption ? { caption } : {}) }] : []);

  /** 仕様書に載せる節 */
  async function specMore(p: Project): Promise<Array<{ title: string; lines: string[]; tables?: Table[] }>> {
    const d = await designTables(p);
    const t = await tests(p);
    const r = await readiness(p);
    const testTable: Table = {
      head: ["テストID", "要件", "工程・種別", "前提", "操作・出来事", "期待する結果"],
      rows: t.cases.map((c) => [c.id, c.requirementCode, `${TEST_LEVELS[c.level]}・${TEST_KINDS[c.kind]}`, c.given, c.when, c.method ? `${c.then}（${c.method}）` : c.then]),
    };
    const VERDICT = { ready: "引き渡せる", conditional: "確認事項を共有すれば着手できる", "not-ready": "足りないものがある" } as const;
    const MARK = { ok: "○", warn: "△", ng: "×" } as const;
    return [
      {
        title: "14. データ設計",
        lines: d.model ? ["設計モデルから作ったエンティティとデータ項目の定義です。物理設計（テーブル定義）はこれを元に設計工程で行います。"] : [],
        tables: [...tableIf(d.entities, "エンティティ一覧（業務の言葉とコード上の名前）"), ...tableIf(d.data, "データ項目定義")],
      },
      {
        title: "画面の入出力項目",
        lines: d.screenItemIssues.unbound.length ? [`データ項目にひも付いていない入力項目：${d.screenItemIssues.unbound.join("、")}`] : [],
        tables: tableIf(d.screenItems),
      },
      {
        title: "状態が変わる条件",
        lines: [],
        tables: tableIf(d.states),
      },
      {
        title: "帳票・出力",
        lines: d.model && !d.outputs.rows.length ? ["帳票・出力はありません（または設計モデルに定義がありません）。"] : [],
        tables: tableIf(d.outputs),
      },
      {
        title: "まとめて行う処理（バッチ）",
        lines: d.model && !d.batches.rows.length ? ["まとめて行う処理はありません（または設計モデルに定義がありません）。"] : [],
        tables: tableIf(d.batches),
      },
      {
        title: "15. 権限表",
        lines: d.crud.rows.length ? [] : d.model ? ["設計モデルに権限の定義がありません（UMLを作り直すと付きます）。"] : [],
        tables: tableIf(d.crud, d.crud.caption),
      },
      {
        title: "16. 外部とのやり取り",
        lines: d.interfaces.rows.length ? [] : d.model ? ["外部とのやり取りはありません（または設計モデルに定義がありません）。"] : [],
        tables: tableIf(d.interfaces),
      },
      {
        title: "17. テスト仕様",
        lines: [
          `テストケース ${t.counts.total}件（${Object.entries(t.counts.byLevel).map(([k, v]) => `${TEST_LEVELS[k as keyof typeof TEST_LEVELS]} ${v}`).join("、")}）／要件のカバー率 ${Math.round(t.trace.coverage * 100)}%`,
          "EARS の文型から規則的に作った観点です（イベント → 起きたとき・起きないとき、状態 → 状態の内・外、望ましくない振る舞い → 異常の再現、数値 → 境界値）。具体的なテストデータは設計工程で決めます。",
          ...(t.trace.methodUndecided.length ? [`確認方法が決まっていない非機能要件：${t.trace.methodUndecided.join("、")}`] : []),
        ],
        tables: tableIf(testTable),
      },
      {
        title: "18. 着手前チェックと未決事項",
        lines: [
          `判定：${VERDICT[r.verdict]}（${r.score}点。○${r.counts.ok}・△${r.counts.warn}・×${r.counts.ng}）`,
          ...r.checks.map((c) => `${MARK[c.status]} ${c.title}：${c.detail}`),
          ...r.openQuestions.map((q) => `【未決】${q}`),
        ],
      },
    ];
  }

  function routes(app: Hono<any>) {
    app.get("/api/projects/:id/tests", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const t = await tests(p);
      return c.json({ cases: t.cases, trace: t.trace, counts: t.counts, stories: t.stories.length });
    });

    app.get("/api/projects/:id/tests.csv", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "export");
      const t = await tests(p);
      const utf8 = encodeURIComponent(`${p.name}_テストケース.csv`);
      return c.body(testCasesCsv(t.cases), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="tests.csv"; filename*=UTF-8''${utf8}` });
    });

    app.get("/api/projects/:id/design/tables", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      const { model: _m, ...rest } = await designTables(p);
      return c.json(rest);
    });

    app.get("/api/projects/:id/readiness", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      return c.json(await readiness(p));
    });

    app.get("/api/projects/:id/handoff.json", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "export");
      const b = await bundle(p);
      const utf8 = encodeURIComponent(`${p.name}_引き継ぎ.json`);
      return c.body(JSON.stringify(b, null, 2), 200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="handoff.json"; filename*=UTF-8''${utf8}` });
    });
  }

  return { routes, specMore, readiness, bundle, tests, designTables, openQuestions };
}
