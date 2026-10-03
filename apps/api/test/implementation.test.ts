import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

const GH_TOKEN = "ghp_secretTOKEN1234";
const JIRA_TOKEN = "jira-secret-9876";
const BL_KEY = "backlogKEY5555";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** GitHub / Jira / Backlog の模擬API */
function fakeTools() {
  const calls: Call[] = [];
  const opts = { failTitlesOnce: new Set<string>(), rejectLabels: false, rejectJiraParent: false, rejectBacklogParent: false };
  let n = 0;
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = typeof init.body === "string" ? init.body : "";
    const body = headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(raw))
      : raw
        ? JSON.parse(raw)
        : null;
    const method = init.method ?? "GET";
    calls.push({ method, url, headers, body });
    const u = new URL(url);

    if (u.host === "api.github.com") {
      if (headers.authorization !== `Bearer ${GH_TOKEN}`) return res(401, { message: "Bad credentials" });
      if (method === "GET" && u.pathname === "/repos/acme/app") return res(200, { full_name: "acme/app", name: "app", owner: { login: "acme" }, has_issues: true, permissions: { push: true, triage: true } });
      if (method === "GET" && u.pathname === "/user") return res(200, { login: "dev-taro" });
      if (method === "GET" && u.pathname === "/user/repos") return res(200, [{ name: "app", full_name: "acme/app", owner: { login: "acme" }, private: true, has_issues: true, permissions: { push: true } }, { name: "old", full_name: "acme/old", owner: { login: "acme" }, archived: true }, { name: "docs", full_name: "acme/docs", owner: { login: "acme" }, private: false, has_issues: false, permissions: { push: false } }]);
      if (method === "GET" && u.pathname === "/repos/acme/app/labels") return res(200, [{ name: "bug" }, { name: "epic" }]);
      if (method === "POST" && u.pathname === "/repos/acme/app/labels") return res(201, { name: body.name });
      if (method === "POST" && u.pathname === "/repos/acme/app/issues") {
        if (opts.rejectLabels && body.labels) return res(422, { message: "Validation Failed", errors: [{ code: "invalid", field: "labels" }] });
        if (opts.failTitlesOnce.delete(body.title)) return res(500, { message: "Server Error" });
        n++;
        return res(201, { number: n, html_url: `https://github.com/acme/app/issues/${n}` });
      }
      if (method === "PATCH" && /^\/repos\/acme\/app\/issues\/\d+$/.test(u.pathname)) return res(200, {});
      return res(404, { message: "Not Found" });
    }
    if (u.host === "acme.atlassian.net") {
      const expected = `Basic ${Buffer.from(`dev@example.com:${JIRA_TOKEN}`).toString("base64")}`;
      if (headers.authorization !== expected) return res(401, { errorMessages: ["認証が必要です"] });
      if (method === "GET" && u.pathname === "/rest/api/2/project/APP")
        return res(200, { key: "APP", name: "予約アプリ", issueTypes: [{ name: "タスク", subtask: false, hierarchyLevel: 0 }, { name: "バグ", subtask: false, hierarchyLevel: 0 }, { name: "ストーリー", subtask: false, hierarchyLevel: 0 }, { name: "エピック", subtask: false, hierarchyLevel: 1 }, { name: "サブタスク", subtask: true, hierarchyLevel: -1 }] });
      if (method === "GET" && u.pathname === "/rest/api/2/myself") return res(200, { displayName: "開発 太郎" });
      if (method === "GET" && u.pathname === "/rest/api/2/project/search") return res(200, { values: [{ key: "APP", name: "予約アプリ" }, { key: "OPS", name: "運用" }], isLast: true });
      if (method === "POST" && u.pathname === "/rest/api/2/issue") {
        if (opts.rejectJiraParent && body.fields.parent) return res(400, { errors: { parent: "親を設定できません" } });
        n++;
        return res(201, { id: String(10000 + n), key: `APP-${n}` });
      }
      return res(404, { errorMessages: ["なし"] });
    }
    if (u.host === "acme.backlog.jp") {
      if (u.searchParams.get("apiKey") !== BL_KEY) return res(401, { errors: [{ message: "Authentication failure." }] });
      if (u.pathname === "/api/v2/projects/APP") return res(200, { id: 77, projectKey: "APP", name: "予約アプリ", useParentChildIssue: false });
      if (u.pathname === "/api/v2/users/myself") return res(200, { name: "開発 花子" });
      if (u.pathname === "/api/v2/projects") return res(200, [{ projectKey: "APP", name: "予約アプリ" }]);
      if (u.pathname === "/api/v2/projects/APP/issueTypes") return res(200, [{ id: 1, name: "バグ" }, { id: 2, name: "タスク" }]);
      if (u.pathname === "/api/v2/projects/77/issueTypes") return res(200, [{ id: 1, name: "バグ" }, { id: 2, name: "タスク" }]);
      if (method === "POST" && u.pathname === "/api/v2/issues") {
        if (opts.rejectBacklogParent && body.parentIssueId) return res(400, { errors: [{ message: "親子課題が無効です" }] });
        n++;
        return res(201, { id: 500 + n, issueKey: `APP-${n}` });
      }
      return res(404, { errors: [{ message: "No project." }] });
    }
    // AIの呼び出しなど（このテストでは使わない）
    return res(503, { message: "down" });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, opts };
}

function setup() {
  const store = new MemoryStore();
  const tools = fakeTools();
  const app = createApp({
    store,
    encryptor: new LocalKeyEncryptor(randomBytes(32).toString("base64")),
    storage: new MemoryStorage(),
    authenticate: devAuthenticator,
    allowMock: true,
    devAuth: true,
    random: () => 0.5,
    fetchImpl: tools.fetchImpl,
    jobs: { pollMs: 10 },
  });
  return { app, store, tools };
}

describe("実装工程への連携", () => {
  let t: ReturnType<typeof setup>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, org = orgId, user = "u1") => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role, "x-user-id": user },
  });
  const req = (path: string, init: RequestInit = {}) => t.app.request(path, init);

  /** 機能要件3件・非機能要件3件を確定したプロジェクト */
  async function project() {
    const ids: string[] = [];
    for (const label of ["生成役1", "生成役2", "評価役"]) {
      ids.push((await (await req(`/api/orgs/${orgId}/providers`, as("admin", json({ vendor: "mock", model: "mock", label })))).json()).id);
    }
    const aiConfig = { mode: "multi", generatorIds: [ids[0], ids[1]], evaluatorId: ids[2] };
    const p = await (await req(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "予約", aiConfig })))).json();
    return p as { id: string };
  }
  async function decide(projectId: string, phaseKey: string, answer: string) {
    const round = await (await req(`/api/projects/${projectId}/rounds`, as("editor", json({ answer, phaseKey })))).json();
    const d = await req(`/api/rounds/${round.id}/decision`, as("editor", json({ pick: "merged", advancePhase: false })));
    expect(d.status).toBe(201);
  }
  async function readyProject() {
    const p = await project();
    await decide(p.id, "purpose", "電話予約を減らしたい");
    await decide(p.id, "functions", "ネットで予約したい");
    await decide(p.id, "quality", "すぐ表示されてほしい");
    return p;
  }
  async function integration(kind: string, config: Record<string, string>, token: string) {
    const r = await req(`/api/orgs/${orgId}/integrations`, as("admin", json({ kind, config, token })));
    expect(r.status).toBe(201);
    return r.json();
  }
  const github = () => integration("github", { owner: "acme", repo: "app" }, GH_TOKEN);

  beforeEach(async () => {
    t = setup();
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
  });

  /* ---------- 連携設定の自動化 ---------- */
  it("連携設定の自動化: トークンで候補を取得し、URL から対象を読み取り、おすすめの設定を返す", async () => {
    const disc = async (b: unknown, role = "admin") => (await req(`/api/orgs/${orgId}/integrations/discover`, as(role, json(b)))).json();
    // GitHub: トークンの持ち主・リポジトリの一覧（アーカイブ済みは除く）
    const g1 = await disc({ kind: "github", token: GH_TOKEN });
    expect(g1).toMatchObject({ ok: true, account: "dev-taro" });
    expect(g1.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/app", "acme/docs"]);
    // リポジトリの URL を貼ると、対象とラベルまで
    const g2 = await disc({ kind: "github", token: GH_TOKEN, url: "https://github.com/acme/app/issues" });
    expect(g2.config).toEqual({ apiBase: "https://api.github.com", labels: "requirements-navigator", owner: "acme", repo: "app" });
    expect(g2.labels).toEqual(["bug", "epic"]);
    expect(g2.warnings).toEqual([]);
    // 間違ったトークン
    const g3 = await disc({ kind: "github", token: "ghp_wrong" });
    expect(g3.ok).toBe(false);
    expect(g3.message).toContain("401");
    expect(JSON.stringify(g3)).not.toContain(GH_TOKEN);

    // Jira: ボードの URL から接続先とプロジェクト、種別からエピック・ストーリーを選ぶ
    const j = await disc({ kind: "jira", token: JIRA_TOKEN, url: "https://acme.atlassian.net/jira/software/projects/APP/boards/1", config: { email: "dev@example.com" } });
    expect(j).toMatchObject({ ok: true, account: "開発 太郎", config: { baseUrl: "https://acme.atlassian.net", email: "dev@example.com", projectKey: "APP", epicType: "エピック", storyType: "ストーリー" } });
    expect(j.projects).toEqual([{ key: "APP", name: "予約アプリ" }, { key: "OPS", name: "運用" }]);
    expect(j.issueTypes.find((x: { name: string }) => x.name === "サブタスク").role).toBe("subtask");

    // Backlog: プロジェクトが1つならそれを選び、種別「タスク」、親子課題が無効なら知らせる
    const b = await disc({ kind: "backlog", token: BL_KEY, url: "https://acme.backlog.jp/dashboard" });
    expect(b).toMatchObject({ ok: true, account: "開発 花子", config: { spaceUrl: "https://acme.backlog.jp", projectKey: "APP", issueType: "タスク" } });
    expect(b.warnings[0]).toContain("親子課題");
    expect(JSON.stringify(b)).not.toContain(BL_KEY);

    // http の接続先・管理者以外は使えない
    expect((await disc({ kind: "jira", token: "x", url: "http://jira.local/browse/APP-1" })).message).toContain("https://");
    expect((await req(`/api/orgs/${orgId}/integrations/discover`, as("editor", json({ kind: "github", token: GH_TOKEN })))).status).toBe(403);

    // 登録と同時に準備（ラベル作成）と接続確認
    const r = await req(`/api/orgs/${orgId}/integrations`, as("admin", json({ kind: "github", config: g2.config, token: GH_TOKEN, setup: true })));
    expect(r.status).toBe(201);
    const reg = await r.json();
    expect(reg.setup).toEqual(["ラベル「requirements-navigator」を作りました"]);
    expect(reg.check).toEqual({ ok: true, message: "acme/app に接続できました" });
    const made = t.tools.calls.filter((c) => c.method === "POST" && c.url.endsWith("/repos/acme/app/labels"));
    expect(made.map((c) => c.body.name)).toEqual(["requirements-navigator"]); // epic は既にある
    // 登録済みの連携先のトークンで、候補を取り直せる（変更のとき）
    const again = await disc({ kind: "github", integrationId: reg.id });
    expect(again.config).toMatchObject({ owner: "acme", repo: "app" });
  });

  /* ---------- 連携先の登録 ---------- */
  it("連携先: 管理者だけが登録でき、トークンは末尾4文字しか返さず、監査ログにも残さない", async () => {
    expect((await req(`/api/orgs/${orgId}/integrations`, as("editor", json({ kind: "github", config: { owner: "a", repo: "b" }, token: "x" })))).status).toBe(403);
    const bad = await req(`/api/orgs/${orgId}/integrations`, as("admin", json({ kind: "jira", config: { baseUrl: "http://jira.local", projectKey: "APP" }, token: "x" })));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("https://");
    expect((await req(`/api/orgs/${orgId}/integrations`, as("admin", json({ kind: "github", config: { owner: "a", repo: "b", extra: "x" }, token: "x" })))).status).toBe(400);

    const gh = await github();
    expect(gh).toMatchObject({ kind: "github", target: "acme/app", token: "••••1234" });
    expect(gh.config).toEqual({ owner: "acme", repo: "app", apiBase: "https://api.github.com", labels: "requirements-navigator" });

    // 閲覧者も一覧（登録先の選択用）は見られる
    const list = await (await req(`/api/orgs/${orgId}/integrations`, as("viewer"))).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(GH_TOKEN);

    // 接続確認
    expect(await (await req(`/api/orgs/${orgId}/integrations/${gh.id}/test`, as("admin", { method: "POST" }))).json()).toEqual({ ok: true, message: "acme/app に接続できました" });

    // 設定の一部とトークンの変更
    const up = await (await req(`/api/orgs/${orgId}/integrations/${gh.id}`, as("admin", json({ config: { labels: "" }, token: "ghp_wrong0000" }, "PATCH")))).json();
    expect(up.config.owner).toBe("acme");
    expect(up.config.labels).toBe("");
    expect(up.token).toBe("••••0000");
    const ng = await (await req(`/api/orgs/${orgId}/integrations/${gh.id}/test`, as("admin", { method: "POST" }))).json();
    expect(ng.ok).toBe(false);
    expect(ng.message).toContain("HTTP 401（トークンが無効か期限切れです） Bad credentials");

    // 他の組織からは見えない
    const other = (await (await req("/api/orgs", json({ name: "別組織" }))).json()).id;
    expect((await req(`/api/orgs/${orgId}/integrations`, as("admin", {}, other))).status).toBe(404);
    expect((await req(`/api/orgs/${other}/integrations/${gh.id}/test`, as("admin", { method: "POST" }, other))).status).toBe(404);

    expect((await req(`/api/orgs/${orgId}/integrations/${gh.id}`, as("admin", { method: "DELETE" }))).status).toBe(204);
    const log = await (await req(`/api/orgs/${orgId}/audit?action=integration`, as("admin"))).json();
    expect(log.entries.map((e: { action: string }) => e.action)).toEqual(["integration.delete", "integration.update", "integration.create"]);
    expect(log.entries[1].detail.tokenChanged).toBe(true);
    expect(JSON.stringify(log)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(log)).not.toContain("ghp_wrong0000");
  });

  /* ---------- タスク分解 ---------- */
  it("タスク分解: 機能・非機能要件をストーリーに分解し、ファイルで出力でき、要件の変更を検知する", async () => {
    const p0 = await project();
    expect((await req(`/api/projects/${p0.id}/tasks/generate`, as("editor", { method: "POST" }))).status).toBe(400);

    const p = await readyProject();
    expect(await (await req(`/api/projects/${p.id}/tasks`, as("viewer"))).json()).toBeNull();
    expect((await req(`/api/projects/${p.id}/tasks/generate`, as("viewer", { method: "POST" }))).status).toBe(403);

    const r = await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    expect(r.status).toBe(201);
    const plan = await r.json();
    expect(plan.stats).toMatchObject({ epics: 2, stories: 6 });
    expect(plan.plan.uncovered).toEqual([]);
    expect(plan.plan.epics[0].requirementCodes).toEqual(["FR-01", "FR-02", "FR-03"]);
    expect(plan.provider).toBe("生成役1");
    expect(plan.stale).toBe(false);

    const md = await (await req(`/api/projects/${p.id}/tasks/file/md`, as("viewer"))).text();
    expect(md).toContain("# 予約 実装タスク");
    expect(md).toContain("| NFR-01");
    const jira = await req(`/api/projects/${p.id}/tasks/file/jira.csv`, as("viewer"));
    expect(jira.headers.get("content-type")).toContain("text/csv");
    expect(jira.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    const jiraText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await jira.arrayBuffer());
    expect(jiraText.startsWith('﻿"Issue Id"')).toBe(true);
    expect(await (await req(`/api/projects/${p.id}/tasks/file/backlog.csv`, as("viewer"))).text()).toContain("カテゴリー名");
    expect((await (await req(`/api/projects/${p.id}/tasks/file/json`, as("viewer"))).json()).epics).toHaveLength(2);
    expect((await req(`/api/projects/${p.id}/tasks/file/exe`, as("viewer"))).status).toBe(400);

    // 要件を手直しすると、分解結果が古いことが分かる
    const reqs = await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json();
    const fr1 = reqs.find((x: { code: string }) => x.code === "FR-01");
    await req(`/api/requirements/${fr1.id}`, as("editor", json({ title: "変えた" }, "PATCH")));
    const after = await (await req(`/api/projects/${p.id}/tasks`, as("viewer"))).json();
    expect(after.stale).toBe(true);
    expect(after.changed).toEqual(["FR-01"]);

    const log = await (await req(`/api/orgs/${orgId}/audit?action=ai.tasks`, as("admin"))).json();
    expect(log.entries[0].detail.sent).toEqual({ requirements: 9, design: false });
  });

  it("タスク分解は非同期でも実行でき、進み具合を返す", async () => {
    const p = await readyProject();
    const r = await req(`/api/projects/${p.id}/tasks/generate?async=1`, as("editor", { method: "POST" }));
    expect(r.status).toBe(202);
    const { jobId } = await r.json();
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.kind).toBe("tasks");
    expect(job.progress.steps[0]).toMatchObject({ status: "done" });
    expect(job.result.stats.stories).toBe(6);
  });

  /* ---------- 課題の登録とトレーサビリティ ---------- */
  it("GitHub: エピックとストーリーを Issue に登録し、再実行では登録済みを飛ばして失敗分だけ登録する", async () => {
    const p = await readyProject();
    const plan = await (await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }))).json();
    const gh = await github();
    const failing = plan.plan.epics[0].stories[1].title;
    t.tools.opts.failTitlesOnce.add(failing);

    // 登録前のトレーサビリティ
    const tr0 = await (await req(`/api/projects/${p.id}/trace`, as("viewer"))).json();
    expect(tr0.summary).toEqual({ targets: 6, covered: 6, registered: 0 });
    expect(tr0.rows.find((r: { code: string }) => r.code === "BR-01").status).toBe("context");

    const r1 = await req(`/api/projects/${p.id}/tasks/register?async=1`, as("editor", json({ integrationId: gh.id })));
    expect(r1.status).toBe(202);
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${(await r1.json()).jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.result.summary).toEqual({ created: 7, skipped: 0, failed: 1 });
    expect(job.result.items.find((x: { key: string }) => x.key === "E1-S2")).toMatchObject({ status: "failed", error: "HTTP 500 Server Error" });
    const epic = job.result.items[0];
    expect(epic).toMatchObject({ key: "E1", type: "epic", status: "created", externalKey: "#1", url: "https://github.com/acme/app/issues/1" });

    const posts = t.tools.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
    expect(posts[0]!.body).toMatchObject({ title: `[エピック] ${plan.plan.epics[0].title}`, labels: ["requirements-navigator", "epic"] });
    const story = posts.find((c) => c.body.title === plan.plan.epics[0].stories[0].title)!;
    expect(story.body.body).toContain("エピック: #1");
    expect(story.body.body).toContain("- [ ] [テスト] テストを書く");
    expect(story.body.body).toContain("- FR-01");
    // エピックの本文にストーリーの一覧を追記する
    const patch = t.tools.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/issues/1"))!;
    expect(patch.body.body).toContain("- [ ] #2 E1-S1");
    // トークンはヘッダーにだけ使い、結果には出さない
    expect(JSON.stringify(job)).not.toContain(GH_TOKEN);

    // 再実行: 失敗した1件だけ登録する
    const before = t.tools.calls.length;
    const r2 = await (await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: gh.id })))).json();
    expect(r2.summary).toEqual({ created: 1, skipped: 7, failed: 0 });
    const newPosts = t.tools.calls.slice(before).filter((c) => c.method === "POST");
    expect(newPosts.map((c) => c.body.title)).toEqual([failing]);

    const tr = await (await req(`/api/projects/${p.id}/trace`, as("viewer"))).json();
    expect(tr.summary).toEqual({ targets: 6, covered: 6, registered: 6 });
    const fr2 = tr.rows.find((r: { code: string }) => r.code === "FR-02");
    expect(fr2.status).toBe("registered");
    expect(fr2.stories[0].links[0]).toMatchObject({ integration: "github acme/app", kind: "github", url: expect.stringMatching(/^https:\/\/github.com\/acme\/app\/issues\/\d+$/) });

    // 選んだストーリーだけ・存在しないストーリー
    expect((await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: gh.id, storyKeys: ["E9-S9"] })))).status).toBe(400);
    expect((await req(`/api/projects/${p.id}/tasks/register`, as("viewer", json({ integrationId: gh.id })))).status).toBe(403);
    const hist = await (await req(`/api/projects/${p.id}/tasks/exports`, as("viewer"))).json();
    expect(hist).toHaveLength(2);

    const log = await (await req(`/api/orgs/${orgId}/audit?action=tasks.export`, as("admin"))).json();
    expect(log.entries[1].detail).toMatchObject({ created: 7, failed: 1, integration: { kind: "github", target: "acme/app" } });
  });

  it("GitHub: ラベルが使えないときはラベルなしで登録し、その旨を残す", async () => {
    const p = await readyProject();
    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    const gh = await github();
    t.tools.opts.rejectLabels = true;
    const r = await (await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: gh.id, storyKeys: ["E1-S1"] })))).json();
    expect(r.summary).toEqual({ created: 2, skipped: 0, failed: 0 });
    expect(r.items[0].note).toContain("ラベルなしで登録しました");
  });

  it("GitHub: トークンが無効なら最初のエピックで打ち切る", async () => {
    const p = await readyProject();
    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    const gh = await integration("github", { owner: "acme", repo: "app" }, "ghp_expired");
    const r = await (await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: gh.id })))).json();
    expect(r.summary.created).toBe(0);
    expect(r.items[0].error).toContain("HTTP 401");
    expect(r.items[1].error).toBe("エピックの登録に失敗したため中止しました");
    expect(t.tools.calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("Jira: エピックの子としてストーリーを登録し、親を設定できない場合は親なしで登録する", async () => {
    const p = await readyProject();
    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    const jr = await integration("jira", { baseUrl: "https://acme.atlassian.net/", email: "dev@example.com", projectKey: "APP" }, JIRA_TOKEN);
    expect(jr.config.baseUrl).toBe("https://acme.atlassian.net");
    expect((await (await req(`/api/orgs/${orgId}/integrations/${jr.id}/test`, as("admin", { method: "POST" }))).json()).message).toContain("予約アプリ");

    const r = await (await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: jr.id, storyKeys: ["E1-S1", "E2-S1"] })))).json();
    expect(r.summary).toEqual({ created: 4, skipped: 0, failed: 0 });
    expect(r.items.map((x: { externalKey: string }) => x.externalKey)).toEqual(["APP-1", "APP-2", "APP-3", "APP-4"]);
    expect(r.items[1].url).toBe("https://acme.atlassian.net/browse/APP-2");
    const posts = t.tools.calls.filter((c) => c.method === "POST");
    expect(posts[0]!.body.fields).toMatchObject({ project: { key: "APP" }, issuetype: { name: "Epic" } });
    expect(posts[1]!.body.fields).toMatchObject({ issuetype: { name: "Story" }, parent: { key: "APP-1" } });
    expect(posts[1]!.body.fields.description).toContain("h3. 受け入れ条件");

    t.tools.opts.rejectJiraParent = true;
    const r2 = await (await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: jr.id, storyKeys: ["E1-S2"] })))).json();
    expect(r2.items.map((x: { status: string }) => x.status)).toEqual(["skipped", "created"]);
    expect(r2.items[1].note).toContain("親なしで登録しました");
  });

  it("Backlog: プロジェクトと種別を調べて親子課題で登録し、必須の要件のストーリーは優先度を高にする", async () => {
    const p = await readyProject();
    await req(`/api/projects/${p.id}/tasks/generate`, as("editor", { method: "POST" }));
    const bl = await integration("backlog", { spaceUrl: "https://acme.backlog.jp", projectKey: "APP" }, BL_KEY);
    const r = await (await req(`/api/projects/${p.id}/tasks/register`, as("editor", json({ integrationId: bl.id, storyKeys: ["E1-S1"] })))).json();
    expect(r.summary).toEqual({ created: 2, skipped: 0, failed: 0 });
    expect(r.items[1].url).toBe("https://acme.backlog.jp/view/APP-2");
    const posts = t.tools.calls.filter((c) => c.method === "POST");
    expect(posts[0]!.body).toMatchObject({ projectId: "77", issueTypeId: "2", priorityId: "3" });
    expect(posts[1]!.body).toMatchObject({ parentIssueId: String(501) });
    // 模擬AIの統合案は1件目が must（FR-01 → E1-S1）
    expect(posts[1]!.body.priorityId).toBe("2");
    // APIキーはクエリにだけ使い、結果・履歴には出さない
    expect(JSON.stringify(r)).not.toContain(BL_KEY);
    expect(JSON.stringify(await (await req(`/api/projects/${p.id}/tasks/exports`, as("viewer"))).json())).not.toContain(BL_KEY);
  });
});
