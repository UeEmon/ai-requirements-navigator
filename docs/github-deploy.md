# GitHub からの展開

GitHub に公開しているものを使って、要件ナビを動かす方法です。

| 方法 | 向いている場面 | 必要なもの |
| --- | --- | --- |
| [A. 公開イメージで Docker Desktop に展開](#a-公開イメージで-docker-desktop-に展開) | 1台のPCで使う・試す | Docker Desktop だけ（ソースの取得・ビルドは不要） |
| [B. GitHub Actions で AWS に展開](#b-github-actions-で-aws-に展開) | 組織で常時使う | AWS アカウント（初回に IAM の設定） |
| [C. テンプレートから自分のリポジトリを作る](#c-テンプレートから自分のリポジトリを作る) | 手を加えて使う | GitHub アカウント |

## 仕組み

`main` に push すると、CI でテスト（単体・PostgreSQL・Docker・docker compose・CDK）がすべて通った後に、コンテナイメージを GitHub Container Registry に公開します。`v` から始まるタグを push すると、版の番号つきのイメージと、Docker Desktop 用のキット（`compose.yml` と `.env.example`）を添付したリリースを作ります。

| イメージのタグ | 中身 |
| --- | --- |
| `ghcr.io/ueemon/ai-requirements-navigator:main` | `main` の最新（開発版） |
| `…:0.1.0`・`…:0.1`・`…:latest` | リリースした版（`latest` は最新のリリース） |
| `…:sha-1a2b3c4` | コミットごと |

イメージは Intel・AMD（amd64）と Apple シリコン・ARM（arm64）の両方に対応しています。

## A. 公開イメージで Docker Desktop に展開

### A-1. ファイルを取得する

**リリースから（おすすめ）**：GitHub のリポジトリの「Releases」から `arn-docker-<版>.zip` をダウンロードして展開します。`compose.yml`・`.env.example`・`README.txt`・`keycloak/` が入っています。

**リリースがまだない、または最新の開発版を使う場合**：2つのファイルを取得します。

```bash
# Mac
mkdir arn && cd arn
curl -fLO https://raw.githubusercontent.com/UeEmon/ai-requirements-navigator/main/deploy/docker/compose.yml
curl -fL -o .env.example https://raw.githubusercontent.com/UeEmon/ai-requirements-navigator/main/.env.example
```

```powershell
# Windows（PowerShell）
mkdir arn; cd arn
Invoke-WebRequest https://raw.githubusercontent.com/UeEmon/ai-requirements-navigator/main/deploy/docker/compose.yml -OutFile compose.yml
Invoke-WebRequest https://raw.githubusercontent.com/UeEmon/ai-requirements-navigator/main/.env.example -OutFile .env.example
```

### A-2. 設定して起動する

```bash
cp .env.example .env            # Windows: Copy-Item .env.example .env
```

暗号化の鍵を作って `.env` に書き込みます（コマンドは [Docker Desktop への展開手順の「暗号化の鍵を作る」](docker-desktop.md#暗号化の鍵master_keyを作る) と同じです。Windows と Mac で書き方が違います）。その後に起動します。

```bash
docker compose up -d
```

ブラウザで http://localhost:8787 を開きます。最初の設定（組織の作成・AI の登録・サンプル事例）は [Docker Desktop への展開手順の 5.](docker-desktop.md#5-最初の設定) と同じです。

> `MASTER_KEY` は別の安全な場所にも控えてください。なくすと、登録済みの API キーを読めなくなります。

### A-3. 版を選ぶ・更新する

`.env` の `ARN_VERSION` で版を選びます（リリースのキットでは、その版が入っています）。

| ARN_VERSION | 使うイメージ |
| --- | --- |
| `0.1.0` など | その版に固定（おすすめ） |
| `latest` | 最新のリリース |
| `main`（ファイルを直接取得した場合の既定） | `main` の最新（開発版） |

更新は次のとおりです。データベースの変更は起動時に自動で適用されます。更新の前にバックアップを取ってください（[手順](docker-desktop.md#8-バックアップと復元)）。

```bash
# 版を固定している場合は、先に .env の ARN_VERSION を新しい版にする
docker compose pull
docker compose up -d
```

ポートの変更・ローカルLLM・ログイン画面・バックアップ・うまくいかないときは、[Docker Desktop への展開手順](docker-desktop.md) と同じです（`docker-compose.yml` を `compose.yml` に読み替えます。コマンドは同じです）。

### イメージを取得できないとき

`docker compose up` で `denied` や `unauthorized` と出る場合は、イメージが非公開になっています。

- リポジトリの所有者が、GitHub のプロフィール →「Packages」→ `ai-requirements-navigator` →「Package settings」→「Change visibility」で **Public** にします（CI の結果にも、非公開のときは警告が出ます）
- 非公開のまま使う場合は、`read:packages` の権限を持つ個人用アクセストークンで `docker login ghcr.io` してから起動します

## B. GitHub Actions で AWS に展開

GitHub の画面から、ワークフロー「Deploy to AWS」を手動で実行して AWS に展開します。AWS のアクセスキーは GitHub に保存せず、OIDC で一時的な認証情報を受け取ります。構成（VPC・ECS Fargate・ALB・RDS・KMS・S3・Cognito）は [README の AWS へのデプロイ](../README.md#aws-へのデプロイ) と同じです。

### B-1. 初回だけ: AWS の準備

**1) GitHub の OIDC プロバイダを登録する**（IAM → ID プロバイダ → プロバイダを追加）

| 項目 | 値 |
| --- | --- |
| プロバイダのタイプ | OpenID Connect |
| プロバイダの URL | `https://token.actions.githubusercontent.com` |
| 対象者 | `sts.amazonaws.com` |

**2) 展開用の IAM ロールを作る**。信頼ポリシーは、このリポジトリの環境 `aws-production` からだけ引き受けられるようにします（`<アカウントID>` を置き換え）。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<アカウントID>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:UeEmon/ai-requirements-navigator:environment:aws-production"
        }
      }
    }
  ]
}
```

権限は、CDK が作るロールを引き受けることだけにします（実際の作成は CDK のブートストラップで作られたロールが行います）。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::<アカウントID>:role/cdk-*" }
  ]
}
```

**3) CDK のブートストラップ**（アカウント・リージョンごとに1回）。AWS CloudShell でも実行できます。

```bash
git clone https://github.com/UeEmon/ai-requirements-navigator.git
cd ai-requirements-navigator/deploy/aws
npm install
npx cdk bootstrap aws://<アカウントID>/ap-northeast-1
```

### B-2. 初回だけ: GitHub の準備

リポジトリの Settings → Environments →「New environment」で `aws-production` を作り、次の変数（Variables）を設定します。

| 変数 | 例 |
| --- | --- |
| `AWS_ROLE_ARN` | `arn:aws:iam::123456789012:role/arn-github-deploy` |
| `AWS_REGION` | `ap-northeast-1` |
| `GOOGLE_OAUTH_CLIENT_ID`（任意） | Gemini の API キーを Google のログインで自動発行する場合の OAuth クライアント ID（[設定方法](ai-keys.md#サーバーの設定初回だけ要件ナビの運用担当者)） |
| `GOOGLE_OAUTH_SECRET_ARN`（任意） | その OAuth クライアントのシークレットを入れた Secrets Manager のシークレットの完全な ARN |

「Required reviewers」に承認者を設定すると、展開の前に承認を求められます（本番ではおすすめ）。

### B-3. 展開する

Actions →「Deploy to AWS」→「Run workflow」で、次を入れて実行します。

| 入力 | 内容 |
| --- | --- |
| 証明書の ARN | HTTPS にする場合の ACM 証明書（空なら HTTP） |
| 独自ドメイン | 証明書を指定した場合のドメイン |
| コンテナの数 | 既定 1 |
| スタック名 | 既定 `ArnStack`（検証用と本番用を分けるときに変える） |

ワークフローは、変更点（`cdk diff`）を表示してから展開します。終わると、実行結果の Summary に URL や初期設定に使う値（`BootstrapTokenSecret` など）が出ます。初期設定（組織の作成・Cognito の利用者）は [README](../README.md#aws-へのデプロイ) の手順です。

更新するときは、`main` に変更を取り込んでから同じワークフローをもう一度実行します。アプリのイメージは、実行したときのソースから作られます。

## C. テンプレートから自分のリポジトリを作る

このリポジトリはテンプレートです。GitHub の「Use this template」で自分のリポジトリを作ると、同じワークフローが動きます。

- `main` に push すると、イメージは `ghcr.io/<自分のアカウント>/<リポジトリ名>` に公開されます。リリースのキットは、自動でそのイメージを使う設定になります
- ファイルを直接取得して使う場合は、`.env` に `ARN_IMAGE=ghcr.io/<自分のアカウント>/<リポジトリ名>` を書きます
- AWS に展開する場合は、B の信頼ポリシーの `repo:` を自分のリポジトリに変えます
- 新しいシステムの要件定義に使う準備（名前の変更・要件定義書の雛形）は `npm run init:project` です（[README](../README.md)）

## リリースの出し方（所有者向け）

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI のテストがすべて通ると、イメージ（`0.1.0`・`0.1`・`latest`）を公開し、`arn-docker-0.1.0.zip` を添付したリリースを作ります。テストが通らなければ、イメージもリリースも作りません。
