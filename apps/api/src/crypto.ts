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

export class LocalKeyEncryptor implements KeyEncryptor {
  private readonly key: Buffer;
  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64, "base64");
    if (key.length !== 32) throw new Error("MASTER_KEY は32バイトをBase64にした値にしてください（npm run gen:key）");
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
