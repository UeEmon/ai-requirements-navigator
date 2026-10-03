# Docker Desktop への展開手順

要件ナビを、Windows または Mac の Docker Desktop で動かす手順です。アプリ（app）とデータベース（PostgreSQL）の2つのコンテナを `docker compose` で起動します。AWS と同じコンテナイメージを使います（[ADR 0003](adr/0003-same-image-aws-and-docker.md)）。

この手順は CI（`compose` ジョブ）で毎回そのとおりに実行して確かめています。

> ソースの取得とビルドをせずに、GitHub で公開しているイメージを使う方法もあります（[GitHub からの展開](github-deploy.md#a-公開イメージで-docker-desktop-に展開)）。手を加えずに使うだけなら、そちらが手軽です。

## 1. 準備

| 必要なもの | 内容 |
| --- | --- |
| Docker Desktop | Windows 10/11（WSL 2 バックエンド）または macOS（Intel・Apple シリコンとも可）。Docker Compose v2 が入っています |
| メモリ | Docker に 4GB 以上（ローカルLLMも動かすなら 8GB 以上）。Docker Desktop の Settings → Resources で確認 |
| ディスク | 10GB 程度（イメージとデータ） |
| ネットワーク | 最初の組み立て（ビルド）で、Docker Hub・npm の公開リポジトリ・`truststore.pki.rds.amazonaws.com` に接続します。社内のプロキシを通す場合は Docker Desktop の Settings → Resources → Proxies に設定してください |
| Git | ソースの取得に使います（ZIP でダウンロードしても構いません） |

> Docker Desktop は、一定規模以上の企業での利用に有償のサブスクリプションが必要です。利用条件は Docker 社のサイトで確認してください。

## 2. ソースを取得する

```bash
git clone https://github.com/UeEmon/ai-requirements-navigator.git
cd ai-requirements-navigator
```

以降のコマンドは、このフォルダ（`docker-compose.yml` があるところ）で実行します。Windows は PowerShell、Mac はターミナルを使います。

## 3. 設定ファイル（.env）を作る

```bash
# Mac
cp .env.example .env
```

```powershell
# Windows（PowerShell）
Copy-Item .env.example .env
```

### 暗号化の鍵（MASTER_KEY）を作る

組織の管理者が登録する AI の API キーは、この鍵で暗号化して保存します。次のコマンドで鍵を作り、`.env` の `MASTER_KEY=` の行に**自動で書き込みます**（手で貼り付けると、別の行を写してしまう間違いが起きやすいため）。Docker だけで動きます。

```powershell
# Windows（PowerShell）
$k = docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
$lines = (Get-Content -Encoding UTF8 .env) -replace '^MASTER_KEY=.*', "MASTER_KEY=$k"
[IO.File]::WriteAllLines("$PWD\.env", $lines)
Select-String -Path .env -Pattern '^MASTER_KEY='
```

```bash
# Mac
k=$(docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
sed -i '' "s|^MASTER_KEY=.*|MASTER_KEY=$k|" .env
grep '^MASTER_KEY=' .env
```

最後の行で `MASTER_KEY=` の後ろに44文字（英数字と `+` `/`、最後が `=`）が表示されれば完了です。手で書く場合も、`MASTER_KEY=` の後ろにこの44文字だけを入れます（空白・引用符・日本語は入れない）。

> 初めて実行するときは、イメージの取得中に `Digest: sha256:…` などの行も表示されます。これは鍵ではありません。上のコマンドは鍵だけを書き込みます。

> **この鍵は別の安全な場所にも控えてください。** なくすと、登録済みの API キーを読めなくなります（その場合は、管理者が API キーを登録し直します）。`.env` は Git に入れないでください（`.gitignore` 済み）。

### 必要に応じて変える値

| 値 | 既定 | 変えるとき |
| --- | --- | --- |
| `ARN_PORT` | 8787 | このPCで 8787 番が使われている |
| `DB_PORT` | 5432 | このPCにほかの PostgreSQL がある（例: 15432） |
| `ARN_BIND` | 127.0.0.1 | ほかのPCからも使う（[6-5](#6-5-社内のほかのpcから使う) を参照） |
| `AUTH_MODE` | dev | ログイン画面を使う（[6-2](#6-2-ログイン画面を使うkeycloak) を参照） |
| `ALLOW_MOCK_PROVIDER` | true | 模擬AI（APIキーなしのお試し用）を使わせない場合は false |

データベースの接続先や成果物の保存先など、コンテナの中の場所は `docker-compose.yml` が決めるため、`.env` で変える必要はありません。

## 4. 起動する

```bash
docker compose up -d --build
```

初回はイメージの組み立てに数分〜10分ほどかかります。起動したかは次で確かめます。

```bash
docker compose ps
```

`app` と `db` が `running`（db は `healthy`）になったら、ブラウザで **http://localhost:8787** を開きます。Docker Desktop の画面では、Containers に `ai-requirements-navigator` として表示されます。

## 5. 最初の設定

既定（`AUTH_MODE=dev`）は開発用のログインで、画面右上で組織と役割を選んで操作します。

1. 右上の「組織を作成」で組織を作る
2. 「AI設定・プロジェクト」で AI を登録する
   - お試し: 種類「模擬AI（開発用）」を3つ（生成用2つ・評価用1つ）
   - 本番の AI: 「Claude を登録」「ChatGPT を登録」「Gemini を登録」のカードから、モデルIDとその AI の API キー（Claude APIキー・ChatGPT（OpenAI）APIキー・Gemini APIキー）を入れる。発行する場所は [AI の登録と API キー](ai-keys.md)
3. 同じタブの「サンプル事例を読み込む」で、本システム自身の要求事項を題材にした事例を開く（要件69件・非機能要件シート・用語集・受け入れ基準入り）
4. 以降の使い方は [README](../README.md#すぐに試すローカルdocker) の手順のとおり

開発用のログインでは、役割（管理者・編集者・レビュー担当・閲覧者）ごとに別の利用者として扱います。レビューの依頼と承認は、役割を切り替えて試せます。

## 6. 必要に応じて

### 6-1. ローカルLLM（Ollama）を使う

社外に送れない（機密）プロジェクトでは、ローカルLLMだけを使えます。

```bash
docker compose --profile local-llm up -d
docker compose exec ollama ollama pull <モデル名>
```

AI の登録で種類「ローカルLLM」、接続先 `http://ollama:11434`、モデル名に取り込んだモデルを指定します。CPU だけでは応答に時間がかかります（`.env` の `AI_TIMEOUT_MS` を長めにしてください）。

### 6-2. ログイン画面を使う（Keycloak）

```bash
docker compose --profile oidc up -d
```

`.env` の設定（`AUTH_MODE=oidc` など）と利用者の登録は [ログインの設定](auth.md) を参照してください。設定を変えたら `docker compose up -d` で app を作り直します。

### 6-3. AI コーディングツールを接続する

「AI設定・プロジェクト」で管理者がトークンを発行し、同じPCの Claude Code などから接続します。

```bash
claude mcp add --transport http requirements-navigator http://localhost:8787/mcp --header "Authorization: Bearer <トークン>"
```

詳しくは [開発・テストのツールとの連携](connect.md)。ほかのPCから使う場合や、ポートを変えた場合は、`.env` の `PUBLIC_URL` に外から見たURLを書くと、開発用パッケージの接続先がそのURLになります。

### 6-4. 同じPCの CI などへ Webhook を送る

コンテナの中の `localhost` はコンテナ自身を指します。同じPCで動いているサービスへは `http://host.docker.internal:<ポート>/...` を送り先にし、`.env` に `WEBHOOK_ALLOW_PRIVATE=true` を設定します（社内アドレスと http を許すため、ローカルでの利用に限ってください）。

### 6-5. 社内のほかのPCから使う

開発用のログインは誰でも管理者を名乗れるため、**必ずログイン画面（`AUTH_MODE=oidc`）にしてから**公開します。

```text
AUTH_MODE=oidc
NODE_ENV=production
ALLOW_MOCK_PROVIDER=false
BOOTSTRAP_TOKEN=<最初の組織を作るための長いランダムな文字列>
ARN_BIND=0.0.0.0
PUBLIC_URL=http://<このPCの名前またはIPアドレス>:8787
```

Windows ではファイアウォールで 8787 番の受信を許可します。通信を暗号化する場合は、手前に HTTPS のリバースプロキシを置いてください。多人数で常時使う場合は AWS への展開（[README](../README.md#aws-へのデプロイ)）を検討してください。

## 7. 更新する

```bash
git pull
docker compose up -d --build
```

データベースの変更（マイグレーション）は起動時に自動で適用されます。更新の前に [バックアップ](#8-バックアップと復元) を取ってください。

## 8. バックアップと復元

データは Docker のボリューム（`pgdata`: データベース、`artifacts`: 保存した仕様書）にあります。次のコマンドは Windows・Mac 共通です（PowerShell のリダイレクトはファイルを壊すことがあるため、コンテナの中で作ってから取り出します）。

**バックアップ**

```bash
docker compose exec -T db pg_dump -U arn -Fc -f /tmp/arn.dump arn
docker compose cp db:/tmp/arn.dump ./arn.dump
docker compose cp app:/data/artifacts ./artifacts-backup
```

`.env`（とくに `MASTER_KEY`）も一緒に、安全な場所に保管してください。データベースだけを戻しても、`MASTER_KEY` が違うと登録済みの API キーを読めません。

**復元**

```bash
docker compose stop app
docker compose cp ./arn.dump db:/tmp/arn.dump
docker compose exec -T db pg_restore -U arn -d arn --clean --if-exists /tmp/arn.dump
docker compose start app
```

## 9. 止める・消す

| コマンド | 内容 |
| --- | --- |
| `docker compose stop` | 止める（`docker compose start` で再開） |
| `docker compose down` | コンテナを消す。**データ（ボリューム）は残る** |
| `docker compose down -v` | コンテナと**データをすべて消す**（元に戻せません） |
| `docker compose logs -f app` | アプリのログを見る |

## 10. うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| `Bind for 127.0.0.1:8787 failed: port is already allocated` | ほかのアプリが使っています。`.env` の `ARN_PORT`（DB は `DB_PORT`）を変えて `docker compose up -d` |
| app がすぐ止まり、ログに「MASTER_KEY …」 | `.env` の `MASTER_KEY` が空か、鍵ではない文字列（`Digest: sha256:…` の行、説明文、途中で切れた文字列など）になっています。メッセージに文字数とバイト数が出ます。[3](#暗号化の鍵master_keyを作る) のコマンドで書き込み直し、`docker compose up -d` で起動し直す。まだ API キーを登録していなければ、鍵を作り直しても影響はありません |
| ビルドが `npm ci` や証明書の取得で失敗する | ネットワーク・プロキシの設定を確認（Settings → Resources → Proxies）。社内の証明書で通信を検査している場合は、ネットワークの管理者に相談してください |
| 画面は出るが AI の呼び出しが失敗する | 「AI設定・プロジェクト」の「登録済みのAI」で、キーの末尾4桁とモデルIDを確認（[確かめ方](ai-keys.md#登録したキーを確かめる)）。API の支払い設定と、会社のネットワークから AI の提供元に接続できるかも確認 |
| 「組織の作成には初期セットアップ用トークンが必要です」 | `AUTH_MODE=oidc` のときは、`.env` の `BOOTSTRAP_TOKEN` を画面の入力欄に入れて組織を作ります |
| 動作が遅い・止まる | Docker Desktop のメモリを増やす（Settings → Resources）。ローカルLLMは特にメモリを使います |
| 最初からやり直したい | `docker compose down -v` の後、`docker compose up -d --build`（データはすべて消えます） |
