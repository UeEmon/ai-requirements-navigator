/**
 * 画面設計とプロトタイプ（機能 F6-5 / F6-6）。
 *
 * 要件定義の段階では「どの画面で、どの情報を見て、どの操作をするか」だけを決める。
 * 利用者が色・配置・文字の大きさなどの細部に時間を使わないよう、次のようにしている。
 * - 画面モデルには見た目の情報（色・寸法・位置・フォント）を持たせない（スキーマで表現できない）
 * - プロトタイプは白黒のワイヤーフレームとし、「イメージ」であることを常に表示する
 * - 画面への意見は「要件に関わるもの」と「見た目の細部」に振り分け、細部は設計工程への申し送りとして記録する
 * - 作り直しの回数が増えたら、要件の確認に戻るよう促す
 */
import { z } from "zod";
import { extractJson } from "./json.js";
import type { AIProvider, Usage } from "./types.js";
import type { Diagram } from "./uml.js";

export const ELEMENT_KINDS = {
  heading: "見出し",
  text: "説明文",
  field: "入力欄",
  select: "選択",
  list: "一覧",
  table: "表",
  button: "ボタン",
  image: "画像",
  message: "お知らせ",
} as const;
export type ElementKind = keyof typeof ELEMENT_KINDS;

const elementKind = z.preprocess((v) => (typeof v === "string" && v in ELEMENT_KINDS ? v : "text"), z.enum(Object.keys(ELEMENT_KINDS) as [ElementKind, ...ElementKind[]]));

/** AIが返す形。見た目の項目は受け取らない（未知の項目は捨てる） */
export const ScreenContent = z.object({
  screens: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(60),
        purpose: z.string().max(300).default(""),
        actor: z.string().max(60).default(""),
        requirementCodes: z.array(z.string()).default([]),
        elements: z.array(z.object({ kind: elementKind, label: z.string().min(1).max(80) })).max(20).default([]),
        actions: z.array(z.object({ label: z.string().min(1).max(40), to: z.string().min(1).max(60) })).max(10).default([]),
      }),
    )
    .min(1)
    .max(30),
});
export type ScreenContent = z.infer<typeof ScreenContent>;

export interface ScreenElement {
  kind: ElementKind;
  label: string;
}
export interface Screen {
  /** S01 など。システムが振る */
  key: string;
  name: string;
  purpose: string;
  actor: string;
  requirementCodes: string[];
  elements: ScreenElement[];
  /** 画面遷移（to は画面のキー） */
  actions: Array<{ label: string; to: string }>;
}
export interface ScreenModel {
  screens: Screen[];
  /** どの画面にも出てこない機能要件 */
  uncovered: string[];
  /** 行き先のない遷移など、取り除いた参照の数 */
  dropped: number;
}

export interface ScreenRequirement {
  code: string;
  type: string;
  title: string;
}

/** 画面が対応すべき要件の区分（機能要件のみ。非機能要件は画面に現れないことが多い） */
export const SCREEN_TARGET_TYPES = ["FR"];

export function normalizeScreens(content: ScreenContent, reqs: ScreenRequirement[]): ScreenModel {
  const known = new Set(reqs.map((r) => r.code));
  let dropped = 0;
  const ids = new Map<string, string>();
  content.screens.forEach((s, i) => {
    const key = `S${String(i + 1).padStart(2, "0")}`;
    if (!ids.has(s.id)) ids.set(s.id, key);
    if (!ids.has(s.name)) ids.set(s.name, key);
  });
  const screens = content.screens.map((s, i): Screen => {
    const codes = s.requirementCodes.map((c) => c.trim()).filter((c, j, a) => a.indexOf(c) === j);
    const valid = codes.filter((c) => known.has(c));
    dropped += codes.length - valid.length;
    const actions = s.actions
      .map((a) => ({ label: a.label.trim(), to: ids.get(a.to) ?? ids.get(a.to.trim()) ?? "" }))
      .filter((a) => {
        if (a.to) return true;
        dropped++;
        return false;
      });
    return {
      key: `S${String(i + 1).padStart(2, "0")}`,
      name: s.name.trim(),
      purpose: s.purpose.trim(),
      actor: s.actor.trim(),
      requirementCodes: valid,
      elements: s.elements.map((e) => ({ kind: e.kind, label: e.label.trim() })),
      actions,
    };
  });
  const used = new Set(screens.flatMap((s) => s.requirementCodes));
  const uncovered = reqs.filter((r) => SCREEN_TARGET_TYPES.includes(r.type) && !used.has(r.code)).map((r) => r.code);
  return { screens, uncovered, dropped };
}

export const SCREEN_SYSTEM = `あなたは業務システムの画面設計者です。要件定義の段階で、利用者と「どの画面で、どの情報を見て、どの操作をするか」を確認するための画面一覧を作ります。
- 見た目（色・文字の大きさ・配置・寸法・アイコン）は決めない。出力にも含めない。それらは設計工程で決める
- 画面ごとに、目的・主に使う人・対応する要件コード・表示する情報と操作（elements）・次の画面への遷移（actions）を書く
- elements の kind は heading / text / field / select / list / table / button / image / message のいずれか。label は「予約日時」「検索する」など短い言葉にする
- 1画面の elements は12個程度まで。細かい項目を並べすぎない
- すべての機能要件（FR）が、いずれかの画面の requirementCodes に入るようにする。存在しない要件コードは使わない
- actions の to には、遷移先の画面の id を書く
- 要件にない画面や機能を作り込まない
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "screens": [{ "id": "top", "name": "...", "purpose": "...", "actor": "...", "requirementCodes": ["FR-01"], "elements": [{ "kind": "field", "label": "..." }], "actions": [{ "label": "...", "to": "confirm" }] }] }`;

export function buildScreenPrompt(projectName: string, purpose: string, reqs: ScreenRequirement[], opts: { design?: string; feedback?: string[] } = {}): string {
  return `# プロジェクト
名称: ${projectName}
目的: ${purpose || "（未記入）"}

# 要件
${reqs.map((r) => `- ${r.code} [${r.type}] ${r.title}`).join("\n") || "（なし）"}
${opts.design ? `\n# 採用した設計（UML）\n${opts.design}\n` : ""}${
    opts.feedback?.length ? `\n# 利用者からの意見（前回の画面への指摘。要件に関わるものだけ）\n${opts.feedback.map((f) => `- ${f}`).join("\n")}\n` : ""
  }`;
}

export interface ScreenGenerationResult {
  model: ScreenModel;
  providerId: string;
  usage: Usage;
  failures: Array<{ providerId: string; reason: string }>;
}

/** 指定順にAIを試し、最初に検証を通った画面一覧を返す */
export async function generateScreens(
  providers: AIProvider[],
  projectName: string,
  purpose: string,
  reqs: ScreenRequirement[],
  opts: { design?: string; feedback?: string[]; timeoutMs?: number } = {},
): Promise<ScreenGenerationResult> {
  const failures: ScreenGenerationResult["failures"] = [];
  const prompt = buildScreenPrompt(projectName, purpose, reqs, opts);
  for (const p of providers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await p.complete({ system: SCREEN_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 10000, signal: ctrl.signal });
      return { model: normalizeScreens(ScreenContent.parse(extractJson(res.text)), reqs), providerId: p.id, usage: res.usage, failures };
    } catch (e) {
      failures.push({ providerId: p.id, reason: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error("画面一覧を作成できませんでした") as Error & { failures: typeof failures };
  err.failures = failures;
  throw err;
}

/* ------------------------------------------------------------------ */
/* 画面への意見の振り分け                                               */
/* ------------------------------------------------------------------ */

/** 見た目の細部に関する言葉（設計工程で決めるもの） */
const DETAIL_PATTERNS: Array<[RegExp, string]> = [
  [/色(?!々)|カラー|配色/, "色"],
  [/フォント|字体|書体|太字|文字の大きさ|文字サイズ/, "文字の見た目"],
  [/ピクセル|\d+\s*px|余白|間隔|幅を|高さを/, "寸法・余白"],
  [/右寄せ|左寄せ|中央寄せ|中央に|配置|レイアウト|並べ方|揃え|[右左](?:に|側)|(?<!以)[上下](?:に|部|側)/, "配置"],
  [/大きく|小さく|大きさ/, "大きさ"],
  [/角丸|影を|枠線|背景|アイコン|ロゴ|アニメーション/, "装飾"],
  [/見た目|デザイン|おしゃれ|かわいい|かっこいい|雰囲気|目立/, "見た目の印象"],
];
/** 要件に関わる言葉（必要な情報・操作・流れ・権限など） */
const REQUIREMENT_PATTERNS: Array<[RegExp, string]> = [
  [/項目|入力|必須/, "入力する情報"],
  [/足りな|必要|追加|が(?:欲しい|ほしい)/, "不足"],
  [/検索|絞り込|並び替|集計|履歴/, "探す・まとめる"],
  [/確認|承認|取り消|取消|キャンセル|削除|登録|保存|変更でき/, "操作"],
  [/通知|メール|お知らせを送/, "通知"],
  [/権限|管理者だけ|見られな|見せたくな/, "権限"],
  [/遷移|戻れ|戻る|次の画面|画面がな|別の画面/, "画面のつながり"],
  [/印刷|出力|ダウンロード|CSV/, "出力"],
  [/できるように|できない|できると|選べ|選択でき/, "できること"],
  [/エラー|間違|誤り|入力ミス/, "誤りへの対応"],
];

export interface FeedbackClassification {
  /** detail: 見た目の細部のみ / requirement: 要件に関わる / mixed: 両方 */
  level: "detail" | "requirement" | "mixed";
  detailHits: string[];
  requirementHits: string[];
  /** 利用者に返す説明 */
  guidance: string;
}

export function classifyScreenFeedback(text: string): FeedbackClassification {
  const hits = (ps: Array<[RegExp, string]>) => [...new Set(ps.filter(([re]) => re.test(text)).map(([, l]) => l))];
  const detailHits = hits(DETAIL_PATTERNS);
  const requirementHits = hits(REQUIREMENT_PATTERNS);
  if (detailHits.length && !requirementHits.length) {
    return {
      level: "detail",
      detailHits,
      requirementHits,
      guidance: `「${detailHits.join("・")}」は設計工程で決めるため、申し送りとして記録しました。この段階では、必要な情報と操作がそろっているか、画面のつながりに問題がないかを確認してください。`,
    };
  }
  if (detailHits.length) {
    return {
      level: "mixed",
      detailHits,
      requirementHits,
      guidance: `要件に関わる点（${requirementHits.join("・")}）は次の作り直しに反映します。「${detailHits.join("・")}」は設計工程への申し送りとして記録します。`,
    };
  }
  return { level: "requirement", detailHits, requirementHits, guidance: "次の作り直しに反映します。新しい要件が必要な場合は、ヒアリングまたは変更要求で確定してください。" };
}

/** 作り直しを促すのをやめ、要件の確認に戻るよう促す目安 */
export const SCREEN_REVISION_NUDGE = 3;

/* ------------------------------------------------------------------ */
/* 出力                                                                */
/* ------------------------------------------------------------------ */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mq = (s: string) => s.replace(/["\n\r<>{}|[\]]/g, " ").trim();

/** 画面遷移図（Mermaid） */
export function screenFlowMermaid(model: ScreenModel): string {
  const lines = ["flowchart LR"];
  for (const s of model.screens) lines.push(`  ${s.key}["${s.key} ${mq(s.name)}"]`);
  for (const s of model.screens) for (const a of s.actions) lines.push(`  ${s.key} -->|${mq(a.label) || " "}| ${a.to}`);
  return lines.join("\n");
}

/** 画面遷移図（PlantUML） */
export function screenFlowPlantUml(model: ScreenModel): string {
  const lines = ["@startuml"];
  for (const s of model.screens) lines.push(`rectangle "${s.key} ${mq(s.name)}" as ${s.key}`);
  for (const s of model.screens) for (const a of s.actions) lines.push(`${s.key} --> ${a.to}${a.label ? ` : ${mq(a.label)}` : ""}`);
  lines.push("@enduml");
  return lines.join("\n");
}

/** 仕様書・UML画面に並べる図 */
export function screenFlowDiagram(model: ScreenModel): Diagram {
  return { kind: "screen", title: "画面遷移図", mermaid: screenFlowMermaid(model), plantuml: screenFlowPlantUml(model), source: "ai" };
}

function elementHtml(e: ScreenElement): string {
  const l = esc(e.label);
  switch (e.kind) {
    case "heading":
      return `<div class="h">${l}</div>`;
    case "field":
      return `<label class="fld"><span>${l}</span><i></i></label>`;
    case "select":
      return `<label class="fld"><span>${l}</span><i class="sel">▾</i></label>`;
    case "list":
      return `<div class="lst"><span>${l}</span><i></i><i></i><i></i></div>`;
    case "table":
      return `<div class="tbl"><span>${l}</span><div>${"<i></i>".repeat(9)}</div></div>`;
    case "button":
      return `<span class="b">${l}</span>`;
    case "image":
      return `<div class="img"><span>${l}</span></div>`;
    case "message":
      return `<div class="msg">${l}</div>`;
    default:
      return `<p class="txt">${l}</p>`;
  }
}

/**
 * クリックで画面を移動できるワイヤーフレーム（1つのHTMLファイル、スクリプトなし）。
 * 白黒・手書き風にして、完成した見た目ではないことが伝わるようにする。
 */
export function renderPrototypeHtml(model: ScreenModel, projectName: string, reqs: ScreenRequirement[] = []): string {
  const title = new Map(reqs.map((r) => [r.code, r.title]));
  const first = model.screens[0]?.key ?? "S01";
  const nav = model.screens.map((s) => `<a href="#${s.key}">${s.key} ${esc(s.name)}</a>`).join("");
  const screens = model.screens
    .map(
      (s) => `<section id="${s.key}" class="scr">
  <div class="frame">
    <div class="bar"><b>${s.key}</b> ${esc(s.name)}</div>
    <div class="body">${s.elements.map(elementHtml).join("\n")}
      <div class="acts">${s.actions.map((a) => `<a class="b go" href="#${a.to}">${esc(a.label)} →</a>`).join("")}</div>
    </div>
  </div>
  <aside class="memo">
    <p><b>目的</b>${esc(s.purpose) || "―"}</p>
    <p><b>使う人</b>${esc(s.actor) || "―"}</p>
    <p><b>対応する要件</b>${s.requirementCodes.map((c) => `<span class="code" title="${esc(title.get(c) ?? "")}">${esc(c)}</span>`).join(" ") || "―"}</p>
  </aside>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(projectName)} 画面イメージ</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:"Comic Sans MS","Segoe Print","Hiragino Maru Gothic ProN","Yu Gothic",sans-serif;background:#f4f4f2;color:#333;filter:grayscale(1)}
.note{background:#333;color:#fff;padding:10px 16px;font-size:13px;line-height:1.6}
.note b{display:block;font-size:14px}
nav{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px dashed #999;font-size:12.5px}
nav a{color:#333;border:1px dashed #888;border-radius:12px;padding:2px 9px;text-decoration:none}
.scr{display:none;padding:18px 16px;gap:18px;flex-wrap:wrap;align-items:flex-start}
.scr:target{display:flex}
body:not(:has(.scr:target)) #${first}{display:flex}
.frame{width:min(380px,100%);min-height:520px;border:2px solid #555;border-radius:14px;background:#fff;position:relative;overflow:hidden}
.frame::after{content:"イメージ";position:absolute;right:-30px;bottom:30px;transform:rotate(-30deg);font-size:40px;color:rgba(0,0,0,.06);pointer-events:none}
.bar{border-bottom:2px solid #555;padding:10px 12px;font-size:14px}
.body{padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.h{font-size:15px;border-bottom:2px solid #bbb;padding-bottom:3px}
.txt{margin:0;color:#666}
.fld{display:flex;flex-direction:column;gap:3px}.fld i{display:block;height:26px;border:1.5px solid #999;border-radius:4px;font-style:normal;text-align:right;padding-right:6px;color:#999}
.lst span,.tbl span,.img span{display:block;margin-bottom:4px}
.lst i{display:block;height:14px;margin:5px 0;background:repeating-linear-gradient(90deg,#ccc 0 60%,transparent 60% 100%);border-radius:3px}
.tbl>div{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}.tbl>div i{height:16px;border:1px solid #bbb}
.img{height:90px;border:1.5px solid #999;background:linear-gradient(to top right,transparent 49%,#bbb 50%,transparent 51%),linear-gradient(to top left,transparent 49%,#bbb 50%,transparent 51%);padding:6px}
.msg{border:1.5px dashed #999;padding:6px 8px;border-radius:6px}
.b{display:inline-block;border:2px solid #555;border-radius:18px;padding:5px 14px;text-align:center;color:#333;text-decoration:none}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.go{background:#eee}
.memo{flex:1;min-width:220px;max-width:420px;font-size:13px;line-height:1.6;border-left:3px solid #ccc;padding-left:12px}
.memo p{margin:0 0 8px}.memo b{display:block;font-size:11.5px;color:#777}
.code{font-family:monospace;border:1px solid #bbb;border-radius:3px;padding:0 4px}
</style></head>
<body>
<div class="note"><b>画面イメージ（ワイヤーフレーム）</b>
色・文字の大きさ・配置・言葉づかいは、設計工程で決めます。ここで確認するのは「必要な情報と操作がそろっているか」「画面のつながりに無理がないか」です。ボタンを押すと次の画面に移ります。</div>
<nav>${nav}</nav>
${screens}
</body></html>
`;
}

/** 仕様書・プロンプト用の要約 */
export function summarizeScreens(model: ScreenModel): string {
  return model.screens
    .map((s) => `- ${s.key} ${s.name}（${s.requirementCodes.join(",") || "要件なし"}）: ${s.elements.map((e) => e.label).join("、")}${s.actions.length ? ` → ${s.actions.map((a) => `${a.label}:${a.to}`).join("、")}` : ""}`)
    .join("\n");
}
