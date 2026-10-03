# 開発・テストのツールとの連携（MCP・外部連携 API・Webhook）

AIコーディングツール、CI、テストツールが要件ナビとやり取りするための入口です。設計判断は [ADR 0010](adr/0010-connect-coding-and-test-tools.md) にあります。

| 入口 | 使う側 | できること |
| --- | --- | --- |
| **MCP サーバー** `POST /mcp` | Claude Code・Cursor・GitHub Copilot など、MCP に対応した AI コーディングツール | 要件・設計・テストケースを読む、実装状況とテスト結果を報告する、質問する |
| **外部連携 API** `/api/v1`（[OpenAPI](#外部連携-api)） | CI、テスト管理ツール、社内の開発基盤 | 同上。テスト結果は JUnit XML をそのまま送れる |
| **開発用パッケージ**（zip） | リポジトリ | AGENTS.md・要件と設計の Markdown・Gherkin のテストシナリオ・MCP の接続設定を置く |
| **Webhook** | 外部のシステム | 確定版の作成・変更の決定・質問・実装状況・テスト結果を知らせる |

返ってきた実装状況・テスト結果・質問は、「テスト・引き継ぎ」タブの「開発・テストのツールとの連携」で要件ごとに確認し、質問に回答できます。開いている質問は着手前チェックの未決事項にも出ます。

## 1. トークンを発行する（組織の管理者）

「AI設定・プロジェクト」タブの「開発・テストのツールとの連携」で発行します。

- **権限**：「参照」は要件・設計・テストを読むだけです。「参照・報告」にすると、実装状況・テスト結果の報告と質問もできます
- **プロジェクト**：開いているプロジェクトだけ、または組織のすべてを選べます。1つのプロジェクトに限ったトークンでは、MCP のツールで `projectId` を省略できます
- **有効期限**：30〜365日

トークン（`arn_…`）は発行したときに一度だけ表示します。要件ナビには SHA-256 だけを保存します。使う側では環境変数 `ARN_TOKEN` に入れ、リポジトリには入れないでください。使わなくなったら「失効」を押します。

API でも発行できます（管理者のログインが必要です。トークンでトークンは発行できません）。

```http
POST /api/orgs/{orgId}/api-tokens
{ "name": "GitHub Actions", "scopes": ["report"], "projectIds": ["<プロジェクトID>"], "expiresInDays": 90 }
```

## 2. AI コーディングツールをつなぐ（MCP）

接続先は `https://<要件ナビのURL>/mcp`（Streamable HTTP）です。トークンは `Authorization: Bearer` ヘッダーで送ります。

**Claude Code**：

```sh
claude mcp add --transport http requirements-navigator https://arn.example.com/mcp --header "Authorization: Bearer $ARN_TOKEN"
```

開発用パッケージの `.mcp.json` にも同じ設定が入っています（トークンは環境変数 `ARN_TOKEN` から読みます）。

**その他のツールの設定例**：

```jsonc
// Cursor: .cursor/mcp.json
{ "mcpServers": { "requirements-navigator": { "url": "https://arn.example.com/mcp", "headers": { "Authorization": "Bearer <トークン>" } } } }

// VS Code（GitHub Copilot）: .vscode/mcp.json
{
  "inputs": [{ "type": "promptString", "id": "arn-token", "description": "要件ナビのトークン", "password": true }],
  "servers": { "requirements-navigator": { "type": "http", "url": "https://arn.example.com/mcp", "headers": { "Authorization": "Bearer ${input:arn-token}" } } }
}
```

設定の書き方（とくに環境変数の参照方法）は、ツールの版によって変わることがあります。各ツールの説明書も確認してください。

### ツール

| ツール | 権限 | 内容 |
| --- | --- | --- |
| `list_projects` | 参照 | 使えるプロジェクト |
| `get_project_overview` | 参照 | 目的・件数・確定版・着手前チェック・未決事項・状況の集計 |
| `list_requirements` | 参照 | 要件（EARS の文と構造）。種類・IDで絞り込める |
| `get_requirement` | 参照 | 1つの要件の、テストケース・ストーリー・画面・エンティティ・外部とのやり取り・状況・質問 |
| `get_design` | 参照 | データ項目定義・権限表・外部とのやり取り・設計モデル・画面一覧 |
| `get_test_cases` | 参照 | テストケース（要件・工程で絞り込める） |
| `get_status` | 参照 | 要件ごとの実装状況とテスト結果 |
| `list_questions` | 参照 | 質問と回答 |
| `get_glossary` | 参照 | 用語集（用語・意味・言い換え・コード上の名前） |
| `get_acceptance` | 参照 | 受け入れ基準と、いまのテスト結果に照らした判定 |
| `get_changes` | 参照 | 確定版からの変更（追加・変更・削除）と、影響するテスト・ストーリー・画面 |
| `report_implementation` | 報告 | 実装状況（未着手・実装中・実装済み・止まっている）とプルリクエストなどのURL |
| `report_test_results` | 報告 | テスト結果（一覧、または JUnit XML の本文） |
| `ask_question` | 報告 | 要件についての質問 |

「参照」だけのトークンでは、報告のツールは一覧に出ません。初期化の応答（`instructions`）で、AIツールに作業の進め方（要件を読む → 推測せずに質問する → テストIDを付ける → 報告する）を伝えます。

## 3. 開発用パッケージをリポジトリに置く

「テスト・引き継ぎ」タブの「開発用パッケージ（zip）」、または `GET /api/v1/projects/{id}/agent-pack.zip` で取得し、リポジトリに展開します。

| ファイル | 内容 |
| --- | --- |
| `AGENTS.md` | AIコーディングツール向けの作業の決まり（要件にないものを作らない、要件IDをコミットに書く、テストにテストIDを付ける、報告する、不明点は質問する）、接続先、未決事項 |
| `CLAUDE.md` | `@AGENTS.md`（Claude Code が AGENTS.md を読むように） |
| `.mcp.json` | MCP の接続設定（トークンは環境変数 `ARN_TOKEN`） |
| `requirements/requirements.md` | 要件の一覧（EARS、優先度、版、テストID）、業務ルールと具体例、非機能要件の確認方法、受け入れ基準 |
| `requirements/design.md` | エンティティ・データ項目定義・権限表・外部とのやり取り・画面の入出力項目・状態が変わる条件・帳票・バッチ・図（Mermaid） |
| `requirements/glossary.md` | 用語集（言い換えは使わない） |
| `requirements/screens.md`・`tasks.md` | 画面一覧、タスク分解（あれば） |
| `requirements/handoff.json` | 引き継ぎパッケージ（`arn-handoff/1`） |
| `tests/acceptance/*.feature` | Gherkin（日本語のキーワード）のテストシナリオ。要件ごと・ストーリーごとに1ファイル。シナリオにテストIDのタグ（`@TC-FR-01-1`）付き |
| `tests/testcases.csv` | テストケースの一覧 |
| `scripts/report-test-results.sh` | JUnit XML を要件ナビに送るスクリプト |
| `.arn/project.json` | 接続先とプロジェクトID |

要件を変えたら作り直してください（ファイルを手で直さず、要件ナビで変更要求を出します）。

## 4. テスト結果を送る（CI・テストツール）

テスト名にテストID（`TC-FR-01-1`、受け入れテストは `AT-E1-S1-1`）を含めると、結果がテストケースと要件に結びつきます。テストIDがなく要件ID（`FR-01`）だけを含むテストは、要件そのものの結果として数えます。どちらも含まないテストは「結びつかない」として件数と名前を返します。

GitHub Actions の例：

```yaml
- run: npx vitest run --reporter=junit --outputFile=junit.xml   # pytest なら --junitxml=junit.xml
- if: always()
  run: sh scripts/report-test-results.sh junit.xml vitest
  env:
    ARN_TOKEN: ${{ secrets.ARN_TOKEN }}
```

直接送る場合：

```sh
curl -X POST "https://arn.example.com/api/v1/projects/<ID>/test-runs?tool=vitest&revision=$(git rev-parse --short HEAD)" \
  -H "Authorization: Bearer $ARN_TOKEN" -H "Content-Type: application/xml" --data-binary @junit.xml
```

JSON でも送れます：`{ "tool": "playwright", "results": [{ "testId": "TC-FR-01-1", "status": "passed" }] }`（status は passed / failed / skipped）。JUnit XML は10MBまでで、DOCTYPE・ENTITY を含むものは受け付けません。

### 集計のしかた

- テストごとに最新の結果を使います（新しい実行で合格すれば、古い不合格は消えます）
- 要件ごとに「合格（すべて合格）／不合格あり／一部未実施／未実施」を出します
- 実装状況は要件ごとの最新の報告です。報告した後に要件が変わったものは「報告後に要件が変更」と表示し、作業の見直しが必要なことを知らせます

## 外部連携 API

定義は `GET /api/v1/openapi.json`（OpenAPI 3.1、認証不要）です。

| メソッド | パス | 権限 |
| --- | --- | --- |
| GET | `/api/v1/projects` | 参照 |
| GET | `/api/v1/projects/{id}` | 参照 |
| GET | `/api/v1/projects/{id}/requirements?type=&codes=` | 参照 |
| GET | `/api/v1/projects/{id}/requirements/{code}` | 参照 |
| GET | `/api/v1/projects/{id}/design?part=` | 参照 |
| GET | `/api/v1/projects/{id}/tests?requirement=&level=` | 参照 |
| GET | `/api/v1/projects/{id}/handoff` | 参照 |
| GET | `/api/v1/projects/{id}/agent-pack.zip` | 参照 |
| GET | `/api/v1/projects/{id}/status` | 参照 |
| GET | `/api/v1/projects/{id}/glossary` | 参照 |
| GET | `/api/v1/projects/{id}/acceptance` | 参照 |
| GET | `/api/v1/projects/{id}/diff?from=&to=` | 参照 |
| POST | `/api/v1/projects/{id}/implementation` | 報告 |
| GET・POST | `/api/v1/projects/{id}/test-runs` | 参照・報告 |
| GET・POST | `/api/v1/projects/{id}/questions` | 参照・報告 |

`/api/v1` は画面のログインでも使えます（閲覧者は参照、編集者以上は報告）。トークンでは `/api/v1` と `/mcp` 以外の API は使えません。

## 5. Webhook（組織の管理者）

「AI設定・プロジェクト」タブで送り先の URL と知らせることを登録します。登録したときに一度だけ表示する秘密の文字列（`whsec_…`）で、本文に署名します。

| イベント | いつ |
| --- | --- |
| `baseline.created` | 要件定義の確定版を作った |
| `change.decided` | 変更要求を判断した（変更した場合は新しい確定版の番号） |
| `review.requested`・`review.decided` | 要件定義のレビューを依頼した・承認または差し戻した |
| `question.created`・`question.answered` | 開発から質問があった・回答した |
| `implementation.reported` | 実装状況の報告があった |
| `test_run.recorded` | テスト結果が登録された |

```http
POST <送り先>
Content-Type: application/json
X-ARN-Event: baseline.created
X-ARN-Delivery: <送信ごとのID>
X-ARN-Timestamp: <UNIX時刻（秒）>
X-ARN-Signature: sha256=<HMAC-SHA256(秘密, タイムスタンプ + "." + 本文) の16進>

{ "id": "…", "event": "baseline.created", "at": "…", "orgId": "…", "data": { "projectId": "…", "version": 2, … } }
```

受け取る側では、署名を確かめ、タイムスタンプが古すぎないこと（例：5分以内）を確かめてください。

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", secret).update(`${req.headers["x-arn-timestamp"]}.${rawBody}`).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-arn-signature"]));
```

- 送り先は https だけで、社内（プライベート）アドレスには送りません（送るたびに名前解決の結果を確かめます）。ローカルの Docker で社内の CI に送るときだけ `WEBHOOK_ALLOW_PRIVATE=true` にします
- 送信は1回だけで、10秒以内に応答がなければ失敗とします。結果は管理者の画面の「最後の送信」に出ます。「送信テスト」で `ping` を送れます

## 設定

| 環境変数 | 内容 |
| --- | --- |
| `PUBLIC_URL` | 外から見たこのサーバーの URL。開発用パッケージ（AGENTS.md・.mcp.json）と OpenAPI に書きます。省略時はリクエストから作ります（`X-Forwarded-Proto` を考慮） |
| `WEBHOOK_ALLOW_PRIVATE` | Webhook の送り先に社内アドレスと http を許す（既定 false） |

## 監査ログ

トークンの発行・失効、Webhook の登録・削除、実装状況の報告、テスト結果の登録、質問と回答、開発用パッケージの出力を記録します。トークンで行った操作の利用者は `token:<トークンの名前>` になります。
