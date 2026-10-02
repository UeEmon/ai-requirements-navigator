# 要件ナビ（AI要件定義支援システム）テンプレート

システム開発の専門家でなくても、AIとの対話で **要求分析 → 要件定義** を進め、**UML と仕様書** を出力できるWebシステムのテンプレートです。

- AIは **1つ、または複数** を選べます（Claude / GPT / Gemini / ローカルLLM）
- 複数のときは、各AIの案を **匿名化して別のAIが評価** し、比較と推奨を添えて選択肢として示します
- AIのAPIキーは **組織ごとに管理者が登録** し、暗号化して保存します。登録後の変更や、**月間トークン上限**（組織全体・AIごと）も設定できます
- **AWS とローカルDocker のどちらでも** 同じコンテナイメージで動きます
- AIが **観点の抜け漏れを確認しながら質問** し、回答の候補と用語の説明を添えます
- 成果物は **UML 5種**（ユースケース・クラス・シーケンス・状態遷移・アクティビティ）と **要件定義書（Word / PDF / Markdown）**
- **議事録や既存システムの資料を取り込む** と、AIが現状の課題（資料の引用つき）を分析し、**業務フローの見直し** を含めた初回の要件案を作ります。今のシステムの焼き増しにならないよう、見直し率や引き継がない機能も示します
- **非機能要件シート**（26項目）で、止まらなさ・速さ・セキュリティなどを漏れなく検討します。システムの性格から推奨水準を示し、項目どうしの矛盾を検出し、未検討の項目が残ると確定の前に知らせます。**過大にならないよう**、規模・目的・予算が似たシステムの事例と比べ、事例より高い水準には理由を求めます
- 機能要件・非機能要件は **EARS 記法**（「〜とき、〇〇システムは、〜しなければならない。」など）でそろえ、あいまいな表現を検査します
- 要件から **画面イメージ（ワイヤーフレーム）** を作り、クリックで画面のつながりを確認できます。見た目の細部は設計工程への申し送りにして、要件の確認に集中できるようにしています
- 要件定義を **確定** した後の変更・追加は変更要求として受け付け、設計・画面・実装タスク・登録済みの課題への **影響を分析** してから、変更するかどうかを選べます
- 確定した要件を **実装タスクに分解** し、**GitHub Issues・Jira・Backlog に登録** できます。要件 → ストーリー → 課題のつながりを一覧で確認できます
- 使用するOSSは **再配布可能・著作権表示で利用できるライセンスのみ** です（CIで自動検査）

## すぐに試す（ローカルDocker）

```bash
cp .env.example .env
# MASTER_KEY を設定（Nodeがあれば npm run gen:key、なければ openssl rand -base64 32）
docker compose up --build
```

http://localhost:8787 を開き、次の順に操作します。

1. 右上「組織を作成」
2. 「AI設定・プロジェクト」で AI を登録（APIキーなしで試すなら「模擬AI（開発用）」を3つ）
3. プロジェクトを作成（複数AI＋評価AI）→ 資料があれば「資料分析」で取り込んで分析し、見直し案と要件案を採用（[資料分析と EARS](docs/discovery-and-ears.md)）→「ヒアリング」で質問に答える
4. 案を比較して採用 →「要件一覧」で確認 →「非機能要件」でシステムの性格に答え、26項目を検討（AIの提案を参考にできます）
5. 「UML」で「AIで設計図を作る」（複数AIモードでは、各AIの設計を匿名で比較して選びます）→ 図ごとに SVG / PNG で保存、Mermaid / PlantUML のソースをコピー
6. 「仕様書」で Word / PDF / Markdown を出力（図は画像として埋め込まれます）
7. 「画面」で「AIで画面を作る」→ 画面イメージを確認し、足りない情報や操作を意見として送って作り直す
8. 「変更管理」で要件定義を確定。以後の変更は変更要求として登録し、影響分析の結果を見て判断（[画面と変更管理](docs/screens-and-changes.md)）
9. 「実装連携」で「AIでタスクに分解する」→ CSV で出力するか、管理者が登録した GitHub・Jira・Backlog に課題として登録（[連携の設定](docs/integrations.md)）

本システム自身の要求事項を題材にした **サンプル事例**（資料の分析・EARSの要件65件・非機能要件シート入り）を「AI設定・プロジェクト」から読み込めます。内容は [docs/sample/requirements-navigator.md](docs/sample/requirements-navigator.md) で読めます。

APIキーなしで画面の流れだけを見たい場合は http://localhost:8787/demo.html を開いてください（応答はすべて模擬）。

ローカルLLMを使う場合: `docker compose --profile local-llm up --build` で Ollama も起動し、
AIの登録で種類「ローカルLLM」、接続先 `http://ollama:11434` を指定します（モデルは事前に `docker compose exec ollama ollama pull <モデル名>`）。

## AWS へのデプロイ

```bash
cd deploy/aws
npm install
npx cdk bootstrap        # 初回のみ
npx cdk deploy           # HTTPSにする場合: -c certificateArn=arn:aws:acm:...
```

作られるもの: VPC、ECS Fargate＋ALB、RDS for PostgreSQL、KMS、S3、Cognito、Secrets Manager。
デプロイ後の初期設定:

1. 出力 `BootstrapTokenSecret` の値を Secrets Manager で確認し、`POST /api/orgs`（ヘッダー `x-bootstrap-token`）で組織を作成
2. Cognito にユーザーを作成し、カスタム属性 `custom:org_id` に組織ID、グループ（admin / editor / reviewer / viewer）を設定
3. 画面右上にIDトークンを入力してログイン（ログイン画面の組み込みは今後の課題）

## 構成

```
apps/
  api/           API（Hono）。認証・権限、AIの登録と暗号化、生成ラウンド、要件・仕様書
  web/public/    画面。index.html（本番画面）、demo.html（模擬応答のデモ）
packages/
  ai-core/       AI連携の中核。各社アダプタ、並列生成→匿名化→評価、プロンプト、UML生成、タスク分解
db/migrations/   PostgreSQL のスキーマ（起動時に自動適用）
deploy/aws/      AWS CDK
docs/            要件定義書、UML（Mermaid）、設計判断（ADR）、OSS方針
scripts/         ライセンス検査、テンプレート初期化
```

| 実行環境の違い | 環境変数 | ローカルDocker | AWS |
| --- | --- | --- | --- |
| データ | `STORE` | postgres コンテナ | RDS |
| APIキー暗号化 | `KEY_ENCRYPTION` | `local`（MASTER_KEY） | `aws-kms` |
| 成果物 | `STORAGE` | ボリューム | S3 |
| 認証 | `AUTH_MODE` | `dev` / `oidc`（Keycloak） | `oidc`（Cognito） |

詳しくは [ADR 0003](docs/adr/0003-same-image-aws-and-docker.md)。

## 開発

```bash
npm install
npm run typecheck
npm test                 # TEST_DATABASE_URL があれば PostgreSQL のテストも実行
npm run licenses         # 依存OSSのライセンス検査
npm run dev              # API＋画面を http://localhost:8787 で起動（メモリ保存、MASTER_KEY は必要）
```

### AIプロバイダを追加する

1. `packages/ai-core/src/providers/` に `AIProvider` を実装したクラスを追加
2. `providers/index.ts` の `createProvider` に1行追加し、`Vendor` 型と DB の CHECK 制約に名前を追加
3. 偽の `fetch` を使ったテストを `packages/ai-core/test/core.test.ts` に追加

## このテンプレートから新しいリポジトリを作る

GitHub の「Use this template」で作成した後、次を実行します。

```bash
npm run init:project -- --name "顧客管理システム" --slug crm-system
```

`package.json` の名前を変え、`docs/project/requirements.md` に新システム用の要件定義書の雛形を作ります。
要件はアプリで作成し、出力した仕様書と UML を `docs/project/` に置いて管理します。
要件の追加・変更は GitHub の Issue テンプレート（要件／変更要求）でも受け付けられます。

## ドキュメント

- [ログインの設定（Cognito / Keycloak）](docs/auth.md)
- [実装工程への連携（GitHub / Jira / Backlog）](docs/integrations.md)
- [画面イメージと、確定後の変更管理](docs/screens-and-changes.md)
- [資料の取り込み・分析と、EARS 記法](docs/discovery-and-ears.md)
- [非機能要件シート](docs/nfr.md)
- [要件定義書（ベースライン・実装状況）](docs/requirements.md)
- [UML](docs/uml/)
- [設計判断（ADR）](docs/adr/)
- [OSS利用方針](docs/oss-policy.md)

## ライセンス

[Apache License 2.0](LICENSE)。利用しているOSSの表示は [NOTICE](NOTICE) を参照してください。

## コントリビューション

Issue・プルリクエストを歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。脆弱性の報告は [SECURITY.md](SECURITY.md) の手順でお願いします。
