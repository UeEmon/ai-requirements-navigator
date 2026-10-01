#!/usr/bin/env node
// 画面で使うライブラリ（mermaid、MIT）を node_modules から public/vendor にコピーする。
// CDNに依存せず、オフラインのローカルDockerでも図を描画できるようにするため。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(ROOT, "node_modules", "mermaid", "dist", "mermaid.min.js");
const dest = join(ROOT, "apps", "web", "public", "vendor", "mermaid.min.js");
if (!existsSync(src)) {
  console.error("mermaid が見つかりません。npm install を実行してください");
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("copied mermaid.min.js → apps/web/public/vendor/");
