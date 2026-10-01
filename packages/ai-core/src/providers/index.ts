import type { AIProvider, FetchLike, ProviderConfig } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";

export { AnthropicProvider, GeminiProvider, MockProvider, OllamaProvider, OpenAIProvider };
export { defaultMockHandler, type MockHandler } from "./mock.js";

export interface FactoryOptions {
  fetchImpl?: FetchLike;
  /** false の場合 vendor: "mock" を拒否する（本番用） */
  allowMock?: boolean;
}

/** 新しいベンダーを追加するときは、ここに1行足すだけでよい */
export function createProvider(cfg: ProviderConfig, opts: FactoryOptions = {}): AIProvider {
  const f = opts.fetchImpl ?? fetch;
  switch (cfg.vendor) {
    case "anthropic":
      return new AnthropicProvider(cfg, f);
    case "openai":
      return new OpenAIProvider(cfg, f);
    case "gemini":
      return new GeminiProvider(cfg, f);
    case "ollama":
      return new OllamaProvider(cfg, f);
    case "mock":
      if (opts.allowMock === false) throw new Error("模擬AIは無効化されています");
      return new MockProvider(cfg.id, undefined, { label: cfg.label });
    default: {
      const v: never = cfg.vendor;
      throw new Error(`未対応のベンダーです: ${String(v)}`);
    }
  }
}
