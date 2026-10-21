import type { AIProvider, CompletionRequest, CompletionResult, FetchLike, ProviderConfig } from "../types.js";
import { withContext } from "./cache.js";
import { postJson, trimSlash } from "./http.js";

/** Ollama（ローカルLLM）。社外にデータを送らないため機密プロジェクトで使える */
export class OllamaProvider implements AIProvider {
  readonly vendor = "ollama" as const;
  readonly isLocal = true;
  readonly id: string;
  readonly model: string;
  readonly label: string;
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.id = cfg.id;
    this.model = cfg.model;
    this.label = cfg.label ?? `ローカルLLM (${cfg.model})`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = Date.now();
    const base = trimSlash(this.cfg.endpoint ?? "http://localhost:11434");
    const data = await postJson(
      this.fetchImpl,
      this.id,
      `${base}/api/chat`,
      {},
      {
        model: this.model,
        stream: false,
        // 直前と先頭が同じ部分は、読み込み済みの計算結果（KVキャッシュ）を使い回す。変わらない部分を先に並べる
        messages: [{ role: "system", content: req.system }, ...withContext(req)],
        // モデルとキャッシュをメモリに残す時間（既定の5分では、利用者が考えている間に消えやすい）
        keep_alive: "30m",
        ...(req.json ? { format: "json" } : {}),
        options: { num_predict: req.maxTokens ?? 4096 },
      },
      req.signal,
    );
    return {
      text: data.message?.content ?? "",
      truncated: data.done_reason === "length",
      usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
      latencyMs: Date.now() - t0,
    };
  }
}
