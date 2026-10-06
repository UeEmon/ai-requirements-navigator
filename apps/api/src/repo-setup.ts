/**
 * プロジェクトを登録するリポジトリの自動作成（GitHub）。
 *
 * 1. GitHub にリポジトリを作る（本人または組織の下。非公開が既定、Issues を有効）
 * 2. 要件ナビのプロジェクトの開発用パッケージ（AGENTS.md・要件・設計・テストシナリオ・MCP の接続設定）を最初のコミットとして入れる
 * 3. そのリポジトリを課題管理ツールの連携先として登録し、ラベルの作成と接続確認を行う
 *
 * トークンは連携先として暗号化して保存する（表示は末尾4桁）。作ったリポジトリは、失敗しても消さない。
 */
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./audit.js";
import type { AnyContext, ImplementationContext } from "./implementation.js";
import { checkIntegration, createGithubRepo, IntegrationError, integrationTarget, parseIntegrationConfig, prepareIntegration, suggestRepoName } from "./integrations.js";
import type { Project } from "./store.js";
import { publicIntegration } from "./implementation.js";

const CreateRepoInput = z
  .object({
    /** 新しいトークン。省略時は integrationId の連携先のトークン */
    token: z.string().min(1).max(500).optional(),
    integrationId: z.string().min(1).optional(),
    apiBase: z.string().url().optional(),
    owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "所有者名に使えない文字があります"),
    name: z.string().min(1).max(100),
    private: z.boolean().default(true),
    description: z.string().max(300).optional(),
    /** このプロジェクトの要件・設計・テストを最初のコミットとして入れる */
    projectId: z.string().min(1).optional(),
    /** 連携先の表示名・付けるラベル */
    label: z.string().min(1).max(100).optional(),
    labels: z.string().max(200).optional(),
  })
  .refine((v) => v.token || v.integrationId, "トークンを入れてください");

export interface RepoSetupOptions {
  /** 開発用パッケージのファイル（connect.ts） */
  filesOf: (c: AnyContext, p: Project) => Promise<Array<{ path: string; content: string }>>;
  pollMs?: number;
}

export function repoSetup(ctx: ImplementationContext, opts: RepoSetupOptions) {
  const { store } = ctx;

  function routes(app: Hono<any>) {
    /** リポジトリ名の候補（プロジェクト名から） */
    app.get("/api/projects/:id/repo-name", async (c) => {
      const p = await ctx.loadProject(c, c.req.param("id"), "project.view");
      return c.json({ name: suggestRepoName(p.name), description: `${p.name}（要件ナビで要件定義）`.slice(0, 300) });
    });

    app.post("/api/orgs/:orgId/integrations/github/repos", async (c: Context) => {
      const orgId = c.req.param("orgId")!;
      ctx.need(c, orgId, "integration.manage");
      const input = await ctx.body(c, CreateRepoInput);
      let token = input.token?.trim() ?? "";
      let apiBase = input.apiBase?.replace(/\/+$/, "") ?? "";
      if (input.integrationId) {
        const cur = (await store.listIntegrations(orgId)).find((x) => x.id === input.integrationId);
        if (!cur || cur.kind !== "github") throw new HTTPException(404, { message: "GitHub の連携先が見つかりません" });
        if (!token) token = await ctx.encryptor.decrypt(cur.encryptedSecret, { orgId });
        apiBase ||= cur.config.apiBase ?? "";
      }
      apiBase ||= "https://api.github.com";
      if (!apiBase.startsWith("https://")) throw new HTTPException(400, { message: "API の URL は https:// で始めてください" });
      // 入れるプロジェクト（同じ組織のもの）
      let project: Project | null = null;
      if (input.projectId) {
        project = await ctx.loadProject(c, input.projectId, "project.view");
        if (project.orgId !== orgId) throw new HTTPException(404, { message: "プロジェクトが見つかりません" });
      }
      const files = project ? await opts.filesOf(c, project) : [];
      let repo;
      try {
        repo = await createGithubRepo({
          apiBase,
          secret: token,
          owner: input.owner,
          name: input.name.trim(),
          private: input.private,
          description: input.description ?? (project ? `${project.name}（要件ナビで要件定義）` : undefined),
          files,
          commitMessage: project ? `要件ナビ: ${project.name} の要件・設計・テストを追加` : undefined,
          fetchImpl: ctx.fetchImpl,
          pollMs: opts.pollMs,
        });
      } catch (e) {
        if (e instanceof IntegrationError) throw new HTTPException(e.status === 422 ? 409 : 400, { message: e.message });
        throw e;
      }
      await audit(store, {
        orgId,
        actor: ctx.actorOf(c),
        action: "integration.repo.create",
        targetType: "project",
        targetId: project?.id ?? "",
        detail: { repo: repo.fullName, url: repo.url, private: repo.private, seeded: repo.seeded, projectId: project?.id ?? null },
      });
      // 連携先として登録（ラベルの作成と接続確認）
      const config = parseIntegrationConfig("github", { owner: repo.owner, repo: repo.repo, apiBase, labels: input.labels ?? "requirements-navigator" });
      const i = await store.addIntegration({
        orgId,
        kind: "github",
        label: input.label ?? `GitHub ${integrationTarget("github", config)}`,
        config,
        encryptedSecret: await ctx.encryptor.encrypt(token, { orgId }),
        secretLast4: token.slice(-4),
      });
      await audit(store, {
        orgId,
        actor: ctx.actorOf(c),
        action: "integration.create",
        targetType: "integration",
        targetId: i.id,
        detail: { kind: i.kind, label: i.label, config, createdRepo: true },
      });
      const setup = await prepareIntegration("github", config, token, ctx.fetchImpl).catch((e) => [`準備に失敗しました（${(e as Error).message}）`]);
      const check = await checkIntegration("github", config, token, ctx.fetchImpl).then(
        (message) => ({ ok: true, message }),
        (e) => ({ ok: false, message: e instanceof IntegrationError ? e.message : "接続確認に失敗しました" }),
      );
      return c.json({ repo, integration: publicIntegration(i), setup: [...repo.notes, ...setup], check }, 201);
    });
  }

  return { routes };
}
