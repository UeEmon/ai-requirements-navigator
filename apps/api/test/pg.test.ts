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
    } finally {
      await store.pool.end();
    }
  });
});
