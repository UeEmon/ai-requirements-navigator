import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 組織ごとに登録されたAIのAPIキーを暗号化する。
 * - ローカルDocker: LocalKeyEncryptor（MASTER_KEY による AES-256-GCM）
 * - AWS: KmsKeyEncryptor（AWS KMS）
 */
export interface KeyEncryptor {
  encrypt(plain: string, context: { orgId: string }): Promise<string>;
  decrypt(cipher: string, context: { orgId: string }): Promise<string>;
}

/**
 * MASTER_KEY（32バイトを Base64 にした44文字）を読む。前後の空白・引用符は取り除く。
 * 間違っているときは、何が違うかを示す（鍵そのものはログに出さない）。
 */
export function parseMasterKey(raw: string): Buffer {
  const v = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const how =
    "作り方: docker run --rm node:22-alpine node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" の出力（44文字）を、.env の MASTER_KEY= の後ろに入れる（docs/docker-desktop.md）";
  if (!v) throw new Error(`MASTER_KEY が空です。${how}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) {
    throw new Error(`MASTER_KEY に Base64 で使わない文字が含まれています（${v.length}文字。空白・日本語・「Digest: sha256:…」など別の行を貼っていないか確認してください）。${how}`);
  }
  const key = Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error(`MASTER_KEY は32バイトをBase64にした44文字にしてください（いまは${v.length}文字、${key.length}バイト）。${how}`);
  return key;
}

export class LocalKeyEncryptor implements KeyEncryptor {
  private readonly key: Buffer;
  constructor(masterKeyBase64: string) {
    const key = parseMasterKey(masterKeyBase64);
    this.key = key;
  }

  async encrypt(plain: string, { orgId }: { orgId: string }): Promise<string> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(orgId)); // 別組織のレコードに付け替えても復号できないようにする
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  async decrypt(cipher: string, { orgId }: { orgId: string }): Promise<string> {
    const [v, iv, tag, ct] = cipher.split(":");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("暗号文の形式が不正です");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAAD(Buffer.from(orgId));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  }
}

export class KmsKeyEncryptor implements KeyEncryptor {
  constructor(
    private readonly keyId: string,
    private readonly region?: string,
  ) {}

  private async client() {
    const { KMSClient, EncryptCommand, DecryptCommand } = await import("@aws-sdk/client-kms");
    return { kms: new KMSClient({ region: this.region }), EncryptCommand, DecryptCommand };
  }

  async encrypt(plain: string, { orgId }: { orgId: string }): Promise<string> {
    const { kms, EncryptCommand } = await this.client();
    const out = await kms.send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: Buffer.from(plain), EncryptionContext: { orgId } }),
    );
    return "kms:" + Buffer.from(out.CiphertextBlob!).toString("base64");
  }

  async decrypt(cipher: string, { orgId }: { orgId: string }): Promise<string> {
    if (!cipher.startsWith("kms:")) throw new Error("KMSの暗号文ではありません");
    const { kms, DecryptCommand } = await this.client();
    const out = await kms.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(cipher.slice(4), "base64"), EncryptionContext: { orgId } }),
    );
    return Buffer.from(out.Plaintext!).toString("utf8");
  }
}

/** 画面表示用。末尾4桁だけ見せる */
export function maskKey(last4: string | null | undefined): string | null {
  return last4 ? `••••${last4}` : null;
}
