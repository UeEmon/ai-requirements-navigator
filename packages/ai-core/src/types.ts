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
  /**
   * プロンプトのキャッシュを保つ時間（Claude のみ。既定 5m）。
   * 1h は書き込みの料金が上がるかわりに、利用者が考えている間（5分を超える間隔）もキャッシュが残る
   */
  cacheTtl?: CacheTtl;
}

export type CacheTtl = "5m" | "1h";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  /** 指示（呼び出しの種類ごとに固定の文。キャッシュの対象） */
  system: string;
  /**
   * 呼び出しをまたいで変わらない前提（プロジェクト・確定済みの要件・資料など）。
   * 最初の利用者メッセージの先頭に置き、キャッシュの対象にする。
   * 変わる部分（回答・評価する案など）は messages に入れる
   */
  context?: string;
  messages: ChatMessage[];
  /** JSONのみを返すようモデルに要求する */
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  /** 入力トークンの合計（キャッシュから読んだ分・キャッシュに書いた分を含む） */
  inputTokens?: number;
  outputTokens?: number;
  /** 入力のうち、キャッシュから読んだトークン（料金が安い） */
  cachedInputTokens?: number;
  /** 入力のうち、キャッシュに書き込んだトークン（Claude のみ） */
  cacheWriteTokens?: number;
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
