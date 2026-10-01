import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { devAuthenticator, oidcAuthenticator } from "./auth.js";
import { KmsKeyEncryptor, LocalKeyEncryptor, type KeyEncryptor } from "./crypto.js";
import { migrate } from "./migrate.js";
import { PgStore } from "./pg-store.js";
import { LocalFsStorage, S3Storage, type ArtifactStorage } from "./storage.js";
import { MemoryStore, type Store } from "./store.js";

/**
 * 実行環境は環境変数だけで切り替える（コードは同じ）。
 *   ローカルDocker: STORE=postgres KEY_ENCRYPTION=local STORAGE=local AUTH_MODE=dev|oidc
 *   AWS:           STORE=postgres KEY_ENCRYPTION=aws-kms STORAGE=s3 AUTH_MODE=oidc
 */
const env = process.env;
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === "true" || v === "1");

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`環境変数 ${name} を設定してください（.env.example を参照）`);
  return v;
}

async function main() {
  const isProd = env.NODE_ENV === "production";

  // AWS（CDK）では接続情報をSecrets Managerから個別に受け取るため、ここで組み立てる
  if (!env.DATABASE_URL && env.DB_HOST && env.DB_PASSWORD) {
    const user = encodeURIComponent(env.DB_USER ?? "arn");
    const pass = encodeURIComponent(env.DB_PASSWORD);
    env.DATABASE_URL = `postgres://${user}:${pass}@${env.DB_HOST}:${env.DB_PORT ?? 5432}/${env.DB_NAME ?? "arn"}`;
  }

  let store: Store;
  if ((env.STORE ?? (env.DATABASE_URL ? "postgres" : "memory")) === "postgres") {
    const pgStore = PgStore.fromUrl(required("DATABASE_URL"), bool(env.DATABASE_SSL, false), env.DATABASE_SSL_CA);
    if (bool(env.MIGRATE_ON_START, true)) {
      await migrate(pgStore.pool, resolve(env.MIGRATIONS_DIR ?? "../../db/migrations"));
    }
    store = pgStore;
  } else {
    if (isProd) throw new Error("本番環境では STORE=postgres を使ってください");
    console.warn("[warn] メモリ保存で起動しています。再起動するとデータは消えます");
    store = new MemoryStore();
  }

  let encryptor: KeyEncryptor;
  if ((env.KEY_ENCRYPTION ?? "local") === "aws-kms") encryptor = new KmsKeyEncryptor(required("KMS_KEY_ID"), env.AWS_REGION);
  else encryptor = new LocalKeyEncryptor(required("MASTER_KEY"));

  let storage: ArtifactStorage;
  if ((env.STORAGE ?? "local") === "s3") storage = new S3Storage(required("S3_BUCKET"), env.AWS_REGION);
  else storage = new LocalFsStorage(resolve(env.STORAGE_DIR ?? "./data/artifacts"));

  const devAuth = (env.AUTH_MODE ?? "dev") === "dev";
  if (devAuth && isProd) throw new Error("本番環境では AUTH_MODE=oidc を使ってください");
  const authenticate = devAuth
    ? devAuthenticator
    : oidcAuthenticator({
        issuer: required("OIDC_ISSUER"),
        audience: env.OIDC_AUDIENCE || undefined,
        orgClaim: env.OIDC_ORG_CLAIM ?? "custom:org_id",
        roleClaim: env.OIDC_ROLE_CLAIM ?? "cognito:groups",
      });

  const allowMock = bool(env.ALLOW_MOCK_PROVIDER, !isProd);
  const app = createApp({
    store,
    encryptor,
    storage,
    authenticate,
    allowMock,
    devAuth,
    bootstrapToken: env.BOOTSTRAP_TOKEN || undefined,
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 90_000),
  });

  // 画面（apps/web/public）を同じコンテナから配信する
  const webRoot = env.WEB_DIR ?? "../web/public";
  app.use("/*", serveStatic({ root: webRoot }));

  const port = Number(env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`listening on :${port}  store=${store.constructor.name} auth=${devAuth ? "dev" : "oidc"} mock=${allowMock}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
