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
    throw new ProviderError(`接続できませんでした: ${(e as Error).message}`, providerId);
  }
  const text = await res.text();
  if (!res.ok) {
    // APIキーなどの機密情報がエラーに混ざらないよう、本文は先頭のみ
    throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, providerId, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("応答がJSONではありません", providerId, res.status);
  }
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
