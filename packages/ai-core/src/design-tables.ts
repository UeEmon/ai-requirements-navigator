/**
 * 設計モデルから、実装とテストで使う表を作る（機能 F9-2）。
 *   - データ項目定義（エンティティ・項目・コード上の名前・型・キー・必須・桁や形式・区分値）
 *   - 権限表（利用者の役割 × エンティティ の CRUD）
 *   - 外部とのやり取りの一覧
 * 古い設計モデル（キーや権限を持たない）でも壊れないように、無い値は空として扱う。
 */
import { INPUT_KINDS, OUTPUT_KINDS, type ScreenModel } from "./screens.js";
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
    head: ["業務の言葉", "コード上の名前", "項目数", "保存期間・削除", "根拠の要件"],
    rows: (m?.classes ?? []).map((c) => [c.label ?? c.name, c.name, String(c.attributes?.length ?? 0), c.retention ?? "", (c.requirementCodes ?? []).join(", ")]),
  };
}

/** 状態が変わる条件（状態遷移とその条件） */
export function stateTable(m: UmlModel | null | undefined): Table {
  return {
    head: ["対象", "変わる前", "変わった後", "きっかけ", "条件"],
    rows: (m?.stateMachines ?? []).flatMap((sm) => sm.transitions.map((t) => [sm.entity, t.from, t.to, t.event ?? "", t.guard ?? ""])),
  };
}

const OUTPUT_KIND: Record<string, string> = { report: "帳票", file: "ファイル", notice: "通知" };

/** 帳票・出力の一覧 */
export function outputTable(m: UmlModel | null | undefined): Table {
  return {
    head: ["ID", "名前", "種類", "目的", "いつ", "受け取る人", "載せる項目", "根拠の要件"],
    rows: (m?.outputs ?? []).map((o, i) => [`OUT-${String(i + 1).padStart(2, "0")}`, o.name, OUTPUT_KIND[o.kind] ?? o.kind, o.purpose, o.timing, o.recipients, o.items.join("、"), o.requirementCodes.join(", ")]),
  };
}

/** まとめて行う処理（バッチ）の一覧 */
export function batchTable(m: UmlModel | null | undefined): Table {
  return {
    head: ["ID", "名前", "いつ", "入力", "出力", "失敗したときの扱い", "根拠の要件"],
    rows: (m?.batches ?? []).map((b, i) => [`BAT-${String(i + 1).padStart(2, "0")}`, b.name, b.timing, b.input, b.output, b.failure, b.requirementCodes.join(", ")]),
  };
}

/** 項目を「エンティティ.項目」で探す（エンティティ・項目とも、コード上の名前か業務の言葉で書いてよい） */
export function resolveField(m: UmlModel | null | undefined, ref: string | undefined) {
  if (!ref || !m) return null;
  const [cn, an] = ref.split(".");
  const c = m.classes.find((x) => x.name === cn || x.label === cn);
  const a = c?.attributes.find((x) => x.name === an || x.label === an);
  return c && a ? { entity: c, attribute: a } : null;
}

/** 画面の入出力項目（画面の要素と、データ項目定義のひも付け） */
export function screenItemTable(screens: ScreenModel | null | undefined, m: UmlModel | null | undefined): Table & { unbound: string[]; unknown: string[] } {
  const rows: string[][] = [];
  const unbound: string[] = [];
  const unknown: string[] = [];
  for (const s of screens?.screens ?? []) {
    for (const e of s.elements) {
      const io = INPUT_KINDS.includes(e.kind) ? "入力" : OUTPUT_KINDS.includes(e.kind) ? "表示" : "";
      if (!io) continue;
      const r = resolveField(m, e.field);
      if (!e.field && io === "入力") unbound.push(`${s.key} ${s.name}「${e.label}」`);
      if (e.field && !r) unknown.push(`${s.key} ${s.name}「${e.label}」→ ${e.field}`);
      rows.push([
        `${s.key} ${s.name}`,
        e.label,
        io,
        r ? `${r.entity.label ?? r.entity.name}.${r.attribute.label ?? r.attribute.name}` : e.field ? `（設計にない：${e.field}）` : "",
        r ? `${r.entity.name}.${r.attribute.name}` : "",
        r?.attribute.required ? "必須" : "",
        r?.attribute.rule ?? "",
        (r?.attribute.values ?? []).join(" / "),
      ]);
    }
  }
  return { head: ["画面", "項目", "入出力", "データ項目", "コード上の名前", "必須", "業務上の制約", "区分値"], rows, unbound, unknown };
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
    head: ["ID", "名前", "相手", "方向", "方式", "タイミング", "受け渡すデータ", "つながらないときの扱い", "根拠の要件"],
    rows: (m?.interfaces ?? []).map((i, n) => [
      `IF-${String(n + 1).padStart(2, "0")}`,
      i.name,
      i.counterpart ?? "",
      DIRECTION[i.direction] ?? i.direction,
      i.method ?? "",
      i.timing ?? "",
      i.data ?? "",
      i.failure ?? "",
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
    withRetention: (m?.classes ?? []).filter((c) => (c.retention ?? "").trim()).length,
    interfacesWithoutFailure: (m?.interfaces ?? []).filter((i) => !(i.failure ?? "").trim()).map((i) => i.name),
    batchesWithoutFailure: (m?.batches ?? []).filter((b) => !(b.failure ?? "").trim()).map((b) => b.name),
    outputs: m?.outputs?.length ?? 0,
    batches: m?.batches?.length ?? 0,
  };
}
