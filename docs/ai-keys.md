# AI の登録と API キー

要件ナビで使う AI は、組織の管理者が「AI設定・プロジェクト」→「AIの登録」で登録します。標準の AI は **Claude・ChatGPT・Gemini** の3つです。AI ごとに、その提供元で発行した API キーが必要です（キーは組織ごとに登録します）。

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

## 登録する

1. 「AI設定・プロジェクト」→「AIの登録」で、使う AI のカード（例:「Claude を登録」）を押す
2. 表示される手順のとおりに、提供元で API キーを発行する
3. モデルID・表示名（任意）・その AI の API キーを入れて「登録」

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
- キーが動くかは、ヒアリングを1回進める（または UML を生成する）と分かります。キーが違えば、進行状況にその AI の失敗が出ます。管理者向けの「今月の利用量」に、AI ごとの使用量が出ていれば正常に呼べています。
- 「監査ログ」に、キーの登録・変更の記録（誰が・いつ）が残ります。キーそのものは記録しません。

## API で登録する場合

`POST /api/orgs/{orgId}/providers`（管理者）

```json
{ "vendor": "anthropic", "model": "<モデルID>", "label": "Claude（本番）", "apiKey": "<Claude APIキー>" }
```

`vendor` は `anthropic`（Claude）・`openai`（ChatGPT）・`gemini`（Gemini）・`ollama`・`mock` です。応答には `vendorName`（Claude など）と `keyName`（Claude APIキー など）が入ります。AI ごとの名前・発行場所・料金の注意は `GET /api/meta` の `vendors` で取得できます。
