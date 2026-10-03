# ログインの設定

`AUTH_MODE=oidc` にすると、画面右上に「ログイン」ボタンが出ます。OpenID Connect の **認可コード＋PKCE** でログインし、コードとトークンの交換はサーバー（`/api/auth/token`）が行います。ブラウザからトークン窓口を直接呼ばないため、認証サーバー側の CORS 設定は不要です。

APIは **IDトークン** を検証します。

## 組織と役割（要件ナビで管理）

ログインの仕組み（Cognito・Keycloak）は **本人の確認だけ** に使います。どの組織に入れるか（メンバー）と役割は、要件ナビの **「組織」タブ** で、組織の管理者が決めます。

1. 組織を作る（初期セットアップ用トークン `BOOTSTRAP_TOKEN` と **最初の管理者のメールアドレス** を指定。画面右上の「組織を作成」または `POST /api/orgs` `{name, adminEmail}`）
2. 最初の管理者が、そのメールアドレスでログインする（アカウントがなければ、ログイン画面で作る）→ 管理者になる
3. 管理者が「組織」タブで、メンバーをメールアドレスで招待し、役割（管理者・編集者・レビュー担当・閲覧者）を選ぶ。表示される招待の文（ログインの URL 入り）を、メールやチャットで送る（要件ナビからはメールを送りません）
4. 招待された人が、同じメールアドレスでログインすると、その組織に入れる

| 決まり | 内容 |
| --- | --- |
| 招待との照合 | ログインの仕組みが **確認済み** としたメールアドレス（`email_verified`）と照合します。メールを送れないローカルの Keycloak では `OIDC_TRUST_UNVERIFIED_EMAIL=true` |
| 複数の組織 | 1人で複数の組織に入れます。画面右上で組織を切り替えます（API ではヘッダー `x-org-id`） |
| 外す | 外した人は、その組織に入れません（下のクレームがあっても入れません） |
| 管理者 | 組織の管理者は最低1人必要です。最後の管理者の役割を変えたり、外したりはできません |
| 招待されていない人 | ログインはできても、どの組織にも入れません（「まだどの組織にも招待されていません」と表示） |
| 記録 | 招待・役割の変更・外したことは、監査ログに残ります |

### 以前の運用（クレームで組織と役割を決める）との互換

IDトークンに組織と役割のクレームがある利用者は、最初のログインで、その組織のメンバーとして登録します（役割はクレームのもの）。以後は「組織」タブの設定に従います（ログインの仕組み側で役割を変えても反映しません）。

| 項目 | 環境変数 | Cognito | Keycloak（同梱の設定） |
| --- | --- | --- | --- |
| 組織ID | `OIDC_ORG_CLAIM` | `custom:org_id`（カスタム属性） | `org_id`（ユーザー属性） |
| 権限 | `OIDC_ROLE_CLAIM` | `cognito:groups`（グループ） | `roles`（レルムロール） |

## AWS（Amazon Cognito）

`deploy/aws` の CDK が、ユーザープール・グループ・ログイン画面のドメイン・アプリクライアントを作ります。

```bash
cd deploy/aws
npx cdk deploy -c certificateArn=arn:aws:acm:ap-northeast-1:...:certificate/... -c domainName=req.example.com
```

- **HTTPS が必須です。** Cognito は https 以外の戻り先を受け付けないため、証明書（ACM）を指定してください。独自ドメインを使う場合は、DNS の CNAME を出力 `Url` の ALB に向けます
- ログイン画面のドメインは `arn-<アカウントID>.auth.<リージョン>.amazoncognito.com` です。変える場合は `-c cognitoDomainPrefix=...`
- 利用者は、ログイン画面の「サインアップ」で自分のアカウントを作れます（メールアドレスを確認）。組織に入れるかは、要件ナビの「組織」タブで管理者が招待して決めます
- 最初の組織は、出力 `BootstrapTokenSecret` のトークンと最初の管理者のメールアドレスで作ります（画面右上の「組織を作成」）
- Cognito の確認メールは、既定では送信数に上限があります（1日あたり）。多人数で使う場合は、Cognito のメール送信を Amazon SES にしてください
- 以前の運用（AWSコンソールでユーザーを作り、`custom:org_id` とグループを設定）も使えます。その人は最初のログインでメンバーとして登録されます

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

利用者は、ログイン画面の「Register」で自分のアカウントを作れます（同梱のレルムで有効）。ローカルの Keycloak はメールを送れないため、`.env` に `OIDC_TRUST_UNVERIFIED_EMAIL=true` を追加してください。組織に入れるかは、要件ナビの「組織」タブで管理者が招待して決めます。

管理画面（http://localhost:8080、admin / admin）で利用者を作る場合は、**Users** → **Add user**（メールアドレスを入れ、**Email verified** をオン）→ **Credentials** でパスワードを設定します。

## 動作の確認状況

- サーバー側（コード交換、更新、IDトークンの検証、招待との照合、組織・役割の判定、複数の組織の切り替え、監査ログへの記録）は、テスト用の認証サーバーを使った自動テストで確認しています
- Cognito・Keycloak との実際の接続と、ブラウザでのログイン画面の遷移は、この環境では確認できていません。導入時に一度確認してください
