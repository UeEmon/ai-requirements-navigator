import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("コーディング・テスト工程への引き継ぎ", () => {
  let app: ReturnType<typeof createApp>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, org = orgId) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role, "x-user-id": "u1" } });
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

  it("着手前チェック: 足りないものを示し、設計・画面・タスクがそろうと条件付きで引き渡せる", async () => {
    const p = await sample();
    const before = await get(`/api/projects/${p.id}/readiness`);
    expect(before.verdict).toBe("not-ready");
    const st = (r: { checks: Array<{ key: string; status: string }> }) => Object.fromEntries(r.checks.map((c) => [c.key, c.status]));
    expect(st(before)).toMatchObject({ "req.fr": "ok", "req.ears": "ok", "req.nfr": "ok", "design.model": "ng", "design.screens": "warn", "test.tasks": "warn", "mgmt.baseline": "warn" });
    expect(before.checks.find((c: { key: string }) => c.key === "design.model").where).toBe("UML");

    // 設計モデル（複数AIで比べて採用）・画面・タスク
    const g = await (await req(`/api/projects/${p.id}/uml/generate`, as("editor", { method: "POST" }))).json();
    expect((await req(`/api/uml-rounds/${g.umlRoundId}/adopt`, as("editor", json({ label: g.evaluation.recommendedLabel, reason: "推奨どおり" })))).status).toBe(201);
    expect((await req(`/api/projects/${p.id}/screens/generate`, as("editor", { method: "POST" }))).status).toBe(201);
    expect((await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }))).status).toBe(201);

    const after = await get(`/api/projects/${p.id}/readiness`);
    expect(st(after)).toMatchObject({ "design.model": "ok", "design.data": "ok", "design.permissions": "ok", "design.interfaces": "ok", "test.cases": "ok", "test.nfr": "ok" });
    expect(after.verdict).toBe("conditional");
    expect(after.score).toBeGreaterThan(before.score);

    // 確定すると残りが解消する
    expect((await req(`/api/projects/${p.id}/baseline`, as("editor", json({ reason: "引き継ぎ" })))).status).toBe(201);
    expect(st(await get(`/api/projects/${p.id}/readiness`))["mgmt.baseline"]).toBe("ok");
  });

  it("テスト仕様: 要件ごとのテストケース、非機能要件の確認方法、受け入れテスト、CSV", async () => {
    const p = await sample();
    const t = await get(`/api/projects/${p.id}/tests`);
    expect(t.trace.coverage).toBe(1);
    expect(t.counts.byLevel).toMatchObject({ system: expect.any(Number), nfr: expect.any(Number) });
    expect(t.counts.byLevel.acceptance).toBeUndefined(); // タスク分解の前は受け入れテストがない
    // 非機能要件シートから作った要件は、シートの項目の確認方法になる（推定ではない）
    const nfr = t.cases.filter((c: { kind: string }) => c.kind === "nfr");
    expect(nfr.length).toBeGreaterThan(10);
    expect(nfr.some((c: { title: string }) => c.title === "負荷試験")).toBe(true);
    expect(t.trace.methodUndecided).toEqual([]);

    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    const t2 = await get(`/api/projects/${p.id}/tests`);
    expect(t2.counts.byLevel.acceptance).toBeGreaterThan(0);
    expect(t2.trace.rows.find((r: { type: string }) => r.type === "FR").acceptance.length).toBeGreaterThan(0);

    const csv = await req(`/api/projects/${p.id}/tests.csv`, as("viewer"));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // Excel 用の BOM
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("テストID,要件ID")).toBe(true);
    expect(text.split("\r\n").length).toBeGreaterThan(t2.cases.length);
  });

  it("設計の表と仕様書: データ項目定義・権限表・外部とのやり取り・テスト仕様・着手前チェック", async () => {
    const p = await sample();
    const empty = await get(`/api/projects/${p.id}/design/tables`);
    expect(empty.data.rows).toEqual([]);

    const g = await (await req(`/api/projects/${p.id}/uml/generate`, as("editor", { method: "POST" }))).json();
    await req(`/api/uml-rounds/${g.umlRoundId}/adopt`, as("editor", json({ label: "A", reason: "x" })));
    const d = await get(`/api/projects/${p.id}/design/tables`);
    expect(d.data.head[0]).toBe("エンティティ");
    expect(d.data.rows.some((r: string[]) => r[4] === "主キー")).toBe(true);
    expect(d.crud.rows.length).toBeGreaterThan(0);
    expect(d.interfaces.rows[0][0]).toBe("IF-01");
    expect(d.model).toBeUndefined();

    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    for (const h of ["## 14. データ設計", "## 15. 権限表", "## 16. 外部とのやり取り", "## 17. テスト仕様", "## 18. 着手前チェックと未決事項"]) expect(md).toContain(h);
    expect(md).toContain("| エンティティ | 項目 | コード上の名前 | 型 | キー | 必須 | 桁・形式・範囲 | 区分値 |");
    expect(md).toContain("| TC-FR-01-1 | FR-01 |");
    expect(md).toMatch(/判定：(引き渡せる|確認事項を共有すれば着手できる|足りないものがある)/);
    expect((await req(`/api/projects/${p.id}/spec.docx`, as("viewer"))).status).toBe(200);
  });

  it("引き継ぎパッケージ（JSON）に要件・非機能要件・設計・テスト・着手前チェックがまとまる", async () => {
    const p = await sample();
    const r = await req(`/api/projects/${p.id}/handoff.json`, as("viewer"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("handoff.json");
    const b = await r.json();
    expect(b.format).toBe("arn-handoff/1");
    expect(Object.keys(b)).toEqual(["format", "generatedAt", "project", "baseline", "howToUse", "requirements", "nfr", "design", "screens", "tasks", "tests", "readiness"]);
    expect(b.requirements.find((x: { type: string }) => x.type === "FR").ears.pattern).toBeTruthy();
    expect(b.requirements.filter((x: { nfrKey: string | null }) => x.nfrKey).length).toBeGreaterThan(10);
    expect(b.nfr.items).toHaveLength(26);
    expect(b.nfr.items.find((i: { key: string }) => i.key === "av.rto").verification.method).toBe("復旧訓練");
    expect(b.tests.cases.every((c: { requirementCode: string }) => b.requirements.some((x: { code: string }) => x.code === c.requirementCode))).toBe(true);
    expect(b.readiness.verdict).toBe("not-ready");

    // 他の組織からは見られない
    const other = (await (await req("/api/orgs", json({ name: "別の組織" }))).json()).id;
    expect((await req(`/api/projects/${p.id}/handoff.json`, as("viewer", {}, other))).status).toBe(404);
  });
});
