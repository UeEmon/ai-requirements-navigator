import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("要件定義で決めること（業務ルール・用語集・受け入れ基準・承認・差分）", () => {
  let app: ReturnType<typeof createApp>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, user = "u1") => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": user } });
  const req = (path: string, init: RequestInit = {}) => app.request(path, init);
  const get = async (path: string) => (await req(path, as("viewer"))).json();

  beforeEach(async () => {
    app = createApp({
      store: new MemoryStore(),
      encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
      storage: new MemoryStorage(),
      authenticate: devAuthenticator,
      allowMock: true,
      devAuth: true,
      jobs: { pollMs: 10 },
    });
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
    for (const label of ["生成役1", "生成役2", "評価役"]) await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label })));
  });
  const sample = async () => (await (await req(`/api/orgs/${orgId}/samples`, as("editor", json({})))).json()).project as { id: string };

  it("業務ルール: ヒアリングの段階で具体例つきで作り、検査し、具体例からテストケースを作る", async () => {
    const meta = await (await req("/api/meta")).json();
    expect(meta.phases.map((p: { key: string }) => p.key)).toContain("rules");
    const p = await sample();
    const round = await (await req(`/api/projects/${p.id}/rounds`, as("editor", json({ answer: "前日までの取消は無料", phaseKey: "rules" })))).json();
    const dr = await (await req(`/api/rounds/${round.id}/decision`, as("editor", json({ pick: "merged", itemIndexes: [0], reason: "x", advancePhase: false })))).json();
    expect(dr.added[0].code).toBe("RL-05"); // サンプルの4件に続く
    expect(dr.added[0].rule.examples.length).toBeGreaterThanOrEqual(2);

    const reqs = await get(`/api/projects/${p.id}/requirements`);
    const rl = reqs.filter((r: { type: string }) => r.type === "RL");
    expect(rl).toHaveLength(5);
    expect(rl.every((r: { lint: { ok: boolean } }) => r.lint.ok)).toBe(true);
    // 具体例を1つにすると指摘される。具体例は業務ルール以外には付かない
    const id = rl[0].id;
    const one = await (await req(`/api/requirements/${id}`, as("editor", json({ rule: { kind: "calc", examples: [{ given: "a", expected: "b" }] } }, "PATCH")))).json();
    expect(one.version).toBe(2);
    expect((await get(`/api/projects/${p.id}/requirements`)).find((r: { id: string }) => r.id === id).lint.issues[0]).toContain("1つだけ");
    const fr = reqs.find((r: { type: string }) => r.type === "FR");
    expect((await (await req(`/api/requirements/${fr.id}`, as("editor", json({ priority: "should", rule: { kind: "calc", examples: [] } }, "PATCH")))).json()).rule ?? null).toBeNull();

    const tests = await get(`/api/projects/${p.id}/tests?requirement=RL-02`);
    expect(tests.cases.map((c: { id: string; kind: string }) => [c.id, c.kind])).toEqual([
      ["TC-RL-02-1", "example"],
      ["TC-RL-02-2", "example"],
      ["TC-RL-02-3", "example"],
    ]);
    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("## この要件定義書の範囲");
    expect(md).toMatch(/## \d+\. 業務ルール/);
    expect(md).toContain("［判定］ 具体例：推奨L1・選んだ水準L3・理由なし → 要対応");
  });

  it("用語集: 設計とAIから作り、人が編集し、要件文の表記ゆれを見つける", async () => {
    const p = await sample();
    const g0 = await get(`/api/projects/${p.id}/glossary`);
    expect(g0.terms.length).toBe(7); // サンプルの用語集
    expect((await req(`/api/projects/${p.id}/glossary`, as("viewer", json({ terms: [] }, "PUT")))).status).toBe(403);
    const terms = [...g0.terms, { term: "利用者", definition: "要件ナビを使う人", synonyms: ["ユーザー", "業務担当者"], codeName: "", source: "manual" }];
    const g1 = await (await req(`/api/projects/${p.id}/glossary`, as("editor", json({ terms }, "PUT")))).json();
    // サンプルの要件「専門家でない業務担当者が…」が言い換えを使っている
    expect(g1.variants).toContainEqual({ code: "BR-01", used: "業務担当者", term: "利用者" });
    expect((await req(`/api/projects/${p.id}/glossary`, as("editor", json({ terms: [terms[0], terms[0]] }, "PUT")))).status).toBe(400);

    const g2 = await (await req(`/api/projects/${p.id}/glossary/generate`, as("editor", { method: "POST" }))).json();
    expect(g2.terms.find((t: { term: string }) => t.term === "利用者")).toMatchObject({ source: "manual", definition: "要件ナビを使う人" });
    expect(g2.terms.length).toBeGreaterThanOrEqual(g1.terms.length);
    const r = await get(`/api/projects/${p.id}/readiness`);
    expect(r.checks.find((c: { key: string }) => c.key === "req.glossary").status).toBe("warn");
  });

  it("受け入れ基準: 決めて、業務の担当者が確認し、テスト結果に照らして判定する", async () => {
    const p = await sample();
    const a0 = await get(`/api/projects/${p.id}/acceptance`);
    expect(a0.defined).toBe(true); // サンプルでは決めてある
    expect(a0.evaluation.accepted).toBe(false);
    const criteria = { ...a0.criteria, mustPassRate: 0, shouldPassRate: 0, nfrAllRun: false, questionsClosed: true, custom: [{ id: "C1", text: "通しで確認した", checked: true, checkedBy: "x", checkedAt: null }] };
    const a1 = await (await req(`/api/projects/${p.id}/acceptance`, as("editor", json({ criteria }, "PUT")))).json();
    // 文を変えた条件は確認をやり直す
    expect(a1.criteria.custom[0]).toMatchObject({ checked: false, checkedBy: null });
    expect(a1.evaluation.accepted).toBe(false);
    expect((await req(`/api/projects/${p.id}/acceptance/check`, as("viewer", json({ id: "C1", checked: true })))).status).toBe(403);
    const a2 = await (await req(`/api/projects/${p.id}/acceptance/check`, as("reviewer", json({ id: "C1", checked: true }), "biz")))).json();
    expect(a2.criteria.custom[0]).toMatchObject({ checked: true, checkedBy: "biz" });
    expect(a2.evaluation.accepted).toBe(true);
    // 不合格のテストが報告されると満たさなくなる
    const t = await (await req(`/api/orgs/${orgId}/api-tokens`, as("admin", json({ name: "ci", scopes: ["report"] })))).json();
    await req(`/api/v1/projects/${p.id}/test-runs`, { method: "POST", body: JSON.stringify({ results: [{ testId: "TC-RL-01-1", status: "failed" }] }), headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` } });
    const a3 = await get(`/api/projects/${p.id}/acceptance`);
    expect(a3.evaluation.items.find((i: { key: string }) => i.key === "failed")).toMatchObject({ ok: false, actual: "1件" });
    expect((await (await req(`/api/v1/projects/${p.id}/acceptance`, { headers: { authorization: `Bearer ${t.token}` } })).json()).evaluation.accepted).toBe(false);
  });

  it("レビューと承認: 承認が必要なプロジェクトは、いまの要件の内容で承認されるまで確定できない", async () => {
    const p = await sample();
    expect((await req(`/api/projects/${p.id}/settings`, as("editor", json({ approvalRequired: true }, "PUT")))).status).toBe(403);
    expect(await (await req(`/api/projects/${p.id}/settings`, as("admin", json({ approvalRequired: true, requiredApprovals: 1 }, "PUT")))).json()).toEqual({ approvalRequired: true, requiredApprovals: 1 });

    const b0 = await req(`/api/projects/${p.id}/baseline`, as("editor", json({ reason: "x", force: true })));
    expect(b0.status).toBe(409);
    expect((await b0.json()).code).toBe("approval_required");

    const rv = await (await req(`/api/projects/${p.id}/reviews`, as("editor", json({ note: "確認をお願いします" }), "requester"))).json();
    expect(rv).toMatchObject({ code: "RV-001", status: "open", requirements: 69, stale: false });
    expect((await req(`/api/reviews/${rv.id}/decide`, as("reviewer", json({ decision: "approve" }), "requester"))).status).toBe(403);
    expect((await req(`/api/reviews/${rv.id}/decide`, as("viewer", json({ decision: "approve" }), "viewer1"))).status).toBe(403);
    expect((await req(`/api/reviews/${rv.id}/decide`, as("reviewer", json({ decision: "reject" }), "approver"))).status).toBe(400); // 理由が必要

    // 依頼した後に要件が変わると承認できない
    const reqs = await get(`/api/projects/${p.id}/requirements`);
    await req(`/api/requirements/${reqs[0].id}`, as("editor", json({ priority: "should" }, "PATCH")));
    expect((await req(`/api/reviews/${rv.id}/decide`, as("reviewer", json({ decision: "approve" }), "approver"))).status).toBe(409);
    expect((await get(`/api/projects/${p.id}/reviews`)).status).toBe("stale");

    const rv2 = await (await req(`/api/projects/${p.id}/reviews`, as("editor", json({}), "requester"))).json();
    expect(rv2.code).toBe("RV-002");
    const list = await get(`/api/projects/${p.id}/reviews`);
    expect(list.reviews.map((r: { code: string; status: string }) => [r.code, r.status])).toEqual([
      ["RV-002", "open"],
      ["RV-001", "withdrawn"], // 前の依頼は取り下げ
    ]);
    const ok = await (await req(`/api/reviews/${rv2.id}/decide`, as("reviewer", json({ decision: "approve", comment: "確認しました" }), "approver"))).json();
    expect(ok).toMatchObject({ status: "approved", approvals: 1 });
    const rd = await get(`/api/projects/${p.id}/readiness`);
    expect(rd.checks.find((c: { key: string }) => c.key === "mgmt.approval").status).toBe("ok");

    expect((await req(`/api/projects/${p.id}/baseline`, as("editor", json({ reason: "承認済み" })))).status).toBe(201);
    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("RV-002");
    expect(md).toContain("approver：承認（確認しました）");
  });

  it("確定版の差分: 変更要求で変えた内容と、影響するテスト・ストーリー・画面を出す（API・MCP）", async () => {
    const p = await sample();
    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    expect((await req(`/api/projects/${p.id}/baselines/diff`, as("viewer"))).status).toBe(400); // 確定版がない
    expect((await req(`/api/projects/${p.id}/baseline`, as("editor", json({ reason: "v1" })))).status).toBe(201);
    const reqs = await get(`/api/projects/${p.id}/requirements`);
    const rl1 = reqs.find((r: { code: string }) => r.code === "RL-01");
    // 業務ルールの具体例だけを変える変更要求
    const cr = await (
      await req(`/api/projects/${p.id}/changes`, as("editor", json({ kind: "modify", requirementId: rl1.id, rule: { ...rl1.rule, examples: [...rl1.rule.examples, { given: "すべて0", expected: "合計点0" }] }, reason: "境界の例を追加" })))
    ).json();
    expect(cr.proposal.rule.examples).toHaveLength(4);
    await req(`/api/changes/${cr.id}/analyze`, as("editor", { method: "POST" }));
    const dec = await (await req(`/api/changes/${cr.id}/decide`, as("editor", json({ option: "apply", reason: "OK" })))).json();
    expect(dec.change.decision.baselineVersion).toBe(2);

    const d = await (await req(`/api/projects/${p.id}/baselines/diff?from=1&to=2`, as("viewer"))).json();
    expect(d.modified.map((x: { code: string; fields: string[] }) => [x.code, x.fields])).toEqual([["RL-01", ["detail"]]]);
    expect(d.affected.tests).toEqual(["TC-RL-01-1", "TC-RL-01-2", "TC-RL-01-3", "TC-RL-01-4"]);
    expect(d).toMatchObject({ from: 1, to: 2, added: [], removed: [] });
    expect((await (await req(`/api/projects/${p.id}/baselines/diff`, as("viewer"))).json()).modified).toEqual([]); // 最新の確定版といまは同じ
    expect((await req(`/api/projects/${p.id}/baselines/diff?from=9`, as("viewer"))).status).toBe(404);

    // AIコーディングツールからも見られる
    const t = await (await req(`/api/orgs/${orgId}/api-tokens`, as("admin", json({ name: "agent", projectIds: [p.id] })))).json();
    const auth = { "content-type": "application/json", authorization: `Bearer ${t.token}` };
    const v1 = await (await req(`/api/v1/projects/${p.id}/diff?from=1`, { headers: auth })).json();
    expect(v1.modified[0].code).toBe("RL-01");
    const mcp = await (await req("/mcp", { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_changes", arguments: { sinceVersion: 1 } } }) })).json();
    expect(mcp.result.structuredContent.modified[0].code).toBe("RL-01");
    const gl = await (await req("/mcp", { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_glossary", arguments: {} } }) })).json();
    expect(gl.result.structuredContent.terms.length).toBe(7);
    const rq = await (await req(`/api/v1/projects/${p.id}/requirements?type=RL`, { headers: auth })).json();
    expect(rq[0].rule.examples).toHaveLength(4);
    // 開発用パッケージに用語集と業務ルールが入る
    const zip = Buffer.from(await (await req(`/api/v1/projects/${p.id}/agent-pack.zip`, { headers: auth })).arrayBuffer()).toString("utf8");
    expect(zip).toContain("requirements/glossary.md");
  });
});
