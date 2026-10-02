# ログインの設定

`AUTH_MODE=oidc` にすると、画面右上に「ログイン」ボタンが出ます。OpenID Connect の **認可コード＋PKCE** でログインし、コードとトークンの交換はサーバー（`/api/auth/token`）が行います。ブラウザからトークン窓口を直接呼ばないため、認証サーバー側の CORS 設定は不要です。

APIは **IDトークン** を検証します。利用者の組織と権限は、IDトークンの次のクレームから読み取ります。

| 項目 | 環境変数 | Cognito | Keycloak（同梱の設定） |
| --- | --- | --- | --- |
| 組織ID | `OIDC_ORG_CLAIM` | `custom:org_id`（カスタム属性） | `org_id`（ユーザー属性） |
| 権限 | `OIDC_ROLE_CLAIM` | `cognito:groups`（グループ） | `roles`（レルムロール） |

権限は `admin` / `editor` / `reviewer` / `viewer` のいずれかです。複数ある場合は最も強いものを使います。組織IDがない利用者はログインできません（403）。

## AWS（Amazon Cognito）

`deploy/aws` の CDK が、ユーザープール・グループ・ログイン画面のドメイン・アプリクライアントを作ります。

```bash
cd deploy/aws
npx cdk deploy -c certificateArn=arn:aws:acm:ap-northeast-1:...:certificate/... -c domainName=req.example.com
```

- **HTTPS が必須です。** Cognito は https 以外の戻り先を受け付けないため、証明書（ACM）を指定してください。独自ドメインを使う場合は、DNS の CNAME を出力 `Url` の ALB に向けます
- ログイン画面のドメインは `arn-<アカウントID>.auth.<リージョン>.amazoncognito.com` です。変える場合は `-c cognitoDomainPrefix=...`
- 利用者の追加（管理者がAWSコンソールまたはCLIで行う）:
  1. ユーザープールにユーザーを作成
  2. カスタム属性 `custom:org_id` に組織IDを設定（組織は画面の「組織を作成」と、出力 `BootstrapTokenSecret` のトークンで作成）
  3. グループ `admin` / `editor` / `reviewer` / `viewer` のいずれかに追加

## ローカルDocker（Keycloak）

```bash
# .env に追記
AUTH_MODE=oidc
OIDC_ISSUER=http://localhost:8080/realms/arn
OIDC_DISCOVERY_URL=http://keycloak:8080/realms/arn/.well-known/openid-configuration
OIDC_CLIENT_ID=arn-web
OIDC_ORG_CLAIM=org_id
OIDC_ROLE_CLAIM=roles
BOOTSTRAP_TOKEN=任意の長い文字列

docker compose --profile oidc up --build
```

`deploy/keycloak/realm-arn.json` がレルム `arn`、クライアント `arn-web`（公開クライアント・PKCE必須）、ロール4種、クレームの設定を読み込みます。

`OIDC_DISCOVERY_URL` を分けているのは、ブラウザは `localhost:8080`、app コンテナは `keycloak:8080` で Keycloak に接続するためです（`KC_HOSTNAME_BACKCHANNEL_DYNAMIC`）。トークンの発行者はどちらも `http://localhost:8080/realms/arn` になります。

利用者の追加（http://localhost:8080 の管理画面、admin / admin）:

1. レルム `arn` → **Realm settings** → **General** → **Unmanaged attributes** を **Enabled** にする（任意の属性 `org_id` を使うため。初回のみ）
2. **Users** → **Add user** → **Credentials** でパスワードを設定
3. **Attributes** に `org_id` = 組織ID を追加（組織は画面の「組織を作成」と `BOOTSTRAP_TOKEN` で作成）
4. **Role mapping** で `admin` などのロールを割り当て

## 動作の確認状況

- サーバー側（コード交換、更新、IDトークンの検証、組織・権限の判定、監査ログへの記録）は、テスト用の認証サーバーを使った自動テストで確認しています
- Cognito・Keycloak との実際の接続と、ブラウザでのログイン画面の遷移は、この環境では確認できていません。導入時に一度確認してください
