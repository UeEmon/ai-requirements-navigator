import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/migrate.js";
import { PgStore } from "../src/pg-store.js";

const migrations = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

/** DATABASE_URL があるとき（CI の postgres サービスなど）だけ実行する */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!url)("PgStore (PostgreSQL)", () => {
  it("マイグレーションと基本操作", async () => {
    const store = PgStore.fromUrl(url!);
    try {
      await migrate(store.pool, migrations, () => {});
      // 2回目は何も適用しない
      expect(await migrate(store.pool, migrations, () => {})).toEqual([]);

      const org = await store.createOrg("pg組織");
      const cred = await store.addCredential({
        orgId: org.id,
        vendor: "ollama",
        model: "llama",
        label: "ローカル",
        endpoint: null,
        encryptedKey: null,
        keyLast4: null,
        isLocal: true,
        monthlyTokenLimit: null,
      });
      const project = await store.createProject({
        orgId: org.id,
        name: "p",
        purpose: "",
        confidential: true,
        aiConfig: { mode: "single", generatorIds: [cred.id], evaluatorId: null },
      });
      const round = await store.saveRound({
        projectId: project.id,
        phaseKey: "purpose",
        answer: "a",
        candidates: [{ label: "A", providerId: cred.id, content: { items: [{ title: "t", description: "", type: "BR", priority: "must" }], questions: [], notes: "" } }],
        evaluation: null,
        failures: [],
        warnings: [],
        status: "awaiting_decision",
      });
      const added = await store.addRequirements(project.id, [
        { title: "t1", description: "", type: "BR", priority: "must", roundId: round.id, source: "案A" },
        { title: "t2", description: "", type: "BR", priority: "should", roundId: round.id, source: "案A" },
      ]);
      expect(added.map((r) => r.code)).toEqual(["BR-01", "BR-02"]);
      await store.addUsage({ orgId: org.id, providerId: cred.id, projectId: project.id, inputTokens: 5, outputTokens: 3 });
      expect(await store.usageSummary(org.id)).toEqual([{ providerId: cred.id, inputTokens: 5, outputTokens: 3, calls: 1 }]);
      expect((await store.getProject(project.id))!.aiConfig.generatorIds).toEqual([cred.id]);

      // 上限と変更（003_limits）
      expect((await store.setOrgLimit(org.id, 1000))!.monthlyTokenLimit).toBe(1000);
      const upd = await store.updateCredential(org.id, cred.id, { model: "llama2", monthlyTokenLimit: 500, endpoint: null });
      expect(upd).toMatchObject({ model: "llama2", monthlyTokenLimit: 500, label: "ローカル", endpoint: null });
      expect(upd!.updatedAt).not.toBeNull();
      expect(await store.updateCredential("00000000-0000-0000-0000-000000000000", cred.id, { model: "x" })).toBeNull();
      expect(await store.usageSummary(org.id, new Date(Date.now() + 60_000))).toEqual([]);

      // 要件の版管理と論理削除（004）
      const r0 = added[0]!;
      const up = await store.updateRequirement(r0.id, { title: "t1改", priority: "could" }, "u1", "見直し");
      expect(up).toMatchObject({ title: "t1改", priority: "could", description: "", version: 2 });
      expect((await store.listRequirementVersions(r0.id))[0]).toMatchObject({ version: 1, title: "t1", changedBy: "u1", changeReason: "見直し" });
      expect(await store.deleteRequirement(r0.id)).toBe(true);
      expect(await store.deleteRequirement(r0.id)).toBe(false);
      expect((await store.listRequirements(project.id)).map((r) => r.code)).toEqual(["BR-02"]);
      expect(await store.updateRequirement(r0.id, { title: "x" }, "u1", "")).toBeNull();
      const again = await store.addRequirements(project.id, [{ title: "t3", description: "", type: "BR", priority: "must", roundId: null, source: "手動", phaseKey: "purpose" }]);
      expect(again[0]).toMatchObject({ code: "BR-03", phaseKey: "purpose" });

      // 質問ガイド: フェーズごとの最新
      const guide = (phaseKey: string, q: string) => ({
        phaseKey, question: q, hint: "", options: [], glossary: [], covered: [], missing: [], coverage: 0, source: "ai" as const, providerId: null, requirementCount: 0,
      });
      await store.saveGuide(project.id, guide("purpose", "古い"));
      await new Promise((r) => setTimeout(r, 5));
      await store.saveGuide(project.id, guide("purpose", "新しい"));
      await store.saveGuide(project.id, guide("actors", "利用者"));
      const gs = await store.latestGuides(project.id);
      expect(gs.map((g) => `${g.phaseKey}:${g.question}`).sort()).toEqual(["actors:利用者", "purpose:新しい"]);

      // 監査ログ: 新しい順・続き・絞り込み・削除
      for (const a of ["ai.round", "provider.update", "ai.uml"]) await store.addAudit({ orgId: org.id, actor: "u1", action: a, targetType: "", targetId: "", detail: { a } });
      const p1 = await store.listAudit(org.id, { limit: 2 });
      expect(p1.map((e) => e.action)).toEqual(["ai.uml", "provider.update"]);
      expect((await store.listAudit(org.id, { limit: 10, before: p1[1]!.id })).map((e) => e.action)).toEqual(["ai.round"]);
      expect((await store.listAudit(org.id, { limit: 10, action: "ai." })).map((e) => e.action)).toEqual(["ai.uml", "ai.round"]);
      expect(await store.purgeAudit(new Date(Date.now() + 60_000))).toBe(3);

      // ジョブ: 取り出しは1件ずつ、同時に取っても重複しない
      const j1 = await store.createJob({ orgId: org.id, projectId: project.id, kind: "round", input: { answer: "a" }, createdBy: "u1" });
      await store.createJob({ orgId: org.id, projectId: project.id, kind: "uml", input: {}, createdBy: "u1" });
      const [c1, c2, c3] = await Promise.all([store.claimJob(), store.claimJob(), store.claimJob()]);
      const claimed = [c1, c2, c3].filter(Boolean).map((j) => j!.id);
      expect(new Set(claimed).size).toBe(2);
      expect(claimed).toContain(j1.id);
      await store.updateJobProgress(j1.id, { steps: [{ key: "k", label: "l", status: "done" }] });
      await store.finishJob(j1.id, { status: "done", result: { ok: 1 } });
      expect(await store.getJob(j1.id)).toMatchObject({ status: "done", result: { ok: 1 }, progress: { steps: [{ status: "done" }] } });
      expect(await store.failStaleJobs(new Date(Date.now() + 60_000))).toBe(1); // 残り1件（実行中）を失敗に

      // UMLの比較
      const ur = await store.saveUmlRound({ projectId: project.id, candidates: [], evaluation: null, failures: [], warnings: ["w"] });
      expect(ur.status).toBe("awaiting_decision");
      await store.markUmlRoundDecided(ur.id);
      expect((await store.getUmlRound(ur.id))!.status).toBe("decided");

      // 実装工程への連携: 連携先・タスク分解・登録結果
      const integ = await store.addIntegration({
        orgId: org.id,
        kind: "github",
        label: "GH",
        config: { owner: "acme", repo: "app" },
        encryptedSecret: "enc",
        secretLast4: "1234",
      });
      const updI = await store.updateIntegration(org.id, integ.id, { config: { owner: "acme", repo: "web" }, label: "GH2" });
      expect(updI).toMatchObject({ label: "GH2", config: { owner: "acme", repo: "web" }, encryptedSecret: "enc" });
      expect(updI!.updatedAt).not.toBeNull();
      expect(await store.updateIntegration("00000000-0000-0000-0000-000000000000", integ.id, { label: "x" })).toBeNull();
      const plan = {
        epics: [{ key: "E1", title: "e", description: "", requirementCodes: ["FR-01"], stories: [] }],
        uncovered: [],
        unknownCodes: [],
      };
      const tp = await store.saveTaskPlan({ projectId: project.id, plan, providerId: cred.id, basis: [{ code: "FR-01", version: 1 }], createdBy: "u1" });
      expect((await store.latestTaskPlan(project.id))!.id).toBe(tp.id);
      expect((await store.getTaskPlan(tp.id))!.basis).toEqual([{ code: "FR-01", version: 1 }]);
      const ex1 = await store.saveTaskExport({
        projectId: project.id,
        planId: tp.id,
        integrationId: integ.id,
        kind: "github",
        target: "acme/web",
        items: [{ key: "E1", type: "epic", title: "e", status: "created", url: "https://github.com/acme/web/issues/1", externalKey: "#1" }],
        createdBy: "u1",
      });
      const exports = await store.listTaskExports(tp.id);
      expect(exports.map((e) => e.id)).toEqual([ex1.id]);
      expect(exports[0]!.items[0]).toMatchObject({ key: "E1", externalKey: "#1" });
      expect(await store.listIntegrations(org.id)).toHaveLength(1);
      expect(await store.deleteIntegration(org.id, integ.id)).toBe(true);
      expect(await store.listIntegrations(org.id)).toHaveLength(0);
      // 連携先を削除しても登録の履歴は残る
      expect(await store.listTaskExports(tp.id)).toHaveLength(1);
    } finally {
      await store.pool.end();
    }
  });
});
