import type { Vendor } from "./types.js";

/**
 * AI の種類ごとの表示名と API キーの案内。
 * Claude・ChatGPT・Gemini を「標準のAI」とし、画面・エラー・監査ログで同じ名前を使う。
 * モデル名は各社で頻繁に変わるため、ここには持たず、提供元のモデル一覧へ案内する。
 */
export interface VendorInfo {
  vendor: Vendor;
  /** 画面に出す名前 */
  name: string;
  /** 提供元 */
  maker: string;
  /** 標準のAI（Claude・ChatGPT・Gemini） */
  standard: boolean;
  /** API キーの名前（キーが不要なら null） */
  keyName: string | null;
  /** キーの先頭の文字（案内に使う。形式は提供元が変えることがある） */
  keyPrefix: string | null;
  /** キーを発行する画面 */
  keyUrl: string | null;
  /** キーを発行する手順（短く） */
  keyHow: string | null;
  /** 料金の注意（チャットの有料プランとは別、など） */
  billingNote: string | null;
  /** モデルIDの一覧 */
  modelsUrl: string | null;
  /** モデル名の入力欄の案内 */
  modelHint: string;
  /** 接続先の既定（ローカルLLM） */
  endpointDefault: string | null;
}

export const VENDOR_INFO: Record<Vendor, VendorInfo> = {
  anthropic: {
    vendor: "anthropic",
    name: "Claude",
    maker: "Anthropic",
    standard: true,
    keyName: "Claude APIキー",
    keyPrefix: "sk-ant-",
    keyUrl: "https://platform.claude.com/settings/keys",
    keyHow: "Claude Console にログイン →「API Keys」→「Create Key」",
    billingNote: "Claude の Pro・Max などのプランとは別に、Claude Console で API の支払い（クレジット）を設定します。",
    modelsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    modelHint: "一覧の「Claude API ID」",
    endpointDefault: null,
  },
  openai: {
    vendor: "openai",
    name: "ChatGPT",
    maker: "OpenAI",
    standard: true,
    keyName: "ChatGPT（OpenAI）APIキー",
    keyPrefix: "sk-",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHow: "OpenAI Platform にログイン →「API keys」→「Create new secret key」",
    billingNote: "ChatGPT Plus などの契約とは別に、OpenAI Platform で API の支払いを設定します。",
    modelsUrl: "https://platform.openai.com/docs/models",
    modelHint: "一覧に出るモデル名",
    endpointDefault: null,
  },
  gemini: {
    vendor: "gemini",
    name: "Gemini",
    maker: "Google",
    standard: true,
    keyName: "Gemini APIキー",
    keyPrefix: "AIza または AQ.",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHow: "Google AI Studio にログイン →「Get API key」→「Create API key」",
    billingNote: "Google One・Gemini アプリの有料プランとは別です。無料枠では、送った内容が Google の改善に使われることがあります（業務では有料の利用を確認してください）。",
    modelsUrl: "https://ai.google.dev/gemini-api/docs/models",
    modelHint: "一覧の「Model code」",
    endpointDefault: null,
  },
  ollama: {
    vendor: "ollama",
    name: "ローカルLLM",
    maker: "Ollama",
    standard: false,
    keyName: null,
    keyPrefix: null,
    keyUrl: null,
    keyHow: null,
    billingNote: null,
    modelsUrl: null,
    modelHint: "ollama pull で取り込んだモデル名",
    endpointDefault: "http://ollama:11434",
  },
  mock: {
    vendor: "mock",
    name: "模擬AI（開発用）",
    maker: "要件ナビ",
    standard: false,
    keyName: null,
    keyPrefix: null,
    keyUrl: null,
    keyHow: null,
    billingNote: null,
    modelsUrl: null,
    modelHint: "mock",
    endpointDefault: null,
  },
};

export const vendorName = (v: Vendor) => VENDOR_INFO[v]?.name ?? v;

/** キーの先頭から、どの AI のキーらしいかを推定する（分からなければ null） */
export function guessKeyVendor(key: string): Vendor | null {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return "gemini";
  if (key.startsWith("sk-")) return "openai";
  return null;
}

export type ApiKeyCheck = { ok: true; key: string } | { ok: false; message: string };

/**
 * 貼り付けた API キーを確かめる。前後の空白・引用符・「Bearer 」は取り除く。
 * 別の AI のキーを貼った、別の行まで貼った、などの間違いを、キーを表示せずに知らせる。
 * 接続先を変えている（互換サーバーなど）ときは、形式の確認はしない。
 */
export function checkApiKey(vendor: Vendor, raw: string, opts: { customEndpoint?: boolean } = {}): ApiKeyCheck {
  const info = VENDOR_INFO[vendor];
  const label = info?.keyName ?? "APIキー";
  const key = raw
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!key) return { ok: false, message: `${label}が空です` };
  if (/\s/.test(key)) return { ok: false, message: `${label}に空白や改行が入っています。キーだけを貼り付けてください` };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, message: `${label}に全角文字などキーで使わない文字が入っています。キーだけを貼り付けてください` };
  if (opts.customEndpoint || !info?.standard) return { ok: true, key };
  const guessed = guessKeyVendor(key);
  if (guessed && guessed !== vendor) {
    const other = VENDOR_INFO[guessed];
    return { ok: false, message: `これは ${other.name} のキーの形式です。${info.name} には ${label}（${info.keyPrefix} で始まるキー）を入れてください。${other.name} として使う場合は、種類「${other.name}」で登録してください` };
  }
  if (vendor === "anthropic" && key.startsWith("sk-ant-admin")) {
    return { ok: false, message: "これは Claude の管理用キー（Admin API キー）です。AI の呼び出しには、Claude Console の「API Keys」で作った通常のキーを入れてください" };
  }
  // 見慣れない形式は止めない（提供元が形式を変えることがあるため。間違っていれば最初の呼び出しで認証エラーになる）
  return { ok: true, key };
}
