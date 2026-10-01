import type { AIProvider, CompletionRequest, CompletionResult, FetchLike, ProviderConfig } from "../types.js";
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
        messages: [{ role: "system", content: req.system }, ...req.messages],
        ...(req.json ? { format: "json" } : {}),
        options: { num_predict: req.maxTokens ?? 4096 },
      },
      req.signal,
    );
    return {
      text: data.message?.content ?? "",
      usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
      latencyMs: Date.now() - t0,
    };
  }
}
