import { ProviderError, type FetchLike } from "../types.js";

export async function postJson(
  fetchImpl: FetchLike,
  providerId: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError("時間内に応答がありませんでした（待つ時間は AI_TIMEOUT_MS で変えられます）", providerId);
    throw new ProviderError(`接続できませんでした: ${(e as Error).message}`, providerId);
  }
  const text = await res.text();
  if (!res.ok) {
    // APIキーなどの機密情報がエラーに混ざらないよう、本文は先頭のみ。キーらしい文字列も伏せる
    throw new ProviderError(`HTTP ${res.status}: ${redactSecrets(text.slice(0, 300))}`, providerId, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("応答がJSONではありません", providerId, res.status);
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

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
