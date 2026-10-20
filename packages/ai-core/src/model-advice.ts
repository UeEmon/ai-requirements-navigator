import type { Vendor } from "./types.js";
import { vendorName } from "./vendors.js";

/**
 * モデルの組み合わせの提案（単一AI・単独AI＋評価AI）。
 *
 * 「応答性（速さ）」「思考の深さ（推論力・品質）」「トークン消費（費用・コンテキストの負荷）」を
 * 1〜5 の目安で表し、目的ごと（バランス・速さと費用・品質）に組み合わせを提案する。最終的な選択は利用者が行う。
 *
 * モデル名は各社で頻繁に変わるため、個々のモデル名の一覧は持たず、名前に含まれる系統（Haiku・Sonnet・Opus、
 * mini・nano、Flash・Pro など）から目安を推定する。推定できない名前は「普通」として扱い、その旨を伝える。
 */

/** 1〜5 の目安 */
export type Level = 1 | 2 | 3 | 4 | 5;

export interface ModelProfile {
  /** 応答性（5 = 速い） */
  speed: Level;
  /** 思考の深さ（5 = 推論力が高い） */
  depth: Level;
  /** トークン消費（5 = 費用・負荷が大きい） */
  cost: Level;
  /** 系統の名前（例: 「Claude の Sonnet 系」）。推定できなければ null */
  family: string | null;
  /** 補足（推論で多くのトークンを使う、社外に送らない、など） */
  notes: string[];
}

export interface AdviceProvider {
  id: string;
  vendor: Vendor;
  model: string;
  label: string;
  isLocal: boolean;
}

export type AdviceGoal = "balanced" | "fast" | "quality";

export const ADVICE_GOALS: Record<AdviceGoal, { title: string; description: string; weights: { speed: number; depth: number; light: number } }> = {
  balanced: {
    title: "バランス（おすすめ）",
    description: "待ち時間と費用を抑えながら、品質を確保します",
    weights: { speed: 1, depth: 2.5, light: 1 },
  },
  fast: {
    title: "速さと費用を優先",
    description: "ヒアリングのやり取りを軽く速く進めます。小さなシステムや下書きの段階に",
    weights: { speed: 2, depth: 0.5, light: 2 },
  },
  quality: {
    title: "品質を優先",
    description: "抜け漏れ・誤りの少なさを重視します。重要なシステムや確定前の見直しに",
    weights: { speed: 0.3, depth: 3, light: 0.3 },
  },
};

const lv = (n: number): Level => Math.min(5, Math.max(1, Math.round(n))) as Level;
const p = (speed: number, depth: number, cost: number, family: string | null, notes: string[] = []): ModelProfile => ({
  speed: lv(speed),
  depth: lv(depth),
  cost: lv(cost),
  family,
  notes,
});
const THINKS = "考える過程でもトークンを使うため、出力の量より消費が多くなりがちです";

/** モデル名から、速さ・推論力・消費の目安を推定する */
export function modelProfile(vendor: Vendor, model: string): ModelProfile {
  const m = model.toLowerCase();
  switch (vendor) {
    case "anthropic":
      if (m.includes("haiku")) return p(5, 2, 1, "Claude の Haiku 系（速く安い）");
      if (m.includes("sonnet")) return p(4, 4, 3, "Claude の Sonnet 系（速さと品質のバランス）");
      if (m.includes("opus")) return p(2, 5, 4, "Claude の Opus 系（推論力が高い）", [THINKS]);
      if (m.includes("fable") || m.includes("mythos")) return p(1, 5, 5, "Claude の最上位（最も推論力が高く、高価）", [THINKS, "1回の応答に時間がかかることがあります"]);
      break;
    case "openai":
      if (m.includes("nano")) return p(5, 1, 1, "ChatGPT の nano 系（最も速く安い）");
      if (/(^|-)o\d/.test(m) && m.includes("mini")) return p(3, 3, 2, "ChatGPT の推論モデル（小型）", [THINKS]);
      if (m.includes("mini")) return p(4, 3, 2, "ChatGPT の mini 系（速く安い）");
      if (m.includes("-pro") || m.endsWith("pro")) return p(1, 5, 5, "ChatGPT の pro 系（最も推論力が高く、高価）", [THINKS, "1回の応答に時間がかかることがあります"]);
      if (/^o\d/.test(m)) return p(2, 4, 4, "ChatGPT の推論モデル", [THINKS]);
      if (/^gpt-[5-9]/.test(m)) return p(3, 4, 3, "ChatGPT の GPT-5 以降（標準）");
      if (/^gpt-4/.test(m)) return p(4, 3, 3, "ChatGPT の GPT-4 系（前の世代）");
      break;
    case "gemini":
      if (m.includes("flash-lite") || m.includes("flash-8b")) return p(5, 2, 1, "Gemini の Flash-Lite 系（最も速く安い）");
      if (m.includes("flash")) return p(4, 3, 2, "Gemini の Flash 系（速く安い）");
      if (m.includes("ultra")) return p(1, 5, 5, "Gemini の Ultra 系（最も推論力が高く、高価）", [THINKS]);
      if (m.includes("pro")) return p(2, 5, 4, "Gemini の Pro 系（推論力が高い）", [THINKS]);
      break;
    case "ollama": {
      // パラメーター数（例: llama3:70b、qwen2.5:14b）が大きいほど推論力は高いが、手元の機械では遅くなる
      const size = Number(/(\d+(?:\.\d+)?)b\b/.exec(m)?.[1] ?? NaN);
      const local = "社外に送らず、API の料金もかかりません（速さは手元の機械の性能によります）";
      if (Number.isFinite(size)) {
        if (size >= 60) return p(1, 4, 1, `ローカルLLM（${size}B・大型）`, [local]);
        if (size >= 20) return p(2, 3, 1, `ローカルLLM（${size}B・中型）`, [local]);
        return p(3, 2, 1, `ローカルLLM（${size}B・小型）`, [local]);
      }
      return p(2, 2, 1, "ローカルLLM", [local, "モデル名から大きさが分からないため、推論力は控えめに見積もっています"]);
    }
    case "mock":
      return p(5, 1, 1, "模擬AI（開発用）", ["決まった応答を返す開発用の AI です。品質の確認には使えません"]);
  }
  return p(3, 3, 3, null, [`モデル名「${model}」から性格を推定できなかったため、普通として扱っています`]);
}

export interface AdviceAxis {
  /** 1〜5 */
  level: Level;
  /** 画面に出す言葉（例: 速い・普通・時間がかかる） */
  word: string;
}

export interface AdviceAxes {
  speed: AdviceAxis;
  depth: AdviceAxis;
  cost: AdviceAxis;
}

export interface ModelCombo {
  /** この組み合わせが最も合う目的（同じ組み合わせが複数の目的で選ばれたら、すべて） */
  goals: AdviceGoal[];
  mode: "single" | "review";
  generatorId: string;
  evaluatorId: string | null;
  axes: AdviceAxes;
  /** 選んだ理由（短い文） */
  reasons: string[];
  /** 気をつける点 */
  cautions: string[];
}

export interface ModelAdvice {
  profiles: Array<AdviceProvider & { profile: ModelProfile }>;
  single: ModelCombo[];
  review: ModelCombo[];
  /** 提案できない理由など */
  notes: string[];
}

const SPEED_WORD = ["", "時間がかかる", "やや遅い", "普通", "速い", "とても速い"];
const DEPTH_WORD = ["", "浅い", "控えめ", "普通", "深い", "とても深い"];
const COST_WORD = ["", "とても少ない", "少ない", "普通", "多い", "とても多い"];
const axes = (speed: number, depth: number, cost: number): AdviceAxes => {
  const s = lv(speed), d = lv(depth), c = lv(cost);
  return { speed: { level: s, word: SPEED_WORD[s]! }, depth: { level: d, word: DEPTH_WORD[d]! }, cost: { level: c, word: COST_WORD[c]! } };
};

/**
 * 単独AI＋評価AI の組み合わせの目安。
 * - 応答性: 生成AI → 評価AI の順に呼ぶため、待ち時間は2つの合計になる
 * - 思考の深さ: 最後に直した案を作るのは評価AI なので、評価AI の推論力を重く見る
 * - トークン消費: 評価AI は会話に加えて生成AI の案も読むため、入力が多い。評価AI を重く見る
 */
export function comboAxes(gen: ModelProfile, ev: ModelProfile | null): AdviceAxes {
  if (!ev) return axes(gen.speed, gen.depth, gen.cost);
  const wait = 6 - gen.speed + (6 - ev.speed); // 2（とても速い×2）〜10
  return axes(5 - (wait - 2) / 2, 0.4 * gen.depth + 0.6 * ev.depth, 0.4 * gen.cost + 0.6 * ev.cost);
}

const score = (a: AdviceAxes, goal: AdviceGoal) => {
  const w = ADVICE_GOALS[goal].weights;
  return w.speed * a.speed.level + w.depth * a.depth.level + w.light * (6 - a.cost.level);
};

/** 組み合わせの点数（目的ごとの重み＋評価AI の選び方の良し悪し） */
function pairScore(g: AdviceProvider & { profile: ModelProfile }, e: AdviceProvider & { profile: ModelProfile }, goal: AdviceGoal) {
  const raw = (gen: ModelProfile, ev: ModelProfile) => {
    const wait = 6 - gen.speed + (6 - ev.speed);
    const w = ADVICE_GOALS[goal].weights;
    return w.speed * (5 - (wait - 2) / 2) + w.depth * (0.4 * gen.depth + 0.6 * ev.depth) + w.light * (6 - (0.4 * gen.cost + 0.6 * ev.cost));
  };
  let s = raw(g.profile, e.profile);
  // 提供元が違うと、同じ癖による見落としに気づきやすい
  if (g.vendor !== e.vendor) s += 1;
  // 審査する側が案を作る側より推論力が低いと、誤りを見逃しやすい
  if (e.profile.depth < g.profile.depth) s -= 0.7 * (g.profile.depth - e.profile.depth);
  // 模擬AI は品質の確認に使えない
  if (e.vendor === "mock") s -= 3;
  return s;
}

const name = (x: AdviceProvider) => `${x.label}`;

function reviewReasons(g: AdviceProvider & { profile: ModelProfile }, e: AdviceProvider & { profile: ModelProfile }) {
  const reasons: string[] = [];
  const cautions: string[] = [];
  const gp = g.profile, ep = e.profile;
  if (gp.speed >= 4) reasons.push(`生成AI（${name(g)}）は応答が速く、ヒアリングのやり取りで待たされにくくなります`);
  else if (gp.depth >= 4) reasons.push(`生成AI（${name(g)}）は推論力が高く、最初の案から質の高いものが出やすくなります`);
  if (ep.depth >= 4) reasons.push(`評価AI（${name(e)}）は推論力が高く、抜け漏れ・誤りの指摘と、直した案の質を支えます`);
  if (gp.cost <= 2 && ep.cost <= 2) reasons.push("どちらも費用の安いモデルで、トークンの消費を抑えられます");
  else if (gp.cost < ep.cost) reasons.push("案づくりは費用の軽いほうのモデルにし、費用を確認の質に回しています");
  if (g.vendor !== e.vendor) reasons.push(`提供元が違う（${vendorName(g.vendor)} と ${vendorName(e.vendor)}）ため、同じ癖による見落としに気づきやすくなります`);
  else cautions.push(`どちらも ${vendorName(g.vendor)} です。同じ提供元のモデルは似た見落としをしやすいため、別の提供元の AI も登録すると確認の効果が上がります`);
  if (ep.depth < gp.depth) cautions.push("評価AI のほうが推論力が低めのため、生成AI の誤りを見逃すことがあります");
  if (ep.cost >= 4) cautions.push("評価AI は会話に加えて生成AI の案も読むため入力が多く、費用の大半は評価AI になります");
  if (gp.speed + ep.speed <= 4) cautions.push("2つの AI を順に呼ぶため、1回の案が出るまで時間がかかります");
  for (const x of [g, e]) if (!x.profile.family) cautions.push(`${name(x)} はモデル名から性格を推定できなかったため、目安は普通として計算しています`);
  if (g.vendor === "mock" || e.vendor === "mock") cautions.push("模擬AI（開発用）を含みます。品質の確認には本物の AI を使ってください");
  return { reasons, cautions };
}

function singleReasons(g: AdviceProvider & { profile: ModelProfile }) {
  const reasons: string[] = [];
  const cautions: string[] = [];
  const gp = g.profile;
  if (gp.family) reasons.push(gp.family);
  if (gp.speed >= 4) reasons.push("応答が速く、やり取りを軽く進められます");
  if (gp.depth >= 4) reasons.push("推論力が高く、1つの AI でも抜け漏れの少ない案を期待できます");
  if (gp.cost <= 2) reasons.push("費用が安く、トークンの消費を抑えられます");
  cautions.push("評価する AI がいないため、案の確認は人が行います");
  if (!gp.family) cautions.push("モデル名から性格を推定できなかったため、目安は普通として計算しています");
  if (g.vendor === "mock") cautions.push("模擬AI（開発用）です。品質の確認には本物の AI を使ってください");
  return { reasons, cautions };
}

/**
 * 組織に登録済みの AI から、目的ごとのおすすめの組み合わせを作る。
 * confidential: 機密プロジェクト（社外に送る AI は使わない）
 */
export function recommendModelCombos(providers: AdviceProvider[], opts: { confidential?: boolean } = {}): ModelAdvice {
  const usable = providers.filter((x) => !opts.confidential || x.isLocal);
  const profiles = usable.map((x) => ({ ...x, profile: modelProfile(x.vendor, x.model) }));
  const notes: string[] = [];
  if (!profiles.length) {
    notes.push(opts.confidential ? "機密プロジェクトで使えるローカルLLMが登録されていません" : "AI が登録されていません。「AI設定」で登録してください");
    return { profiles, single: [], review: [], notes };
  }
  const goals = Object.keys(ADVICE_GOALS) as AdviceGoal[];
  // 同じ組み合わせが複数の目的で選ばれたら、1つにまとめる
  const add = (list: ModelCombo[], goal: AdviceGoal, c: Omit<ModelCombo, "goals">) => {
    const same = list.find((x) => x.generatorId === c.generatorId && x.evaluatorId === c.evaluatorId);
    if (same) same.goals.push(goal);
    else list.push({ goals: [goal], ...c });
  };
  // 点数が同じなら、登録の順（先に登録した AI）を優先する
  const single: ModelCombo[] = [];
  for (const goal of goals) {
    let best = profiles[0]!;
    let bestScore = -Infinity;
    for (const g of profiles) {
      const s = score(comboAxes(g.profile, null), goal) - (g.vendor === "mock" ? 3 : 0);
      if (s > bestScore + 1e-9) [best, bestScore] = [g, s];
    }
    add(single, goal, { mode: "single", generatorId: best.id, evaluatorId: null, axes: comboAxes(best.profile, null), ...singleReasons(best) });
  }
  const review: ModelCombo[] = [];
  if (profiles.length < 2) {
    notes.push("単独AI＋評価AI には、生成AI と別の AI がもう1つ必要です（自分の案を自分で審査すると、見落としに気づきにくいため）");
  } else {
    for (const goal of goals) {
      let best: [typeof profiles[number], typeof profiles[number]] | null = null;
      let bestScore = -Infinity;
      for (const g of profiles)
        for (const e of profiles) {
          if (g.id === e.id) continue;
          const s = pairScore(g, e, goal);
          if (s > bestScore + 1e-9) [best, bestScore] = [[g, e], s];
        }
      const [g, e] = best!;
      add(review, goal, { mode: "review", generatorId: g.id, evaluatorId: e.id, axes: comboAxes(g.profile, e.profile), ...reviewReasons(g, e) });
    }
    if (new Set(profiles.map((x) => x.vendor)).size < 2) notes.push("登録済みの AI がすべて同じ提供元です。評価AI は別の提供元にすると、見落としに気づきやすくなります");
  }
  notes.push("目安はモデル名の系統から推定したものです。実際の速さ・料金は、提供元の最新の案内と「使用量」で確かめてください。どれを使うかは、あなたが決めてください");
  return { profiles, single, review, notes };
}
