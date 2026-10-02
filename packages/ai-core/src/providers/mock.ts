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
      notes: `模擬AI ${id} の案`,
    });
  };
}
