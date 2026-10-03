# AI の登録と API キー

要件ナビで使う AI は、組織の管理者が「AI設定・プロジェクト」→「AIの登録」で登録します。標準の AI は **Claude・ChatGPT・Gemini** の3つです。AI ごとに API キーが必要です（キーは組織ごとに登録します）。ChatGPT と Gemini はキーを[自動で発行](#api-キーの自動発行)でき、Claude は提供元の画面で発行したキーを貼り付けます。

## 標準の AI と API キー

| AI | 提供元 | 画面での名前 | 発行する場所 | キーの形 |
| --- | --- | --- | --- | --- |
| Claude | Anthropic | Claude APIキー | [Claude Console](https://platform.claude.com/settings/keys) →「API Keys」→「Create Key」 | `sk-ant-` で始まる |
| ChatGPT | OpenAI | ChatGPT（OpenAI）APIキー | [OpenAI Platform](https://platform.openai.com/api-keys) →「API keys」→「Create new secret key」 | `sk-` で始まる |
| Gemini | Google | Gemini APIキー | [Google AI Studio](https://aistudio.google.com/apikey) →「Get API key」→「Create API key」 | `AIza` または `AQ.` で始まる |

- API の料金は、チャットの有料プラン（Claude の Pro・Max、ChatGPT Plus、Gemini アプリの有料プランなど）とは**別**です。提供元の画面で API の支払いを設定してください。
- Gemini の無料枠では、送った内容が Google のサービス改善に使われることがあります。業務で使う場合は、有料での利用条件を確認してください。
- キーの全文が見られるのは、提供元の画面で発行したときだけです。
- モデルIDは各社で頻繁に変わるため、登録画面の「モデル一覧」から最新のものを選んでください（[Claude](https://platform.claude.com/docs/en/about-claude/models/overview)・[OpenAI](https://platform.openai.com/docs/models)・[Gemini](https://ai.google.dev/gemini-api/docs/models)）。

標準の AI のほかに、社外に送れないプロジェクト向けの「ローカルLLM（Ollama）」（キー不要）と、お試し用の「模擬AI（開発用）」があります。

## API キーの自動発行

提供元が公式に用意している方法だけを使って、API キーを自動で発行できます。

| AI | 自動発行 | 必要なもの | 発行されるキー |
| --- | --- | --- | --- |
| Claude | **できません**（Anthropic の決まりで、API キーは Claude Console でしか作れません） | ― | 発行したキーを貼り付けると、キーの確認とモデル一覧の取得は自動 |
| ChatGPT | できます | OpenAI の**管理用キー**（Admin key、`sk-admin-` で始まる） | OpenAI のプロジェクトに作る、要件ナビ専用の**サービスアカウント**のキー |
| Gemini | できます（サーバーの設定が必要） | Google Cloud のプロジェクトのオーナー（または編集者）の Google アカウント | **Gemini API だけに使える**ように制限したキー |

発行したキーは画面に表示せず、そのまま暗号化して保存します（表示は末尾4桁）。登録の直後に、そのキーで接続を確かめ、モデルIDが提供元の一覧にあるかを調べます。どの方法で発行したか（OpenAI のプロジェクトとサービスアカウント、Google Cloud のプロジェクト）は監査ログに残ります。

### ChatGPT: 管理用キーで発行する

1. [OpenAI Platform の Admin keys](https://platform.openai.com/settings/organization/admin-keys) で管理用キーを作る（組織のオーナーだけが作れます）。プロジェクトとサービスアカウントを管理する権限を付けてください
2. 要件ナビの「ChatGPT を登録」→「自動で発行」に管理用キーを貼り付け、「プロジェクトを読み込む」
3. キーを作るプロジェクト（または「新しいプロジェクト「要件ナビ」を作る」）・キーの有効期限・モデルIDを選んで「発行して登録」

- **管理用キーは保存しません。** 発行の処理の間だけ使い、データベースにも監査ログにも残しません。組織全体を操作できる強いキーなので、使い終わったら OpenAI Platform で無効にしてもかまいません（発行したキーは使い続けられます）
- 発行したキーは、OpenAI Platform のプロジェクトの「Service accounts」に「要件ナビ <組織名>」として表示されます。不要になったら、そこで削除します
- 組織の方針でキーの有効期限が必須の場合は、有効期限（90日・180日・365日）を選んでください。期限が近づいたら、もう一度「発行して登録」で新しいキーを作り、古い AI の登録を削除します

### Gemini: Google でログインして発行する

1. 「Gemini を登録」→「自動で発行」→「Google でログイン」
2. Google Cloud のプロジェクトのオーナー（または編集者）のアカウントでログインし、Google Cloud の操作を許可する
3. キーを作るプロジェクトとモデルIDを選んで「キーを作って登録」

要件ナビは、選んだプロジェクトで Gemini API（`generativelanguage.googleapis.com`）を有効にし、Gemini API だけに使えるように制限したキー（表示名「要件ナビ <組織名>」）を作ります。作ったキーは、Google Cloud コンソールの「API とサービス」→「認証情報」に表示されます。新しいキーが使えるようになるまで1〜2分かかることがあります。

- **Google のログインの情報は保存しません。** アクセストークンは暗号化して画面に渡し、ログインした本人が1時間以内に使うときだけ受け付けます
- 要件ナビは、Google に「Google Cloud のデータの表示と管理」（`cloud-platform`）を求めます。プロジェクトの一覧の取得・Gemini API の有効化・キーの作成だけに使います

#### サーバーの設定（初回だけ、要件ナビの運用担当者）

Google でのログインには、要件ナビ用の OAuth クライアントが必要です。

1. [Google Cloud コンソール](https://console.cloud.google.com/)で、要件ナビ用のプロジェクトを選ぶ（キーを作るプロジェクトとは別でもかまいません）
2. 「API とサービス」→「ライブラリ」で、**Cloud Resource Manager API**・**Service Usage API**・**API Keys API** を有効にする
3. 「Google Auth Platform」（OAuth 同意画面）を設定する。社内（Google Workspace）だけで使うなら対象を「内部」にします。「外部」で公開前（テスト中）の場合は、ログインする人をテストユーザーに追加します
4. 「クライアント」→「クライアントを作成」→ 種類「ウェブ アプリケーション」。**承認済みのリダイレクト URI** に `<要件ナビのURL>/api/oauth/google/callback` を登録する（例: `http://localhost:8787/api/oauth/google/callback`。localhost 以外は https が必要です）
5. 表示されたクライアント ID とシークレットを、サーバーに設定する

| 動かし方 | 設定 |
| --- | --- |
| Docker Desktop | `.env` の `GOOGLE_OAUTH_CLIENT_ID`・`GOOGLE_OAUTH_CLIENT_SECRET`（ポートを変えた・ほかのPCから使う場合は `PUBLIC_URL` も）を書いて `docker compose up -d` |
| AWS（GitHub Actions） | シークレットを AWS Secrets Manager に文字列で保存し、Environment `aws-production` の変数 `GOOGLE_OAUTH_CLIENT_ID` と `GOOGLE_OAUTH_SECRET_ARN`（シークレットの完全な ARN）を設定して「Deploy to AWS」を実行。戻り先の URI は実行結果の `GoogleOAuthRedirectUri` |
| AWS（手元から CDK） | `cdk deploy -c googleOAuthClientId=… -c googleOAuthSecretArn=…` |

設定していない場合は、画面に Google Cloud Shell で実行するコマンドを表示します。

```bash
gcloud config set project <プロジェクトID>
gcloud services enable generativelanguage.googleapis.com apikeys.googleapis.com
gcloud services api-keys create --key-id=arn-gemini --display-name="要件ナビ" --api-target=service=generativelanguage.googleapis.com
gcloud services api-keys get-key-string arn-gemini
```

最後に表示された文字列を「キーを貼り付け」で登録します。

### Claude: 発行して貼り付ける

Anthropic は、API キーを外部のシステムから発行する仕組みを用意していません（Admin API でできるのは、キーの一覧・名前の変更・無効化だけです）。[Claude Console](https://platform.claude.com/settings/keys) で発行したキーを「キーを貼り付け」に入れ、「キーを確かめる」を押すと、キーが使えるかを確かめてモデルの一覧を取得します。一覧からモデルを選んで「登録」します。

## キーを貼り付けて登録する

1. 「AI設定・プロジェクト」→「AIの登録」で、使う AI のカード（例:「Claude を登録」）を押す（ChatGPT と Gemini は「キーを貼り付け」を選ぶ）
2. 表示される手順のとおりに、提供元で API キーを発行して貼り付け、「キーを確かめる」
3. 取得したモデルの一覧からモデルを選び（または手で入れ）、表示名（任意）を入れて「登録」

同じ AI を、モデルを変えて複数登録することもできます（例: 生成用と評価用）。

### 貼り間違いの確認

登録のときに、次の間違いを見つけて止めます（キーそのものは画面にもログにも出しません）。

| 間違い | 表示 |
| --- | --- |
| 別の AI のキーを貼った（例: Claude に Gemini のキー） | 「これは Gemini のキーの形式です。…種類「Gemini」で登録してください」 |
| Claude の管理用キー（Admin API キー）を貼った | 通常の API キーを入れるよう案内 |
| 空白・改行・全角文字が入っている（別の行まで貼った） | キーだけを貼るよう案内 |

前後の空白・引用符・`Bearer ` は自動で取り除きます。キーの形式は提供元が変えることがあるため、見慣れない形式のキーは止めません（間違っていれば、最初に AI を呼び出したときに認証エラーになります）。互換サーバーや社内プロキシを経由する場合（「接続先」を指定した場合）は、形式を確かめません。

## 登録したキーを確かめる

- 「登録済みのAI」の表に、AI ごとのキーの名前と**末尾4桁**（`••••abcd`）が出ます。提供元の画面にあるキーの一覧と、末尾4桁で照らし合わせてください。
- キーの全文は、要件ナビでは表示できません（暗号化して保存しているため）。分からなくなったときは、提供元で新しいキーを発行し、「変更」→「新しい○○APIキー」に入れて「保存」します。空欄のままなら、今のキーのままです。
- 「登録済みのAI」の「接続確認」で、保存したキーで提供元に接続できるか、モデルIDが提供元の一覧にあるかを確かめます（モデルの一覧を取得するだけなので、トークンは使いません）。モデルIDが一覧にないときは、「変更」に一覧が出るので選び直します
- 実際に使えているかは、管理者向けの「今月の利用量」で AI ごとの使用量を見ると分かります
- 「監査ログ」に、キーの登録・変更の記録（誰が・いつ）が残ります。キーそのものは記録しません。

## API で登録する場合

`POST /api/orgs/{orgId}/providers`（管理者）

```json
{ "vendor": "anthropic", "model": "<モデルID>", "label": "Claude（本番）", "apiKey": "<Claude APIキー>" }
```

`vendor` は `anthropic`（Claude）・`openai`（ChatGPT）・`gemini`（Gemini）・`ollama`・`mock` です。応答には `vendorName`（Claude など）と `keyName`（Claude APIキー など）が入ります。AI ごとの名前・発行場所・料金の注意・自動発行の方法は `GET /api/meta` の `vendors` と `keyAutoIssue` で取得できます。

| 操作 | API（すべて管理者） |
| --- | --- |
| 登録前にキーを確かめ、モデル一覧を取得 | `POST /api/orgs/{orgId}/providers/check` `{vendor, apiKey, endpoint?}` |
| 登録済みの AI の接続確認 | `POST /api/orgs/{orgId}/providers/{id}/check` |
| ChatGPT: プロジェクトの一覧 | `POST /api/orgs/{orgId}/providers/auto/openai/projects` `{adminKey}` |
| ChatGPT: 発行して登録 | `POST /api/orgs/{orgId}/providers/auto/openai` `{adminKey, projectId?, projectName?, expiresInDays?, model, label?, monthlyTokenLimit?}` |
| Gemini: Google のログインを始める | `GET /api/orgs/{orgId}/providers/auto/google/start` → `{url}`（戻り先 `/api/oauth/google/callback` から画面の `#google-session=…` に戻る） |
| Gemini: プロジェクトの一覧 | `POST /api/orgs/{orgId}/providers/auto/google/projects` `{session}` |
| Gemini: 作って登録 | `POST /api/orgs/{orgId}/providers/auto/google` `{session, projectId, model, label?, monthlyTokenLimit?}` |
