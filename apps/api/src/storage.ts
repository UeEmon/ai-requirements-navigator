import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

/**
 * 成果物（仕様書・図）の保存先。
 * - ローカルDocker: LocalFsStorage（ボリュームをマウント）
 * - AWS: S3Storage
 */
export interface ArtifactStorage {
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

function safeKey(key: string): string {
  const k = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  if (k.startsWith("/") || k.includes("..")) throw new Error("不正な保存キーです");
  return k;
}

export class LocalFsStorage implements ArtifactStorage {
  constructor(private readonly root: string) {}
  async put(key: string, body: string | Uint8Array): Promise<void> {
    const path = join(this.root, safeKey(key));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(join(this.root, safeKey(key)));
    } catch {
      return null;
    }
  }
}

export class S3Storage implements ArtifactStorage {
  constructor(
    private readonly bucket: string,
    private readonly region?: string,
  ) {}
  private async s3() {
    const m = await import("@aws-sdk/client-s3");
    return { client: new m.S3Client({ region: this.region }), m };
  }
  async put(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const { client, m } = await this.s3();
    await client.send(
      new m.PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: body, ContentType: contentType, ServerSideEncryption: "aws:kms" }),
    );
  }
  async get(key: string): Promise<Uint8Array | null> {
    const { client, m } = await this.s3();
    try {
      const out = await client.send(new m.GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
      return out.Body ? await out.Body.transformToByteArray() : null;
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }
}

export class MemoryStorage implements ArtifactStorage {
  readonly files = new Map<string, Uint8Array>();
  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.files.set(safeKey(key), typeof body === "string" ? new TextEncoder().encode(body) : body);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(safeKey(key)) ?? null;
  }
}
