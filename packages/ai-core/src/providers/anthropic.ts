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
        ...this.cachedPrompt(req),
      },
      req.signal,
    );
    const text = (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    // input_tokens はキャッシュを除いた分なので、読んだ分・書いた分を足して入力の合計にする
    const u = data.usage ?? {};
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    return {
      text,
      truncated: data.stop_reason === "max_tokens",
      usage: {
        inputTokens: u.input_tokens === undefined ? undefined : u.input_tokens + read + write,
        outputTokens: u.output_tokens,
        cachedInputTokens: read,
        cacheWriteTokens: write,
      },
      latencyMs: Date.now() - t0,
    };
  }

  /**
   * キャッシュの印（cache_control）を、変わらない部分の終わりに付ける。
   * 1つ目: 指示（system）の終わり。同じ種類の呼び出しなら、プロジェクトをまたいで使い回せる
   * 2つ目: 前提（context）の終わり。同じプロジェクトで続けて呼ぶと使い回せる
   * 回答や評価する案など毎回変わる部分には付けない（書き込みの割増だけがかかるため）。
   * 短すぎる部分（モデルごとの最小の長さ未満）は、印があってもキャッシュされないだけで害はない
   */
  private cachedPrompt(req: CompletionRequest) {
    const mark = { type: "ephemeral" as const, ...(this.cfg.cacheTtl === "1h" ? { ttl: "1h" } : {}) };
    const system = [{ type: "text", text: req.system, cache_control: mark }];
    if (!req.context) return { system, messages: req.messages };
    const i = req.messages.findIndex((m) => m.role === "user");
    const contextBlock = { type: "text", text: req.context, cache_control: mark };
    const messages =
      i < 0
        ? [{ role: "user", content: [contextBlock] }, ...req.messages]
        : req.messages.map((m, j) => (j === i ? { role: m.role, content: [contextBlock, { type: "text", text: m.content }] } : m));
    return { system, messages };
  }
}
