import type { AIProvider, CompletionRequest, CompletionResult, FetchLike, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";
import { postJson, trimSlash } from "./http.js";

/** Anthropic Messages API */
export class AnthropicProvider implements AIProvider {
  readonly vendor = "anthropic" as const;
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
    this.label = cfg.label ?? `Claude (${cfg.model})`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = Date.now();
    const base = trimSlash(this.cfg.endpoint ?? "https://api.anthropic.com");
    const data = await postJson(
      this.fetchImpl,
      this.id,
      `${base}/v1/messages`,
      { "x-api-key": this.cfg.apiKey!, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: req.messages,
      },
      req.signal,
    );
    const text = (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    return {
      text,
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
      latencyMs: Date.now() - t0,
    };
  }
}
