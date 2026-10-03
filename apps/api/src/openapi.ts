/**
 * 外部連携 API（/api/v1）の OpenAPI 3.1 定義。GET /api/v1/openapi.json で配る（認証不要）。
 * CI・テスト管理ツール・社内の開発基盤から、この定義を元にクライアントを作れるようにする。
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const ok = (description: string, schema: unknown) => ({ description, content: json(schema) });
const projectId = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "プロジェクトID" };
const errors = {
  "400": ok("入力が正しくない", ref("Error")),
  "401": ok("トークンがない・無効・期限切れ", ref("Error")),
  "403": ok("トークンに必要な権限（read / report）がない", ref("Error")),
  "404": ok("見つからない（トークンの範囲外のプロジェクトを含む）", ref("Error")),
};

export function openApiDocument(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "要件ナビ 外部連携 API",
      version: "1.0.0",
      description:
        "AIコーディングツール・テストツール・CI から、確定した要件・設計の材料・テストケースを読み、実装状況とテスト結果を報告するための API です。" +
        "組織の管理者が発行したトークン（arn_…）を Authorization: Bearer で送ってください。read は読み取り、report は報告と質問に必要です。" +
        "MCP に対応したツールは、同じトークンで /mcp にも接続できます。",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    security: [{ bearer: [] }],
    paths: {
      "/projects": {
        get: { summary: "使えるプロジェクトの一覧", operationId: "listProjects", responses: { "200": ok("プロジェクト", { type: "array", items: ref("ProjectSummary") }), "401": errors["401"] } },
      },
      "/projects/{id}": {
        get: { summary: "プロジェクトの概要（件数・確定版・着手前チェック・状況の集計）", operationId: "getProject", parameters: [projectId], responses: { "200": ok("概要", { type: "object" }), ...errors } },
      },
      "/projects/{id}/requirements": {
        get: {
          summary: "要件の一覧（EARS の文と構造）",
          operationId: "listRequirements",
          parameters: [
            projectId,
            { name: "type", in: "query", schema: { type: "string", enum: ["BR", "AC", "FR", "RL", "NFR", "CN"] } },
            { name: "codes", in: "query", schema: { type: "string" }, description: "カンマ区切りの要件ID" },
          ],
          responses: { "200": ok("要件", { type: "array", items: ref("Requirement") }), ...errors },
        },
      },
      "/projects/{id}/requirements/{code}": {
        get: {
          summary: "要件の詳細（テストケース・ストーリー・画面・エンティティ・外部とのやり取り・状況・質問）",
          operationId: "getRequirement",
          parameters: [projectId, { name: "code", in: "path", required: true, schema: { type: "string" }, example: "FR-01" }],
          responses: { "200": ok("要件の詳細", { type: "object" }), ...errors },
        },
      },
      "/projects/{id}/design": {
        get: {
          summary: "設計の材料（データ項目定義・権限表・外部とのやり取り・設計モデル・画面一覧）",
          operationId: "getDesign",
          parameters: [projectId, { name: "part", in: "query", schema: { type: "string", enum: ["entities", "data", "crud", "interfaces", "states", "outputs", "batches", "screenItems", "model", "screens"] } }],
          responses: { "200": ok("設計の材料。表は head と rows", { type: "object" }), ...errors },
        },
      },
      "/projects/{id}/tests": {
        get: {
          summary: "テストケース（要件から規則で作成。テストIDは要件が変わらない限り同じ）",
          operationId: "listTestCases",
          parameters: [
            projectId,
            { name: "requirement", in: "query", schema: { type: "string" } },
            { name: "level", in: "query", schema: { type: "string", enum: ["system", "nfr", "acceptance"] } },
          ],
          responses: { "200": ok("テストケース", { type: "object", properties: { cases: { type: "array", items: ref("TestCase") }, coverage: { type: "number" } } }), ...errors },
        },
      },
      "/projects/{id}/glossary": {
        get: { summary: "用語集（用語・意味・言い換え・コード上の名前）と、要件文の表記ゆれ", operationId: "getGlossary", parameters: [projectId], responses: { "200": ok("用語集", { type: "object" }), ...errors } },
      },
      "/projects/{id}/acceptance": {
        get: { summary: "受け入れ基準と、いまのテスト結果に照らした判定", operationId: "getAcceptance", parameters: [projectId], responses: { "200": ok("受け入れ基準と判定", { type: "object" }), ...errors } },
      },
      "/projects/{id}/diff": {
        get: {
          summary: "確定版の差分（追加・変更・削除された要件と、影響するテスト・ストーリー・画面）",
          operationId: "getDiff",
          parameters: [
            projectId,
            { name: "from", in: "query", schema: { type: "integer" }, description: "比べる元の確定版（省略時は最新の確定版）" },
            { name: "to", in: "query", schema: { type: "string" }, description: "比べる先の確定版の番号、または current（省略時はいまの要件）" },
          ],
          responses: { "200": ok("差分", { type: "object" }), ...errors },
        },
      },
      "/projects/{id}/handoff": {
        get: { summary: "引き継ぎパッケージ（format: arn-handoff/1）", operationId: "getHandoff", parameters: [projectId], responses: { "200": ok("要件・非機能要件・設計・画面・タスク・テスト・着手前チェック", { type: "object" }), ...errors } },
      },
      "/projects/{id}/agent-pack.zip": {
        get: {
          summary: "リポジトリ用パッケージ（AGENTS.md・CLAUDE.md・.mcp.json・要件と設計の Markdown・Gherkin のテストシナリオ・テストケースCSV）",
          operationId: "getAgentPack",
          parameters: [projectId],
          responses: { "200": { description: "ZIP", content: { "application/zip": { schema: { type: "string", format: "binary" } } } }, ...errors },
        },
      },
      "/projects/{id}/status": {
        get: { summary: "要件ごとの実装状況とテスト結果", operationId: "getStatus", parameters: [projectId], responses: { "200": ok("状況", { type: "object" }), ...errors } },
      },
      "/projects/{id}/implementation": {
        post: {
          summary: "実装状況の報告（report 権限）",
          operationId: "reportImplementation",
          parameters: [projectId],
          requestBody: { required: true, content: json(ref("ImplementationReport")) },
          responses: { "201": ok("記録した件数", { type: "object" }), ...errors },
        },
      },
      "/projects/{id}/test-runs": {
        get: { summary: "テストの実行結果の履歴", operationId: "listTestRuns", parameters: [projectId], responses: { "200": ok("実行結果（新しい順）", { type: "array", items: { type: "object" } }), ...errors } },
        post: {
          summary: "テスト結果の報告（report 権限）。JUnit XML をそのまま送るか、JSON で送る",
          description: "テスト名にテストID（TC-FR-01-1 など）か要件ID（FR-01 など）を含めると、要件に結びつきます。XML で送るときは tool・revision・url をクエリで渡します。",
          operationId: "recordTestRun",
          parameters: [
            projectId,
            { name: "tool", in: "query", schema: { type: "string" } },
            { name: "revision", in: "query", schema: { type: "string" } },
            { name: "url", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/xml": { schema: { type: "string", description: "JUnit XML（10MBまで。DOCTYPE・ENTITY は不可）" } }, "application/json": { schema: ref("TestRunInput") } },
          },
          responses: { "201": ok("結びつけた結果", ref("TestRunResult")), ...errors },
        },
      },
      "/projects/{id}/questions": {
        get: {
          summary: "質問と回答",
          operationId: "listQuestions",
          parameters: [projectId, { name: "status", in: "query", schema: { type: "string", enum: ["open", "answered", "closed"] } }],
          responses: { "200": ok("質問（新しい順）", { type: "array", items: ref("Question") }), ...errors },
        },
        post: {
          summary: "要件についての質問（report 権限）。回答は要件ナビの画面で行う",
          operationId: "askQuestion",
          parameters: [projectId],
          requestBody: { required: true, content: json({ type: "object", required: ["text"], properties: { text: { type: "string" }, requirementCode: { type: "string" }, context: { type: "string" } } }) },
          responses: { "201": ok("登録した質問", { type: "object" }), ...errors },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "組織の管理者が発行するトークン（arn_…）" } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } } },
        ProjectSummary: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, purpose: { type: "string" }, createdAt: { type: "string", format: "date-time" } } },
        Ears: {
          type: "object",
          properties: {
            pattern: { type: "string", enum: ["ubiquitous", "event", "state", "unwanted", "optional", "complex"] },
            trigger: { type: "string" },
            state: { type: "string" },
            feature: { type: "string" },
            system: { type: "string" },
            response: { type: "string" },
          },
        },
        Requirement: {
          type: "object",
          properties: {
            code: { type: "string", example: "FR-01" },
            type: { type: "string", enum: ["BR", "AC", "FR", "RL", "NFR", "CN"] },
            title: { type: "string", description: "EARS 記法の要件文" },
            description: { type: "string" },
            priority: { type: "string", enum: ["must", "should", "could"] },
            ears: { oneOf: [ref("Ears"), { type: "null" }] },
            rule: {
              type: ["object", "null"],
              description: "業務ルール（RL）の種類と具体例",
              properties: { kind: { type: "string", enum: ["calc", "judge", "constraint", "transition"] }, examples: { type: "array", items: { type: "object", properties: { given: { type: "string" }, expected: { type: "string" } } } }, entities: { type: "array", items: { type: "string" } } },
            },
            version: { type: "integer" },
            nfrKey: { type: ["string", "null"], description: "非機能要件シートの項目（av.rto など）" },
          },
        },
        TestCase: {
          type: "object",
          properties: {
            id: { type: "string", example: "TC-FR-01-1" },
            requirementCode: { type: "string" },
            kind: { type: "string" },
            level: { type: "string", enum: ["system", "nfr", "acceptance"] },
            title: { type: "string" },
            given: { type: "string" },
            when: { type: "string" },
            then: { type: "string" },
            method: { type: "string" },
            storyKey: { type: "string" },
          },
        },
        ImplementationReport: {
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["requirementCode", "status"],
                properties: {
                  requirementCode: { type: "string" },
                  status: { type: "string", enum: ["not_started", "in_progress", "implemented", "blocked"] },
                  refs: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string", format: "uri" } } } },
                  note: { type: "string" },
                },
              },
            },
          },
        },
        TestRunInput: {
          type: "object",
          properties: {
            tool: { type: "string" },
            revision: { type: "string" },
            url: { type: "string" },
            results: {
              type: "array",
              items: { type: "object", required: ["status"], properties: { testId: { type: "string" }, name: { type: "string" }, status: { type: "string", enum: ["passed", "failed", "skipped"] }, message: { type: "string" }, durationMs: { type: "number" } } },
            },
            junitXml: { type: "string" },
          },
        },
        TestRunResult: {
          type: "object",
          properties: {
            id: { type: "string" },
            summary: { type: "object", properties: { passed: { type: "integer" }, failed: { type: "integer" }, skipped: { type: "integer" }, unmatched: { type: "integer" } } },
            matched: { type: "integer" },
            unmatched: { type: "array", items: { type: "string" } },
          },
        },
        Question: {
          type: "object",
          properties: {
            id: { type: "string" },
            code: { type: "string", example: "Q-001" },
            requirementCode: { type: ["string", "null"] },
            text: { type: "string" },
            status: { type: "string", enum: ["open", "answered", "closed"] },
            answer: { type: "string" },
            answeredAt: { type: ["string", "null"] },
          },
        },
      },
    },
  };
}
