import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

function setup() {
  const store = new MemoryStore();
  const app = createApp({
    store,
    encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
    storage: new MemoryStorage(),
    authenticate: devAuthenticator,
    allowMock: true,
    devAuth: true,
    random: () => 0.5,
    fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    jobs: { pollMs: 10 },
  });
  return { app, store };
}

describe("画面設計・要件定義の確定・変更管理", () => {
  let t: ReturnType<typeof setup>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, org = orgId, user = "u1") => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role, "x-user-id": user },
  });
  const req = (path: string, init: RequestInit = {}) => t.app.request(path, init);
  const post = async (path: string, b: unknown = {}, role = "editor") => req(path, as(role, json(b)));

  async function project() {
    const ids: string[] = [];
    for (const label of ["生成役1", "生成役2", "評価役"]) {
      ids.push((await (await post(`/api/orgs/${orgId}/providers`, { vendor: "mock", model: "mock", label }, "admin")).json()).id);
    }
    const aiConfig = { mode: "multi", generatorIds: [ids[0], ids[1]], evaluatorId: ids[2] };
    return (await (await post(`/api/orgs/${orgId}/projects`, { name: "予約", aiConfig })).json()) as { id: string };
  }
  async function decide(projectId: string, phaseKey: string, answer: string) {
    const round = await (await post(`/api/projects/${projectId}/rounds`, { answer, phaseKey })).json();
    return (await post(`/api/rounds/${round.id}/decision`, { pick: "merged", advancePhase: false })).json();
  }
  /** 機能要件3件・非機能要件3件 */
  async function ready() {
    const p = await project();
    await decide(p.id, "functions", "ネットで予約したい");
    await decide(p.id, "quality", "すぐ表示されてほしい");
    return p;
  }
  const reqByCode = async (pid: string, code: string) =>
    ((await (await req(`/api/projects/${pid}/requirements`, as("viewer"))).json()) as Array<{ id: string; code: string; title: string; version: number }>).find((r) => r.code === code);

  beforeEach(async () => {
    t = setup();
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
  });

  /* ---------- 画面 ---------- */
  it("画面: 要件からワイヤーフレームを作り、見た目の指摘は申し送りに、要件の指摘は作り直しに使う", async () => {
    const p0 = await project();
    expect((await post(`/api/projects/${p0.id}/screens/generate`)).status).toBe(400);

    const p = await ready();
    const g = await post(`/api/projects/${p.id}/screens/generate`);
    expect(g.status).toBe(201);
    const v1 = await g.json();
    expect(v1.screens.revision).toBe(1);
    expect(v1.screens.model.screens.map((s: { key: string }) => s.key)).toEqual(["S01", "S02"]);
    expect(v1.screens.model.uncovered).toEqual([]);
    expect(v1.nudge).toBeNull();

    // ワイヤーフレーム（スクリプトを動かさない）
    const html = await req(`/api/projects/${p.id}/screens/prototype.html`, as("viewer"));
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    const text = await html.text();
    expect(text).toContain("画面イメージ（ワイヤーフレーム）");
    expect(text).not.toContain("<script");
    expect((await req(`/api/projects/${p.id}/screens/prototype.html?download=1`, as("viewer"))).headers.get("content-disposition")).toContain("attachment");

    // 見た目の細部 → 申し送り（作り直しには使わない）
    const f1 = await (await post(`/api/projects/${p.id}/screens/feedback`, { screenKey: "S01", text: "ボタンの色を青にして、もう少し大きくしてほしい" })).json();
    expect(f1.feedback).toMatchObject({ level: "detail", status: "noted" });
    expect(f1.guidance).toContain("設計工程で決める");
    // 要件に関わる → 次の作り直しに反映
    const f2 = await (await post(`/api/projects/${p.id}/screens/feedback`, { screenKey: "S01", text: "電話番号の入力欄が足りない" })).json();
    expect(f2.feedback).toMatchObject({ level: "requirement", status: "open" });
    expect((await post(`/api/projects/${p.id}/screens/feedback`, { screenKey: "S99", text: "x" })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/screens/feedback`, { text: "x" }, "viewer")).status).toBe(403);

    const v2 = await (await post(`/api/projects/${p.id}/screens/generate`)).json();
    expect(v2.screens.revision).toBe(2);
    expect(v2.screens.model.screens[0].elements.map((e: { label: string }) => e.label)).toContain("意見を反映した項目");
    expect(v2.open).toEqual([]);
    expect(v2.applied.map((f: { text: string }) => f.text)).toEqual(["電話番号の入力欄が足りない"]);
    expect(v2.notes.map((f: { text: string }) => f.text)).toEqual(["ボタンの色を青にして、もう少し大きくしてほしい"]);

    // 作り直しが続いたら、要件の確認に戻るよう促す
    const v3 = await (await post(`/api/projects/${p.id}/screens/generate`)).json();
    expect(v3.nudge).toContain("3回作り直しています");

    // 仕様書とUMLに、画面一覧・画面遷移図・申し送りが入る
    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toMatch(/## \d+\. 画面一覧（ワイヤーフレーム）/);
    expect(md).toContain("### 画面遷移図");
    expect(md).toContain("S01：ボタンの色を青にして");
    expect(md).toContain("未確定（作成中）");
    const uml = await (await req(`/api/projects/${p.id}/uml`, as("viewer"))).json();
    expect(uml.diagrams.map((d: { kind: string }) => d.kind)).toContain("screen");

    // 非同期でも作れる
    const { jobId } = await (await post(`/api/projects/${p.id}/screens/generate?async=1`)).json();
    await t.app.jobs.drain();
    expect((await (await req(`/api/jobs/${jobId}`, as("editor"))).json()).result.screens.revision).toBe(4);
  });

  /* ---------- 確定と変更管理 ---------- */
  it("確定: 確定後は要件を直接変えられず、変更要求の影響分析を見て変更すると確定版の版が上がる", async () => {
    const p = await ready();
    await post(`/api/projects/${p.id}/tasks/generate`);
    await post(`/api/projects/${p.id}/screens/generate`);
    const fr1 = (await reqByCode(p.id, "FR-01"))!;

    // 確定前は変更要求を作れない（直接編集できる）
    expect((await post(`/api/projects/${p.id}/changes`, { kind: "modify", requirementId: fr1.id, title: "x" })).status).toBe(400);

    // 非機能要件が未検討なので、そのままでは確定できない
    const blocked = await post(`/api/projects/${p.id}/baseline`, { reason: "初版" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "nfr_incomplete", undecided: expect.arrayContaining(["稼働率（止まってよい時間）"]) });
    expect((await post(`/api/projects/${p.id}/baseline`, { force: true })).status).toBe(400); // 理由が必要
    const b1 = await post(`/api/projects/${p.id}/baseline`, { reason: "初版（非機能要件は次の打合せで決める）", force: true });
    expect(b1.status).toBe(201);
    expect((await b1.json()).version).toBe(1);
    expect((await post(`/api/projects/${p.id}/baseline`, { reason: "x", force: true })).status).toBe(409);
    expect((await post(`/api/projects/${p.id}/baseline`, {}, "viewer")).status).toBe(403);

    // 直接の編集・削除はできない
    const patch = await req(`/api/requirements/${fr1.id}`, as("editor", json({ title: "直接変更" }, "PATCH")));
    expect(patch.status).toBe(409);
    expect((await patch.json()).error).toContain("変更要求");
    expect((await req(`/api/requirements/${fr1.id}`, as("editor", { method: "DELETE" }))).status).toBe(409);

    // 変更要求 → 影響分析
    expect((await post(`/api/projects/${p.id}/changes`, { kind: "modify", requirementId: fr1.id })).status).toBe(400); // 変更内容なし
    const cr = await (await post(`/api/projects/${p.id}/changes`, { kind: "modify", requirementId: fr1.id, title: "予約を登録・変更できる", reason: "日時の変更が多い" })).json();
    expect(cr).toMatchObject({ code: "CR-001", status: "open", requirementCode: "FR-01" });
    expect((await post(`/api/changes/${cr.id}/decide`, { option: "apply" })).status).toBe(400); // 分析前

    const analyzed = await (await post(`/api/changes/${cr.id}/analyze`)).json();
    expect(analyzed.status).toBe("analyzed");
    const im = analyzed.impact;
    expect(im.analysts).toBe(2); // 複数AIモード: 生成AI 2つで分析
    expect(im.requirements[0]).toMatchObject({ item: { code: "FR-01" }, votes: 2, traced: true });
    expect(im.stories.map((s: { item: { key: string } }) => s.item.key)).toEqual(["E1-S1"]);
    expect(im.screens.map((s: { item: { key: string } }) => s.item.key)).toEqual(["S01"]);
    expect(im.summaries.map((s: { provider: string }) => s.provider)).toEqual(["生成役1", "生成役2"]);
    expect(im.options.map((o: { key: string }) => o.key)).toEqual(["apply", "alternative", "defer", "reject"]);
    expect(im.options[0].consequence).toContain("画面 1件");

    // 変更する
    const d = await (await post(`/api/changes/${cr.id}/decide`, { option: "apply", reason: "受付の負担を減らすため" })).json();
    expect(d.change).toMatchObject({ status: "approved", decision: { option: "apply", requirementCode: "FR-01", baselineVersion: 2 } });
    expect(d.followUps.stories[0].item.key).toBe("E1-S1");
    const after = (await reqByCode(p.id, "FR-01"))!;
    expect(after).toMatchObject({ title: "予約を登録・変更できる", version: 2 });
    expect((await post(`/api/changes/${cr.id}/decide`, { option: "reject" })).status).toBe(409);
    expect((await post(`/api/changes/${cr.id}/analyze`)).status).toBe(409);

    // 分解結果・画面は「要件が変わった」と分かる
    expect((await (await req(`/api/projects/${p.id}/tasks`, as("viewer"))).json()).changed).toEqual(["FR-01"]);
    expect((await (await req(`/api/projects/${p.id}/screens`, as("viewer"))).json()).screens.stale).toBe(true);

    const base = await (await req(`/api/projects/${p.id}/baseline`, as("viewer"))).json();
    expect(base.current.version).toBe(2);
    expect(base.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    expect(base.current.snapshot.find((r: { code: string }) => r.code === "FR-01").title).toBe("予約を登録・変更できる");

    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("確定版 v2");
    expect(md).toContain("CR-001 変更 FR-01「予約を登録・変更できる」：変更（確定版 v2） 受付の負担を減らすため");

    const log = await (await req(`/api/orgs/${orgId}/audit?limit=20`, as("admin"))).json();
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["baseline.create", "change.create", "ai.impact", "change.decide"]));
  });

  it("確定後のヒアリングで採用した項目は変更要求になり、代替案・保留・変更しない・削除を選べる", async () => {
    const p = await ready();
    await post(`/api/projects/${p.id}/baseline`, { reason: "テスト", force: true });
    const before = (await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json()).length;

    // ヒアリング → 要件には加えず、追加の変更要求にする
    const dec = await decide(p.id, "functions", "空き枠を通知したい");
    expect(dec.added).toEqual([]);
    expect(dec.changeRequests.map((x: { code: string; kind: string; source: string }) => [x.code, x.kind, x.source])).toEqual([
      ["CR-001", "add", "hearing"],
      ["CR-002", "add", "hearing"],
      ["CR-003", "add", "hearing"],
    ]);
    expect((await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json()).length).toBe(before);

    // 非同期で分析 → 代替案で追加
    const [c1, c2, c3] = dec.changeRequests;
    const r = await post(`/api/changes/${c1.id}/analyze?async=1`);
    expect(r.status).toBe(202);
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${(await r.json()).jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.progress.steps.map((s: { status: string }) => s.status)).toEqual(["done", "done"]);
    const alt = await (await post(`/api/changes/${c1.id}/decide`, { option: "alternative" })).json();
    expect(alt.change.decision).toMatchObject({ option: "alternative", requirementCode: "FR-04", baselineVersion: 2 });
    expect((await reqByCode(p.id, "FR-04"))!.title).toBe("運用で対応する");

    // 保留（分析なしでも可）→ 分析し直してから変更しない
    expect((await (await post(`/api/changes/${c2.id}/decide`, { option: "defer", reason: "次期で検討" })).json()).change.status).toBe("deferred");
    expect((await (await post(`/api/changes/${c2.id}/analyze`)).json()).status).toBe("deferred");
    expect((await (await post(`/api/changes/${c2.id}/decide`, { option: "reject", reason: "費用に見合わない" })).json()).change.status).toBe("rejected");
    expect((await (await req(`/api/projects/${p.id}/baseline`, as("viewer"))).json())).toMatchObject({ pending: 1, deferred: 0 });
    expect(c3.status).toBe("open");

    // 削除の変更要求
    const nfr1 = (await reqByCode(p.id, "NFR-01"))!;
    const del = await (await post(`/api/projects/${p.id}/changes`, { kind: "delete", requirementId: nfr1.id, reason: "不要になった" })).json();
    await post(`/api/changes/${del.id}/analyze`);
    expect((await post(`/api/changes/${del.id}/decide`, { option: "alternative" })).status).toBe(400);
    const dd = await (await post(`/api/changes/${del.id}/decide`, { option: "apply" })).json();
    expect(dd.change.decision.baselineVersion).toBe(3);
    expect(await reqByCode(p.id, "NFR-01")).toBeUndefined();
    const base = await (await req(`/api/projects/${p.id}/baseline`, as("viewer"))).json();
    expect(base.current.snapshot.some((x: { code: string }) => x.code === "NFR-01")).toBe(false);

    // 入力の誤り
    expect((await post(`/api/projects/${p.id}/changes`, { kind: "add", title: "区分なし" })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/changes`, { kind: "delete" })).status).toBe(400);
    const list = await (await req(`/api/projects/${p.id}/changes`, as("viewer"))).json();
    expect(list.map((x: { code: string }) => x.code)).toEqual(["CR-004", "CR-003", "CR-002", "CR-001"]);
  });
});
