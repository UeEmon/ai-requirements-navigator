import type { AIProvider, CompletionRequest, CompletionResult } from "../types.js";

export type MockHandler = (req: CompletionRequest) => string | Promise<string>;

/**
 * 開発・テスト用の模擬AI。APIキーなしで画面とフローを確認できる。
 * 本番では ALLOW_MOCK_PROVIDER=false にして無効化する。
 */
export class MockProvider implements AIProvider {
  readonly vendor = "mock" as const;
  readonly model = "mock";
  readonly label: string;
  readonly isLocal: boolean;
  constructor(
    readonly id: string,
    private readonly handler: MockHandler = defaultMockHandler(id),
    opts: { label?: string; isLocal?: boolean } = {},
  ) {
    this.label = opts.label ?? `模擬AI (${id})`;
    this.isLocal = opts.isLocal ?? false;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = Date.now();
    const text = await this.handler(req);
    return { text, usage: { inputTokens: req.system.length, outputTokens: text.length }, latencyMs: Date.now() - t0 };
  }
}

function seed(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** 生成プロンプトには要件案を、評価プロンプトには採点結果を返す */
export function defaultMockHandler(id: string): MockHandler {
  return (req) => {
    const prompt = req.messages.map((m) => m.content).join("\n");
    const typeMatch = prompt.match(/主に作る要件の区分: (BR|AC|FR|NFR|CN)/);
    const type = (typeMatch?.[1] ?? "FR") as "BR" | "AC" | "FR" | "NFR" | "CN";
    const answer = prompt.split("# 利用者の回答")[1]?.split("\n").find((l) => l.trim())?.trim() ?? "回答";

    if (req.system.includes("ソフトウェア設計者")) return JSON.stringify(MOCK_UML);
    if (req.system.includes("設計レビュアー")) {
      const labels = [...prompt.matchAll(/### 案([A-F])/g)].map((m) => m[1]!);
      return JSON.stringify({
        scores: Object.fromEntries(
          labels.map((l, i) => [l, { traceability: 80 - i * 5, consistency: 78, granularity: 75, clarity: 82 - i * 3 }]),
        ),
        comments: Object.fromEntries(labels.map((l) => [l, { strengths: ["主要な概念を押さえている"], weaknesses: ["例外の流れが少ない"] }])),
        recommendedLabel: labels[0] ?? "A",
        recommendation: `案${labels[0] ?? "A"}が要件との対応で優れています。`,
      });
    }
    if (req.system.includes("インタビュアー")) return mockGuide(prompt);
    if (req.system.includes("テックリード")) return mockTaskPlan(prompt);
    if (req.system.includes("画面設計者")) return mockScreens(prompt);
    if (req.system.includes("変更管理の担当者")) return mockImpact(prompt);

    if (req.system.includes("レビュアー")) {
      const labels = [...prompt.matchAll(/### 案([A-D])/g)].map((m) => m[1]!);
      const scores: Record<string, { coverage: number; accuracy: number; consistency: number; feasibility: number; clarity: number }> = {};
      for (const l of labels) {
        const s = seed(id + l + prompt.length);
        scores[l] = {
          coverage: 60 + (s % 35),
          accuracy: 70 + ((s >>> 3) % 25),
          consistency: 70 + ((s >>> 5) % 25),
          feasibility: 65 + ((s >>> 7) % 30),
          clarity: 70 + ((s >>> 9) % 25),
        };
      }
      const best = labels.reduce((a, b) => (scores[a]!.coverage >= scores[b]!.coverage ? a : b), labels[0] ?? "A");
      return JSON.stringify({
        scores,
        comments: Object.fromEntries(
          labels.map((l) => [l, { strengths: [`案${l}は基本項目を押さえている`], weaknesses: [`案${l}は例外ケースが少ない`] }]),
        ),
        recommendedLabel: "merged",
        recommendation: `各案に独自の項目があるため、統合案を推奨します。最も網羅的なのは案${best}です。`,
        merged: {
          items: [
            { title: `「${answer}」を満たす基本機能を提供する`, type, priority: "must" },
            { title: "例外時の扱い（取消・やり直し）を定める", type, priority: "should" },
            { title: "結果を管理者が確認できる", type, priority: "should" },
          ],
          questions: [],
          notes: "模擬AIによる統合案",
        },
      });
    }

    const s = seed(id);
    const extras = [
      "例外時の扱い（取消・やり直し）を定める",
      "結果を管理者が確認できる",
      "処理完了を利用者に通知する",
      "操作の履歴を記録する",
    ];
    return JSON.stringify({
      items: [
        { title: `「${answer}」を満たす基本機能を提供する`, type, priority: "must" },
        { title: extras[s % extras.length], type, priority: "should" },
        { title: extras[(s >>> 4) % extras.length], type, priority: "could" },
      ].filter((v, i, a) => a.findIndex((x) => x.title === v.title) === i),
      questions: [],
      notes: "模擬AIによる案",
    });
  };
}

/** 模擬AIが返すUMLモデル（予約システムの例） */
const MOCK_UML = {
  classes: [
    { name: "Customer", label: "顧客", attributes: [{ name: "氏名", type: "string" }, { name: "電話番号", type: "string" }], operations: [] },
    { name: "Reservation", label: "予約", attributes: [{ name: "日時", type: "datetime" }, { name: "状態", type: "enum" }], operations: ["確定する", "キャンセルする"] },
    { name: "Staff", label: "スタッフ", attributes: [{ name: "氏名", type: "string" }], operations: [] },
    { name: "Menu", label: "メニュー", attributes: [{ name: "所要時間", type: "int" }, { name: "料金", type: "int" }], operations: [] },
  ],
  relations: [
    { from: "Customer", to: "Reservation", kind: "association", fromMultiplicity: "1", toMultiplicity: "*", label: "予約する" },
    { from: "Staff", to: "Reservation", kind: "association", fromMultiplicity: "1", toMultiplicity: "*", label: "担当" },
    { from: "Reservation", to: "Menu", kind: "aggregation", fromMultiplicity: "*", toMultiplicity: "1..*" },
    { from: "Reservation", to: "Unknown", kind: "association" },
  ],
  sequences: [
    {
      title: "予約登録",
      participants: [
        { id: "customer", label: "顧客", actor: true },
        { id: "web", label: "予約画面" },
        { id: "server", label: "予約サーバ" },
      ],
      messages: [
        { from: "customer", to: "web", text: "日時とメニューを選ぶ" },
        { from: "web", to: "server", text: "空き枠を確認" },
        { from: "server", to: "web", text: "予約完了", reply: true },
        { from: "web", to: "customer", text: "確認メール", reply: true },
      ],
    },
  ],
  stateMachines: [
    {
      entity: "予約",
      states: ["仮予約", "確定", "キャンセル", "来店済み"],
      initial: "仮予約",
      finals: ["キャンセル", "来店済み"],
      transitions: [
        { from: "仮予約", to: "確定", event: "登録成功" },
        { from: "確定", to: "キャンセル", event: "取消" },
        { from: "確定", to: "来店済み", event: "受付" },
      ],
    },
  ],
  activities: [
    {
      title: "予約から来店まで",
      steps: [
        { id: "s1", label: "予約を受け付ける" },
        { id: "s2", label: "空き枠がある", kind: "decision" },
        { id: "s3", label: "予約を確定する" },
        { id: "s4", label: "別の日時を提案する" },
        { id: "s5", label: "前日にリマインドする" },
      ],
      edges: [
        { from: "s1", to: "s2" },
        { from: "s2", to: "s3", label: "はい" },
        { from: "s2", to: "s4", label: "いいえ" },
        { from: "s4", to: "s1" },
        { from: "s3", to: "s5" },
      ],
    },
  ],
};

/** 確定した要件の件数ぶん、観点を前から順に「埋まった」とみなす */
function mockGuide(prompt: string): string {
  const section = (name: string) =>
    (prompt.split(`# ${name}`)[1] ?? "").split("\n# ")[0]!.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  const checklist = section("確認すべき観点");
  const done = section("このフェーズで確定した要件").length;
  const covered = checklist.slice(0, Math.min(done, checklist.length));
  const next = checklist[covered.length];
  return JSON.stringify({
    question: next ? `「${next}」について、今の状況を教えてください。` : "ほかに補足したいことはありますか？",
    hint: "思いつく範囲で大丈夫です。",
    options: ["今は紙で管理している", "担当者によってやり方が違う", "応答時間を3秒以内にしたい"],
    glossary: [{ term: "担当者", explanation: "その業務を受け持つ人。" }],
    coveredPoints: covered,
  });
}

/** 要件を区分ごとのエピックにまとめ、1要件を1ストーリーにする */
function mockTaskPlan(prompt: string): string {
  const reqs = (prompt.split("# 要件")[1] ?? "")
    .split("\n# ")[0]!
    .split("\n")
    .map((l) => l.match(/^- ([A-Z]+-\d+) \[([A-Z]+)[^\]]*\] (.+?)(?: — .*)?$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ code: m[1]!, type: m[2]!, title: m[3]! }));
  const groups: Array<[string, string]> = [
    ["FR", "基本機能"],
    ["NFR", "品質・運用"],
  ];
  const epics = groups
    .map(([type, title]) => ({
      title,
      description: `${title}に関する要件を実装する`,
      stories: reqs
        .filter((r) => r.type === type)
        .map((r, i) => ({
          title: r.title,
          description: `${r.code} を実装する`,
          acceptanceCriteria: [`${r.title}ことを確認できる`],
          requirementCodes: [r.code],
          estimate: ["S", "M", "L"][i % 3],
          tasks: [
            { title: "画面を作る", kind: type === "FR" ? "frontend" : "infra" },
            { title: "処理を作る", kind: "backend" },
            { title: "テストを書く", kind: "test" },
          ],
        })),
    }))
    .filter((e) => e.stories.length);
  if (!epics.length) {
    epics.push({
      title: "準備",
      description: "開発環境を整える",
      stories: [{ title: "開発環境を作る", description: "", acceptanceCriteria: [], requirementCodes: [], estimate: "S", tasks: [{ title: "リポジトリを作る", kind: "infra" }] }],
    });
  }
  return JSON.stringify({ epics });
}

/** 機能要件を2つずつ1画面にまとめ、前後の画面へ遷移する */
function mockScreens(prompt: string): string {
  const frs = [...prompt.matchAll(/^- (FR-\d+) \[FR\] (.+)$/gm)].map((m) => ({ code: m[1]!, title: m[2]! }));
  const groups: Array<typeof frs> = [];
  for (let i = 0; i < frs.length; i += 2) groups.push(frs.slice(i, i + 2));
  if (!groups.length) groups.push([]);
  const screens = groups.map((g, i) => ({
    id: `s${i + 1}`,
    name: i === 0 ? "トップ" : `画面${i + 1}`,
    purpose: g.map((r) => r.title).join("、") || "利用を始める",
    actor: "利用者",
    requirementCodes: g.map((r) => r.code),
    // 見た目の項目（color など）は返しても捨てられる
    elements: [
      { kind: "heading", label: i === 0 ? "ようこそ" : `手続き${i + 1}`, color: "red" },
      { kind: "field", label: "日時" },
      { kind: "list", label: "一覧" },
      { kind: "button", label: "保存" },
    ],
    actions: [
      ...(i + 1 < groups.length ? [{ label: "次へ", to: `s${i + 2}` }] : []),
      ...(i > 0 ? [{ label: "戻る", to: `s${i}` }] : []),
      { label: "存在しない画面へ", to: "nowhere" },
    ],
  }));
  if (prompt.includes("# 利用者からの意見")) screens[0]!.elements.push({ kind: "field", label: "意見を反映した項目" } as never);
  return JSON.stringify({ screens });
}

/** 変更対象の要件と、それを参照するストーリー・画面を影響ありとする */
function mockImpact(prompt: string): string {
  const target = prompt.match(/対象の要件: (\S+)/)?.[1];
  const firstFr = prompt.match(/^- (FR-\d+) \[FR\]/m)?.[1];
  const code = target ?? firstFr ?? "";
  const ref = (section: string, re: RegExp) =>
    ((prompt.split(`# ${section}`)[1] ?? "").split("\n# ")[0] ?? "")
      .split("\n")
      .filter((l) => code && l.includes(code))
      .map((l) => l.match(re)?.[1])
      .filter((x): x is string => !!x);
  return JSON.stringify({
    summary: `${code || "既存の機能"}に関係する画面と実装タスクの見直しが必要です。`,
    relatedRequirementCodes: code ? [code, "FR-99"] : [],
    designElements: ["Reservation", "存在しない要素"],
    screens: ref("画面", /^- (S\d+)/),
    stories: ref("実装タスク（ストーリー）", /^- (E\d+-S\d+)/),
    effort: "m",
    risks: ["登録済みのデータの移行が必要になる可能性があります", "関連する機能のテストのやり直しが必要です"],
    alternative: { title: "運用で対応する", description: "当面は管理者が手作業で対応し、次の段階で機能として追加します。" },
  });
}
