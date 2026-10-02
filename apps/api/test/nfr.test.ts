import { randomBytes } from "node:crypto";
import { NFR_ITEMS } from "@arn/ai-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("非機能要件シート", () => {
  let app: ReturnType<typeof createApp>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": "u1" },
  });
  const req = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, b: unknown = {}, role = "editor") => req(path, as(role, json(b)));
  const patch = (path: string, b: unknown, role = "editor") => req(path, as(role, json(b, "PATCH")));

  async function project() {
    const ids: string[] = [];
    // ID の偶奇で模擬AIの提案が変わるため、表示名を変えて何度か登録する
    for (const label of ["生成役1", "生成役2", "評価役"]) {
      ids.push((await (await post(`/api/orgs/${orgId}/providers`, { vendor: "mock", model: "mock", label }, "admin")).json()).id);
    }
    const aiConfig = { mode: "multi", generatorIds: [ids[0], ids[1]], evaluatorId: ids[2] };
    const p = (await (await post(`/api/orgs/${orgId}/projects`, { name: "予約", aiConfig })).json()) as { id: string };
    const rnd = await (await post(`/api/projects/${p.id}/rounds`, { answer: "ネットで予約したい", phaseKey: "functions" })).json();
    await post(`/api/rounds/${rnd.id}/decision`, { pick: "merged", advancePhase: false });
    return p;
  }

  beforeEach(async () => {
    app = createApp({
      store: new MemoryStore(),
      encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
      storage: new MemoryStorage(),
      authenticate: devAuthenticator,
      allowMock: true,
      devAuth: true,
      random: () => 0.5,
      jobs: { pollMs: 10 },
    });
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
  });

  it("システムの性格から推奨水準を示し、項目ごとに決定・対象外・保留を記録し、矛盾を検出する", async () => {
    const p = await project();
    const v0 = await (await req(`/api/projects/${p.id}/nfr`, as("viewer"))).json();
    expect(v0.items).toHaveLength(26);
    expect(v0.evaluation.coverage).toBe(0);
    expect(v0.grade.label).toBe("社会的影響が限定されるシステム");
    expect(v0.items.find((i: { key: string }) => i.key === "av.rate").recommended).toBe("L2");

    const v1 = await (await req(`/api/projects/${p.id}/nfr/profile`, as("editor", json({ users: 2, impact: 2, data: 2, hours: 2 }, "PUT")))).json();
    expect(v1.grade.label).toBe("社会的影響が極めて大きいシステム");
    expect(v1.items.find((i: { key: string }) => i.key === "av.rate").recommended).toBe("L3");
    expect((await req(`/api/projects/${p.id}/nfr/profile`, as("editor", json({ users: 5 }, "PUT")))).status).toBe(400);

    expect((await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided" })).status).toBe(400); // 水準がない
    expect((await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided", level: "L9" })).status).toBe(400);
    expect((await patch(`/api/projects/${p.id}/nfr/items/zz`, { status: "na" })).status).toBe(404);
    expect((await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided", level: "L3" }, "viewer")).status).toBe(403);
    await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided", level: "L3" });
    const v2 = await (await patch(`/api/projects/${p.id}/nfr/items/op.monitoring`, { status: "decided", level: "L1" })).json();
    expect(v2.evaluation.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", items: ["av.rate", "op.monitoring"] })]));
    const v3 = await (await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided", level: null, value: "99.5%", rationale: "夜間は止めてよい" })).json();
    expect(v3.items.find((i: { key: string }) => i.key === "av.rate").decision).toMatchObject({ level: null, value: "99.5%", rationale: "夜間は止めてよい" });
    const v4 = await (await patch(`/api/projects/${p.id}/nfr/items/mg.cutover`, { status: "deferred", owner: "情報システム部" })).json();
    expect(v4.evaluation.counts).toMatchObject({ decided: 2, deferred: 1, undecided: 23 });
  });

  it("複数AIの提案を並べ、一致したものはまとめて採用し、決めた水準を EARS の非機能要件にする", async () => {
    const p = await project();
    const { jobId } = await (await post(`/api/projects/${p.id}/nfr/suggest?async=1`)).json();
    await app.jobs.drain();
    const job = await (await req(`/api/jobs/${jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.progress.steps.map((s: { status: string }) => s.status)).toEqual(["done", "done"]);
    const items = job.result.items as Array<{ key: string; suggestion: { split: boolean; proposals: Array<{ provider: string }> } }>;
    expect(items.every((i) => i.suggestion)).toBe(true);
    expect(items[0]!.suggestion.proposals.map((x) => x.provider).sort()).toEqual(["生成役1", "生成役2"]);

    const ap = await (await post(`/api/projects/${p.id}/nfr/apply-suggestions`)).json();
    const split = items.filter((i) => i.suggestion.split).map((i) => i.key);
    expect(ap.applied).toHaveLength(26 - split.length);
    expect(ap.sheet.evaluation.counts.decided).toBe(26 - split.length);
    expect(ap.sheet.items.find((i: { key: string }) => i.key === "pf.response").decision.rationale).toContain("AIの提案（2件が一致）");

    const r = await (await post(`/api/projects/${p.id}/nfr/requirements`, { systemName: "予約システム" })).json();
    expect(r.added.length).toBeGreaterThan(5);
    expect(r.added.every((c: string) => c.startsWith("NFR-"))).toBe(true);
    const reqs = await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json();
    const resp = reqs.find((x: { title: string }) => x.title.includes("操作の95%について3秒以内に結果を表示"));
    expect(resp).toMatchObject({ type: "NFR", source: "非機能要件シート（画面の応答時間）", lint: { ok: true }, ears: { pattern: "event" } });
    expect(reqs.filter((x: { type: string }) => x.type === "NFR").every((x: { lint: { ok: boolean } }) => x.lint.ok)).toBe(true);
    // 2回目は変更がないので何も作らない。水準を変えると要件も直す
    expect((await (await post(`/api/projects/${p.id}/nfr/requirements`, { systemName: "予約システム" })).json()).added).toEqual([]);
    await patch(`/api/projects/${p.id}/nfr/items/pf.response`, { status: "decided", level: "L3", rationale: "顧客が使うため" });
    const r2 = await (await post(`/api/projects/${p.id}/nfr/requirements`, { systemName: "予約システム" })).json();
    expect(r2.updated).toEqual([resp.code]);
    const after = (await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json()).find((x: { id: string }) => x.id === resp.id);
    expect(after.title).toContain("1秒以内");
    expect(after.version).toBe(2);
  });

  it("確定の前に、未検討の項目と要対応の矛盾がないかを確かめる", async () => {
    const p = await project();
    const r1 = await post(`/api/projects/${p.id}/baseline`, {});
    expect(r1.status).toBe(409);
    const b1 = await r1.json();
    expect(b1.code).toBe("nfr_incomplete");
    expect(b1.undecided).toHaveLength(26);

    // すべて決めても、要対応の矛盾があれば確定できない
    for (const i of NFR_ITEMS) await patch(`/api/projects/${p.id}/nfr/items/${i.key}`, { status: "decided", level: i.levels[1]?.id ?? "L1", rationale: "検討済み" });
    await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided", level: "L3" });
    await patch(`/api/projects/${p.id}/nfr/items/op.monitoring`, { status: "decided", level: "L1", rationale: "人が見る" });
    const r2 = await (await post(`/api/projects/${p.id}/baseline`, {})).json();
    expect(r2.undecided).toEqual([]);
    expect(r2.errors[0]).toContain("停止を自動で検知");

    await patch(`/api/projects/${p.id}/nfr/items/op.monitoring`, { status: "decided", level: "L2" });
    const ok = await post(`/api/projects/${p.id}/baseline`, {});
    expect(ok.status).toBe(201);

    // 仕様書に非機能要件シートが入る
    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("## 13. 非機能要件シート");
    expect(md).toContain("［決定］可用性／稼働率（止まってよい時間）：99.9%（月に約43分まで）");
    const log = await (await req(`/api/orgs/${orgId}/audit?action=baseline`, as("admin"))).json();
    expect(log.entries[0].detail.nfr).toMatchObject({ coverage: 1, override: false });
  });
});
