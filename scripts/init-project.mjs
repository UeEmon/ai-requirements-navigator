#!/usr/bin/env node
/**
 * テンプレートから作った新しいリポジトリを初期化する。
 *
 *   npm run init:project -- --name "顧客管理システム" --slug crm-system
 *
 * - package.json の name / description を書き換える
 * - docs/project/requirements.md に新しいシステム用の要件定義書の雛形を作る
 * - README の先頭にプロジェクト名を入れる
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const name = args.name;
const slug = args.slug ?? (name ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "");
if (!name || !slug) {
  console.error('使い方: npm run init:project -- --name "システム名" --slug system-slug');
  process.exit(1);
}

const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = slug;
pkg.description = `${name}（AI要件定義支援テンプレートから作成）`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const PHASES = [
  ["1. 目的", "解決したい課題 / 達成したい状態 / 効果の測り方 / 対象範囲と対象外"],
  ["2. 利用者", "主な利用者 / 管理者 / 外部の関係者・システム / 権限"],
  ["3. 業務フロー", "開始のきっかけ / 主な手順 / 例外・取消 / 通知 / 記録・集計"],
  ["4. 機能要件", "入力 / 検索・一覧 / 更新・削除 / 帳票・出力 / 管理機能"],
  ["5. 非機能要件", "性能 / 可用性 / セキュリティ / 使いやすさ / 運用・保守"],
  ["6. 制約条件", "予算 / 期限 / 既存システム / 法令・規程 / 体制"],
];
const doc = [
  `# ${name} 要件定義書`,
  "",
  `作成日: ${new Date().toISOString().slice(0, 10)}`,
  "",
  "要件定義支援システム（このリポジトリのアプリ）で作成した仕様書の Markdown を、ここに貼り付けて管理してください。",
  "",
  ...PHASES.flatMap(([h, points]) => [`## ${h}`, "", `観点: ${points}`, "", "| ID | 内容 | 優先度 | 根拠 |", "| --- | --- | --- | --- |", ""]),
  "## 7. UML", "", "`docs/project/uml/` に Mermaid 形式で置く。", "",
  "## 8. 未決事項", "", "- [ ] ", "",
].join("\n");
const dir = join(ROOT, "docs", "project");
mkdirSync(join(dir, "uml"), { recursive: true });
const reqPath = join(dir, "requirements.md");
if (existsSync(reqPath)) console.log(`既にあるため上書きしません: ${reqPath}`);
else writeFileSync(reqPath, doc);

const readmePath = join(ROOT, "README.md");
const readme = readFileSync(readmePath, "utf8");
if (!readme.startsWith(`# ${name}`)) writeFileSync(readmePath, `# ${name}\n\n> AI要件定義支援テンプレートから作成\n\n${readme.replace(/^# .*\n/, "")}`);

console.log(`初期化しました: ${name} (${slug})`);
console.log("次の手順: cp .env.example .env → MASTER_KEY を設定 → docker compose up --build");
