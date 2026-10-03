# AI要件定義支援システム 要件定義書（ベースライン）

この文書は本テンプレート自体の要件定義です。UML は [docs/uml](./uml) に Mermaid 形式で置いています。
テンプレートから新しいシステムを作る場合は、このファイルを新しいシステムの要件定義書で置き換えてください（`npm run init:project` が雛形を作ります）。

## 1. 目的・スコープ

システム開発の専門知識がない利用者でも、AIとの対話で要求分析から要件定義までを完了し、UML図と仕様書を出力できるWebシステム。

- 非専門家が「やりたいこと」を話すだけで、抜け漏れの少ない要件定義書を作れる
- 複数AIの回答を別AIが評価・比較し、根拠つきの選択肢として提示する
- 出力物（UML・仕様書）をそのまま設計・実装工程へ引き渡せる

| 区分 | 対象 |
| --- | --- |
| 対象工程 | 企画整理 → 要求分析 → 要件定義（機能・非機能）→ 概要設計の入口（UML） |
| 対応AI | Claude、GPT（OpenAI）、Gemini、ローカルLLM（Ollama） |
| 出力形式 | UML（Mermaid / PlantUML テキスト、SVG / PNG 画像）、仕様書（Markdown / Word / PDF） |
| 動作環境 | AWS またはローカルDocker（同じコンテナイメージ） |

## 2. 要求一覧

| ID | 要求 | 優先度 |
| --- | --- | --- |
| RQ-01 | 対話形式で質問に答えるだけで要件が整理される | 必須 |
| RQ-02 | 専門用語に解説がつき、例から選べる | 必須 |
| RQ-03 | 使うAIを1つまたは複数選べる | 必須 |
| RQ-04 | 複数AIの結果を別AIが評価し、比較と推奨を示す | 必須 |
| RQ-05 | 提示された選択肢から選ぶ、または組み合わせられる | 必須 |
| RQ-06 | UML図と仕様書を自動生成し、出力できる | 必須 |
| RQ-07 | 要件の変更履歴と決定理由を追跡できる | 必須 |
| RQ-08 | チームでレビュー・承認できる | 推奨 |
| RQ-09 | 実装工程へ連携できる（タスク分解、Issue出力） | 推奨 |
| RQ-10 | AIの利用コストを把握・制限できる | 推奨 |

## 3. 機能要件と実装状況

| ID | 機能 | 優先度 | 実装 | 場所 |
| --- | --- | --- | --- | --- |
| F1-1 | プロジェクト作成 | 必須 | 済 | `POST /api/orgs/:orgId/projects` |
| F1-2 | メンバー権限（admin / editor / reviewer / viewer） | 推奨 | 済（認可） | `apps/api/src/auth.ts` |
| F1-3 | テンプレート選択 | 推奨 | 未 | ― |
| F2-1 | フェーズ別ガイド（6フェーズ） | 必須 | 済 | `packages/ai-core/src/phases.ts` |
| F2-2 | 選択肢つき質問（AIが回答候補を作成） | 必須 | 済 | `ai-core/src/guide.ts`、`POST /api/projects/:id/guide` |
| F2-3 | 用語解説（標準の用語集＋AIの解説） | 必須 | 済 | `ai-core/src/glossary.ts` |
| F2-4 | 曖昧さ検出 | 必須 | 済 | `ai-core/src/ambiguity.ts`、`POST /api/projects/:id/ambiguity` |
| F2-5 | 抜け漏れチェック（観点ごとの網羅状況と網羅率） | 必須 | 済 | `GET /api/projects/:id/coverage` |
| F2-6 | 資料取込（議事録・既存システムの資料。テキスト / Word / PDF） | 推奨 | 済 | `apps/api/src/extract.ts`、`POST /api/projects/:id/documents` |
| F2-7 | 資料の分析（現状の業務フロー・課題と根拠の照合・業務の見直し（ECRS）・見直し後のフロー・引き継がないもの・初回の要件案） | 推奨 | 済 | `ai-core/src/analysis.ts`、`POST /api/projects/:id/analyses`・`/api/analyses/:id/adopt` |
| F3-1 | 単一 / 複数モード選択 | 必須 | 済 | `aiConfig.mode` |
| F3-2 | 生成AI選択（1〜4） | 必須 | 済 | `aiConfig.generatorIds` |
| F3-3 | 評価AI選択と同一時の警告 | 必須 | 済 | `orchestrator.ts` |
| F3-4 | 評価基準の重み設定 | 推奨 | 済（API未公開） | `RoundOptions.weights` |
| F4-1 | 並列生成 | 必須 | 済 | `runRound` |
| F4-2 | 評価・分析 | 必須 | 済 | 同上 |
| F4-3 | 選択肢提示（案＋統合案） | 必須 | 済 | `apps/web/public/index.html` |
| F4-4 | 採用・部分採用 | 必須 | 済 | `POST /api/rounds/:id/decision` |
| F4-5 | 決定記録 | 必須 | 済 | `decisions` テーブル |
| F5-1 | 要件リポジトリ（ID採番） | 必須 | 済 | `requirements` テーブル |
| F5-2 | 要件の編集・削除と版の履歴 | 必須 | 済（差分表示は今後） | `PATCH/DELETE /api/requirements/:id`、`GET .../versions` |
| F5-3 | トレーサビリティ（要件 → 案・決定 → ストーリー → 課題） | 推奨 | 済 | `requirements.round_id`、`GET /api/projects/:id/trace` |
| F5-4 | レビュー・承認 | 推奨 | 未 | ― |
| F5-7 | EARS 記法による要件文（機能要件・非機能要件。構造で保存し、文型と表現を検査） | 推奨 | 済 | `ai-core/src/ears.ts`、`POST /api/ears/preview` |
| F5-8 | 非機能要件シート（システムの性格からの推奨水準、26項目の検討、矛盾の検出、複数AIの提案、EARS要件化、確定前の確認） | 推奨 | 済 | `ai-core/src/nfr.ts`、`apps/api/src/nfr-sheet.ts`、[nfr.md](./nfr.md) |
| F5-9 | 非機能要件の適正化（規模・目的・予算、似た事例（参考類型・社内の過去事例）との比較、過大の検出、AIによる見直し） | 推奨 | 済 | `ai-core/src/nfr-cases.ts`、`POST /api/projects/:id/nfr/review` |
| F5-5 | 要件定義の確定（確定版の保存。確定後は要件を直接編集できない） | 推奨 | 済 | `POST /api/projects/:id/baseline` |
| F5-6 | 確定後の変更要求と影響分析（トレース＋複数AI）、変更する／代替案／保留／変更しないの選択 | 推奨 | 済 | `ai-core/src/impact.ts`、`POST /api/changes/:id/analyze`・`/decide` |
| F6-1 | UML生成（ユースケース・クラス・シーケンス・状態遷移・アクティビティ） | 必須 | 済 | `ai-core/src/uml.ts`、`POST /api/projects/:id/uml/generate` |
| F6-2 | 仕様書生成 | 必須 | 済（Markdown / Word / PDF） | `apps/api/src/spec.ts` |
| F6-3 | エクスポート（Markdown / Word / PDF、図の画像埋め込み）・版の保存 | 必須 | 済 | `apps/api/src/spec.ts`、`POST /api/projects/:id/exports` |
| F8-1 | AIの登録・変更・削除（組織の管理者） | 必須 | 済 | `POST/PATCH/DELETE /api/orgs/:orgId/providers` |
| F8-2 | 月間トークン上限（組織全体・AIごと）と80%警告 | 推奨 | 済 | `apps/api/src/usage.ts`、`PUT /api/orgs/:orgId/limits` |
| F8-3 | 今月の利用量の確認 | 推奨 | 済 | `GET /api/orgs/:orgId/usage` |
| F8-4 | 監査ログ（誰が・いつ・どのAIに何を送ったか） | 推奨 | 済 | `GET /api/orgs/:orgId/audit` |
| F8-5 | ログイン画面（OIDC 認可コード＋PKCE、Cognito / Keycloak） | 推奨 | 済 | `apps/api/src/auth.ts`、[auth.md](./auth.md) |
| F8-6 | AI処理の非同期実行と進み具合の表示 | 推奨 | 済 | `apps/api/src/jobs.ts`、`GET /api/jobs/:id` |
| F6-4 | UML生成の複数AI比較（匿名評価して選択） | 推奨 | 済 | `compareUmlModels`、`POST /api/uml-rounds/:id/adopt` |
| F6-5 | 画面設計（画面一覧・画面遷移図。見た目の情報は持たない） | 推奨 | 済 | `ai-core/src/screens.ts`、`POST /api/projects/:id/screens/generate` |
| F6-6 | プロトタイプ（クリックで移動できるワイヤーフレーム）と、見た目の指摘を申し送りにする仕組み | 推奨 | 済 | `GET .../screens/prototype.html`、`POST .../screens/feedback` |
| F7-1 | タスク分解（エピック・ストーリー・作業タスク、受け入れ条件、見積り、未対応要件の検出） | 推奨 | 済 | `ai-core/src/tasks.ts`、`POST /api/projects/:id/tasks/generate` |
| F7-2 | GitHub / Jira / Backlog 連携（直接登録・CSV出力・再実行で続きから） | 任意 | 済 | `apps/api/src/integrations.ts`、[integrations.md](./integrations.md) |
| F9-1 | テスト仕様の導出（EARS の文型から正常系・異常系・状態の内外・境界値、非機能要件の確認方法、受け入れ条件からの受け入れテスト、要件 → テストの追跡、CSV） | 推奨 | 済 | `ai-core/src/testspec.ts`、`GET /api/projects/:id/tests`、[handoff.md](./handoff.md) |
| F9-2 | 設計の材料（データ項目定義：キー・必須・桁や形式・区分値、権限表（CRUD）、外部とのやり取りの一覧、業務の言葉とコード上の名前の対応） | 推奨 | 済 | `ai-core/src/design-tables.ts`、`GET /api/projects/:id/design/tables` |
| F9-3 | 着手前チェック（引き渡せる状態かの点検、未決事項の一覧、直す画面への案内） | 推奨 | 済 | `ai-core/src/readiness.ts`、`GET /api/projects/:id/readiness` |
| F9-4 | 引き継ぎパッケージ（要件・非機能要件・設計・画面・タスク・テストをまとめた JSON。開発者のツールや AI コーディングツール向け） | 推奨 | 済 | `GET /api/projects/:id/handoff.json` |

## 4. 非機能要件

| 区分 | 要件 | 目標値（初期案） |
| --- | --- | --- |
| 性能 | 複数AI比較の完了 | 4AI並列＋評価で90秒以内（`AI_TIMEOUT_MS`）。時間切れのAIは除外して続行 |
| 可用性 | AI障害時の継続 | 1プロバイダ障害時も他AIで継続 |
| セキュリティ | 認証 | OIDC（AWS: Cognito、ローカル: Keycloak）。開発用ヘッダー認証は本番で無効 |
| セキュリティ | APIキー保管 | 組織ごとに管理者が登録。KMS または AES-256-GCM で暗号化、組織IDで束縛。表示は末尾4桁 |
| セキュリティ | データ送信制御 | 機密プロジェクトはローカルLLMのみ |
| セキュリティ | 通信 | ALBでHTTPS終端（証明書指定時）、RDSへはTLS（証明書検証あり） |
| 監査 | AI呼出の記録 | 監査ログに、利用者・日時・操作・送信した回答・使ったAIとトークン数を記録。APIキーは記録しない。`AUDIT_RETENTION_DAYS`（既定365日）を過ぎたものは自動削除 |
| 性能 | AI処理の待ち | AI処理はジョブとして実行し、画面は進み具合を表示。複数コンテナでも1回だけ実行（PostgreSQL の SKIP LOCKED） |
| コスト | 利用上限 | 組織全体とAIごとに月間トークン上限。組織の上限で停止、AIの上限ではそのAIを除外して続行。月の区切りは `USAGE_TIMEZONE`（既定 Asia/Tokyo） |
| 拡張性 | AIプロバイダ追加 | `ai-core/src/providers` にアダプタを追加し、factory に1行登録 |
| 拡張性 | マルチテナント | 全データを組織IDで分離 |
| 移植性 | 動作環境 | AWS（ECS Fargate）とローカルDockerで同じイメージ |
| ライセンス | 利用OSS | 再配布可能・表示で利用可能なもののみ（[oss-policy.md](./oss-policy.md)） |

## 5. マルチAIの仕組み

[ADR 0002](./adr/0002-anonymized-evaluation.md) と [シーケンス図](./uml/03-sequence-round.mmd) を参照。

| 評価基準 | 内容 | 重み |
| --- | --- | --- |
| 網羅性 | 必要な要件・例外ケースが揃っているか | 25% |
| 正確性 | 業務・技術的に誤りがないか | 25% |
| 一貫性 | 既存の要件と矛盾しないか | 20% |
| 実現可能性 | 実装できる粒度・内容か | 15% |
| 分かりやすさ | 非専門家が理解できるか | 15% |

## 6. 未決事項

- [ ] 利用規模：社内利用から始めるか、最初からSaaSとして提供するか
- [x] APIキーの負担：組織ごとに管理者が登録する（[ADR 0001](./adr/0001-org-api-keys.md)）
- [x] 動作環境：AWS またはローカルDocker（[ADR 0003](./adr/0003-same-image-aws-and-docker.md)）
- [ ] ローカルLLMの実行場所：利用者のPCか、組織のサーバか
- [x] 本リポジトリ自体のライセンス：OSSとして公開（Apache-2.0）
- [ ] 成果物の書式：社内標準の要件定義書テンプレートに合わせる必要があるか
