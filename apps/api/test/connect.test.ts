import { createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { isPrivateAddress } from "../src/connect.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("AIコーディングツール・テストツールとの連携", () => {
  let app: ReturnType<typeof createApp>;
  let orgId: string;
  let sent: Array<{ url: string; headers: Record<string, string>; body: string }>;
  const as = (role: string, init: RequestInit = {}, org = orgId) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role, "x-user-id": "u1" } });
  const req = (path: string, init: RequestInit = {}) => app.request(path, init);
  const bearer = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  const rpc = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    req("/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers } });

  beforeEach(async () => {
    sent = [];
    app = createApp({
      store: new MemoryStore(),
      encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
      storage: new MemoryStorage(),
      authenticate: devAuthenticator,
      allowMock: true,
      devAuth: true,
      jobs: { pollMs: 10 },
      publicUrl: "https://arn.example.com",
      webhookLookup: async (host) => [{ address: host.endsWith(".internal") ? "10.0.0.5" : "203.0.113.10" }],
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
    for (const label of ["生成役1", "生成役2", "評価役"]) await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label })));
  });

  const sample = async () => (await (await req(`/api/orgs/${orgId}/samples`, as("editor", json({})))).json()).project as { id: string; name: string };
  const issue = async (body: Record<string, unknown>) => {
    const r = await req(`/api/orgs/${orgId}/api-tokens`, as("admin", json(body)));
    expect(r.status).toBe(201);
    return (await r.json()) as { id: string; token: string; scopes: string[] };
  };

  it("APIトークン: 管理者が発行し、範囲と権限で使える場所を制限し、失効できる", async () => {
    const p = await sample();
    const g1 = (await (await req(`/api/orgs/${orgId}/providers`, as("admin"))).json())[0].id;
    const p2r = await req(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "別の案件", aiConfig: { mode: "single", generatorIds: [g1] } })));
    expect(p2r.status).toBe(201);
    const p2 = (await p2r.json()) as { id: string };
    expect((await req(`/api/orgs/${orgId}/api-tokens`, as("editor", json({ name: "x" })))).status).toBe(403);
    expect((await req(`/api/orgs/${orgId}/api-tokens`, as("admin", json({ name: "x", projectIds: ["nope"] })))).status).toBe(400);

    const t = await issue({ name: "Claude Code", projectIds: [p.id] });
    expect(t.token).toMatch(/^arn_[A-Za-z0-9_-]{40,}$/);
    expect(t.scopes).toEqual(["read"]);
    // 一覧では末尾4文字だけ
    const list = await (await req(`/api/orgs/${orgId}/api-tokens`, as("admin"))).json();
    expect(list[0].token).toBe(`arn_…${t.token.slice(-4)}`);
    expect(JSON.stringify(list)).not.toContain(t.token);

    const projects = await (await req("/api/v1/projects", bearer(t.token))).json();
    expect(projects.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect((await req(`/api/v1/projects/${p2.id}`, bearer(t.token))).status).toBe(404); // 範囲外
    // read だけのトークンでは報告できない
    const rep = await req(`/api/v1/projects/${p.id}/implementation`, bearer(t.token, json({ items: [{ requirementCode: "FR-01", status: "implemented" }] })));
    expect(rep.status).toBe(403);
    // トークンでは画面用の API は使えない
    expect((await req(`/api/projects/${p.id}`, bearer(t.token))).status).toBe(401);

    expect((await req(`/api/orgs/${orgId}/api-tokens/${t.id}`, as("admin", { method: "DELETE" }))).status).toBe(204);
    const after = await req("/api/v1/projects", bearer(t.token));
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain("Bearer");
    expect((await req("/api/v1/projects", bearer("arn_" + "x".repeat(43)))).status).toBe(401);
    // 定義は認証なしで読める
    const oa = await (await req("/api/v1/openapi.json")).json();
    expect(oa.openapi).toBe("3.1.0");
    expect(oa.servers[0].url).toBe("https://arn.example.com/api/v1");
    expect(Object.keys(oa.paths)).toContain("/projects/{id}/test-runs");
  });

  it("外部連携API: 要件・要件の詳細・設計・テストケース・引き継ぎを読む（画面のログインでも使える）", async () => {
    const p = await sample();
    const t = await issue({ name: "CI" });
    const reqs = await (await req(`/api/v1/projects/${p.id}/requirements?type=FR`, bearer(t.token))).json();
    expect(reqs.length).toBe(31);
    expect(reqs[0]).toMatchObject({ code: "FR-01", type: "FR", version: 1 });
    expect(reqs[0].ears.pattern).toBeTruthy();
    const nfr = await (await req(`/api/v1/projects/${p.id}/requirements?type=NFR`, bearer(t.token))).json();
    expect(nfr.filter((r: { nfrKey: string | null }) => r.nfrKey).length).toBeGreaterThan(10);

    const d = await (await req(`/api/v1/projects/${p.id}/requirements/FR-01`, bearer(t.token))).json();
    expect(d.tests.map((x: { id: string }) => x.id)).toContain("TC-FR-01-1");
    expect(d.status.tests.status).toBe("not_run");
    expect((await req(`/api/v1/projects/${p.id}/requirements/FR-999`, bearer(t.token))).status).toBe(404);

    const tests = await (await req(`/api/v1/projects/${p.id}/tests?requirement=FR-01`, bearer(t.token))).json();
    expect(tests.cases.every((c: { requirementCode: string }) => c.requirementCode === "FR-01")).toBe(true);
    expect((await (await req(`/api/v1/projects/${p.id}/design?part=crud`, bearer(t.token))).json()).crud).toBeTruthy();
    expect((await req(`/api/v1/projects/${p.id}/design?part=x`, bearer(t.token))).status).toBe(400);
    expect((await (await req(`/api/v1/projects/${p.id}/handoff`, bearer(t.token))).json()).format).toBe("arn-handoff/1");
    // 画面のログイン（開発用ヘッダー）でも同じ API を使える
    expect((await req(`/api/v1/projects/${p.id}`, as("viewer"))).status).toBe(200);
  });

  it("実装状況とテスト結果（JUnit XML・JSON）を受け取り、要件ごとに集計する", async () => {
    const p = await sample();
    const t = await issue({ name: "CI", scopes: ["report"] });
    expect(t.scopes).toEqual(["read", "report"]);
    const bad = await req(`/api/v1/projects/${p.id}/implementation`, bearer(t.token, json({ items: [{ requirementCode: "FR-999", status: "implemented" }] })));
    expect(bad.status).toBe(400);
    const r = await req(
      `/api/v1/projects/${p.id}/implementation`,
      bearer(t.token, json({ items: [{ requirementCode: "FR-01", status: "implemented", refs: [{ label: "PR #1", url: "https://github.com/acme/app/pull/1" }] }, { requirementCode: "FR-02", status: "in_progress" }] })),
    );
    expect(r.status).toBe(201);
    expect((await r.json()).items[0]).toMatchObject({ requirementCode: "FR-01", statusLabel: "実装済み", requirementVersion: 1 });

    const xml = `<?xml version="1.0"?><testsuites><testsuite name="s">
      <testcase name="TC-FR-01-1 回答すると要件案を作る" time="0.1"/>
      <testcase name="TC-FR-01-2 回答していなければ作らない"><failure message="作ってしまった"/></testcase>
      <testcase name="FR-03 合計点" />
      <testcase name="ほかのテスト" />
    </testsuite></testsuites>`;
    const run = await req(`/api/v1/projects/${p.id}/test-runs?tool=vitest&revision=abc123`, bearer(t.token, { method: "POST", body: xml, headers: { "content-type": "application/xml" } }));
    expect(run.status).toBe(201);
    const rr = await run.json();
    expect(rr).toMatchObject({ summary: { passed: 2, failed: 1, skipped: 0, unmatched: 1 }, matched: 3, unmatched: ["ほかのテスト"] });
    expect(rr.hint).toContain("テストID");
    const j = await req(`/api/v1/projects/${p.id}/test-runs`, bearer(t.token, json({ tool: "playwright", results: [{ testId: "TC-FR-01-2", status: "passed" }] })));
    expect(j.status).toBe(201);
    const evil = await req(`/api/v1/projects/${p.id}/test-runs`, bearer(t.token, { method: "POST", body: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite/>', headers: { "content-type": "text/xml" } }));
    expect(evil.status).toBe(400);

    const st = await (await req(`/api/v1/projects/${p.id}/status`, bearer(t.token))).json();
    const fr1 = st.rows.find((x: { code: string }) => x.code === "FR-01");
    expect(fr1.impl).toMatchObject({ status: "implemented", stale: false, refs: [{ label: "PR #1" }] });
    expect(fr1.tests).toMatchObject({ passed: 2, failed: 0, status: "passed" }); // 2回目で TC-FR-01-2 が合格
    expect(st.rows.find((x: { code: string }) => x.code === "FR-03").tests.status).toBe("passed");
    expect(st.summary).toMatchObject({ implemented: 1, in_progress: 1 });
    const runs = await (await req(`/api/v1/projects/${p.id}/test-runs`, bearer(t.token))).json();
    expect(runs.map((x: { tool: string }) => x.tool)).toEqual(["playwright", "vitest"]);

    // 報告の後に要件が変わると「要件が変わった」になる
    const all = await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json();
    const fr1Id = all.find((x: { code: string }) => x.code === "FR-01").id;
    expect((await req(`/api/requirements/${fr1Id}`, as("editor", json({ title: "利用者が質問に回答したとき、要件ナビは、生成AIそれぞれに要件案を作成させなければならない。" }, "PATCH")))).status).toBe(200);
    const ui = await (await req(`/api/projects/${p.id}/connect`, as("viewer"))).json();
    expect(ui.status.rows.find((x: { code: string }) => x.code === "FR-01").impl.stale).toBe(true);
    expect(ui.runs).toHaveLength(2);
    expect(ui.server).toBe("https://arn.example.com");
  });

  it("質問: AIツールが質問し、画面で回答すると、着手前チェックの未決事項から消える", async () => {
    const p = await sample();
    const t = await issue({ name: "agent", scopes: ["read", "report"] });
    expect((await req(`/api/v1/projects/${p.id}/questions`, bearer(t.token, json({ text: "x", requirementCode: "FR-999" })))).status).toBe(400);
    const q = await (await req(`/api/v1/projects/${p.id}/questions`, bearer(t.token, json({ text: "評価AIが応答しないときの点数は0点ですか？", requirementCode: "FR-03", context: "src/evaluate.ts" })))).json();
    expect(q).toMatchObject({ code: "Q-001", status: "open" });
    const r1 = await (await req(`/api/projects/${p.id}/readiness`, as("viewer"))).json();
    expect(r1.openQuestions.some((x: string) => x.includes("Q-001"))).toBe(true);

    expect((await req(`/api/questions/${q.id}/answer`, as("viewer", json({ answer: "x" })))).status).toBe(403);
    const a = await (await req(`/api/questions/${q.id}/answer`, as("editor", json({ answer: "採点から除外します（0点にはしない）" })))).json();
    expect(a).toMatchObject({ status: "answered", answeredBy: "u1" });
    const list = await (await req(`/api/v1/projects/${p.id}/questions?status=answered`, bearer(t.token))).json();
    expect(list[0].answer).toBe("採点から除外します（0点にはしない）");
    const r2 = await (await req(`/api/projects/${p.id}/readiness`, as("viewer"))).json();
    expect(r2.openQuestions.some((x: string) => x.includes("Q-001"))).toBe(false);
  });

  it("MCP: 初期化・ツールの一覧・呼び出し（読み取り・報告・権限・エラー）", async () => {
    const p = await sample();
    const ro = await issue({ name: "読み取り", projectIds: [p.id] });
    const rw = await issue({ name: "報告も", scopes: ["report"], projectIds: [p.id] });

    const init = await rpc(ro.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(init.status).toBe(200);
    const ib = await init.json();
    expect(ib.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "requirements-navigator" }, capabilities: { tools: {} } });
    expect(ib.result.instructions).toContain("ask_question");
    expect((await (await rpc(ro.token, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json()).result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(ro.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const names = (r: { result: { tools: Array<{ name: string }> } }) => r.result.tools.map((x) => x.name);
    const roTools = names(await (await rpc(ro.token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json());
    expect(roTools).toContain("get_requirement");
    expect(roTools).not.toContain("report_test_results");
    const rwTools = names(await (await rpc(rw.token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json());
    expect(rwTools).toEqual(expect.arrayContaining(["report_implementation", "report_test_results", "ask_question"]));

    // プロジェクトが1つのトークンなら projectId を省略できる
    const ov = await (await rpc(ro.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_project_overview", arguments: {} } })).json();
    expect(ov.result.isError).toBe(false);
    expect(ov.result.structuredContent).toMatchObject({ id: p.id, counts: { FR: 31 } });
    expect(JSON.parse(ov.result.content[0].text).name).toBe(p.name);
    const det = await (await rpc(ro.token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_requirement", arguments: { code: "FR-02" } } })).json();
    expect(det.result.structuredContent.tests.length).toBeGreaterThan(0);
    const missing = await (await rpc(ro.token, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_requirement", arguments: { code: "FR-999" } } })).json();
    expect(missing.result).toMatchObject({ isError: true, content: [{ type: "text", text: "要件 FR-999 が見つかりません" }] });
    // 読み取りのトークンで報告しようとしても拒否される
    const deny = await (await rpc(ro.token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_question", arguments: { text: "?" } } })).json();
    expect(deny.result).toMatchObject({ isError: true });
    expect(deny.result.content[0].text).toContain("report");

    // 報告のトークン: JUnit XML とバッチ
    const batch = await (
      await rpc(rw.token, [
        { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "report_test_results", arguments: { tool: "jest", junitXml: '<testsuite><testcase name="TC-FR-02-1 x"/></testsuite>' } } },
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "report_implementation", arguments: { items: [{ requirementCode: "FR-02", status: "blocked", note: "仕様の確認待ち" }] } } },
        { jsonrpc: "2.0", method: "notifications/cancelled" },
      ])
    ).json();
    expect(batch.map((x: { id: number }) => x.id)).toEqual([10, 11]);
    expect(batch[0].result.structuredContent.summary).toMatchObject({ passed: 1 });
    const bad = await (await rpc(rw.token, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "report_implementation", arguments: { items: [{ requirementCode: "FR-02", status: "done" }] } } })).json();
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain("not_started"); // 使える値を示す
    const st = await (await rpc(rw.token, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "get_status", arguments: {} } })).json();
    expect(st.result.structuredContent.rows.find((x: { code: string }) => x.code === "FR-02")).toMatchObject({ impl: { status: "blocked" }, tests: { passed: 1 } });

    // プロトコルのエラー
    expect((await (await rpc(ro.token, { jsonrpc: "2.0", id: 20, method: "resources/list" })).json()).error.code).toBe(-32601);
    expect((await (await rpc(ro.token, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "nope" } })).json()).error.code).toBe(-32602);
    const parse = await req("/mcp", { method: "POST", body: "{", headers: { "content-type": "application/json", authorization: `Bearer ${ro.token}` } });
    expect(parse.status).toBe(400);
    expect((await parse.json()).error.code).toBe(-32700);
    expect((await req("/mcp", { method: "GET", headers: { authorization: `Bearer ${ro.token}` } })).status).toBe(405);
    const noAuth = await req("/mcp", json({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Bearer");
    expect((await rpc(ro.token, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("リポジトリ用パッケージ（zip）に AGENTS.md・MCP の設定・要件・Gherkin・送信スクリプトが入る", async () => {
    const p = await sample();
    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    const t = await issue({ name: "pack" });
    const r = await req(`/api/v1/projects/${p.id}/agent-pack.zip`, bearer(t.token));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");
    const names = buf.toString("utf8"); // ファイル名は圧縮されずに入っている
    for (const f of ["AGENTS.md", "CLAUDE.md", ".mcp.json", "requirements/requirements.md", "requirements/design.md", "requirements/tasks.md", "requirements/handoff.json", "tests/acceptance/FR-01.feature", "tests/testcases.csv", "scripts/report-test-results.sh", ".arn/project.json"]) {
      expect(names).toContain(f);
    }
    expect(names).toMatch(/tests\/acceptance\/stories\/E\d+-S\d+\.feature/);
    // 画面のログイン（閲覧者）でもダウンロードできる
    expect((await req(`/api/v1/projects/${p.id}/agent-pack.zip`, as("viewer"))).status).toBe(200);
  });

  it("Webhook: 社内アドレスを拒否し、確定版の作成などを署名つきで知らせる", async () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("203.0.113.10")).toBe(false);

    const p = await sample();
    expect((await req(`/api/orgs/${orgId}/webhooks`, as("editor", json({ url: "https://hooks.example.com/x" })))).status).toBe(403);
    expect((await req(`/api/orgs/${orgId}/webhooks`, as("admin", json({ url: "http://hooks.example.com/x" })))).status).toBe(400);
    expect((await req(`/api/orgs/${orgId}/webhooks`, as("admin", json({ url: "https://ci.internal/x" })))).status).toBe(400);
    expect((await req(`/api/orgs/${orgId}/webhooks`, as("admin", json({ url: "https://127.0.0.1/x" })))).status).toBe(400);
    const w = await (await req(`/api/orgs/${orgId}/webhooks`, as("admin", json({ url: "https://hooks.example.com/arn", events: ["baseline.created", "question.created"] })))).json();
    expect(w.secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await (await req(`/api/orgs/${orgId}/webhooks`, as("admin"))).json())).not.toContain(w.secret);

    expect((await req(`/api/projects/${p.id}/baseline`, as("editor", json({ reason: "引き継ぎ" })))).status).toBe(201);
    await (app as unknown as { connect: { flush: () => Promise<void> } }).connect.flush();
    expect(sent).toHaveLength(1);
    const h = sent[0]!;
    expect(h.url).toBe("https://hooks.example.com/arn");
    expect(h.headers["x-arn-event"]).toBe("baseline.created");
    const expected = createHmac("sha256", w.secret).update(`${h.headers["x-arn-timestamp"]}.${h.body}`).digest("hex");
    expect(h.headers["x-arn-signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(h.body)).toMatchObject({ event: "baseline.created", orgId, data: { projectId: p.id, version: 1 } });

    // 登録していないイベントは送らない
    const t = await issue({ name: "ci", scopes: ["report"] });
    await req(`/api/v1/projects/${p.id}/implementation`, bearer(t.token, json({ items: [{ requirementCode: "FR-01", status: "implemented" }] })));
    await req(`/api/v1/projects/${p.id}/questions`, bearer(t.token, json({ text: "質問" })));
    await (app as unknown as { connect: { flush: () => Promise<void> } }).connect.flush();
    expect(sent.map((s) => s.headers["x-arn-event"])).toEqual(["baseline.created", "question.created"]);

    const ping = await (await req(`/api/orgs/${orgId}/webhooks/${w.id}/test`, as("admin", { method: "POST" }))).json();
    expect(ping).toEqual({ ok: true, status: "HTTP 200" });
    expect((await (await req(`/api/orgs/${orgId}/webhooks`, as("admin"))).json())[0].lastStatus).toBe("HTTP 200");
    expect((await req(`/api/orgs/${orgId}/webhooks/${w.id}`, as("admin", { method: "DELETE" }))).status).toBe(204);
  });
});
