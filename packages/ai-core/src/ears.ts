/**
 * EARS（Easy Approach to Requirements Syntax）による要件文の表記（機能 F5-7）。
 *
 * 機能要件・非機能要件は、次の5つの型（と複合）の決まった文型で書き、書き手による表現の振れを防ぐ。
 *
 * | 型 | 文型 |
 * | --- | --- |
 * | 普遍 ubiquitous | <システム>は、<応答>。 |
 * | イベント駆動 event | <トリガー>とき、<システム>は、<応答>。 |
 * | 状態駆動 state | <状態>間、<システム>は、<応答>。 |
 * | 望ましくない振る舞い unwanted | <トリガー>場合、<システム>は、<応答>。 |
 * | オプション optional | <機能>がある場合、<システム>は、<応答>。 |
 * | 複合 complex | <状態>間に<トリガー>とき、<システム>は、<応答>。 |
 *
 * <応答> は「〜しなければならない」で終える（義務の表現をそろえる）。
 * 文はAIの出力（構造）から組み立て、人が書いた文は検査（lintEars）で問題を示す。
 */
import { z } from "zod";
import { detectAmbiguity } from "./ambiguity.js";

export const EARS_PATTERNS = {
  ubiquitous: "普遍",
  event: "イベント駆動",
  state: "状態駆動",
  unwanted: "望ましくない振る舞い",
  optional: "オプション",
  complex: "複合",
} as const;
export type EarsPattern = keyof typeof EARS_PATTERNS;

/** EARSで書く要件の区分（目的・利用者・制約はシステムの振る舞いではないため対象外） */
export const EARS_TYPES = ["FR", "NFR"];

const phrase = z.string().max(300).default("");
export const Ears = z.object({
  pattern: z.preprocess((v) => (typeof v === "string" && v in EARS_PATTERNS ? v : "ubiquitous"), z.enum(Object.keys(EARS_PATTERNS) as [EarsPattern, ...EarsPattern[]])),
  /** イベント駆動・望ましくない振る舞い・複合: 「利用者が予約を確定した」「決済に失敗した」 */
  trigger: phrase,
  /** 状態駆動・複合: 「予約の受付期間中である」 */
  state: phrase,
  /** オプション: 「多言語表示の機能」 */
  feature: phrase,
  /** 主語: 「予約システム」 */
  system: z.string().max(60).default("システム"),
  /** 「予約確認メールを送信しなければならない」 */
  response: z.string().min(1).max(500),
});
export type Ears = z.infer<typeof Ears>;

const trimEnd = (s: string, ...tails: string[]) => {
  let t = s.trim().replace(/[。、,.\s]+$/u, "");
  for (const tail of tails) if (t.endsWith(tail)) t = t.slice(0, -tail.length);
  return t.trim();
};

/** 応答の終わりを「〜しなければならない」にそろえる */
export function normalizeResponse(r: string): string {
  let t = trimEnd(r);
  if (/なければならない$/.test(t)) return t;
  if (/ないこと$/.test(t)) return t.replace(/ないこと$/, "ないようにしなければならない");
  if (/すること$/.test(t)) return t.replace(/すること$/, "しなければならない");
  if (/する$/.test(t)) return t.replace(/する$/, "しなければならない");
  if (/こと$/.test(t)) t = t.replace(/こと$/, "");
  // 「送信」「表示」など名詞で終わるものはサ変動詞として扱う
  if (/[ぁ-ん]$/.test(t)) return `${t}ようにしなければならない`;
  return `${t}しなければならない`;
}

/** 構造から要件文を組み立てる */
export function renderEars(e: Ears): string {
  const system = trimEnd(e.system || "システム", "は") || "システム";
  const response = normalizeResponse(e.response);
  const trigger = trimEnd(e.trigger, "とき", "時", "場合", "ならば", "ら");
  const state = trimEnd(e.state, "の間", "間");
  const feature = trimEnd(e.feature, "がある場合", "場合");
  const statePhrase = state ? (/[るいた]$/.test(state) ? `${state}間` : `${state}の間`) : "";
  let head = "";
  switch (e.pattern) {
    case "event":
      head = trigger ? `${trigger}とき、` : "";
      break;
    case "state":
      head = statePhrase ? `${statePhrase}、` : "";
      break;
    case "unwanted":
      head = trigger ? `${trigger}場合、` : "";
      break;
    case "optional":
      head = feature ? (/[るいた]$/.test(feature) ? `${feature}場合、` : `${feature}がある場合、`) : "";
      break;
    case "complex":
      head = [statePhrase ? `${statePhrase}に` : "", trigger ? `${trigger}とき` : ""].join("");
      head = head ? `${head}、` : "";
      break;
  }
  return `${head}${system}は、${response}。`;
}

/** 文から型を推定する（人が書いた文の検査用） */
export function detectEarsPattern(text: string): EarsPattern | null {
  const t = text.trim();
  if (!/は、?.+なければならない/.test(t)) return null;
  const hasTrigger = /とき、/.test(t);
  const hasState = /間(に|、)/.test(t);
  if (hasTrigger && hasState) return "complex";
  if (hasTrigger) return "event";
  if (hasState) return "state";
  if (/がある場合、/.test(t)) return "optional";
  if (/場合、/.test(t)) return "unwanted";
  return "ubiquitous";
}

/** 解釈が分かれやすい言葉 */
const WEAK_TERMS: Array<[RegExp, string]> = [
  [/など|等(?!し)/, "「など」は範囲があいまいです。対象を列挙してください"],
  [/適切に|適宜|必要に応じて/, "「適切に」「必要に応じて」は判断基準が書かれていません"],
  [/可能な限り|できる限り|なるべく/, "努力目標か必須かが分かりません"],
  [/ほぼ|おおむね|程度/, "許容範囲を数値で書いてください"],
  [/及び\/又は|および\/または|and\/or/, "「及び／又は」は解釈が分かれます"],
];

export interface EarsLint {
  pattern: EarsPattern | null;
  ok: boolean;
  issues: string[];
}

/** 要件文がEARSの文型に沿っているか、振れの原因になる表現がないかを調べる */
export function lintEars(text: string, type = "FR"): EarsLint {
  if (!EARS_TYPES.includes(type)) return { pattern: null, ok: true, issues: [] };
  const issues: string[] = [];
  const t = text.trim();
  const obligations = t.match(/なければなら(?:ない|ず)/g)?.length ?? 0;
  if (!obligations) issues.push("「〜しなければならない」で終わる文にしてください（EARSの文型）");
  if (obligations > 1) issues.push("1文に複数の要件が含まれています。要件ごとに分けてください");
  if (obligations && !/^.*?は、/.test(t)) issues.push("主語（「〇〇システムは、」）を書いてください");
  for (const [re, msg] of WEAK_TERMS) if (re.test(t)) issues.push(msg);
  for (const h of detectAmbiguity(t)) issues.push(`「${h.term}」はあいまいです（${h.ask}）`);
  return { pattern: detectEarsPattern(t), ok: issues.length === 0, issues: [...new Set(issues)] };
}

/** AIへの指示（生成・統合・資料分析で共通） */
export const EARS_INSTRUCTIONS = `- 機能要件（FR）と非機能要件（NFR）は EARS 記法の構造で書き、"ears" に入れる。title には ears から組み立てた文を入れる
  - pattern: ubiquitous（常に）/ event（〜とき）/ state（〜の間）/ unwanted（〜の場合＝異常・エラー・不正）/ optional（〜機能がある場合）/ complex（状態＋トリガー）
  - trigger: きっかけとなる出来事（例「利用者が予約を確定した」「決済に失敗した」）。state: 継続する状態（例「予約の受付期間中である」）。feature: 任意の機能（例「多言語表示の機能」）
  - system: 主語となるシステム名（例「予約システム」）。response: システムの応答を「〜しなければならない」で終える（例「予約確認メールを3分以内に送信しなければならない」）
  - 1要件に1つの応答。「など」「適切に」「必要に応じて」「なるべく」などの解釈が分かれる言葉は使わない。数値が不明なら questions で確認する
- 目的（BR）・利用者（AC）・業務ルール（RL）・制約条件（CN）は ears を付けず、title に1文で書く`;

export const EARS_SHAPE = `"ears": { "pattern": "event", "trigger": "...", "state": "", "feature": "", "system": "...", "response": "...しなければならない" }`;
