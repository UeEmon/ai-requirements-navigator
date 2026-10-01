# ADR 0003: AWSとローカルDockerで同じコンテナイメージを使う

- 状態: 決定
- 日付: 2026-10-02

## 決定

アプリ（Web画面＋API）は1つのコンテナイメージにまとめ、実行環境の違いは環境変数だけで切り替える。

| 機能 | 環境変数 | ローカルDocker | AWS |
| --- | --- | --- | --- |
| データ | `STORE` | `postgres`（postgres コンテナ） | `postgres`（RDS、TLS検証あり） |
| APIキー暗号化 | `KEY_ENCRYPTION` | `local`（MASTER_KEY） | `aws-kms` |
| 成果物 | `STORAGE` | `local`（ボリューム） | `s3` |
| 認証 | `AUTH_MODE` | `dev` または `oidc`（Keycloak） | `oidc`（Cognito） |
| 模擬AI | `ALLOW_MOCK_PROVIDER` | `true` | `false` |

- ジョブキューやキャッシュのために Redis を追加しない（ライセンスと構成の単純さのため）。非同期化が必要になったら PostgreSQL 上のキュー（pg-boss、MIT）を使う
- AWS 環境は AWS CDK（Apache-2.0）で構築する（`deploy/aws`）
- `NODE_ENV=production` では、開発用認証とメモリ保存での起動を拒否する

## 理由

- 手元で動いたものがそのままAWSで動く（環境差による不具合を減らす）
- 社内サーバー（Docker）とクラウドのどちらにも導入できる
