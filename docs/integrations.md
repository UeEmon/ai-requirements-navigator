# 実装工程への連携（GitHub / Jira / Backlog）

確定した要件を、開発チームがそのまま着手できる **エピック → ストーリー → 作業タスク** に分解し、課題管理ツールへ登録します。
要件 → ストーリー → 課題のつながり（トレーサビリティ）は「実装連携」タブで確認できます。

## 流れ

1. 「実装連携」タブで **AIでタスクに分解する**
   - 機能要件（FR）と非機能要件（NFR）を対象に、採用したUML設計があれば参考にして分解します
   - 各ストーリーには、受け入れ条件・見積り（S / M / L）・作業タスク（画面・サーバー・DB・テストなど）と、元になった要件コードが付きます
   - どのストーリーにも対応しない要件は警告します。AIが存在しない要件コードを出した場合は取り除きます
   - 分解した後に要件を手直しすると「要件が変わっています」と表示します
2. 出力する
   - **ファイル**: Markdown / Jira用CSV / Backlog用CSV / JSON（CSVは Excel で開けるよう BOM 付き）
   - **直接登録**: 管理者が登録した連携先を選び、登録するストーリーを選んで「選んだストーリーを登録」
3. トレーサビリティで、各要件が「登録済み／未登録／ストーリーなし」のどれかを確認する

登録済みのストーリーは次回の登録で飛ばすため、途中で失敗しても **もう一度登録すれば失敗した分だけ** を登録します。
分解し直すと新しい分解結果として扱い、以前の登録結果は以前の分解結果に残ります。

## 登録のされ方

| | エピック | ストーリー | 作業タスク・受け入れ条件 |
| --- | --- | --- | --- |
| GitHub Issues | `[エピック] 名前` の Issue（ラベル `epic`） | Issue（本文に「エピック: #番号」）。登録後、エピックの本文にストーリーの一覧を追記 | 本文のチェックリスト（`- [ ]`） |
| Jira | 課題タイプ Epic | 課題タイプ Story（`parent` でエピックの子） | 説明欄（Jira記法） |
| Backlog | `[エピック] 名前` の課題 | 子課題（`parentIssueId`）。必須の要件を含むものは優先度「高」 | 詳細欄 |

- GitHub でラベルを付けられない、Jira で親を設定できない、Backlog で親子課題が無効、といった場合は、その項目を外して登録し、結果に理由を表示します
- トークンが無効・権限不足（401 / 403 / 404）の場合は、最初の失敗で打ち切ります

## 連携先の登録（組織の管理者）

「プロジェクト設定」タブの「課題管理ツールとの連携」で登録します。トークンの取得方法は、「トークンの取得方法」ボタン（「AI設定」タブの「APIキー・トークンの取得方法」）か [docs/ai-keys.md](ai-keys.md#自動で取得できないキーとトークンの取得方法) にあります。登録後に **接続確認** で、トークンでリポジトリ・プロジェクトを読めるか確認できます。

| 種類 | 設定 | トークン |
| --- | --- | --- |
| GitHub | 所有者・リポジトリ名・ラベル（任意）・APIのURL（GitHub Enterprise Server のみ `https://ホスト/api/v3`） | Fine-grained personal access token（対象リポジトリの **Issues: Read and write** と **Metadata: Read**） |
| Jira | JiraのURL・メールアドレス・プロジェクトキー・課題タイプ名（既定 Epic / Story） | Jira Cloud: APIトークン（メールアドレスと組み合わせて Basic 認証）。Data Center: メールアドレスを空にして個人用アクセストークン |
| Backlog | スペースのURL・プロジェクトキー・種別名（既定「タスク」） | APIキー（個人設定 → API） |

API で登録する場合:

```bash
curl -X POST http://localhost:8787/api/orgs/$ORG/integrations \
  -H 'content-type: application/json' -H "authorization: Bearer $ID_TOKEN" \
  -d '{"kind":"github","config":{"owner":"acme","repo":"booking-app"},"token":"github_pat_..."}'
```

## セキュリティ

- トークンは AI の APIキーと同じ方法で暗号化して保存します（ローカル: AES-256-GCM、AWS: KMS。組織IDを暗号化コンテキストにするため、他の組織のデータとしては復号できません）
- 画面・API の応答・監査ログ・ジョブの記録にはトークンを出しません（表示は末尾4文字のみ）
- 接続先のURLは `https://` のみ受け付けます。リダイレクトは追いません
- 登録・変更・削除は admin 権限、課題の登録は editor 権限以上が必要です。登録の結果（誰が・どこに・何件）は監査ログに残ります
- 課題の本文には要件のコードと内容が入ります。社外の課題管理ツールに登録してよい内容か、機密プロジェクトでは特に確認してください

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET / POST | `/api/orgs/:orgId/integrations` | 連携先の一覧（viewer 以上）・登録（admin） |
| PATCH / DELETE | `/api/orgs/:orgId/integrations/:id` | 変更（設定は差分で上書き、`token` 省略で据え置き）・削除 |
| POST | `/api/orgs/:orgId/integrations/:id/test` | 接続確認 |
| GET | `/api/projects/:id/tasks` | 最新の分解結果（`stale`: 分解後に要件が変わったか） |
| POST | `/api/projects/:id/tasks/generate[?async=1]` | タスク分解 |
| GET | `/api/projects/:id/tasks/file/:format` | `md` / `jira.csv` / `backlog.csv` / `json` |
| POST | `/api/projects/:id/tasks/register[?async=1]` | 課題の登録 `{ integrationId, storyKeys?, planId? }` |
| GET | `/api/projects/:id/tasks/exports` | 登録の履歴 |
| GET | `/api/projects/:id/trace` | 要件 → ストーリー → 課題 |

## CSV で取り込む場合

- **Jira**: 「課題の作成 → CSVからインポート」で、`Issue Id` と `Parent Id` を対応付けると、エピック → ストーリー → サブタスクの階層で取り込めます
- **Backlog**: 「課題の一括登録（CSV）」で取り込みます。CSV では親子関係を指定できないため、エピックは「カテゴリー名」、作業タスクは詳細欄のチェックリストになります
