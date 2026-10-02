#!/usr/bin/env node
/**
 * 依存OSSのライセンス検査と THIRD_PARTY_NOTICES の生成（外部パッケージ不要）。
 *
 *   node scripts/check-licenses.mjs                 … 本番依存（配布物に入るもの）を検査
 *   node scripts/check-licenses.mjs --all           … 開発用ツールも含めて検査
 *   node scripts/check-licenses.mjs --production --notices <file>
 *                                                   … 検査に加えて著作権表示ファイルを生成
 *
 * 許可リスト外のライセンスが見つかると終了コード1で失敗する（CIで使用）。
 * 方針は docs/oss-policy.md を参照。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 再配布可能、または著作権表示で利用できるライセンス */
export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "PostgreSQL",
  "Python-2.0",
  "Zlib",
  "MPL-2.0",
  "OFL-1.1",
]);
/** 開発時のみ使うツールで追加で許可するもの（配布物には入らない） */
const ALLOWED_DEV_ONLY = new Set(["CC-BY-4.0", "CC-BY-3.0"]);

const args = process.argv.slice(2);
const all = args.includes("--all");
const noticesIdx = args.indexOf("--notices");
const noticesFile = noticesIdx >= 0 ? args[noticesIdx + 1] : null;

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function licenseOf(pkg, dir) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return licenseFromFile(dir);
}

/** package.json に記載がない場合、LICENSE ファイルの本文から判定する */
function licenseFromFile(dir) {
  const f = readdirSync(dir).find((x) => /^licen[cs]e(\.|$)/i.test(x));
  if (!f) return "UNKNOWN";
  const t = readFileSync(join(dir, f), "utf8").replace(/\s+/g, " ");
  if (/Permission is hereby granted, free of charge/i.test(t) && /WITHOUT WARRANTY OF ANY KIND/i.test(t)) return "MIT";
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return "ISC";
  if (/Redistribution and use in source and binary forms/i.test(t))
    return /Neither the name/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  return "UNKNOWN";
}

/** SPDX式（OR / AND / 括弧）を評価する */
export function isAllowed(expr, allowed) {
  const s = expr.replace(/[()]/g, " ").trim();
  if (/ OR /i.test(s)) return s.split(/ OR /i).some((x) => isAllowed(x, allowed));
  if (/ AND /i.test(s)) return s.split(/ AND /i).every((x) => isAllowed(x, allowed));
  return allowed.has(s.replace(/\+$/, ""));
}

/** node_modules の中で、ある場所から依存名を解決する（Nodeの解決規則と同じ順） */
function resolveDep(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const p = join(dir, "node_modules", name, "package.json");
    if (existsSync(p)) return dirname(p);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function workspaceDirs() {
  const root = readJson(join(ROOT, "package.json"));
  const dirs = [ROOT];
  for (const pattern of root.workspaces ?? []) {
    const base = join(ROOT, pattern.replace(/\/\*$/, ""));
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) if (existsSync(join(base, d, "package.json"))) dirs.push(join(base, d));
  }
  return dirs;
}

const found = new Map(); // dir -> {name, version, license, dir}
function walk(dir, includeDev, isWorkspace) {
  const pkg = readJson(join(dir, "package.json"));
  const deps = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...(includeDev && isWorkspace ? pkg.devDependencies : {}),
  };
  for (const name of Object.keys(deps)) {
    const d = resolveDep(dir, name);
    if (!d) continue; // optional で未インストール
    const real = d;
    if (found.has(real)) continue;
    const p = readJson(join(real, "package.json"));
    if (name.startsWith("@arn/")) {
      found.set(real, null);
      walk(real, includeDev, true);
      continue;
    }
    found.set(real, { name: p.name, version: p.version, license: licenseOf(p, real), dir: real });
    walk(real, false, false);
  }
}

for (const w of workspaceDirs()) walk(w, all, true);

const entries = [...found.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
const allowed = all ? new Set([...ALLOWED, ...ALLOWED_DEV_ONLY]) : ALLOWED;
const bad = entries.filter((e) => !isAllowed(e.license, allowed));

const counts = {};
for (const e of entries) counts[e.license] = (counts[e.license] ?? 0) + 1;
console.log(`検査対象: ${entries.length} パッケージ（${all ? "開発用を含む" : "本番依存のみ"}）`);
for (const [l, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${l}: ${n}`);

if (noticesFile) {
  const parts = [
    "THIRD-PARTY SOFTWARE NOTICES",
    "本ソフトウェアは以下のオープンソースソフトウェアを利用しています。",
    "",
  ];
  for (const e of entries) {
    parts.push("=".repeat(72), `${e.name}@${e.version}  (${e.license})`, "");
    const lic = readdirSync(e.dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
    if (lic) parts.push(readFileSync(join(e.dir, lic), "utf8").trim(), "");
  }
  writeFileSync(join(process.cwd(), noticesFile), parts.join("\n"));
  console.log(`著作権表示を書き出しました: ${noticesFile}`);
}

if (bad.length) {
  console.error("\n許可されていないライセンスのパッケージがあります:");
  for (const e of bad) {
    console.error(`  ${e.name}@${e.version}: ${e.license}`);
    // GitHub Actions では注釈として表示する
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=License::${e.name}@${e.version} (${e.license}) at ${e.dir.replace(ROOT + "/", "")}`);
  }
  console.error("docs/oss-policy.md の方針に従い、代替パッケージを検討してください。");
  process.exit(1);
}
console.log("OK: すべて許可リスト内のライセンスです");
