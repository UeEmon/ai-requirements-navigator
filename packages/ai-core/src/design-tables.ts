/**
 * 設計モデルから、実装とテストで使う表を作る（機能 F9-2）。
 *   - データ項目定義（エンティティ・項目・コード上の名前・型・キー・必須・桁や形式・区分値）
 *   - 権限表（利用者の役割 × エンティティ の CRUD）
 *   - 外部とのやり取りの一覧
 * 古い設計モデル（キーや権限を持たない）でも壊れないように、無い値は空として扱う。
 */
import type { UmlModel } from "./uml.js";

export interface Table {
  caption?: string;
  head: string[];
  rows: string[][];
}

const KEY: Record<string, string> = { pk: "主キー", fk: "参照", unique: "重複不可" };
const DIRECTION: Record<string, string> = { in: "受け取る", out: "送る", both: "送受信" };
const isCode = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** データ項目定義 */
export function dataDictionary(m: UmlModel | null | undefined): Table {
  const rows: string[][] = [];
  for (const c of m?.classes ?? []) {
    for (const a of c.attributes ?? []) {
      // 古いモデルは name に業務の言葉が入っている
      const label = a.label ?? (isCode(a.name) ? "" : a.name);
      const code = isCode(a.name) ? a.name : "";
      rows.push([
        `${c.label ?? c.name}（${c.name}）`,
        label,
        code,
        a.type ?? "",
        KEY[a.key ?? ""] ?? "",
        a.required ? "必須" : "",
        a.rule ?? "",
        (a.values ?? []).join(" / "),
      ]);
    }
  }
  return { head: ["エンティティ", "項目", "コード上の名前", "型", "キー", "必須", "桁・形式・範囲", "区分値"], rows };
}

/** エンティティの一覧（業務の言葉とコード上の名前の対応、根拠の要件） */
export function entityTable(m: UmlModel | null | undefined): Table {
  return {
    head: ["業務の言葉", "コード上の名前", "項目数", "根拠の要件"],
    rows: (m?.classes ?? []).map((c) => [c.label ?? c.name, c.name, String(c.attributes?.length ?? 0), (c.requirementCodes ?? []).join(", ")]),
  };
}

/** 権限表（行: 役割、列: エンティティ） */
export function crudMatrix(m: UmlModel | null | undefined): Table {
  const perms = m?.permissions ?? [];
  const classes = (m?.classes ?? []).filter((c) => perms.some((p) => p.entity === c.name));
  const actors = [...new Set(perms.map((p) => p.actor))];
  return {
    caption: "C: 登録 / R: 参照 / U: 更新 / D: 削除 / －: 操作できない",
    head: ["役割", ...classes.map((c) => c.label ?? c.name)],
    rows: actors.map((a) => [
      a,
      ...classes.map((c) => {
        const ops = new Set(perms.filter((p) => p.actor === a && p.entity === c.name).flatMap((p) => [...p.ops]));
        return [..."CRUD"].filter((x) => ops.has(x)).join("") || "－";
      }),
    ]),
  };
}

/** 外部とのやり取り */
export function interfaceTable(m: UmlModel | null | undefined): Table {
  return {
    head: ["ID", "名前", "相手", "方向", "方式", "タイミング", "受け渡すデータ", "根拠の要件"],
    rows: (m?.interfaces ?? []).map((i, n) => [
      `IF-${String(n + 1).padStart(2, "0")}`,
      i.name,
      i.counterpart ?? "",
      DIRECTION[i.direction] ?? i.direction,
      i.method ?? "",
      i.timing ?? "",
      i.data ?? "",
      (i.requirementCodes ?? []).join(", "),
    ]),
  };
}

/** 設計モデルの詳しさ（着手前チェックで使う） */
export function designCompleteness(m: UmlModel | null | undefined) {
  const attrs = (m?.classes ?? []).flatMap((c) => c.attributes ?? []);
  return {
    classes: m?.classes.length ?? 0,
    attributes: attrs.length,
    /** 主キーを持つエンティティの数 */
    withPk: (m?.classes ?? []).filter((c) => (c.attributes ?? []).some((a) => a.key === "pk")).length,
    /** 古いモデル（業務の言葉しかない）の項目の数 */
    uncoded: attrs.filter((a) => !isCode(a.name)).length,
    enumWithoutValues: attrs.filter((a) => a.type === "enum" && !(a.values ?? []).length).length,
    permissions: m?.permissions?.length ?? 0,
    interfaces: m?.interfaces?.length ?? 0,
    classesWithoutReq: (m?.classes ?? []).filter((c) => !(c.requirementCodes ?? []).length).length,
  };
}
