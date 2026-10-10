import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { MemoryStorage } from "../src/storage.js";
import { migrate } from "../src/migrate.js";
import { PgStore } from "../src/pg-store.js";
import { MemoryStore, type Store } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

/**
 * メモリの保存先と、TEST_DATABASE_URL があれば PostgreSQL でも同じことを確かめる。
 * pg.test.ts（監査ログの全件削除などを確かめる）と同時に動くため、別のデータベースを使う
 */
const url = process.env.TEST_DATABASE_URL;
let pg: PgStore | null = null;
let ready: Promise<PgStore> | null = null;
afterAll(async () => {
  await pg?.pool.end();
});
const pgStore = async () => {
  const u = new URL(url!);
  const name = `${u.pathname.slice(1) || "arn"}_collab`;
  const admin = PgStore.fromUrl(url!);
  try {
    await admin.pool.query(`CREATE DATABASE "${name}"`);
  } catch (e) {
    if ((e as { code?: string }).code !== "42P04") throw e; // すでにある
  } finally {
    await admin.pool.end();
  }
  u.pathname = `/${name}`;
  pg = PgStore.fromUrl(u.toString());
  await migrate(pg.pool, fileURLToPath(new URL("../../../db/migrations", import.meta.url)), () => {});
  return pg;
};
const stores: Array<[string, () => Promise<Store>]> = [["メモリ", async () => new MemoryStore()]];
if (url) stores.push(["PostgreSQL", () => (ready ??= pgStore())]);

describe.each(stores)("要件の手入力・コメント・プロジェクトのメンバー・複製と書き出し（%s）", (_name, makeStore) => {
  let app: ReturnType<typeof createApp>;
  let store: Store;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}, user = "u1", org = orgId) => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-org-id": org, "x-role": role, "x-user-id": user } });
  const req = (path: string, init: RequestInit = {}) => app.request(path, init);

  beforeEach(async () => {
    store = await makeStore();
    app = createApp({
      store,
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
  const sample = async () => (await (await req(`/api/orgs/${orgId}/samples`, as("editor", json({})))).json()).project as { id: string; name: string };
  const emptyProject = async () => {
    const provs = (await (await req(`/api/orgs/${orgId}/providers`, as("admin"))).json()) as Array<{ id: string }>;
    return (await (await req(`/api/orgs/${orgId}/projects`, as("editor", json({ name: "空", aiConfig: { mode: "single", generatorIds: [provs[0]!.id], evaluatorId: null } })))).json()) as { id: string };
  };
  const reqsOf = async (pid: string, role = "viewer", user = "u1") => (await (await req(`/api/projects/${pid}/requirements`, as(role, {}, user))).json()) as Array<{ id: string; code: string; title: string; type: string; source: string; comments: { open: number; total: number } }>;

  it("要件を手で追加できる（EARS の構造から文を組み立てる・権限・確定後は変更要求から）", async () => {
    const p = await emptyProject();
    const fr = await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "FR", ears: { pattern: "event", trigger: "予約が確定した", system: "システム", response: "確認メールを送る" }, priority: "must", reason: "打ち合わせで追加" })));
    expect(fr.status).toBe(201);
    const r = await fr.json();
    expect(r).toMatchObject({ code: "FR-01", type: "FR", priority: "must", source: "手入力", phaseKey: "functions" });
    expect(r.title).toContain("予約が確定した");
    expect(r.lint.ok).toBe(true);
    // 区分ごとの連番。目的は文で書く
    expect((await (await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "FR", title: "システムは、予約の一覧を表示しなければならない。" })))).json()).code).toBe("FR-02");
    expect((await (await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "BR", title: "電話予約を減らす" })))).json()).code).toBe("BR-01");
    // 業務ルールは具体例つき
    const rl = await (await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "RL", title: "前日までの取消は無料とする", rule: { kind: "judge", examples: [{ given: "前日に取消", expected: "無料" }, { given: "当日に取消", expected: "有料" }] } })))).json();
    expect(rl.rule.examples).toHaveLength(2);
    expect((await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "FR", title: "  " })))).status).toBe(400);
    expect((await req(`/api/projects/${p.id}/requirements`, as("viewer", json({ type: "FR", title: "x" })))).status).toBe(403);
    // 削除しても番号は再利用しない
    await req(`/api/requirements/${r.id}`, as("editor", { method: "DELETE" }));
    expect((await (await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "FR", title: "システムは、予約を取り消せなければならない。" })))).json()).code).toBe("FR-03");
    const audit = await (await req(`/api/orgs/${orgId}/audit?action=requirement.create`, as("admin"))).json();
    expect(audit.entries).toHaveLength(5);
    // 確定後は変更要求から
    await req(`/api/projects/${p.id}/baseline`, as("editor", json({ reason: "確定", force: true })));
    const locked = await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "FR", title: "x" })));
    expect(locked.status).toBe(409);
    expect((await locked.json()).error).toContain("変更要求");
  });

  it("要件ごとにコメントを書き、解決済みにできる（本文は本人だけが直せる・消せるのは本人と管理者）", async () => {
    const p = await sample();
    const target = (await reqsOf(p.id))[0]!;
    const post = (role: string, user: string, body: string) => req(`/api/requirements/${target.id}/comments`, as(role, json({ body }), user));
    expect((await post("viewer", "v1", "閲覧者は書けない")).status).toBe(403);
    const a = await (await post("reviewer", "rev1", "数値の根拠はありますか？")).json();
    expect(a).toMatchObject({ requirementCode: target.code, status: "open", mine: true, authorName: "rev1" });
    await post("editor", "ed1", "前回の打ち合わせの資料にあります");
    expect((await reqsOf(p.id)).find((r) => r.id === target.id)!.comments).toEqual({ open: 2, total: 2 });
    // 他人の本文は直せない。解決済みにはできる
    expect((await req(`/api/comments/${a.id}`, as("editor", json({ body: "書き換え" }, "PATCH"), "ed1"))).status).toBe(403);
    expect((await (await req(`/api/comments/${a.id}`, as("reviewer", json({ body: "数値の根拠（出典）はありますか？" }, "PATCH"), "rev1"))).json()).body).toContain("出典");
    const resolved = await (await req(`/api/comments/${a.id}`, as("editor", json({ resolved: true }, "PATCH"), "ed1"))).json();
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "ed1" });
    expect((await reqsOf(p.id)).find((r) => r.id === target.id)!.comments).toEqual({ open: 1, total: 2 });
    const list = await (await req(`/api/projects/${p.id}/comments?requirementId=${target.id}`, as("viewer", {}, "v1"))).json();
    expect(list.map((m: { status: string }) => m.status)).toEqual(["resolved", "open"]);
    // 消せるのは本人と管理者
    expect((await req(`/api/comments/${a.id}`, as("editor", { method: "DELETE" }, "ed1"))).status).toBe(403);
    expect((await req(`/api/comments/${a.id}`, as("admin", { method: "DELETE" }, "boss"))).status).toBe(204);
    const actions = (await (await req(`/api/orgs/${orgId}/audit?limit=20`, as("admin"))).json()).entries.map((e: { action: string; detail: Record<string, unknown> }) => e);
    expect(actions.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["comment.create", "comment.update", "comment.resolve", "comment.delete"]));
    // 監査ログには本文を残さない
    expect(JSON.stringify(actions)).not.toContain("根拠");
  });

  it("プロジェクトのメンバーを決めると、入っている人だけが見られ、プロジェクトでの役割で操作が決まる", async () => {
    const p = await sample();
    const invite = async (email: string, role: string) => (await (await req(`/api/orgs/${orgId}/members`, as("admin", json({ email, role })))).json()).member as { id: string };
    const alice = await invite("alice@example.com", "editor");
    const bob = await invite("bob@example.com", "editor");
    const carol = await invite("carol@example.com", "viewer");
    // 編集者でも、メンバーを決めるのはプロジェクトの管理の権限（既定は管理者）
    expect((await req(`/api/projects/${p.id}/members`, as("editor", json({ restricted: true, members: [] }, "PUT"), "alice@example.com"))).status).toBe(403);
    const put = await req(`/api/projects/${p.id}/members`, as("admin", json({ restricted: true, members: [{ memberId: alice.id, role: "viewer" }, { memberId: carol.id, role: "editor" }] }, "PUT"), "boss"));
    expect(put.status).toBe(200);

    const list = async (user: string, role: string) => ((await (await req(`/api/orgs/${orgId}/projects`, as(role, {}, user))).json()) as Array<{ id: string; restricted: boolean; myRole: string }>).find((x) => x.id === p.id);
    // 入っていない人には見えない（あることも知らせない）
    expect(await list("bob@example.com", "editor")).toBeUndefined();
    expect((await req(`/api/projects/${p.id}`, as("editor", {}, "bob@example.com"))).status).toBe(404);
    expect((await req(`/api/projects/${p.id}/requirements`, as("editor", {}, "bob@example.com"))).status).toBe(404);
    // 組織では編集者でも、このプロジェクトでは閲覧者
    expect(await list("alice@example.com", "editor")).toMatchObject({ restricted: true, myRole: "viewer" });
    const pa = await (await req(`/api/projects/${p.id}`, as("editor", {}, "alice@example.com"))).json();
    expect(pa.permissions).not.toContain("requirements.edit");
    const denied = await req(`/api/projects/${p.id}/requirements`, as("editor", json({ type: "FR", title: "x" }), "alice@example.com"));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("このプロジェクトでのあなたの役割: 閲覧者");
    // 組織では閲覧者でも、このプロジェクトでは編集者
    expect((await req(`/api/projects/${p.id}/requirements`, as("viewer", json({ type: "FR", title: "システムは、予約を表示しなければならない。" }), "carol@example.com"))).status).toBe(201);
    // 組織の管理者はいつでも見られる
    expect(await list("boss", "admin")).toMatchObject({ restricted: true, myRole: "admin" });
    const view = await (await req(`/api/projects/${p.id}/members`, as("admin", {}, "boss"))).json();
    expect(view.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ["alice@example.com", "viewer"],
      ["carol@example.com", "editor"],
    ]);
    expect(view.candidates.map((m: { email: string }) => m.email)).toEqual(expect.arrayContaining([`bob@example.com`]));
    // 管理者はメンバーに入れない
    const admin = await invite("admin2@example.com", "admin");
    expect((await req(`/api/projects/${p.id}/members`, as("admin", json({ restricted: true, members: [{ memberId: admin.id, role: "editor" }] }, "PUT"), "boss"))).status).toBe(400);
    // 管理者でない人がメンバーを決めるとき、自分を外すと開けなくなるので止める
    await req(`/api/orgs/${orgId}/permissions`, as("admin", json({ roles: { editor: ["project.view", "export", "project.create", "requirements.edit", "comment.write", "tasks.publish", "project.settings", "project.manage"] } }, "PUT"), "boss"));
    await req(`/api/projects/${p.id}/members`, as("admin", json({ restricted: true, members: [{ memberId: bob.id, role: "editor" }] }, "PUT"), "boss"));
    const self = await req(`/api/projects/${p.id}/members`, as("editor", json({ restricted: true, members: [{ memberId: alice.id, role: "editor" }] }, "PUT"), "bob@example.com"));
    expect(self.status).toBe(409);
    // 限るのをやめると全員に見える
    await req(`/api/projects/${p.id}/members`, as("admin", json({ restricted: false, members: [] }, "PUT"), "boss"));
    expect(await list("alice@example.com", "editor")).toMatchObject({ restricted: false, myRole: "editor" });
    const audit = await (await req(`/api/orgs/${orgId}/audit?action=project.members`, as("admin"))).json();
    expect(audit.entries[0].detail.before.restricted).toBe(true);
    expect(audit.entries[0].detail.after.restricted).toBe(false);
  });

  it("プロジェクトを複製できる（番号・欠番・コメント・用語集・非機能要件・メンバーを写し、履歴は写さない）", async () => {
    const p = await sample();
    const before = await reqsOf(p.id);
    const fr = before.filter((r) => r.type === "FR");
    // 1つ消して欠番を作り、コメントを付ける
    await req(`/api/requirements/${fr[1]!.id}`, as("editor", { method: "DELETE" }));
    await req(`/api/requirements/${fr[0]!.id}/comments`, as("reviewer", json({ body: "ここを確認したい" }), "rev1"));
    const nfr0 = await (await req(`/api/projects/${p.id}/nfr`, as("viewer"))).json();

    expect((await req(`/api/projects/${p.id}/duplicate`, as("viewer", json({})))).status).toBe(403);
    const res = await req(`/api/projects/${p.id}/duplicate`, as("editor", json({ name: "予約システム（第2期）" })));
    expect(res.status).toBe(201);
    const d = await res.json();
    expect(d.project.name).toBe("予約システム（第2期）");
    expect(d.counts.requirements).toBe(before.length - 1);
    const copied = await reqsOf(d.project.id);
    expect(copied.map((r) => r.code)).toEqual(before.filter((r) => r.id !== fr[1]!.id).map((r) => r.code));
    expect(copied.find((r) => r.code === fr[0]!.code)!.comments).toEqual({ open: 1, total: 1 });
    // 欠番は再利用しない
    const maxFr = Math.max(...fr.map((r) => Number(r.code.slice(3))));
    const added = await (await req(`/api/projects/${d.project.id}/requirements`, as("editor", json({ type: "FR", title: "システムは、予約を表示しなければならない。" })))).json();
    expect(added.code).toBe(`FR-${String(maxFr + 1).padStart(2, "0")}`);
    // 非機能要件シート（要件とのひも付けは番号で付け直す）
    const nfr1 = await (await req(`/api/projects/${d.project.id}/nfr`, as("viewer"))).json();
    expect(nfr1.evaluation.coverage).toEqual(nfr0.evaluation.coverage);
    // 元のプロジェクトは変わらない
    expect((await reqsOf(p.id)).length).toBe(before.length - 1);
    const audit = await (await req(`/api/orgs/${orgId}/audit?action=project.duplicate`, as("admin"))).json();
    expect(audit.entries[0].detail.from.id).toBe(p.id);
  });

  it("書き出したファイルを、別の組織に取り込める（AI はその組織のものを使う）", async () => {
    const p = await sample();
    const target = (await reqsOf(p.id))[0]!;
    await req(`/api/requirements/${target.id}/comments`, as("reviewer", json({ body: "確認済み" }), "rev1"));
    const ex = await req(`/api/projects/${p.id}/export.json`, as("viewer"));
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toContain("attachment");
    const data = await ex.json();
    expect(data.format).toBe("arn-project/1");
    // API キーや利用者の ID は入れない（コメントは書いた人の表示名だけ）
    expect(JSON.stringify(data)).not.toMatch(/authorId|createdBy|apiKey|encrypted|tokenHash/);

    const org2 = (await (await req("/api/orgs", json({ name: "別の組織" }))).json()).id as string;
    expect((await req(`/api/orgs/${org2}/projects/import`, as("editor", json({ data }), "u2", org2))).status).toBe(400); // AI が未登録
    await req(`/api/orgs/${org2}/providers`, as("admin", json({ vendor: "mock", model: "mock", label: "A" }), "u2", org2));
    const res = await req(`/api/orgs/${org2}/projects/import`, as("editor", json({ data, name: "取り込み" }), "u2", org2));
    expect(res.status).toBe(201);
    const r = await res.json();
    expect(r.notes.join()).toContain("登録済みの AI");
    expect(r.project.aiConfig.mode).toBe("single");
    const got = await (await req(`/api/projects/${r.project.id}/requirements`, as("viewer", {}, "u2", org2))).json();
    expect(got.map((x: { code: string }) => x.code)).toEqual((await reqsOf(p.id)).map((x) => x.code));
    const cm = await (await req(`/api/projects/${r.project.id}/comments`, as("viewer", {}, "u2", org2))).json();
    expect(cm[0].authorName).toBe("rev1（取り込み）");
    // ほかの組織からは見えない
    expect((await req(`/api/projects/${r.project.id}`, as("admin"))).status).toBe(404);

    // 形式の確認
    const bad = async (d: unknown) => (await req(`/api/orgs/${org2}/projects/import`, as("editor", json({ data: d }), "u2", org2))).status;
    expect(await bad({ format: "other" })).toBe(400);
    expect(await bad({ ...data, requirements: [...data.requirements, data.requirements[0]] })).toBe(400); // 番号の重なり
    expect(await bad({ ...data, requirements: [{ ...data.requirements[0], code: "NFR-99" }] })).toBe(400); // 番号と区分の食い違い
    expect((await req(`/api/orgs/${org2}/projects/import`, as("viewer", json({ data }), "u3", org2))).status).toBe(403);
  });
});
