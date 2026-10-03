import type { FetchLike, Vendor } from "../types.js";
import { trimSlash } from "./http.js";

/**
 * API キーで提供元のモデル一覧を取得する（キーの確認を兼ねる。トークンは消費しない）。
 * エラーの本文にはキーの一部が含まれることがあるため、利用者に見せる文は自前で作る。
 */
export interface ModelEntry {
  id: string;
  name: string;
}

export type KeyCheckReason = "auth" | "permission" | "billing" | "network" | "notfound" | "other";

export class KeyCheckError extends Error {
  constructor(
    message: string,
    readonly reason: KeyCheckReason,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KeyCheckError";
  }
}

/** キーらしい文字列を伏せる（エラー文に混ざったときのため） */
export function redactSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_\-*]{4,}/g, "sk-…")
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, "AIza…")
    .replace(/AQ\.[0-9A-Za-z_\-.]{6,}/g, "AQ.…")
    .replace(/ya29\.[0-9A-Za-z_\-.]+/g, "ya29.…");
}

const NAMES: Record<string, string> = { anthropic: "Claude", openai: "ChatGPT（OpenAI）", gemini: "Gemini", ollama: "ローカルLLM" };

export function keyCheckMessage(vendor: Vendor, status: number, detail = ""): KeyCheckError {
  const n = NAMES[vendor] ?? vendor;
  if (status === 401) return new KeyCheckError(`${n} の API キーが正しくないか、無効になっています。提供元の画面でキーを確認し、入れ直してください`, "auth", status);
  if (status === 403) return new KeyCheckError(`${n} の API キーに、この操作の権限がありません（プロジェクトや組織の設定を確認してください）`, "permission", status);
  if (status === 402 || status === 429) return new KeyCheckError(`${n} の利用上限か支払い設定で止められています。提供元の画面で API の支払い（クレジット）と上限を確認してください`, "billing", status);
  if (status === 404) return new KeyCheckError(`${n} に接続できましたが、見つかりませんでした（接続先かモデルIDを確認してください）`, "notfound", status);
  return new KeyCheckError(`${n} から HTTP ${status} が返りました${detail ? `：${redactSecrets(detail).slice(0, 200)}` : ""}`, "other", status);
}

async function getJson(fetchImpl: FetchLike, vendor: Vendor, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal });
  } catch (e) {
    throw new KeyCheckError(`${NAMES[vendor] ?? vendor} に接続できませんでした（ネットワーク・プロキシの設定を確認してください）: ${redactSecrets((e as Error).message).slice(0, 120)}`, "network");
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? "";
    } catch {
      /* 本文は使わない */
    }
    throw keyCheckMessage(vendor, res.status, typeof detail === "string" ? detail : "");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KeyCheckError("応答がJSONではありません（接続先を確認してください）", "other", res.status);
  }
}

/** チャットに使えない OpenAI のモデル（音声・画像・埋め込みなど）を除く */
const OPENAI_NON_CHAT = /(audio|realtime|tts|transcribe|whisper|dall-e|image|embedding|moderation|search|davinci|babbage|instruct)/;

export async function listModels(
  vendor: Vendor,
  cfg: { apiKey?: string | null; endpoint?: string | null },
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ModelEntry[]> {
  switch (vendor) {
    case "anthropic": {
      const base = trimSlash(cfg.endpoint ?? "https://api.anthropic.com");
      const j = await getJson(fetchImpl, vendor, `${base}/v1/models?limit=100`, { "x-api-key": cfg.apiKey ?? "", "anthropic-version": "2023-06-01" }, signal);
      return (j.data ?? []).map((m: any) => ({ id: String(m.id), name: String(m.display_name ?? m.id) }));
    }
    case "openai": {
      const base = trimSlash(cfg.endpoint ?? "https://api.openai.com");
      const j = await getJson(fetchImpl, vendor, `${base}/v1/models`, { authorization: `Bearer ${cfg.apiKey ?? ""}` }, signal);
      const all = (j.data ?? []) as Array<{ id: string; created?: number }>;
      // 標準の接続先では、チャットに使うモデルだけを新しい順に出す（互換サーバーではそのまま）
      const list = cfg.endpoint ? all : all.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_NON_CHAT.test(m.id));
      return [...list].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map((m) => ({ id: m.id, name: m.id }));
    }
    case "gemini": {
      const base = trimSlash(cfg.endpoint ?? "https://generativelanguage.googleapis.com");
      const out: ModelEntry[] = [];
      let token = "";
      for (let page = 0; page < 5; page++) {
        const j = await getJson(fetchImpl, vendor, `${base}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { "x-goog-api-key": cfg.apiKey ?? "" }, signal);
        for (const m of j.models ?? []) {
          if (!(m.supportedGenerationMethods ?? []).includes("generateContent")) continue;
          const id = String(m.name ?? "").replace(/^models\//, "");
          if (!/^gemini/.test(id)) continue;
          out.push({ id, name: String(m.displayName ?? id) });
        }
        token = j.nextPageToken ?? "";
        if (!token) break;
      }
      return out;
    }
    case "ollama": {
      const base = trimSlash(cfg.endpoint ?? "http://localhost:11434");
      const j = await getJson(fetchImpl, vendor, `${base}/api/tags`, {}, signal);
      return (j.models ?? []).map((m: any) => ({ id: String(m.name), name: String(m.name) }));
    }
    case "mock":
      return [{ id: "mock", name: "模擬AI" }];
  }
}
