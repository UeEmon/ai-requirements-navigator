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
  /** AIが使えないときに出す回答候補 */
  defaultOptions: string[];
  /** 質問の補足 */
  hint: string;
}

export const PHASES: readonly Phase[] = [
  {
    key: "purpose",
    name: "目的整理",
    type: "BR",
    question: "このシステムで一番解決したい困りごとは何ですか？",
    checklist: ["解決したい課題", "達成したい状態", "効果の測り方", "対象範囲と対象外"],
    defaultOptions: ["電話やメールの対応に時間を取られている", "紙やExcelの管理でミスが起きている", "情報が人によってばらばらで共有できない", "お客様の待ち時間を減らしたい"],
    hint: "具体的な場面や、困っている人を思い浮かべて書いてください。",
  },
  {
    key: "actors",
    name: "利用者定義",
    type: "AC",
    question: "誰がこのシステムを使いますか？",
    checklist: ["主な利用者", "管理者", "外部の関係者・システム", "利用者ごとの権限"],
    defaultOptions: ["お客様（社外）", "現場の担当者", "管理者・責任者", "経理など別部署"],
    hint: "使う人と、その人が何をするかを書いてください。",
  },
  {
    key: "flow",
    name: "業務フロー",
    type: "FR",
    question: "仕事が始まってから終わるまでの流れを教えてください。",
    checklist: ["開始のきっかけ", "主な手順", "例外・取消", "通知", "記録・集計"],
    defaultOptions: ["受付 → 確認 → 対応 → 完了報告", "申請 → 承認 → 実行", "取消や変更が多い", "月末に集計している"],
    hint: "いつもの流れを順番に書くだけで大丈夫です。困っている場面があれば一緒に書いてください。",
  },
  {
    key: "functions",
    name: "機能要件",
    type: "FR",
    question: "画面でできてほしいことを教えてください。",
    checklist: ["入力", "検索・一覧", "更新・削除", "帳票・出力", "管理機能"],
    defaultOptions: ["一覧で検索・絞り込みしたい", "入力ミスを防ぎたい", "帳票やCSVを出力したい", "担当者に通知したい"],
    hint: "「あったら便利」も歓迎です。優先度は後で決められます。",
  },
  {
    key: "rules",
    name: "業務ルール",
    type: "RL",
    question: "料金や期限の計算、受け付けてよいかの判断など、決まったルールはありますか？",
    checklist: ["計算のしかた", "判定・受付の条件", "上限・下限などの制約", "状態が変わる条件（取消できる期限など）"],
    defaultOptions: ["料金は人数と時間で決まる", "前日までなら無料で取り消せる", "1人が同時に持てる予約は3件まで", "承認されたら変更できない"],
    hint: "「〇〇のときは××になる」という具体例を一緒に書くと確実です。例が後でそのままテストになります。",
  },
  {
    key: "quality",
    name: "非機能要件",
    type: "NFR",
    question: "速さ・止まらなさ・安全性で気になることはありますか？",
    checklist: ["性能", "可用性", "セキュリティ", "使いやすさ", "運用・保守"],
    defaultOptions: ["スマホでも快適に使いたい", "24時間止まらないでほしい", "個人情報をしっかり守りたい", "操作が簡単であること"],
    hint: "「速い」ではなく「3秒以内」のように、数字で言えると確実です。",
  },
  {
    key: "constraints",
    name: "制約条件",
    type: "CN",
    question: "予算・期限・既存の仕組みなどの制約を教えてください。",
    checklist: ["予算", "期限", "既存システム", "法令・規程", "体制"],
    defaultOptions: ["予算はまだ決まっていない", "〇か月後までに使い始めたい", "今使っているシステムと連携したい", "社内規程で使えるサービスが限られる"],
    hint: "未定のものは「未定」で構いません。",
  },
];

export function getPhase(key: string): Phase {
  const p = PHASES.find((x) => x.key === key);
  if (!p) throw new Error(`不明なフェーズです: ${key}`);
  return p;
}
