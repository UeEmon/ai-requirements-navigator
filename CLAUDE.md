# 要件ナビの開発ガイド（Claude 向け）

このファイルは、Claude（claude.ai のプロジェクト・Claude Code）でこのリポジトリの開発を進めるときの前提です。人が読んでも分かるように書いています。
今どこまでできているか・次に何をするかは [docs/development-status.md](docs/development-status.md)、Claude のプロジェクトでの管理のしかたは [docs/claude-project.md](docs/claude-project.md) にあります。

## 1. このシステム

要件ナビ（AI要件定義支援システム）は、システム開発の専門家でなくても、AI との対話で要求分析から要件定義までを進め、UML と仕様書を出力できる Web システムのテンプレートです（OSS・Apache-2.0）。

- 複数の AI（Claude・ChatGPT・Gemini・ローカルLLM）の案を、匿名化して別の AI が評価する
- 組織ごとに AI の API キーを暗号化して保存する。ユーザー・役割・権限は組織の管理者が管理する
- AWS とローカルDocker で同じコンテナイメージが動く（違いは環境変数だけ）

## 2. 構成

| 場所 | 内容 |
| --- | --- |
| `packages/ai-core` | AI の呼び出し・比較・評価、プロンプト、UML・EARS・非機能要件などのロジック（TypeScript） |
| `apps/api` | API サーバー（Hono・zod・pg・jose）。`src/app.ts` が本体で、機能ごとのモジュール（`org-admin.ts`・`local-auth.ts`・`implementation.ts` など）が `routes(app)` で窓口を足す |
| `apps/api/src/store.ts` / `pg-store.ts` | 保存先。メモリ（テスト・お試し）と PostgreSQL の2つを同じインターフェイスで実装する |
| `apps/web/public/index.html` | 画面（1ファイルの素の JavaScript。ビルドなし） |
| `db/migrations` | PostgreSQL の変更（番号順。起動時に自動で適用） |
| `deploy/aws`（CDK）・`deploy/docker`・`docker-compose.yml` | 展開 |
| `docs/` | 利用者向けの説明・要件定義書（`requirements.md`）・判断の記録（`adr/`） |

## 3. 作業の決まり

- **日本語で応答する**。画面の文言・ドキュメント・コミットメッセージも日本語。専門用語より、利用者に伝わる言葉を選ぶ
- **秘密情報を表示・記録しない**: API キー・管理用キー・トークン・パスワード・`MASTER_KEY` を、ログ・エラーメッセージ・監査ログ・テストデータ・画面に全文で出さない（画面は末尾4桁まで）。パスワードとトークンはハッシュだけを保存する
- **保存先は2つとも直す**: `Store` に足したものは `MemoryStore` と `PgStore` の両方に実装し、テーブルを変えるときは `db/migrations` に新しい番号のファイルを足す（既存のファイルは変えない）
- **権限**: 窓口では `need(c, orgId, "<権限>")` か `loadProject(c, id, "<権限>")` で確かめる。権限の一覧と既定は `apps/api/src/permissions.ts`。新しい操作には、既存の権限を当てるか、権限を足して画面の `PERM_MIN` もそろえる
- **監査ログ**: 組織・ユーザー・AI・プロジェクトの設定を変える操作は `audit()` で記録する（`audit.ts` の `AuditAction` に足す）。変更前の値は、更新の前に `structuredClone` などで写しを取る（メモリの保存先は同じオブジェクトを書き換えるため）
- **環境の違いはコードで分けない**: AWS とローカルDocker の違いは環境変数で吸収する（[ADR 0003](docs/adr/0003-same-image-aws-and-docker.md)）
- **依存パッケージ**: 再配布可能なライセンスだけ（GPL・AGPL・SSPL・BUSL は不可）。足したら `npm run licenses`
- **判断を伴う変更**は `docs/adr/` に記録し、要件に関わる変更は `docs/requirements.md` と利用者向けの `docs/*.md`・`README.md` もそろえる

## 4. 確認のしかた

```bash
npm install
npm run typecheck   # ai-core のビルドと API の型チェック
npm test            # ai-core と API のテスト（TEST_DATABASE_URL があれば PostgreSQL も）
npm run licenses
```

- API のテストは `apps/api/test/*.test.ts`（`createApp` にメモリの保存先を渡し、`app.request` で呼ぶ）。外部サービス（OpenAI・Google・GitHub・Jira・Backlog・OIDC）は偽の `fetch` で置き換える
- 画面を変えたら、`<script>` の中身を取り出して `node --check` で構文を確かめ、実際に開いて操作を確かめる
- GitHub Actions の CI（test・docker・compose・cdk・publish）がすべて通ることを確かめる。ログが見られないときは、check-runs の注釈（annotations）に失敗の行が出る

## 5. コミット

- `main` に直接コミットする運用（大きな変更は Issue で相談してから）。メッセージは日本語で「何を・なぜ」
- 1つの機能は「API・保存先・マイグレーション → 画面 → テスト → ドキュメント」をそろえてからコミットする
- 作業を終えたら [docs/development-status.md](docs/development-status.md) を更新する（できたこと・残り・確かめていないこと）
