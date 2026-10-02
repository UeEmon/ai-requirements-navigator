import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("サンプル事例（要件ナビ自身の要求事項）", () => {
  let app: ReturnType<typeof createApp>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": "u1" } });
  const req = (path: string, init: RequestInit = {}) => app.request(path, init);

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
  });

  it("AIを呼ばずに、資料・分析・EARS の要件・非機能要件シートが揃ったプロジェクトを作る", async () => {
    expect((await req(`/api/orgs/${orgId}/samples`, as("editor", json({})))).status).toBe(400); // AIが未登録
    for (const label of ["生成役1", "生成役2", "評価役"]) await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label })));
    expect((await req(`/api/orgs/${orgId}/samples`, as("viewer", json({})))).status).toBe(403);
    const r = await req(`/api/orgs/${orgId}/samples`, as("editor", json({})));
    expect(r.status).toBe(201);
    const { project, requirements, documents } = await r.json();
    expect(project).toMatchObject({ name: "要件ナビ（サンプル事例）", aiConfig: { mode: "multi" } });
    expect(project.aiConfig.evaluatorId).toBeTruthy();
    expect(documents).toBe(2);

    const reqs = await (await req(`/api/projects/${project.id}/requirements`, as("viewer"))).json();
    expect(reqs).toHaveLength(requirements);
    const count = (t: string) => reqs.filter((x: { type: string }) => x.type === t).length;
    expect([count("BR"), count("AC"), count("FR"), count("CN")]).toEqual([4, 5, 31, 5]);
    expect(count("NFR")).toBeGreaterThanOrEqual(15);
    // 機能・非機能はすべて EARS の検査を通る
    expect(reqs.filter((x: { type: string }) => ["FR", "NFR"].includes(x.type)).every((x: { lint: { ok: boolean }; ears: unknown }) => x.lint.ok && x.ears)).toBe(true);

    // 非機能要件シートは検討済みで、要対応・確認がない（確定前の確認を通る）
    const nfr = await (await req(`/api/projects/${project.id}/nfr`, as("viewer"))).json();
    expect(nfr.evaluation.coverage).toBe(1);
    expect(nfr.evaluation.findings).toEqual([]);
    expect(nfr.items.filter((i: { requirement: unknown }) => i.requirement).length).toBe(count("NFR") - 2);

    // 資料の分析は採用済み。引用はすべて資料で確かめられる
    const list = await (await req(`/api/projects/${project.id}/analyses`, as("viewer"))).json();
    const a = await (await req(`/api/analyses/${list[0].id}`, as("viewer"))).json();
    expect(a.status).toBe("adopted");
    expect(a.candidates[0].analysis.metrics.groundedRate).toBe(1);
    expect(a.candidates[0].analysis.warnings).toEqual([]);
    expect(a.adoption.requirementCodes).toHaveLength(4);

    // 仕様書に、資料分析・非機能要件シートが入る
    const md = await (await req(`/api/projects/${project.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("## 11. 現状の課題（資料分析）");
    expect(md).toContain("## 13. 非機能要件シート");
    expect(md).toContain("要件ナビは、評価の合計点を、評価AIの申告ではなく定めた重みで計算しなければならない。");

    // そのまま確定できる
    expect((await req(`/api/projects/${project.id}/baseline`, as("editor", json({ reason: "サンプル" })))).status).toBe(201);
  });
});
