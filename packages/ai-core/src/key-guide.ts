/**
 * 自動で取得できない API キー・トークンの取得方法（画面の「APIキー・トークンの取得方法」と docs/ai-keys.md で使う）。
 *
 * 自動で取得できるもの:
 *   - ChatGPT の API キー: 管理用キーがあれば、要件ナビが発行する
 *   - Gemini の API キー: サーバーで Google のログインを設定していれば、要件ナビが発行する
 * 自動で取得できないもの（ここで案内する）:
 *   - Claude の API キー（Anthropic に外部から発行する仕組みがない）
 *   - ChatGPT の管理用キー（自動発行に使うキーそのもの）と、管理用キーを使わない場合の API キー
 *   - Gemini の API キー（Google のログインを設定していない場合）
 *   - 課題管理ツール（GitHub・Jira・Backlog）のトークン
 *
 * 画面の名前やURLは提供元が変えることがあるため、見つからない場合は提供元のヘルプを案内する。
 */
export type KeyGuideGroup = "ai" | "integration";

export interface KeyGuide {
  id: string;
  group: KeyGuideGroup;
  /** 対象（Claude・ChatGPT・GitHub など） */
  target: string;
  /** キーの名前（画面の入力欄と同じ） */
  name: string;
  /** なぜ自動で取得できないか・いつ必要か */
  why: string;
  /** 取得する画面 */
  url: string;
  urlLabel: string;
  /** 取得の手順 */
  steps: string[];
  /** キーの形（先頭の文字など） */
  format?: string;
  /** 要件ナビのどこに入れるか */
  where: string;
  /** 注意 */
  notes?: string[];
  /** 提供元のヘルプ */
  helpUrl?: string;
  /** 代わりに自動で取得できる場合（その説明） */
  autoAlternative?: string;
}

export interface KeyGuideOptions {
  /** Gemini のキーを Google のログインで自動発行できるか（GOOGLE_OAUTH_CLIENT_ID などが設定済み） */
  googleOAuth: boolean;
}

export function keyGuides(opts: KeyGuideOptions): { manual: KeyGuide[]; auto: Array<{ target: string; how: string }> } {
  const manual: KeyGuide[] = [
    {
      id: "claude",
      group: "ai",
      target: "Claude",
      name: "Claude APIキー",
      why: "Anthropic には、外部のシステムから API キーを発行する仕組みがありません。Claude Console で発行して貼り付けます。",
      url: "https://platform.claude.com/settings/keys",
      urlLabel: "Claude Console の API Keys",
      steps: [
        "Claude Console（platform.claude.com）にログインする（アカウントがなければ作る）",
        "「Settings」→「API Keys」→「Create Key」を押す",
        "ワークスペースを選び、名前（例: 要件ナビ）を入れて作る",
        "表示されたキーをコピーする（全文が見られるのはこのときだけ）",
        "「Billing」で API の支払い（クレジット）を設定する",
      ],
      format: "sk-ant- で始まる",
      where: "「AI設定」→「Claude を登録」→ 貼り付ける（モデルの一覧を自動で取得）→ モデルをプルダウンから選んで「登録」",
      notes: ["Claude の Pro・Max などのプランとは別に、API の支払いが必要です"],
      helpUrl: "https://platform.claude.com/docs/en/get-api-key",
    },
    {
      id: "openai-admin",
      group: "ai",
      target: "ChatGPT",
      name: "ChatGPT（OpenAI）の管理用キー（Admin key）",
      why: "ChatGPT の API キーを自動で発行するために使うキーです。管理用キーそのものは、OpenAI Platform でしか作れません。",
      url: "https://platform.openai.com/settings/organization/admin-keys",
      urlLabel: "OpenAI Platform の Admin keys",
      steps: [
        "OpenAI Platform に、組織のオーナーのアカウントでログインする",
        "「Settings」→「Organization」→「Admin keys」→「Create admin key」を押す",
        "名前（例: 要件ナビ）を入れ、プロジェクトとサービスアカウントを管理する権限を付けて作る",
        "表示されたキーをコピーする（全文が見られるのはこのときだけ）",
      ],
      format: "sk-admin- で始まる",
      where: "「AI設定」→「ChatGPT を登録」→「自動で発行」→ 貼り付けて「プロジェクトを読み込む」→「キーを発行」→ モデルをプルダウンから選んで「登録」",
      notes: [
        "要件ナビは管理用キーを保存しません（発行の処理の間だけ使います）",
        "組織全体を操作できる強いキーです。使い終わったら OpenAI Platform で無効にしてもかまいません（発行した API キーは使い続けられます）",
      ],
    },
    {
      id: "openai",
      group: "ai",
      target: "ChatGPT",
      name: "ChatGPT（OpenAI）APIキー",
      why: "管理用キーを使わない（使えない）場合は、OpenAI Platform で API キーを発行して貼り付けます。",
      url: "https://platform.openai.com/api-keys",
      urlLabel: "OpenAI Platform の API keys",
      steps: [
        "OpenAI Platform（platform.openai.com）にログインする",
        "「API keys」→「Create new secret key」を押す",
        "名前（例: 要件ナビ）とプロジェクトを選び、権限は「All」のまま作る",
        "表示されたキーをコピーする（全文が見られるのはこのときだけ）",
        "「Settings」→「Billing」で API の支払いを設定する",
      ],
      format: "sk- で始まる（sk-proj- など）",
      where: "「AI設定」→「ChatGPT を登録」→「キーを貼り付け」→ 貼り付ける（モデルの一覧を自動で取得）→ モデルをプルダウンから選んで「登録」",
      notes: ["ChatGPT Plus などの契約とは別に、API の支払いが必要です"],
      autoAlternative: "組織のオーナーなら、管理用キーで自動発行できます",
    },
    {
      id: "gemini",
      group: "ai",
      target: "Gemini",
      name: "Gemini APIキー",
      why: opts.googleOAuth
        ? "Google でログインすれば自動で発行できます。ログインを使わない場合は、Google AI Studio で発行して貼り付けます。"
        : "このサーバーでは Google のログインが設定されていないため、自動では発行できません。Google AI Studio で発行して貼り付けます。",
      url: "https://aistudio.google.com/apikey",
      urlLabel: "Google AI Studio の API キー",
      steps: [
        "Google AI Studio（aistudio.google.com）に Google アカウントでログインする",
        "「Get API key」→「Create API key」を押す",
        "キーを作る Google Cloud のプロジェクトを選ぶ（なければ新しく作る）",
        "表示されたキーをコピーする",
      ],
      format: "AIza または AQ. で始まる",
      where: "「AI設定」→「Gemini を登録」→「キーを貼り付け」→ 貼り付ける（モデルの一覧を自動で取得）→ モデルをプルダウンから選んで「登録」",
      notes: [
        "Google One・Gemini アプリの有料プランとは別です",
        "無料枠では、送った内容が Google のサービス改善に使われることがあります。業務では有料での利用条件を確認してください",
        "Google Cloud Shell で作る方法もあります（docs/ai-keys.md）",
      ],
      helpUrl: "https://ai.google.dev/gemini-api/docs/api-key",
      ...(opts.googleOAuth ? { autoAlternative: "「自動で発行」→「Google でログイン」で発行できます" } : {}),
    },
    {
      id: "github",
      group: "integration",
      target: "GitHub",
      name: "GitHub の個人用アクセストークン（Fine-grained）",
      why: "実装タスクを GitHub Issues に登録するためのトークンです。GitHub の画面でしか作れません。",
      url: "https://github.com/settings/personal-access-tokens/new",
      urlLabel: "GitHub の Fine-grained token の作成",
      steps: [
        "GitHub にログインし、「Settings」→「Developer settings」→「Personal access tokens」→「Fine-grained tokens」→「Generate new token」を押す",
        "名前・有効期限を入れ、「Resource owner」でリポジトリの所有者を選ぶ",
        "「Repository access」で「Only select repositories」を選び、課題を登録するリポジトリを選ぶ",
        "「Permissions」の「Issues」を「Read and write」にする（「Metadata: Read」は自動で付きます）",
        "「Generate token」を押し、表示されたトークンをコピーする",
      ],
      format: "github_pat_ で始まる",
      where: "「プロジェクト設定」→「課題管理ツールとの連携」→ 種類「GitHub Issues」→ 貼り付ける（リポジトリの一覧を自動で読み込み）→ リポジトリを選んで「登録」（ラベルの作成と接続確認は自動）",
      notes: ["組織のリポジトリでは、組織の管理者の承認が必要な場合があります", "要件ナビでリポジトリを自動で作る場合は、「Repository access」を「All repositories」にし、「Administration」と「Contents」も「Read and write」にしてください（組織に作る場合は「Resource owner」をその組織にします）"],
      helpUrl: "https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    },
    {
      id: "jira",
      group: "integration",
      target: "Jira",
      name: "Jira の API トークン",
      why: "実装タスクを Jira に登録するためのトークンです。Atlassian アカウントの画面でしか作れません。",
      url: "https://id.atlassian.com/manage-profile/security/api-tokens",
      urlLabel: "Atlassian アカウントの API トークン",
      steps: [
        "Atlassian アカウントにログインし、「セキュリティ」→「API トークン」を開く",
        "「API トークンを作成する」を押し、名前（例: 要件ナビ）と有効期限を入れて作る",
        "表示されたトークンをコピーする（全文が見られるのはこのときだけ）",
      ],
      where: "「プロジェクト設定」→「課題管理ツールとの連携」→ 種類「Jira」→ ボードの URL・メールアドレスと一緒に貼り付ける（プロジェクトと種別を自動で読み込み）→ 選んで「登録」（接続確認は自動）",
      notes: ["Jira Data Center の場合は、プロフィールの「個人用アクセストークン」で作り、メールアドレスは空にします"],
      helpUrl: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
    },
    {
      id: "backlog",
      group: "integration",
      target: "Backlog",
      name: "Backlog の API キー",
      why: "実装タスクを Backlog に登録するためのキーです。Backlog の個人設定でしか作れません。",
      url: "https://support-ja.backlog.com/hc/ja/articles/360035641754",
      urlLabel: "Backlog ヘルプ「API の設定」",
      steps: [
        "Backlog のスペースにログインし、右上のアイコン →「個人設定」を開く",
        "左のメニューの「API」を選ぶ",
        "メモ（例: 要件ナビ）を入れて「登録」を押す",
        "表示された API キーをコピーする",
      ],
      where: "「プロジェクト設定」→「課題管理ツールとの連携」→ 種類「Backlog」→ スペースの URL と一緒に貼り付ける（プロジェクトと種別を自動で読み込み）→ 選んで「登録」（接続確認は自動）",
      notes: ["API キーは、作った人の権限で課題を登録します。課題を登録するプロジェクトに参加しているアカウントで作ってください"],
    },
  ];
  const auto = [
    { target: "ChatGPT", how: "管理用キー（下の「ChatGPT（OpenAI）の管理用キー」の手順で作る）があれば、要件ナビが専用の API キーを発行します" },
    ...(opts.googleOAuth ? [{ target: "Gemini", how: "Google でログインすると、要件ナビが Gemini API 専用のキーを作ります" }] : []),
  ];
  return { manual, auto };
}
