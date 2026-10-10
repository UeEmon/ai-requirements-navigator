# 開発の状況

要件ナビの開発で、何ができていて、何が残っているかの一覧です。作業を終えるたびに更新します（最終更新: 2026-10-10）。
開発の決まりは [CLAUDE.md](../CLAUDE.md)、Claude のプロジェクトでの管理のしかたは [claude-project.md](claude-project.md) を参照してください。

## できていること

| 分野 | 内容 | 説明 |
| --- | --- | --- |
| ヒアリング | フェーズごとの質問ガイド（観点の抜け漏れ確認・回答の候補・用語の説明）、あいまいな表現の検出 | [requirements.md](requirements.md) |
| 複数AI | 複数AI＋評価AI（匿名化して評価）／単独AI＋評価AI（審査して改善案）／単一AI。作成後も変更できる | [ADR 0002](adr/0002-anonymized-evaluation.md) |
| 資料分析・EARS | 議事録・既存資料の取り込み（テキスト・Word・PDF）、現状の課題と業務の見直し、EARS 記法と検査 | [discovery-and-ears.md](discovery-and-ears.md) |
| 非機能要件 | 26項目のシート、推奨水準・矛盾の検出・似た事例との比較（過大の検出） | [nfr.md](nfr.md) |
| 設計・出力 | UML 5種（複数AIで比較）、画面イメージ、要件定義書（Word・PDF・Markdown） | [screens-and-changes.md](screens-and-changes.md) |
| 確定と変更 | 要件定義の確定、変更要求と影響分析、レビューと承認、業務ルール・用語集・受け入れ基準、要件の手入力 | [phase-boundaries.md](phase-boundaries.md) |
| チームでの利用 | プロジェクト単位のメンバー（メンバーに限る・プロジェクトでの役割）、要件へのコメント、プロジェクトの複製・書き出し・取り込み | [auth.md](auth.md)・[ADR 0012](adr/0012-team-collaboration.md) |
| 実装・テストへの引き継ぎ | タスク分解と GitHub Issues・Jira・Backlog への登録、テスト仕様、引き継ぎパッケージ、AIコーディングツール連携（API トークン・MCP・Webhook） | [integrations.md](integrations.md)・[handoff.md](handoff.md)・[connect.md](connect.md) |
| AI設定 | Claude・ChatGPT・Gemini ごとの登録、キーの自動発行（ChatGPT: 管理用キー、Gemini: Google でログイン）、モデル一覧の自動取得、月間トークン上限 | [ai-keys.md](ai-keys.md) |
| 連携の自動化 | 課題管理ツールの設定の自動読み込み、GitHub リポジトリの自動作成 | [integrations.md](integrations.md) |
| 組織とユーザー | 組織設定の編集（名前・説明・問い合わせ先・招待できるドメイン・月間上限）、ユーザーの招待と役割、役割ごとの権限の変更、管理者は1人以上 | [auth.md](auth.md) |
| ログイン | 開発用（dev）／要件ナビのログイン（local: メールアドレスとパスワード、招待・再設定のリンク）／Cognito・Keycloak（oidc） | [auth.md](auth.md) |
| 展開 | ローカルDocker（Docker Desktop）、GitHub の公開イメージ（GHCR）、GitHub Actions から AWS（CDK） | [docker-desktop.md](docker-desktop.md)・[github-deploy.md](github-deploy.md) |
| 品質 | 型チェック・テスト（メモリと PostgreSQL）・ライセンス検査・Docker の動作確認を CI で実行 | [CONTRIBUTING.md](../CONTRIBUTING.md) |

## 次の候補（未着手）

優先度は目安です。着手するときは、ここから「作業中」に移します。

| # | 内容 | 優先度 | メモ |
| --- | --- | --- | --- |
| 1 | 本物の外部サービスでの動作確認（下の「確かめていないこと」） | 高 | 公開前に、少なくとも Claude・ChatGPT・Gemini のキー登録と、GitHub の課題登録を確かめる |
| 2 | システム名の変更（候補: KANAME） | 中 | 候補の調査は済み。採用するかは未決定 |
| 3 | 要件ナビのログインでのメール送信（招待・パスワード再設定のリンク） | 低 | 今は画面に出た文を管理者が送る。SMTP などの設定が必要になる |
| 4 | CI の Ubuntu 26 への移行（2026-10-19 から ubuntu-latest が変わる） | 中 | actions は Node.js 24 対応の版に更新済み（2026-10-10）。移行後に CI がすべて通るかを確かめる |
| 5 | コメントの通知（メール・Webhook）とコメントへの返信 | 低 | コメントはできた。今は要件一覧で開いて確かめる |
| 6 | テンプレート選択（F1-3） | 中 | 要件定義書で唯一「未」の機能。複製で代わりにできる部分もある |

## 作業中

（なし）

## 確かめていないこと

テストは偽の応答で確かめています。次は本物のサービスではまだ確かめていません。

- OpenAI の管理用キーによるキーの自動発行、Google のログインによる Gemini のキーの作成
- GitHub のリポジトリの自動作成、Jira・Backlog への課題の登録
- Amazon Cognito・Keycloak でのログインと招待の照合
- 要件ナビのログイン（AUTH_MODE=local）を、本物の画面と API を通して使うこと（画面は模擬 API で、API はテストで確かめた）
- メンバーに限ったプロジェクトを、管理者以外の利用者として画面から使うこと（API はテストで確かめた。画面は開発用ログインの管理者で、メンバーの設定・コメント・手入力・複製・書き出し・取り込みを確かめた）
- 更新した GitHub Actions（checkout・setup-node・upload-artifact・docker の各 action・configure-aws-credentials）での CI と AWS への展開

## 記録

| 日付 | 内容 |
| --- | --- |
| 2026-10-10 | 要件の手入力、要件へのコメント、プロジェクト単位のメンバー、プロジェクトの複製・書き出し・取り込み、CI の actions の更新（Node.js 24） |
| 2026-10-09 | Claude のプロジェクトで開発を管理するための資料（CLAUDE.md・この一覧・claude-project.md）を追加 |
| 2026-10-07 | 組織設定の編集・役割ごとの権限・要件ナビのログイン（ユーザー管理） |
| 2026-10-04 | 組織の管理（メンバーと役割）、プロジェクトの整理、作成後の AI の変更、単独AI＋評価AI |
| 2026-10-03 | AI設定の整理とキーの自動発行、課題管理ツールの設定の自動化、リポジトリの自動作成、Docker Desktop と GitHub からの展開 |
| 2026-10-02 | 初版と、UML・資料分析・非機能要件・画面・変更管理・実装連携・引き継ぎ |
