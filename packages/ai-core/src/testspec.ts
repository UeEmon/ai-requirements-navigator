/**
 * テスト仕様の導出（機能 F9-1）。
 *
 * 要件定義で決めたことから、テスト工程の出発点になるテストケースを規則的に作る。
 * AIは使わない（同じ要件からは同じテストケースが出る。要件を直せばテストも追従する）。
 *
 * - 機能要件: EARS の型ごとに、正常系・異常系・状態の内外・機能の有無を確かめるケースを作る
 *   （普遍 → 正常 / イベント → 起きたとき・起きないとき / 状態 → 状態の内・外 /
 *    望ましくない振る舞い → 異常の再現 / オプション → 機能あり・なし / 複合 → 状態の内外 × 起きたとき）
 *   数値と単位（3秒・100件 など）を含む要件には境界値のケースを足す
 * - 非機能要件: シートの項目ごとに確認方法（負荷試験・復旧訓練・脆弱性診断など）を決めておく
 * - ストーリーの受け入れ条件: 受け入れテストのケースにする
 */
import type { Ears, EarsPattern } from "./ears.js";
import { RULE_KINDS, type BusinessRule } from "./rules.js";

export type TestKind = "normal" | "negative" | "abnormal" | "state-in" | "state-out" | "option-on" | "option-off" | "boundary" | "example" | "nfr" | "acceptance";
export const TEST_KINDS: Record<TestKind, string> = {
  normal: "正常系",
  negative: "条件を満たさない",
  abnormal: "異常系",
  "state-in": "状態の内",
  "state-out": "状態の外",
  "option-on": "機能あり",
  "option-off": "機能なし",
  boundary: "境界値",
  example: "業務ルールの具体例",
  nfr: "目標の確認",
  acceptance: "受け入れ",
};

export type TestLevel = "system" | "acceptance" | "nfr";
export const TEST_LEVELS: Record<TestLevel, string> = { system: "システムテスト", acceptance: "受け入れテスト", nfr: "非機能テスト" };

export interface TestCase {
  /** TC-FR-01-1 のように要件IDから作る（要件が同じなら同じID） */
  id: string;
  requirementCode: string;
  kind: TestKind;
  level: TestLevel;
  title: string;
  /** 前提 */
  given: string;
  /** 操作・出来事 */
  when: string;
  /** 期待する結果 */
  then: string;
  /** 非機能: 確かめ方（負荷試験・復旧訓練 など） */
  method?: string;
  /** ストーリーの受け入れ条件から作ったときのストーリーのキー */
  storyKey?: string;
  /** rule: EARS から規則的に作成 / story: 受け入れ条件 / nfr: 非機能要件シート */
  source: "rule" | "story" | "nfr";
}

export interface TestRequirement {
  code: string;
  type: string;
  title: string;
  ears?: Ears | null;
  /** 業務ルール（RL）の具体例 */
  rule?: BusinessRule | null;
  priority?: string;
  /** 非機能要件シートの項目（av.rto など）。シートから作った要件だけ */
  nfrKey?: string;
}

export interface TestStory {
  key: string;
  title: string;
  acceptanceCriteria: string[];
  requirementCodes: string[];
}

/* ------------------------------------------------------------------ */
/* 非機能要件の確認方法                                                 */
/* ------------------------------------------------------------------ */

export interface NfrVerification {
  method: string;
  how: string;
  /** 本番前に実施できず、運用の記録で確かめるもの */
  operational?: boolean;
  /** 試験ではなく書類・設定の確認で確かめるもの */
  review?: boolean;
}

export const NFR_VERIFY: Record<string, NfrVerification> = {
  "av.hours": { method: "運用試験", how: "運用時間帯の始まりと終わりに利用できることを確かめ、試行運用中は監視の記録で確認する" },
  "av.rate": { method: "稼働実績の計測", how: "監視ツールで稼働率を計測し、試行運用期間の実績が目標を満たすことを確認する", operational: true },
  "av.rto": { method: "復旧訓練", how: "サーバーの停止などの障害を模擬し、手順書どおりに目標時間内に利用を再開できるかを計測する" },
  "av.rpo": { method: "リストア試験", how: "バックアップと変更の記録からデータを復元し、失われるデータが目標の範囲内であることを確認する" },
  "av.disaster": { method: "災害復旧訓練", how: "設置場所が使えない想定で、別の場所のバックアップや設備から復旧・継続できるかを確認する" },
  "pf.users": { method: "負荷試験", how: "想定する同時利用者数の負荷をかけ、応答時間の目標を満たすことを確認する" },
  "pf.response": { method: "性能試験", how: "主要な画面の操作を繰り返し計測し、95%の操作が目標時間内であることを確認する" },
  "pf.peak": { method: "ピーク負荷試験", how: "集中する時期の倍率で負荷をかけ、応答時間の目標を満たし、止まらないことを確認する" },
  "pf.growth": { method: "大量データ試験", how: "将来の想定量のテストデータを入れた状態で、主要な画面と処理の応答時間を計測する" },
  "pf.batch": { method: "処理時間の計測", how: "本番と同じ量のデータで一括処理を実行し、完了までの時間を計測する" },
  "op.backup": { method: "バックアップ運用の確認", how: "取得の予定と保管期間の設定を確認し、試行運用中に取得されていることを記録で確認する" },
  "op.monitoring": { method: "監視・通知の試験", how: "停止や応答の悪化を模擬し、決めた時間内に担当者へ通知が届くことを確認する" },
  "op.maintenance": { method: "計画停止・更新の試験", how: "更新の手順を本番と同じ環境で実施し、事前の告知または無停止での適用ができることを確認する" },
  "op.support": { method: "体制の確認", how: "問い合わせ窓口の体制と対応時間が運用の取り決めに書かれていることを確認する", review: true },
  "mg.data": { method: "移行リハーサル", how: "本番相当のデータで移行を実施し、件数と合計値を移行元と突き合わせる" },
  "mg.cutover": { method: "切り替え計画の確認", how: "切り替えの手順と戻し方を計画書で確認し、リハーサルを実施する", review: true },
  "sc.auth": { method: "認証の試験", how: "正しい・誤った認証情報、多要素認証が求められる条件でログインし、結果を確認する" },
  "sc.access": { method: "権限の試験", how: "役割ごとに、許された操作ができ、許されていない操作と情報の参照が拒否されることを権限表に沿って確認する" },
  "sc.data": { method: "暗号化の確認", how: "通信が暗号化されていること（平文の接続が拒否されること）と、保存データの暗号化の設定を確認する" },
  "sc.audit": { method: "操作記録の確認", how: "対象の操作を行い、誰が・いつ・何をしたかが記録され、保存期間と改ざん防止の設定があることを確認する" },
  "sc.vuln": { method: "脆弱性診断", how: "公開前に脆弱性診断を実施し、更新の運用手順が決まっていることを確認する" },
  "ev.devices": { method: "互換性の試験", how: "対象とする端末とブラウザの組み合わせごとに、主要な操作を確認する" },
  "ev.law": { method: "法令適合の確認", how: "対象の法令・ガイドラインの確認項目に沿って、取り扱いの手順と設定を確認する", review: true },
  "ev.location": { method: "構成の確認", how: "データの保管場所（リージョン・設備）が決まりに合っていることを構成と契約で確認する", review: true },
  "us.access": { method: "アクセシビリティ試験", how: "検査ツールと目視で、文字の拡大・色に頼らない表示・キーボード操作などの基準を確認する" },
  "us.learn": { method: "利用者による試験", how: "初めての利用者に主要な操作を依頼し、決めた条件で完了できた割合を計測する" },
};

/** シートから作っていない非機能要件は、文の言葉から確認方法を推定する */
const NFR_KEYWORDS: Array<[RegExp, string]> = [
  [/応答|秒以内|表示まで/, "pf.response"],
  [/同時|利用者数/, "pf.users"],
  [/稼働率/, "av.rate"],
  [/復旧|再開/, "av.rto"],
  [/復元|バックアップ/, "av.rpo"],
  [/暗号/, "sc.data"],
  [/認証|ログイン/, "sc.auth"],
  [/権限|役割/, "sc.access"],
  [/記録|ログ/, "sc.audit"],
  [/脆弱/, "sc.vuln"],
  [/ブラウザ|端末|スマートフォン/, "ev.devices"],
  [/アクセシビリティ|JIS X 8341|拡大/, "us.access"],
  [/移行/, "mg.data"],
  [/監視|通知/, "op.monitoring"],
];

export function verificationOf(r: Pick<TestRequirement, "title" | "nfrKey">): (NfrVerification & { key: string | null; guessed: boolean }) | null {
  if (r.nfrKey && NFR_VERIFY[r.nfrKey]) return { ...NFR_VERIFY[r.nfrKey]!, key: r.nfrKey, guessed: false };
  for (const [re, key] of NFR_KEYWORDS) if (re.test(r.title)) return { ...NFR_VERIFY[key]!, key, guessed: true };
  return null;
}

/* ------------------------------------------------------------------ */
/* 文の加工                                                             */
/* ------------------------------------------------------------------ */

const A_TO_U: Record<string, string> = { わ: "う", か: "く", が: "ぐ", さ: "す", た: "つ", な: "ぬ", ば: "ぶ", ま: "む", ら: "る" };

/** 「〜しなければならない」を「〜する」（期待する結果の言い方）に直す */
export function expectationOf(response: string): string {
  let t = response.trim().replace(/[。\s]+$/u, "");
  const m = /^(.*?)なければならない$/u.exec(t);
  if (!m) return t;
  const stem = m[1]!;
  if (stem.endsWith("し")) return `${stem.slice(0, -1)}する`;
  if (stem.endsWith("こ")) return `${stem.slice(0, -1)}くる`;
  const last = stem.slice(-1);
  if (A_TO_U[last]) return stem.slice(0, -1) + A_TO_U[last];
  t = `${stem}る`; // 一段動詞（できる・伝える・受ける など）
  return t;
}

const clean = (s: string) => s.trim().replace(/[。、\s]+$/u, "");

/** 数値と単位（境界値を確かめる対象） */
const NUMBER_UNIT = /(\d+(?:[.,]\d+)?)\s*(ミリ秒|秒|分|時間|日|週|か月|ヶ月|年|件|人|文字|桁|回|円|%|％|MB|GB|KB)/gu;

export function boundariesOf(text: string): Array<{ value: string; unit: string }> {
  const out: Array<{ value: string; unit: string }> = [];
  for (const m of text.matchAll(NUMBER_UNIT)) {
    if (!out.some((x) => x.value === m[1] && x.unit === m[2])) out.push({ value: m[1]!, unit: m[2]! });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* テストケースの導出                                                   */
/* ------------------------------------------------------------------ */

type Draft = Omit<TestCase, "id" | "requirementCode" | "level" | "source">;

function fromEars(e: Ears): Draft[] {
  const sys = clean(e.system || "システム").replace(/は$/u, "") || "システム";
  const expect = `${sys}が${expectationOf(e.response)}`;
  const trigger = clean(e.trigger);
  const state = clean(e.state);
  const feature = clean(e.feature);
  const p: EarsPattern = e.pattern;
  switch (p) {
    case "event":
      return [
        { kind: "normal", title: `${trigger || "きっかけの出来事"}とき`, given: "通常の利用状態", when: trigger || "きっかけとなる出来事が起きる", then: expect },
        { kind: "negative", title: `${trigger || "きっかけの出来事"}が起きないとき`, given: "通常の利用状態", when: `「${trigger || "きっかけ"}」の条件を満たさない操作・出来事が起きる`, then: "この応答は行われない（誤って実行されない）" },
      ];
    case "state":
      return [
        { kind: "state-in", title: `${state || "対象の状態"}の間`, given: state || "対象の状態にある", when: "対象の操作・処理を行う", then: expect },
        { kind: "state-out", title: `${state || "対象の状態"}ではないとき`, given: `「${state || "対象の状態"}」ではない`, when: "同じ操作・処理を行う", then: "この応答は求められない（状態の外の振る舞いが他の要件どおりである）" },
      ];
    case "unwanted":
      return [
        {
          kind: "abnormal",
          title: `${trigger || "望ましくない出来事"}場合`,
          given: "通常の利用状態（異常を再現する手段：不正な入力・障害の模擬などを用意する）",
          when: trigger || "望ましくない出来事が起きる",
          then: expect,
        },
      ];
    case "optional":
      return [
        { kind: "option-on", title: `${feature || "対象の機能"}がある場合`, given: `${feature || "対象の機能"}が有効`, when: "対象の操作を行う", then: expect },
        { kind: "option-off", title: `${feature || "対象の機能"}がない場合`, given: `${feature || "対象の機能"}が無効`, when: "同じ操作を行う", then: "この応答は行われず、他の機能に影響しない" },
      ];
    case "complex":
      return [
        { kind: "state-in", title: `${state || "対象の状態"}の間に${trigger || "出来事"}とき`, given: state || "対象の状態にある", when: trigger || "きっかけとなる出来事が起きる", then: expect },
        { kind: "state-out", title: `${state || "対象の状態"}ではないときに${trigger || "出来事"}とき`, given: `「${state || "対象の状態"}」ではない`, when: trigger || "きっかけとなる出来事が起きる", then: "この応答は行われない" },
      ];
    default:
      return [{ kind: "normal", title: "基本の動作", given: "通常の利用状態", when: "対象の操作・処理を行う", then: expect }];
  }
}

/** EARS の構造がない要件（人が書いた文）は、文そのものを期待する結果にする */
function fromText(title: string): Draft[] {
  return [{ kind: "normal", title: "基本の動作", given: "通常の利用状態", when: "対象の操作・処理を行う", then: `「${clean(title)}」のとおりに動作する` }];
}

export const TEST_TARGET_TYPES = ["FR", "RL", "NFR"];

export function deriveTestCases(reqs: TestRequirement[], stories: TestStory[] = []): TestCase[] {
  const out: TestCase[] = [];
  for (const r of reqs) {
    if (!TEST_TARGET_TYPES.includes(r.type)) continue;
    const drafts: Array<Draft & { level: TestLevel; source: TestCase["source"] }> = [];
    if (r.type === "NFR") {
      const v = verificationOf(r);
      const e = r.ears;
      drafts.push({
        kind: "nfr",
        level: "nfr",
        source: "nfr",
        title: v ? v.method : "確認方法を決める",
        given: e?.state ? clean(e.state) : v?.operational ? "試行運用の期間" : "本番と同じ構成の環境",
        when: e?.trigger ? clean(e.trigger) : v ? `${v.method}を行う` : "（確認方法が決まっていません。試験・計測・書類の確認のどれで確かめるかを決めてください）",
        then: e ? `${clean(e.system || "システム").replace(/は$/u, "")}が${expectationOf(e.response)}` : `「${clean(r.title)}」を満たす`,
        method: v ? `${v.method}：${v.how}${v.guessed ? "（文の言葉から推定）" : ""}` : undefined,
      });
    } else if (r.type === "RL") {
      const ex = r.rule?.examples ?? [];
      const kind = r.rule ? RULE_KINDS[r.rule.kind] : "業務ルール";
      if (!ex.length) drafts.push({ ...fromText(r.title)[0]!, title: `${kind}（具体例なし）`, level: "system", source: "rule" });
      ex.forEach((e, i) => drafts.push({ kind: "example", level: "system", source: "rule", title: `${kind}の具体例${i + 1}`, given: clean(e.given), when: "このルールを使う処理を行う", then: clean(e.expected) }));
    } else {
      for (const d of r.ears ? fromEars(r.ears) : fromText(r.title)) drafts.push({ ...d, level: "system", source: "rule" });
    }
    // 業務ルールは具体例に境界の値を含めてもらうため、文からは境界値のケースを作らない
    for (const b of r.type === "RL" ? [] : boundariesOf(r.title)) {
      drafts.push({
        kind: "boundary",
        level: r.type === "NFR" ? "nfr" : "system",
        source: "rule",
        title: `境界値 ${b.value}${b.unit}`,
        given: "通常の利用状態",
        when: `${b.value}${b.unit}ちょうど、およびそれを少し超える・下回る条件にする`,
        then: `${b.value}${b.unit}ちょうどでは要件を満たし、超える側の扱いが要件どおりである`,
      });
    }
    drafts.forEach((d, i) => out.push({ ...d, id: `TC-${r.code}-${i + 1}`, requirementCode: r.code }));
  }
  // ストーリーの受け入れ条件 → 受け入れテスト（最初の対象要件に結びつけ、他の要件は stories の対応で辿る）
  for (const s of stories) {
    s.acceptanceCriteria.forEach((ac, i) => {
      out.push({
        id: `AT-${s.key}-${i + 1}`,
        requirementCode: s.requirementCodes[0] ?? "",
        kind: "acceptance",
        level: "acceptance",
        source: "story",
        storyKey: s.key,
        title: s.title,
        given: "ストーリーの前提を満たす",
        when: "ストーリーの操作を行う",
        then: clean(ac),
      });
    });
  }
  return out;
}

export interface TestTraceRow {
  code: string;
  type: string;
  title: string;
  tests: string[];
  acceptance: string[];
  /** 非機能: 確認方法（推定・未定を含む） */
  method: string | null;
  methodGuessed: boolean;
}

/** 要件 → テストケースの対応。ストーリーの受け入れテストは、ストーリーが結びつくすべての要件に載せる */
export function traceTests(reqs: TestRequirement[], cases: TestCase[], stories: TestStory[] = []): { rows: TestTraceRow[]; coverage: number; untested: string[]; methodUndecided: string[] } {
  const rows = reqs
    .filter((r) => TEST_TARGET_TYPES.includes(r.type))
    .map((r) => {
      const v = r.type === "NFR" ? verificationOf(r) : null;
      const storyKeys = new Set(stories.filter((s) => s.requirementCodes.includes(r.code)).map((s) => s.key));
      return {
        code: r.code,
        type: r.type,
        title: r.title,
        tests: cases.filter((c) => c.requirementCode === r.code && c.level !== "acceptance").map((c) => c.id),
        acceptance: cases.filter((c) => c.storyKey && storyKeys.has(c.storyKey)).map((c) => c.id),
        method: v ? v.method : null,
        methodGuessed: v?.guessed ?? false,
      };
    });
  const untested = rows.filter((r) => !r.tests.length && !r.acceptance.length).map((r) => r.code);
  return {
    rows,
    coverage: rows.length ? (rows.length - untested.length) / rows.length : 1,
    untested,
    methodUndecided: rows.filter((r) => r.type === "NFR" && !r.method).map((r) => r.code),
  };
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** テスト管理ツールや表計算で開けるCSV（BOM付きUTF-8） */
export function testCasesCsv(cases: TestCase[]): string {
  const head = ["テストID", "要件ID", "種別", "工程", "観点", "前提", "操作・出来事", "期待する結果", "確認方法", "ストーリー"];
  const rows = cases.map((c) => [c.id, c.requirementCode, TEST_KINDS[c.kind], TEST_LEVELS[c.level], c.title, c.given, c.when, c.then, c.method ?? "", c.storyKey ?? ""]);
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
