# Claude のプロジェクトで開発を管理する

要件ナビの開発を、claude.ai の **プロジェクト** で管理する手順です。プロジェクトにリポジトリの資料と決まりを入れておくと、どのチャットでも同じ前提で相談・作業できます。

| 置き場所 | 役割 |
| --- | --- |
| claude.ai のプロジェクト | 相談・設計・レビューのチャットをまとめる。プロジェクトの指示とナレッジは、そのプロジェクトのすべてのチャットで使われる |
| このリポジトリの [CLAUDE.md](../CLAUDE.md) | 開発の決まり（構成・秘密情報・テスト・コミット）。Claude Code も自動で読む |
| [development-status.md](development-status.md) | できていること・次の候補・確かめていないこと。作業のたびに更新する |

## 1. プロジェクトを作る

1. claude.ai の左の「Projects」（または claude.ai/projects）を開き、「+ New Project」を押す
2. 名前（例: 要件ナビの開発）と説明を入れて作る

## 2. プロジェクトの指示を入れる

「Set project instructions」を押し、次の文を貼り付けて保存します。

```text
このプロジェクトは、OSS「要件ナビ（AI要件定義支援システム）」の開発です。リポジトリは UeEmon/ai-requirements-navigator です。

- 日本語で応答してください。画面の文言・ドキュメントも日本語で、専門用語より利用者に伝わる言葉を選んでください。
- 開発の決まりはナレッジの CLAUDE.md に従ってください（構成、保存先はメモリと PostgreSQL の両方、権限と監査ログ、秘密情報を表示しない、テストとCI、コミット）。
- 今の状況と次の候補は development-status.md を見てください。新しい依頼は、すでにある機能・候補と重ならないかを確かめてから答えてください。
- 要件に関わる提案では、docs/requirements.md と関係する docs/adr を参照し、判断を伴うものは ADR に残す案も示してください。
- API キー・トークン・パスワードを、例でも全文で書かないでください。
- 作業を終えたら、development-status.md に足す内容（できたこと・残り・確かめていないこと）を最後に示してください。
```

## 3. ナレッジにリポジトリを入れる

プロジェクトのナレッジの「+」から **GitHub** を選び、リポジトリ `UeEmon/ai-requirements-navigator` を指定して、次のファイルとフォルダーを選びます。リポジトリ全体は大きいため、まず資料だけを入れ、コードは相談する部分だけを足します。

| 入れるもの | 理由 |
| --- | --- |
| `CLAUDE.md` | 開発の決まり |
| `docs/development-status.md` | 状況と次の候補 |
| `README.md` | 機能の全体と使い方 |
| `docs/requirements.md`・`docs/adr/` | 要件定義書と判断の記録 |
| `docs/auth.md`・`docs/ai-keys.md`・`docs/integrations.md` など | 相談する機能の説明（必要なものだけ） |
| `apps/api/src/permissions.ts`・`apps/api/src/store.ts` など | コードを相談するときだけ。終わったら外す |

- 後から選び直すときは「Configure files」を使います
- リポジトリを更新したら、ナレッジの **同期（Sync）** を押して最新にします。同期されるのはファイルの中身だけで、コミットの履歴やプルリクエストは入りません
- 非公開のリポジトリにしている場合は、Claude の GitHub アプリにリポジトリへのアクセスを許可します

## 4. 進め方

1. **依頼・相談**: 機能ごとに新しいチャットを始める（例:「プロジェクトごとのメンバーと役割を設計したい」）。前のチャットの内容は引き継がれないため、決まったことは development-status.md か ADR に残す
2. **実装**: Claude Code（またはこの作業用のセッション）でリポジトリを変更し、型チェック・テスト・CI を通してコミットする
3. **記録**: development-status.md を更新してコミットし、プロジェクトのナレッジを同期する

## 5. チームで使う

プロジェクトの共有は Team・Enterprise プランで使えます。共有された人の役割は「閲覧のみ（チャットはできる）」か「編集（指示とナレッジを変えられる）」です。

## 参考

- [Claude のプロジェクトの作り方と管理](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)
- [GitHub との連携](https://support.claude.com/en/articles/10167454-using-the-github-integration)
