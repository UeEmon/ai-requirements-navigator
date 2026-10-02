import { randomBytes } from "node:crypto";
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/auth.js";
import { LocalKeyEncryptor } from "../src/crypto.js";
import { extractText } from "../src/extract.js";
import { buildSpec, findPdfFont, renderPdf } from "../src/spec.js";
import { MemoryStorage } from "../src/storage.js";
import { MemoryStore, type Project } from "../src/store.js";

const json = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b), headers: { "content-type": "application/json" } });

const MINUTES = [
  "受付担当が電話で予約を受け、紙の受付票に記入している。",
  "店長が毎晩、受付票をExcelに転記している。",
  "前日に全員へ電話で確認しており、1日1時間かかる。",
  "店長が月末に売上を集計する。",
].join("\n");

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

describe("資料の取り込み", () => {
  it("Word の本文（表を含む）・Shift_JIS のテキストを取り出し、対応しない形式を断る", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph("現行システムの説明"),
            new Table({
              rows: [
                new TableRow({ children: [new TableCell({ children: [new Paragraph("担当")] }), new TableCell({ children: [new Paragraph("作業")] })] }),
                new TableRow({ children: [new TableCell({ children: [new Paragraph("店長")] }), new TableCell({ children: [new Paragraph("Excelに転記"), new Paragraph("毎晩")] })] }),
              ],
            }),
          ],
        },
      ],
    });
    const r = await extractText("説明.docx", await Packer.toBuffer(doc));
    expect(r.format).toBe("docx");
    expect(r.text).toBe("現行システムの説明\n担当\t作業\n店長\tExcelに転記 毎晩");
    const sjis = await extractText("a.csv", Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x2c, 0x82, 0xa0]));
    expect(sjis.text).toBe("日本,あ");
    await expect(extractText("a.xlsx", Buffer.from("x"))).rejects.toMatchObject({ status: 415 });
    await expect(extractText("a.docx", Buffer.from("not zip"))).rejects.toMatchObject({ status: 400 });
  });

  it.skipIf(!findPdfFont())("PDF の日本語の本文を取り出す", async () => {
    const p = { id: "p", orgId: "o", name: "予約", purpose: "電話を減らす", confidential: false, phaseKey: "purpose", aiConfig: { mode: "single", generatorIds: [], evaluatorId: null }, createdAt: "" } as Project;
    const pdf = await renderPdf(buildSpec(p, [], [], []));
    const r = await extractText("仕様書.pdf", pdf);
    expect(r.format).toBe("pdf");
    expect(r.text).toContain("予約 要件定義書");
    expect(r.text).toContain("電話を減らす");
  });
});

describe("資料の分析・業務の見直し・EARS", () => {
  let t: ReturnType<typeof setup>;
  let orgId: string;
  const as = (role: string, init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), "x-org-id": orgId, "x-role": role, "x-user-id": "u1" },
  });
  const req = (path: string, init: RequestInit = {}) => t.app.request(path, init);
  const post = (path: string, b: unknown = {}, role = "editor") => req(path, as(role, json(b)));

  async function project(mode: "multi" | "single" = "multi") {
    const ids: string[] = [];
    for (const label of ["生成役0", "生成役1", "評価役"]) {
      ids.push((await (await post(`/api/orgs/${orgId}/providers`, { vendor: "mock", model: "mock", label }, "admin")).json()).id);
    }
    const aiConfig = mode === "multi" ? { mode, generatorIds: [ids[0], ids[1]], evaluatorId: ids[2] } : { mode, generatorIds: [ids[0]] };
    return (await (await post(`/api/orgs/${orgId}/projects`, { name: "予約", aiConfig })).json()) as { id: string };
  }

  beforeEach(async () => {
    t = setup();
    orgId = (await (await req("/api/orgs", json({ name: "組織" }))).json()).id;
  });

  it("資料: 貼り付け・ファイルで取り込み、一覧・本文・削除ができる", async () => {
    const p = await project();
    const d1 = await post(`/api/projects/${p.id}/documents`, { name: "定例会議事録", kind: "minutes", text: MINUTES });
    expect(d1.status).toBe(201);
    const v1 = await d1.json();
    expect(v1).toMatchObject({ name: "定例会議事録", kind: "minutes", kindLabel: "議事録", format: "text", chars: MINUTES.length, warnings: [] });
    const d2 = await post(`/api/projects/${p.id}/documents`, { name: "説明.md", kind: "existing", contentBase64: Buffer.from("# 現行システム\n予約はExcelで管理").toString("base64") });
    expect(d2.status).toBe(201);
    expect((await post(`/api/projects/${p.id}/documents`, { name: "a.xlsx", contentBase64: "AAAA" })).status).toBe(415);
    expect((await post(`/api/projects/${p.id}/documents`, { name: "a", text: "x", contentBase64: "AAAA" })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/documents`, { name: "a", text: "x" }, "viewer")).status).toBe(403);

    const list = await (await req(`/api/projects/${p.id}/documents`, as("viewer"))).json();
    expect(list.map((d: { name: string }) => d.name)).toEqual(["定例会議事録", "説明.md"]);
    expect(list[0].text).toBeUndefined();
    expect((await (await req(`/api/documents/${v1.id}`, as("viewer"))).json()).text).toBe(MINUTES);
    expect((await req(`/api/documents/${v1.id}`, as("editor", { method: "DELETE" }))).status).toBe(204);
    expect((await (await req(`/api/projects/${p.id}/documents`, as("viewer"))).json())).toHaveLength(1);
  });

  it("分析: 複数AIの分析を匿名で比較し、採用した見直し案と要件案を EARS の要件にする", async () => {
    const p = await project();
    expect((await post(`/api/projects/${p.id}/analyses`)).status).toBe(400); // 資料なし
    await post(`/api/projects/${p.id}/documents`, { name: "定例会議事録", kind: "minutes", text: MINUTES });

    const r = await post(`/api/projects/${p.id}/analyses`, { focus: "受付の手間" });
    expect(r.status).toBe(201);
    const a = await r.json();
    expect(a.candidates.map((c: { label: string }) => c.label)).toEqual(["A", "B"]);
    expect(a.candidates[0].provider).toBeUndefined(); // 採用前は作成者を伏せる
    expect(a.mapping).toBeNull();
    expect(a.evaluation.evaluator).toBe("評価役");
    expect(Object.keys(a.evaluation.totals)).toEqual(["A", "B"]);
    expect(a.notes).toContain("D1 = 定例会議事録");
    const an = a.candidates[0].analysis;
    expect(an.issues[0].evidence[0]).toMatchObject({ document: "D1", verified: true });
    expect(an.metrics.groundedRate).toBe(1);
    expect(an.requirements[0].lint.ok).toBe(true);

    const bad = await post(`/api/analyses/${a.id}/adopt`, { label: "A", proposalIds: ["P99"], requirementIndexes: [0] });
    expect(bad.status).toBe(400);
    const ad = await post(`/api/analyses/${a.id}/adopt`, { label: "A", proposalIds: ["P1", "P3"], requirementIndexes: [0, 1, 2, 3], reason: "転記をなくす" });
    expect(ad.status).toBe(201);
    const adopted = await ad.json();
    expect(adopted.requirementCodes).toEqual(["FR-01", "FR-02", "NFR-01", "BR-01"]);
    expect(adopted.analysis.mapping).toEqual({ A: expect.stringMatching(/^生成役/), B: expect.stringMatching(/^生成役/) });
    expect((await post(`/api/analyses/${a.id}/adopt`, { label: "A", requirementIndexes: [0] })).status).toBe(409);

    const reqs = await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json();
    const fr1 = reqs.find((x: { code: string }) => x.code === "FR-01");
    expect(fr1.title).toBe("利用者が予約日時を選んだとき、予約システムは、空き枠と予約内容を確認画面に表示しなければならない。");
    expect(fr1.ears).toMatchObject({ pattern: "event", system: "予約システム" });
    expect(fr1.lint).toEqual({ pattern: "event", ok: true, issues: [] });
    expect(fr1.source).toBe("資料分析（案A）");
    expect(fr1.description).toContain("見直し案：P3");
    expect(reqs.find((x: { code: string }) => x.code === "BR-01").ears).toBeNull();

    // 仕様書と UML に、業務フロー（現状・見直し後）と課題・見直し案が入る
    const md = await (await req(`/api/projects/${p.id}/spec.md`, as("viewer"))).text();
    expect(md).toContain("## 11. 現状の課題（資料分析）");
    expect(md).toContain("D1「受付担当が電話で予約を受け、紙の受付票に記入している。」");
    expect(md).toContain("採用　P1 [やめる]");
    expect(md).toContain("引き継がない：紙の受付票の印刷機能");
    expect(md).toContain("### 業務フロー（見直し後）");
    const uml = await (await req(`/api/projects/${p.id}/uml`, as("viewer"))).json();
    expect(uml.diagrams.map((d: { title: string }) => d.title)).toEqual(expect.arrayContaining(["業務フロー（現状）", "業務フロー（見直し後）"]));

    const log = await (await req(`/api/orgs/${orgId}/audit?limit=10`, as("admin"))).json();
    const actions = log.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["document.create", "ai.analysis", "analysis.adopt"]));
    // 監査ログには資料の本文を残さない
    const analysisLog = log.entries.find((e: { action: string }) => e.action === "ai.analysis");
    expect(analysisLog.detail.sent.documents).toEqual([{ name: "定例会議事録", chars: MINUTES.length }]);
    expect(JSON.stringify(analysisLog)).not.toContain("紙の受付票に記入");
  });

  it("確定後に採用した要件案は変更要求になり、変更すると EARS の構造ごと要件になる。非同期でも分析できる", async () => {
    const p = await project("single");
    await post(`/api/projects/${p.id}/documents`, { name: "議事録", kind: "minutes", text: MINUTES });
    const rnd = await (await post(`/api/projects/${p.id}/rounds`, { answer: "電話を減らしたい", phaseKey: "purpose" })).json();
    await post(`/api/rounds/${rnd.id}/decision`, { pick: "A", advancePhase: false });
    await post(`/api/projects/${p.id}/baseline`, { reason: "テスト", force: true });

    const { jobId } = await (await post(`/api/projects/${p.id}/analyses?async=1`, {})).json();
    await t.app.jobs.drain();
    const job = await (await req(`/api/jobs/${jobId}`, as("editor"))).json();
    expect(job.status).toBe("done");
    expect(job.result.candidates).toHaveLength(1);
    expect(job.result.evaluation).toBeNull();

    const ad = await (await post(`/api/analyses/${job.result.id}/adopt`, { label: "A", proposalIds: ["P1"], requirementIndexes: [1] })).json();
    expect(ad.requirementCodes).toEqual([]);
    expect(ad.changeCodes).toEqual(["CR-001"]);
    const cr = (await (await req(`/api/projects/${p.id}/changes`, as("viewer"))).json())[0];
    expect(cr).toMatchObject({ kind: "add", source: "analysis", proposal: { type: "FR", ears: { pattern: "ubiquitous" } } });
    await post(`/api/changes/${cr.id}/analyze`);
    await post(`/api/changes/${cr.id}/decide`, { option: "apply" });
    const fr = (await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json()).find((x: { code: string }) => x.code === "FR-01");
    expect(fr.title).toBe("予約システムは、予約時に入力された内容を受付担当の予約一覧に反映しなければならない。");
    expect(fr.ears.pattern).toBe("ubiquitous");
  });

  it("EARS: 構造で要件を手直しでき、文を手で変えると構造は外れる。入力中の確認もできる", async () => {
    const p = await project();
    const rnd = await (await post(`/api/projects/${p.id}/rounds`, { answer: "ネットで予約したい", phaseKey: "functions" })).json();
    await post(`/api/rounds/${rnd.id}/decision`, { pick: "merged", advancePhase: false });
    const reqs = await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json();
    // ヒアリングで作った機能要件も EARS の文
    expect(reqs.every((x: { lint: { ok: boolean } }) => x.lint.ok)).toBe(true);
    expect(reqs[1].ears.pattern).toBe("unwanted");
    expect(reqs[1].title).toBe("利用者が操作を取り消した場合、本システムは、取消前の状態に戻さなければならない。");

    const ears = { pattern: "event", trigger: "利用者が予約を確定した", system: "予約システム", response: "確認メールを3分以内に送信する" };
    const up = await (await req(`/api/requirements/${reqs[0].id}`, as("editor", json({ ears }, "PATCH")))).json();
    expect(up.title).toBe("利用者が予約を確定したとき、予約システムは、確認メールを3分以内に送信しなければならない。");
    expect(up.ears.response).toBe("確認メールを3分以内に送信する");
    const manual = await (await req(`/api/requirements/${reqs[0].id}`, as("editor", json({ title: "予約できるなど、使いやすくする" }, "PATCH")))).json();
    expect(manual.ears).toBeNull();
    const after = (await (await req(`/api/projects/${p.id}/requirements`, as("viewer"))).json())[0];
    expect(after.lint.ok).toBe(false);
    expect(after.lint.issues.join("\n")).toContain("「など」");

    const pv = await (await post(`/api/ears/preview`, { ears: { pattern: "unwanted", trigger: "決済に失敗した", system: "予約システム", response: "仮予約のまま保持" }, type: "FR" }, "viewer")).json();
    expect(pv).toEqual({ text: "決済に失敗した場合、予約システムは、仮予約のまま保持しなければならない。", lint: { pattern: "unwanted", ok: true, issues: [] } });
  });
});
