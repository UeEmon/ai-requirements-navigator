import type { AIProvider, CompletionRequest, CompletionResult, FetchLike, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";
import { postJson, trimSlash } from "./http.js";

/** Google Gemini API (generateContent) */
export class GeminiProvider implements AIProvider {
  readonly vendor = "gemini" as const;
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
    this.label = cfg.label ?? `Gemini (${cfg.model})`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = Date.now();
    const base = trimSlash(this.cfg.endpoint ?? "https://generativelanguage.googleapis.com");
    const data = await postJson(
      this.fetchImpl,
      this.id,
      `${base}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { "x-goog-api-key": this.cfg.apiKey! },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 4096,
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      },
      req.signal,
    );
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts.map((p: any) => p.text ?? "").join(""),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
      latencyMs: Date.now() - t0,
    };
  }
}
