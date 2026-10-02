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
    // 別の水準に変えると、AIの提案の理由は引き継がない（推奨より低ければ理由を求める）
    const low = await (await patch(`/api/projects/${p.id}/nfr/items/sc.auth`, { status: "decided", level: "L1", rationale: "AIの提案（2件が一致）：業務への影響と費用のバランスから選びました" })).json();
    expect(low.items.find((i: { key: string }) => i.key === "sc.auth").decision.rationale).toBe("");
    expect(low.evaluation.findings.some((f: { items: string[] }) => f.items.includes("sc.auth"))).toBe(true);
    await patch(`/api/projects/${p.id}/nfr/items/sc.auth`, { status: "decided", level: "L2", rationale: "社内のみで使うため" });

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
  it("適正化: 似た規模・目的の事例（参考類型と社内の過去事例）と比べ、過大な水準を示し、AIに見直してもらえる", async () => {
    const small = { users: 2, impact: 0, data: 2, hours: 2, scale: 0, purpose: 1, budget: 0 };
    // 同じ組織の過去のプロジェクト（ほぼすべて L1 で決めた）
    const past = await project();
    await req(`/api/projects/${past.id}/nfr/profile`, as("editor", json(small, "PUT")));
    for (const i of NFR_ITEMS) await patch(`/api/projects/${past.id}/nfr/items/${i.key}`, { status: "decided", level: "L1", rationale: "小規模のため" });

    const p = await project();
    const v = await (await req(`/api/projects/${p.id}/nfr/profile`, as("editor", json(small, "PUT")))).json();
    expect(v.sizing.ready).toBe(true);
    const names = v.sizing.similar.map((c: { name: string }) => c.name);
    expect(names).toContain("社内事例：予約");
    expect(names).toContain("小規模店舗の予約受付");
    expect(names).not.toContain("金融機関のオンラインサービス（参考：最上位）");
    expect(v.items.find((i: { key: string }) => i.key === "av.rate").cases.levels.length).toBe(v.sizing.similar.length);
    const cases = await (await req(`/api/projects/${p.id}/nfr/cases`, as("viewer"))).json();
    expect(cases.length).toBeGreaterThanOrEqual(13);

    // 似た事例のどれよりも高い水準・推奨より大きく高い水準は、理由がないと過大の可能性として示す
    const over = await (await patch(`/api/projects/${p.id}/nfr/items/av.rate`, { status: "decided", level: "L4" })).json();
    const msgs = over.evaluation.findings.map((f: { message: string }) => f.message).join("\n");
    expect(msgs).toContain("似た事例");
    expect(msgs).toContain("過大の可能性");
    for (const i of NFR_ITEMS.filter((x) => x.key !== "av.rate")) {
      const rec = v.items.find((x: { key: string }) => x.key === i.key).recommended;
      await patch(`/api/projects/${p.id}/nfr/items/${i.key}`, { status: "decided", level: rec, rationale: "推奨どおり" });
    }
    const gate = await (await post(`/api/projects/${p.id}/baseline`, {})).json();
    expect(gate.code).toBe("nfr_incomplete");
    expect(gate.errors.join("\n")).toContain("稼働率（止まってよい時間）」が推奨より大きく高い水準");

    // 複数AIの見直し: 理由のない高い水準を下げる提案
    const rv = await (await post(`/api/projects/${p.id}/nfr/review`)).json();
    const item = rv.items.find((i: { key: string }) => i.key === "av.rate");
    expect(item.review).toMatchObject({ level: "L3", votes: 2, analysts: 2 });
    expect(item.review.reasons.map((r: { provider: string }) => r.provider).sort()).toEqual(["生成役1", "生成役2"]);
    expect(rv.reviewAnalysts).toBe(2);

    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("比べた事例：");
    expect(md).toContain("社内事例：予約（社内");
  });
});
