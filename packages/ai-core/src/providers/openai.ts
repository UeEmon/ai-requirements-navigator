import type { AIProvider, CompletionRequest, CompletionResult, FetchLike, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";
import { postJson, trimSlash } from "./http.js";

/** OpenAI Chat Completions API（互換APIのエンドポイントにも endpoint で対応） */
export class OpenAIProvider implements AIProvider {
  readonly vendor = "openai" as const;
  readonly isLocal = false;
  readonly id: string;
  readonly model: string;
  readonly label: string;
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.apiKey) throw new ProviderError("APIキーが登録されていません", cfg.id);
    this.id = cfg.id;
    this.model = cfg.model;
    this.label = cfg.label ?? `GPT (${cfg.model})`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = Date.now();
    const base = trimSlash(this.cfg.endpoint ?? "https://api.openai.com");
    const data = await postJson(
      this.fetchImpl,
      this.id,
      `${base}/v1/chat/completions`,
      { authorization: `Bearer ${this.cfg.apiKey}` },
      {
        model: this.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        max_completion_tokens: req.maxTokens ?? 4096,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      },
      req.signal,
    );
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
      latencyMs: Date.now() - t0,
    };
  }
}
