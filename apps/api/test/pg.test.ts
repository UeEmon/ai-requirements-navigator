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

      // 画面・意見・確定版・変更要求
      const sr = await store.saveScreens({ projectId: project.id, model: { screens: [], uncovered: [], dropped: 0 }, providerId: cred.id, basis: [], revision: 1, createdBy: "u1" });
      await store.saveScreens({ projectId: project.id, model: { screens: [], uncovered: ["FR-01"], dropped: 0 }, providerId: cred.id, basis: [], revision: 2, createdBy: "u1" });
      expect((await store.latestScreens(project.id))!.revision).toBe(2);
      expect(sr.revision).toBe(1);
      const fb1 = await store.addScreenFeedback({ projectId: project.id, screenKey: "S01", text: "色", level: "detail", detailHits: ["色"], requirementHits: [], status: "noted", revision: 1, createdBy: "u1" });
      const fb2 = await store.addScreenFeedback({ projectId: project.id, screenKey: null, text: "項目", level: "requirement", detailHits: [], requirementHits: ["入力する情報"], status: "open", revision: 1, createdBy: "u1" });
      await store.setScreenFeedbackStatus([fb2.id], "applied");
      expect((await store.listScreenFeedback(project.id)).map((f) => [f.id, f.status])).toEqual([
        [fb1.id, "noted"],
        [fb2.id, "applied"],
      ]);
      const bl1 = await store.addBaseline({ projectId: project.id, snapshot: [{ code: "FR-01", type: "FR", title: "t", description: "", priority: "must", version: 1 }], reason: "初版", createdBy: "u1" });
      const bl2 = await store.addBaseline({ projectId: project.id, snapshot: [], reason: "CR-001", createdBy: "u1" });
      expect([bl1.version, bl2.version]).toEqual([1, 2]);
      expect((await store.latestBaseline(project.id))!.version).toBe(2);
      expect((await store.listBaselines(project.id)).map((b) => b.version)).toEqual([2, 1]);
      const cr1 = await store.addChangeRequest({ projectId: project.id, kind: "add", requirementId: null, requirementCode: null, proposal: { title: "t", description: "", priority: "should", type: "FR" }, reason: "r", source: "manual", createdBy: "u1" });
      const cr2 = await store.addChangeRequest({ projectId: project.id, kind: "delete", requirementId: null, requirementCode: "FR-01", proposal: null, reason: "", source: "hearing", createdBy: "u1" });
      expect([cr1.code, cr2.code, cr1.status]).toEqual(["CR-001", "CR-002", "open"]);
      const crU = await store.updateChangeRequest(cr1.id, { status: "approved", decision: { option: "apply", reason: "", by: "u1", at: new Date().toISOString(), baselineVersion: 2 } });
      expect(crU).toMatchObject({ status: "approved", decision: { option: "apply", baselineVersion: 2 }, proposal: { title: "t" } });
      expect(crU!.updatedAt).not.toBeNull();
      expect((await store.listChangeRequests(project.id)).map((x) => x.code)).toEqual(["CR-002", "CR-001"]);
      expect((await store.getChangeRequest(cr2.id))!.source).toBe("hearing");

      // 資料・分析・EARS
      const doc = await store.addDocument({ projectId: project.id, name: "議事録", kind: "minutes", format: "text", text: "本文", chars: 2, truncated: false, createdBy: "u1" });
      expect((await store.listDocuments(project.id)).map((d) => d.name)).toEqual(["議事録"]);
      expect((await store.getDocument(doc.id))!.text).toBe("本文");
      const an = await store.saveAnalysis({ projectId: project.id, documentIds: [doc.id], focus: "", candidates: [], evaluation: null, failures: [], warnings: ["w"], notes: [], createdBy: "u1" });
      expect(an.status).toBe("awaiting_decision");
      const anA = await store.adoptAnalysis(an.id, { label: "A", proposalIds: ["P1"], requirementCodes: ["FR-09"], changeCodes: [], reason: "", by: "u1", at: new Date().toISOString() });
      expect(anA).toMatchObject({ status: "adopted", adoption: { label: "A", requirementCodes: ["FR-09"] }, warnings: ["w"] });
      expect((await store.listAnalyses(project.id))[0]!.id).toBe(an.id);
      expect(await store.deleteDocument(doc.id)).toBe(true);
      const ears = { pattern: "event" as const, trigger: "予約した", state: "", feature: "", system: "予約システム", response: "通知しなければならない" };
      const [er] = await store.addRequirements(project.id, [{ title: "予約したとき、予約システムは、通知しなければならない。", description: "", type: "FR", priority: "must", ears, roundId: null, source: "t" }]);
      expect(er!.ears).toEqual(ears);
      expect((await store.updateRequirement(er!.id, { priority: "should" }, "u1", ""))!.ears).toEqual(ears);
      expect((await store.updateRequirement(er!.id, { title: "手で変えた", ears: null }, "u1", ""))!.ears).toBeNull();

      // 非機能要件シート（なければ null、保存は上書き）
      expect(await store.getNfrSheet(project.id)).toBeNull();
      await store.saveNfrSheet({ projectId: project.id, profile: { impact: 1 }, decisions: {}, suggestions: null });
      const ns = await store.saveNfrSheet({
        projectId: project.id,
        profile: { impact: 2 },
        decisions: { "av.rate": { status: "decided", level: "L3", value: "", rationale: "r", owner: "" } },
        suggestions: { items: [], at: "2026-10-02T00:00:00Z", failures: [] },
      });
      expect(ns.updatedAt).not.toBeNull();
      expect(await store.getNfrSheet(project.id)).toMatchObject({ profile: { impact: 2 }, decisions: { "av.rate": { level: "L3" } }, suggestions: { items: [] } });

      // 外部連携: プロジェクトの一覧・トークン・実装状況・テスト結果・質問・Webhook
      expect((await store.listProjects(org.id)).map((x) => x.id)).toContain(project.id);
      const tk = await store.createApiToken({ orgId: org.id, name: "ci", tokenHash: `h-${project.id}`, last4: "abcd", scopes: ["read", "report"], projectIds: [project.id], expiresAt: "2099-01-01T00:00:00.000Z", createdBy: "u1" });
      expect(await store.findApiToken(`h-${project.id}`)).toMatchObject({ id: tk.id, scopes: ["read", "report"], projectIds: [project.id], revokedAt: null });
      await store.touchApiToken(tk.id);
      expect((await store.findApiToken(`h-${project.id}`))!.lastUsedAt).not.toBeNull();
      expect(await store.revokeApiToken(org.id, tk.id)).toBe(true);
      expect(await store.revokeApiToken(org.id, tk.id)).toBe(false);
      expect((await store.listApiTokens(org.id))[0]!.revokedAt).not.toBeNull();

      await store.addImplReports(project.id, [{ requirementCode: "FR-01", status: "implemented", requirementVersion: 2, refs: [{ label: "PR", url: "https://x/1" }], note: "", reportedBy: "token:ci", at: "2026-10-03T00:00:00.000Z" }]);
      expect(await store.listImplReports(project.id)).toMatchObject([{ requirementCode: "FR-01", status: "implemented", requirementVersion: 2, refs: [{ label: "PR" }] }]);
      await store.addTestRun({ projectId: project.id, tool: "vitest", revision: "r1", url: "", format: "junit", tests: [{ testId: "TC-FR-01-1", status: "passed" }], requirements: [], unmatched: ["x"], summary: { passed: 1, failed: 0, skipped: 0, unmatched: 1 }, createdBy: "token:ci" });
      await store.addTestRun({ projectId: project.id, tool: "jest", revision: "r2", url: "", format: "json", tests: [], requirements: [{ requirementCode: "FR-01", status: "failed", name: "n" }], unmatched: [], summary: { passed: 0, failed: 1, skipped: 0, unmatched: 0 }, createdBy: "token:ci" });
      const runs = await store.listTestRuns(project.id);
      expect(runs.map((r) => r.tool)).toEqual(["jest", "vitest"]);
      expect(runs[1]!.tests).toEqual([{ testId: "TC-FR-01-1", status: "passed" }]);

      const q1 = await store.addQuestion({ projectId: project.id, requirementCode: "FR-01", text: "q1", context: "", askedBy: "token:ci" });
      const q2 = await store.addQuestion({ projectId: project.id, requirementCode: null, text: "q2", context: "c", askedBy: "token:ci" });
      expect([q1.code, q2.code]).toEqual(["Q-001", "Q-002"]);
      expect((await store.answerQuestion(q1.id, { status: "answered", answer: "a", answeredBy: "u1" }))!).toMatchObject({ status: "answered", answer: "a" });
      expect((await store.listQuestions(project.id)).map((q) => q.code)).toEqual(["Q-002", "Q-001"]);

      const wh = await store.addWebhook({ orgId: org.id, url: "https://hooks.example.com/x", events: ["baseline.created"], encryptedSecret: "enc", createdBy: "u1" });
      await store.recordWebhookDelivery(wh.id, "HTTP 200");
      expect((await store.listWebhooks(org.id))[0]).toMatchObject({ events: ["baseline.created"], lastStatus: "HTTP 200" });
      expect(await store.deleteWebhook(org.id, wh.id)).toBe(true);
    } finally {
      await store.pool.end();
    }
  });
});
