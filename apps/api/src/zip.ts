import { deflateRawSync } from "node:zlib";

/**
 * ZIP の作成（引き継ぎパッケージ用）。依存を増やさないため最小限の実装にする。
 * - 圧縮は deflate、ファイル名は UTF-8（汎用ビット11）
 * - ZIP64 には対応しない（1ファイル・全体とも 4GB 未満）
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipEntry {
  /** 区切りは /。先頭の / や .. は使えない */
  path: string;
  content: string | Buffer;
}

export function zipFiles(entries: ZipEntry[], date = new Date()): Buffer {
  const { time, date: day } = dosTime(date);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.path || e.path.startsWith("/") || e.path.split("/").some((s) => s === ".." || s === "")) throw new Error(`ZIPに入れられないパスです: ${e.path}`);
    if (seen.has(e.path)) throw new Error(`ZIPのパスが重複しています: ${e.path}`);
    seen.add(e.path);
    const name = Buffer.from(e.path, "utf8");
    const data = typeof e.content === "string" ? Buffer.from(e.content, "utf8") : e.content;
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に必要なバージョン
    local.writeUInt16LE(0x0800, 6); // UTF-8 のファイル名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // 作成: UNIX, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 通常のファイル（rw-r--r--）
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
