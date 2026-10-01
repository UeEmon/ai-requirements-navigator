/** 対応するAIベンダー。新しいベンダーは providers/ にアダプタを追加し、factory に登録する。 */
export type Vendor = "anthropic" | "openai" | "gemini" | "ollama" | "mock";

export interface ProviderConfig {
  /** 組織内で一意なID（DBの provider_credentials.id） */
  id: string;
  vendor: Vendor;
  /** モデル名。組織の管理者が登録時に指定する（例: 各社の最新モデル名） */
  model: string;
  /** 復号済みのAPIキー。ローカルLLMでは不要 */
  apiKey?: string;
  /** エンドポイントの上書き（Azure OpenAI、プロキシ、Ollamaのホストなど） */
  endpoint?: string;
  /** 画面表示名 */
  label?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** JSONのみを返すようモデルに要求する */
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  latencyMs: number;
}

export interface AIProvider {
  readonly id: string;
  readonly vendor: Vendor;
  readonly model: string;
  readonly label: string;
  /** 社外にデータを送信しないか（機密プロジェクトの判定に使う） */
  readonly isLocal: boolean;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type FetchLike = typeof fetch;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
