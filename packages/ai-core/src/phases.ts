import type { RequirementType } from "./schema.js";

export interface Phase {
  key: string;
  name: string;
  /** このフェーズで主に作られる要件の区分 */
  type: RequirementType;
  /** 利用者への最初の質問 */
  question: string;
  /** 抜け漏れチェックの観点。AIへの指示と網羅率の計算に使う */
  checklist: string[];
}

export const PHASES: readonly Phase[] = [
  {
    key: "purpose",
    name: "目的整理",
    type: "BR",
    question: "このシステムで一番解決したい困りごとは何ですか？",
    checklist: ["解決したい課題", "達成したい状態", "効果の測り方", "対象範囲と対象外"],
  },
  {
    key: "actors",
    name: "利用者定義",
    type: "AC",
    question: "誰がこのシステムを使いますか？",
    checklist: ["主な利用者", "管理者", "外部の関係者・システム", "利用者ごとの権限"],
  },
  {
    key: "flow",
    name: "業務フロー",
    type: "FR",
    question: "仕事が始まってから終わるまでの流れを教えてください。",
    checklist: ["開始のきっかけ", "主な手順", "例外・取消", "通知", "記録・集計"],
  },
  {
    key: "functions",
    name: "機能要件",
    type: "FR",
    question: "画面でできてほしいことを教えてください。",
    checklist: ["入力", "検索・一覧", "更新・削除", "帳票・出力", "管理機能"],
  },
  {
    key: "quality",
    name: "非機能要件",
    type: "NFR",
    question: "速さ・止まらなさ・安全性で気になることはありますか？",
    checklist: ["性能", "可用性", "セキュリティ", "使いやすさ", "運用・保守"],
  },
  {
    key: "constraints",
    name: "制約条件",
    type: "CN",
    question: "予算・期限・既存の仕組みなどの制約を教えてください。",
    checklist: ["予算", "期限", "既存システム", "法令・規程", "体制"],
  },
];

export function getPhase(key: string): Phase {
  const p = PHASES.find((x) => x.key === key);
  if (!p) throw new Error(`不明なフェーズです: ${key}`);
  return p;
}
