import type { ChatMessage, CompletionRequest } from "../types.js";

/**
 * プロンプトのキャッシュの共通処理。
 * どのAIも「先頭から同じ部分」をキャッシュするため、変わらない前提（context）を最初の利用者メッセージの先頭に置く。
 */

/** context を最初の利用者メッセージの先頭に足したメッセージ（明示の印を使わないAI向け） */
export function withContext(req: CompletionRequest): ChatMessage[] {
  if (!req.context) return req.messages;
  const i = req.messages.findIndex((m) => m.role === "user");
  if (i < 0) return [{ role: "user", content: req.context }, ...req.messages];
  return req.messages.map((m, j) => (j === i ? { ...m, content: `${req.context}\n\n${m.content}` } : m));
}

/**
 * 同じ指示・前提の呼び出しを同じキャッシュに寄せるための鍵（ChatGPT の prompt_cache_key）。
 * 中身そのものは送らず、ハッシュの先頭だけを使う
 */
export function promptCacheKey(req: CompletionRequest): string {
  const s = `${req.system}\0${req.context ?? ""}`;
  // 53ビットの簡易ハッシュ（cyrb53）。暗号用途ではなく、同じ文に同じ鍵を付けるだけ
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `arn-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}
