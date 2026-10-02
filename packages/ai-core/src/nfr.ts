/**
 * 非機能要件の網羅的な検討（機能 F5-8）。
 *
 * 非機能要件は利用者から自然には出てこず、後から「止まっては困る」「遅い」「個人情報が…」と問題になりやすい。
 * そこで IPA「非機能要求グレード」の考え方（大項目ごとに段階的な水準を選ぶ、システムの重要度に応じた推奨水準を示す）を参考に、
 * 次の仕組みで、すべての項目を「決めた／対象外／保留」のどれかにするまで検討を促す。
 *   - 26項目の非機能要件シート（専門用語を避けた質問・なぜ大事か・段階的な水準と費用への影響）
 *   - システムの性格（4つの質問）から、項目ごとの推奨水準を決める
 *   - 推奨より低い水準には理由を求める。項目どうしの矛盾（例: 稼働率は高いのに停止を検知しない）を検出する
 *   - 複数のAIに推奨水準を提案させ、意見が分かれた項目を示す
 *   - 決めた水準を EARS の非機能要件に変換する
 * 項目と水準の文言は本システムで独自に作成したもの（IPA の資料の転載ではない）。
 */
import { z } from "zod";
import { renderEars, type Ears } from "./ears.js";
import { extractJson } from "./json.js";
import type { AIProvider, Usage } from "./types.js";

/* ------------------------------------------------------------------ */
/* システムの性格                                                       */
/* ------------------------------------------------------------------ */

export const PROFILE_QUESTIONS = {
  users: {
    question: "主に誰が使いますか？",
    options: ["社内の一部の人（数十人まで）", "社内の多くの人・取引先", "社外の顧客・一般の人"],
  },
  impact: {
    question: "システムが止まると、どうなりますか？",
    options: ["少し不便になるが、手作業で代わりができる", "業務が止まり、社内に大きな影響が出る", "顧客や取引先に損害が出る・社会的な影響がある"],
  },
  data: {
    question: "どんな情報を扱いますか？",
    options: ["公開してよい情報だけ", "社内の情報（売上・在庫など）", "個人情報・機密情報"],
  },
  hours: {
    question: "いつ使いますか？",
    options: ["平日の業務時間", "毎日、朝から夜まで", "24時間365日"],
  },
} as const;
export type ProfileKey = keyof typeof PROFILE_QUESTIONS;
export type NfrProfile = Partial<Record<ProfileKey, 0 | 1 | 2>>;

export const NFR_CATEGORIES = {
  availability: "可用性（止まらないこと）",
  performance: "性能・拡張性（速さ・量）",
  operation: "運用・保守性（日々の運用）",
  migration: "移行性（今のシステムからの切り替え）",
  security: "セキュリティ（情報を守る）",
  environment: "システム環境（端末・法令・設置場所）",
  usability: "使いやすさ・アクセシビリティ",
} as const;
export type NfrCategory = keyof typeof NFR_CATEGORIES;

/** 重要度（0: 社会的影響がほとんどない / 1: 限定される / 2: 極めて大きい） */
export const GRADE_LABELS = ["社会的影響がほとんどないシステム", "社会的影響が限定されるシステム", "社会的影響が極めて大きいシステム"] as const;

/** 大項目ごとの重要度。答えていない質問は「中」とみなす */
export function gradesOf(p: NfrProfile): Record<NfrCategory, 0 | 1 | 2> & { overall: 0 | 1 | 2 } {
  const v = (k: ProfileKey) => p[k] ?? 1;
  const max = (...xs: number[]) => Math.max(...xs) as 0 | 1 | 2;
  return {
    overall: v("impact") as 0 | 1 | 2,
    availability: max(v("impact"), v("hours")),
    performance: v("users") as 0 | 1 | 2,
    operation: max(v("impact"), v("hours") === 2 ? 1 : 0),
    migration: 1,
    security: max(v("data"), v("users") === 2 ? 1 : 0),
    environment: max(v("users"), v("data") === 2 ? 1 : 0),
    usability: v("users") as 0 | 1 | 2,
  };
}

/* ------------------------------------------------------------------ */
/* 項目                                                                */
/* ------------------------------------------------------------------ */

type EarsPart = Partial<Omit<Ears, "system">> & { response: string };

export interface NfrLevel {
  id: string;
  /** 選択肢として表示する説明 */
  label: string;
  /** 要件文に入れる短い値 */
  value: string;
  /** 費用・手間への影響（1: 小 〜 4: 大） */
  cost: 1 | 2 | 3 | 4;
  /** この水準で作る要件。null なら要件にしない（例: 「対策しない」） */
  ears?: EarsPart | null;
}

export interface NfrItem {
  key: string;
  category: NfrCategory;
  name: string;
  /** 専門家でない利用者への質問 */
  question: string;
  /** なぜ決める必要があるか */
  why: string;
  levels: NfrLevel[];
  /** 重要度（0〜2）ごとの推奨水準の番号 */
  recommended: [number, number, number];
  /** 値を入れて要件文を作るひな形（水準ごとの ears がないとき・自由入力のとき） */
  template?: (v: string) => EarsPart;
  /** システムではなく体制・計画の要件（要件にはせず、シートと仕様書に残す） */
  organizational?: boolean;
}

const L = (id: string, label: string, value: string, cost: NfrLevel["cost"], ears?: EarsPart | null): NfrLevel => ({ id, label, value, cost, ...(ears !== undefined ? { ears } : {}) });

export const NFR_ITEMS: NfrItem[] = [
  /* 可用性 */
  {
    key: "av.hours",
    category: "availability",
    name: "運用時間",
    question: "システムを使える必要がある時間帯は？",
    why: "使う時間が長いほど、止めて作業できる時間が減り、運用の体制と費用が増えます。",
    levels: [L("L1", "平日の業務時間（9〜18時など）", "平日の業務時間", 1), L("L2", "毎日、朝から夜まで（7〜23時など）", "毎日7時から23時", 2), L("L3", "24時間365日", "24時間365日", 3)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "ubiquitous", response: `${v}の間、利用者が利用できる状態を保たなければならない` }),
  },
  {
    key: "av.rate",
    category: "availability",
    name: "稼働率（止まってよい時間）",
    question: "運用時間のうち、止まってもよい時間はどのくらい？",
    why: "「止まらない」ほど設備の二重化や監視が必要になり、費用が大きく増えます。業務に必要な水準を選びます。",
    levels: [
      L("L1", "95%（月に約36時間まで止まってよい）", "95%", 1),
      L("L2", "99%（月に約7時間まで）", "99%", 2),
      L("L3", "99.9%（月に約43分まで）", "99.9%", 3),
      L("L4", "99.99%（月に約4分まで）", "99.99%", 4),
    ],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "ubiquitous", response: `運用時間中の稼働率${v}以上を維持しなければならない` }),
  },
  {
    key: "av.rto",
    category: "availability",
    name: "復旧までの時間（RTO）",
    question: "止まってしまったとき、いつまでに使えるように戻したい？",
    why: "早く戻すほど、予備の設備や手順の準備が必要になります。業務を止めていられる時間から決めます。",
    levels: [L("L1", "翌営業日まで", "翌営業日中", 1), L("L2", "当日中（数時間以内）", "数時間以内", 2), L("L3", "1時間以内", "1時間以内", 3), L("L4", "数分以内（自動で切り替え）", "5分以内", 4)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "unwanted", trigger: "障害でシステムが停止した", response: `${v}に利用を再開できるようにしなければならない` }),
  },
  {
    key: "av.rpo",
    category: "availability",
    name: "データを戻せる時点（RPO）",
    question: "障害が起きたとき、どの時点までのデータを取り戻したい？",
    why: "直前まで戻すには、データを常に別の場所へ写しておく仕組みが必要です。再入力できる範囲なら費用を抑えられます。",
    levels: [L("L1", "前日の終業時点（当日分は再入力する）", "前日の終業時点", 1), L("L2", "数時間前の時点", "数時間前の時点", 2), L("L3", "障害の直前（データを失わない）", "障害の直前の時点", 3)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "unwanted", trigger: "障害が発生した", response: `${v}までのデータを復元できるようにしなければならない` }),
  },
  {
    key: "av.disaster",
    category: "availability",
    name: "大規模な災害への備え",
    question: "地震などで設置場所ごと使えなくなったらどうする？",
    why: "災害への備えは費用が大きく、何もしないと長期間止まります。事業を続ける必要性から決めます。",
    levels: [
      L("L1", "特に備えない（復旧はできる範囲で）", "", 1, null),
      L("L2", "別の場所にバックアップを保管し、そこから戻す", "別の場所に保管したバックアップから復旧", 2, {
        pattern: "unwanted",
        trigger: "大規模な災害で設置場所の設備が使えなくなった",
        response: "別の場所に保管したバックアップからデータを復旧できるようにしなければならない",
      }),
      L("L3", "別の地域の設備で業務を続ける", "別の地域の設備で業務を継続", 4, {
        pattern: "unwanted",
        trigger: "大規模な災害で設置場所の設備が使えなくなった",
        response: "別の地域の設備で業務を継続できるようにしなければならない",
      }),
    ],
    recommended: [0, 1, 2],
  },
  /* 性能・拡張性 */
  {
    key: "pf.users",
    category: "performance",
    name: "利用者数・同時に使う人数",
    question: "何人くらいが、同時に何人くらい使いそう？",
    why: "同時に使う人数で、必要な設備の大きさが決まります。少なく見積もると繁忙時に遅くなります。",
    levels: [L("L1", "50人まで（同時に10人程度）", "同時に10人", 1), L("L2", "500人まで（同時に100人程度）", "同時に100人", 2), L("L3", "5,000人以上（同時に1,000人程度）", "同時に1,000人", 3)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "ubiquitous", response: `${v}の利用者が使っても、応答時間の目標を満たさなければならない` }),
  },
  {
    key: "pf.response",
    category: "performance",
    name: "画面の応答時間",
    question: "画面の操作から結果が出るまで、どのくらいなら待てる？",
    why: "利用者の満足度と業務の効率に直結します。短くするほど設計と設備の手間が増えます。",
    levels: [L("L1", "5秒以内", "5秒以内", 1), L("L2", "3秒以内", "3秒以内", 2), L("L3", "1秒以内", "1秒以内", 3)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "event", trigger: "利用者が画面を操作した", response: `操作の95%について${v}に結果を表示しなければならない` }),
  },
  {
    key: "pf.peak",
    category: "performance",
    name: "利用が集中する時期",
    question: "月末やキャンペーンなど、利用が急に増える時期はある？",
    why: "普段に合わせて作ると、集中する時期に遅くなったり止まったりします。",
    levels: [L("L1", "特にない", "", 1, null), L("L2", "決まった時期に通常の2〜3倍", "通常の3倍", 2), L("L3", "キャンペーンなどで通常の10倍以上", "通常の10倍", 3)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "state", state: `利用が${v}に集中している`, response: "応答時間の目標を満たさなければならない" }),
  },
  {
    key: "pf.growth",
    category: "performance",
    name: "データ量の増え方",
    question: "5年後、データはどのくらい増えていそう？",
    why: "増え方を見込まないと、数年後に遅くなったり保存場所が足りなくなったりします。",
    levels: [L("L1", "ほとんど増えない", "", 1, null), L("L2", "数倍に増える", "現在の3倍", 2), L("L3", "10倍以上に増える", "現在の10倍", 3)],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "ubiquitous", response: `データ量が${v}になっても、応答時間の目標を満たさなければならない` }),
  },
  {
    key: "pf.batch",
    category: "performance",
    name: "締め処理・まとめて行う処理",
    question: "夜間の集計や月末の締めなど、まとめて行う処理はある？",
    why: "処理が終わる時間を決めておかないと、翌朝の業務に間に合わないことがあります。",
    levels: [
      L("L1", "特にない", "", 1, null),
      L("L2", "夜間に終わればよい", "翌朝の業務開始まで", 2, { pattern: "event", trigger: "夜間の一括処理を開始した", response: "翌朝の業務開始までに処理を完了しなければならない" }),
      L("L3", "業務時間中に数分で終わる必要がある", "10分以内", 3, { pattern: "event", trigger: "利用者が一括処理を開始した", response: "10分以内に処理を完了しなければならない" }),
    ],
    recommended: [0, 1, 1],
  },
  /* 運用・保守性 */
  {
    key: "op.backup",
    category: "operation",
    name: "バックアップ",
    question: "データの写しは、どのくらいの頻度で、どのくらいの期間残す？",
    why: "誤って消した・壊れたときに戻せる範囲が決まります。「データを戻せる時点」と合わせて決めます。",
    levels: [
      L("L1", "週1回取得し、4週間残す", "週1回取得し4週間保管", 1),
      L("L2", "毎日取得し、1か月残す", "毎日取得し1か月保管", 2),
      L("L3", "毎日取得し1年残す。変更の記録も常に保存する", "毎日取得し1年間保管（変更の記録は常時保存）", 3),
    ],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "ubiquitous", response: `データのバックアップを${v}しなければならない` }),
  },
  {
    key: "op.monitoring",
    category: "operation",
    name: "監視と障害の知らせ",
    question: "止まったことに、どうやって気づく？",
    why: "利用者からの連絡で初めて気づくと、復旧が遅れます。止まらないことを求めるほど自動の監視が必要です。",
    levels: [
      L("L1", "利用者からの連絡で気づく", "", 1, null),
      L("L2", "停止を自動で検知し、担当者に知らせる", "", 2, { pattern: "unwanted", trigger: "システムの停止を検知した", response: "5分以内に運用担当者に通知しなければならない" }),
      L("L3", "遅くなったことも検知し、24時間体制で対応する", "", 3, {
        pattern: "unwanted",
        trigger: "システムの停止または応答時間の悪化を検知した",
        response: "直ちに24時間体制の運用担当者に通知しなければならない",
      }),
    ],
    recommended: [0, 1, 2],
  },
  {
    key: "op.maintenance",
    category: "operation",
    name: "計画停止（メンテナンス）",
    question: "更新作業のために止めてよいのはいつ？",
    why: "止められないほど、更新の手順や設備が複雑になります。運用時間と合わせて決めます。",
    levels: [
      L("L1", "業務時間外ならいつ止めてもよい", "", 1, null),
      L("L2", "事前に知らせれば月1回程度止めてよい", "", 2, { pattern: "event", trigger: "計画停止を予定した", response: "7日前までに利用者に予定を知らせなければならない" }),
      L("L3", "止めずに更新する", "", 3, { pattern: "ubiquitous", response: "サービスを停止せずに更新を適用できなければならない" }),
    ],
    recommended: [0, 1, 2],
  },
  {
    key: "op.support",
    category: "operation",
    name: "問い合わせ対応の時間",
    question: "利用者からの問い合わせに、いつ対応する？",
    why: "システムではなく体制の取り決めですが、決めておかないと運用開始後に問題になります。",
    levels: [L("L1", "平日の業務時間", "平日の業務時間", 1), L("L2", "毎日（休日も）", "毎日", 2), L("L3", "24時間", "24時間", 3)],
    recommended: [0, 1, 2],
    organizational: true,
  },
  /* 移行性 */
  {
    key: "mg.data",
    category: "migration",
    name: "今のデータの引き継ぎ",
    question: "今のシステムやExcelのデータを、新しいシステムに移す？",
    why: "移すデータが多いほど、整理と確認に時間がかかります。古いデータは移さず参照だけにする方法もあります。",
    levels: [
      L("L1", "移さない（新しく始める）", "", 1, null),
      L("L2", "必要なもの（基本情報と直近1年分）を移す", "基本情報と直近1年分のデータ", 2),
      L("L3", "過去のデータをすべて移す", "過去のすべてのデータ", 3),
    ],
    recommended: [1, 1, 1],
    template: (v) => ({ pattern: "ubiquitous", response: `稼働開始までに、既存のシステムから${v}を移行しなければならない` }),
  },
  {
    key: "mg.cutover",
    category: "migration",
    name: "切り替えの進め方",
    question: "新しいシステムへは、どう切り替える？",
    why: "一斉に切り替えると早い反面、問題が起きたときの影響が大きくなります（計画の取り決め）。",
    levels: [L("L1", "ある日に一斉に切り替える", "一斉切り替え", 1), L("L2", "しばらく新旧を並行して使う", "並行稼働", 2), L("L3", "部署・拠点ごとに順番に切り替える", "段階的な切り替え", 2)],
    recommended: [0, 1, 1],
    organizational: true,
  },
  /* セキュリティ */
  {
    key: "sc.auth",
    category: "security",
    name: "本人確認（ログイン）",
    question: "ログインの確かめ方は？",
    why: "パスワードだけでは、漏れたときに他人に使われます。扱う情報と使う場所から決めます。",
    levels: [
      L("L1", "IDとパスワード", "", 1, { pattern: "ubiquitous", response: "利用者をIDとパスワードで認証しなければならない" }),
      L("L2", "社外から使うときは、追加の確認（多要素認証）も", "", 2, { pattern: "event", trigger: "利用者が社外のネットワークからログインした", response: "多要素認証で本人を確認しなければならない" }),
      L("L3", "全員に多要素認証（または会社の共通ログイン）", "", 3, { pattern: "ubiquitous", response: "すべての利用者を多要素認証で認証しなければならない" }),
    ],
    recommended: [0, 1, 2],
  },
  {
    key: "sc.access",
    category: "security",
    name: "権限（見られる情報・できる操作）",
    question: "人によって、見られる情報やできる操作を分ける？",
    why: "分けないと、必要のない人が情報を見たり変更したりできてしまいます。",
    levels: [
      L("L1", "全員が同じ", "", 1, null),
      L("L2", "役割（一般・管理者など）で分ける", "", 2, { pattern: "ubiquitous", response: "利用者の役割に応じて、見られる情報とできる操作を制限しなければならない" }),
      L("L3", "役割と担当範囲（部署・顧客など）で分ける", "", 3, { pattern: "ubiquitous", response: "利用者の役割と担当範囲に応じて、見られる情報とできる操作を制限しなければならない" }),
    ],
    recommended: [1, 1, 2],
  },
  {
    key: "sc.data",
    category: "security",
    name: "重要な情報の保護（暗号化）",
    question: "情報が盗み見られないよう、どこまで守る？",
    why: "個人情報などは、通信だけでなく保存しているデータも暗号化しないと、漏えい時の被害が大きくなります。",
    levels: [
      L("L1", "特別な対策はしない（公開情報だけ）", "", 1, null),
      L("L2", "通信を暗号化する", "", 1, { pattern: "ubiquitous", response: "利用者との通信をすべて暗号化しなければならない" }),
      L("L3", "通信と保存しているデータの両方を暗号化する", "", 2, { pattern: "ubiquitous", response: "利用者との通信と保存しているデータを暗号化しなければならない" }),
    ],
    recommended: [1, 1, 2],
  },
  {
    key: "sc.audit",
    category: "security",
    name: "操作の記録（ログ）",
    question: "誰が何をしたかの記録は残す？",
    why: "不正や誤操作があったときに調べられるようにします。個人情報を扱う場合はほぼ必須です。",
    levels: [
      L("L1", "残さない", "", 1, null),
      L("L2", "ログインと重要な操作を1年残す", "", 2, { pattern: "ubiquitous", response: "ログインと重要な操作の記録を1年間保存しなければならない" }),
      L("L3", "すべての操作を5年残し、改ざんできないようにする", "", 3, { pattern: "ubiquitous", response: "すべての操作の記録を改ざんできない形で5年間保存しなければならない" }),
    ],
    recommended: [1, 1, 2],
  },
  {
    key: "sc.vuln",
    category: "security",
    name: "弱点（脆弱性）への対応",
    question: "ソフトウェアの弱点が見つかったとき、どう直す？",
    why: "放置すると攻撃に使われます。社外に公開するシステムほど、早く・定期的に直す必要があります。",
    levels: [
      L("L1", "重大なものだけ、見つかったら直す", "", 1, { pattern: "event", trigger: "重大な脆弱性が公表された", response: "30日以内に修正を適用しなければならない" }),
      L("L2", "月1回、定期的に更新する", "", 2, { pattern: "ubiquitous", response: "公表された脆弱性の修正を月1回以上適用しなければならない" }),
      L("L3", "定期的な更新に加え、年1回は専門家の診断を受ける", "", 3, { pattern: "ubiquitous", response: "公表された脆弱性の修正を月1回以上適用し、年1回以上第三者の脆弱性診断を受けなければならない" }),
    ],
    recommended: [0, 1, 2],
  },
  /* システム環境 */
  {
    key: "ev.devices",
    category: "environment",
    name: "使う端末・ブラウザ",
    question: "どんな端末で使う？",
    why: "対応する端末が増えるほど、作る手間と確認の手間が増えます。",
    levels: [
      L("L1", "会社のパソコン（決められたブラウザ）", "会社が指定したパソコンのブラウザ", 1),
      L("L2", "パソコンとスマートフォンの主なブラウザ", "パソコンとスマートフォンの主要なブラウザ", 2),
      L("L3", "それに加えてタブレット・少し古い端末も", "パソコン・スマートフォン・タブレットの主要なブラウザ（2年前までの版を含む）", 3),
    ],
    recommended: [0, 1, 2],
    template: (v) => ({ pattern: "ubiquitous", response: `${v}で利用できなければならない` }),
  },
  {
    key: "ev.law",
    category: "environment",
    name: "守るべき法令・基準",
    question: "守らなければならない法律や業界のルールは？",
    why: "後から分かると作り直しになります。個人情報を扱うなら個人情報保護法は必ず関係します。",
    levels: [
      L("L1", "特にない", "", 1, null),
      L("L2", "個人情報保護法など一般的な法令", "", 2, { pattern: "ubiquitous", response: "個人情報保護法に従って個人情報を取り扱わなければならない" }),
      L("L3", "業界の基準（金融・医療・公共など）も", "", 3, { pattern: "ubiquitous", response: "個人情報保護法と、所属する業界のガイドラインに従って情報を取り扱わなければならない" }),
    ],
    recommended: [0, 1, 2],
  },
  {
    key: "ev.location",
    category: "environment",
    name: "データを置く場所",
    question: "データを置く場所に決まりはある？",
    why: "会社の規程や契約で、国外のサーバーや外部のクラウドを使えないことがあります。",
    levels: [
      L("L1", "特に決まりはない", "", 1, null),
      L("L2", "国内のデータセンター（クラウド可）", "", 2, { pattern: "ubiquitous", response: "データを国内のデータセンターに保管しなければならない" }),
      L("L3", "社内または指定された設備", "", 3, { pattern: "ubiquitous", response: "データを社内または指定された設備に保管しなければならない" }),
    ],
    recommended: [0, 1, 1],
  },
  /* 使いやすさ */
  {
    key: "us.access",
    category: "usability",
    name: "アクセシビリティ",
    question: "目や手が不自由な人、高齢の人も使う？",
    why: "社外の人が使うシステムでは、だれもが使えることが求められます。後から直すと手間がかかります。",
    levels: [
      L("L1", "特別な対応はしない", "", 1, null),
      L("L2", "文字の拡大や、色だけに頼らない表示に対応する", "", 2, { pattern: "ubiquitous", response: "文字を拡大しても利用でき、色だけに頼らずに情報を伝えなければならない" }),
      L("L3", "JIS X 8341-3 の適合レベルAAに対応する", "", 3, { pattern: "ubiquitous", response: "JIS X 8341-3:2016 の適合レベルAAを満たさなければならない" }),
    ],
    recommended: [0, 1, 2],
  },
  {
    key: "us.learn",
    category: "usability",
    name: "使い始めるまでの手間",
    question: "初めての人が使えるようになるまで、どのくらいかかってよい？",
    why: "社外の人や時々しか使わない人は、説明を受けずに使えることが大切です。",
    levels: [
      L("L1", "研修を受けてから使う", "", 1, null),
      L("L2", "30分程度の説明で使える", "", 2, { pattern: "ubiquitous", response: "初めての利用者が30分の説明を受けた後、主要な操作を手順書なしで完了できなければならない" }),
      L("L3", "説明なしで使える", "", 3, { pattern: "ubiquitous", response: "初めての利用者が説明なしで主要な操作を完了できなければならない" }),
    ],
    recommended: [1, 1, 2],
  },
];

export const NFR_ITEM_BY_KEY = new Map(NFR_ITEMS.map((i) => [i.key, i]));

export function recommendedLevel(item: NfrItem, profile: NfrProfile): NfrLevel {
  const g = gradesOf(profile)[item.category];
  return item.levels[Math.min(item.recommended[g], item.levels.length - 1)]!;
}

/* ------------------------------------------------------------------ */
/* シートの状態と評価                                                   */
/* ------------------------------------------------------------------ */

export type NfrStatus = "undecided" | "decided" | "na" | "deferred";
export interface NfrDecision {
  status: NfrStatus;
  /** 選んだ水準（L1〜）。自由入力なら null */
  level: string | null;
  /** 自由入力の値（水準に当てはまらないとき） */
  value: string;
  rationale: string;
  /** 保留のとき、誰が決めるか */
  owner: string;
  /** この項目から作った要件 */
  requirementId?: string | null;
  updatedBy?: string;
  updatedAt?: string;
}

export interface NfrFinding {
  severity: "error" | "warning";
  items: string[];
  message: string;
}

const idx = (item: NfrItem | undefined, d: NfrDecision | undefined) =>
  item && d?.status === "decided" && d.level ? item.levels.findIndex((l) => l.id === d.level) : -1;

/** 項目どうしの矛盾、推奨より低い水準、決め残しを調べる */
export function evaluateNfr(profile: NfrProfile, decisions: Record<string, NfrDecision>): {
  findings: NfrFinding[];
  coverage: number;
  counts: Record<NfrStatus, number>;
  byCategory: Record<NfrCategory, { total: number; considered: number }>;
  cost: { chosen: number; recommended: number };
} {
  const d = (k: string) => decisions[k];
  const at = (k: string) => idx(NFR_ITEM_BY_KEY.get(k), d(k));
  const findings: NfrFinding[] = [];
  const both = (a: string, b: string) => at(a) >= 0 && at(b) >= 0;
  const add = (severity: NfrFinding["severity"], items: string[], message: string) => findings.push({ severity, items, message });

  if (both("av.rto", "op.backup") && at("av.rto") >= 2 && at("op.backup") === 0)
    add("error", ["av.rto", "op.backup"], "1時間以内に復旧するには、週1回のバックアップでは足りません。バックアップの頻度を上げるか、復旧時間を見直してください。");
  if (both("av.rpo", "op.backup") && at("av.rpo") === 2 && at("op.backup") < 2)
    add("error", ["av.rpo", "op.backup"], "障害の直前までデータを戻すには、変更の記録を常に保存する必要があります（バックアップの水準を上げてください）。");
  if (both("av.rate", "op.monitoring") && at("av.rate") >= 2 && at("op.monitoring") === 0)
    add("error", ["av.rate", "op.monitoring"], "稼働率99.9%以上を目指すなら、停止を自動で検知する仕組みが必要です。");
  if (both("av.rate", "av.rto") && at("av.rate") >= 2 && at("av.rto") === 0)
    add("error", ["av.rate", "av.rto"], "稼働率99.9%（月43分まで）と、復旧は翌営業日まで、は両立しません。");
  if (both("av.hours", "op.maintenance") && at("av.hours") === 2 && at("op.maintenance") === 0)
    add("warning", ["av.hours", "op.maintenance"], "24時間365日の運用には「業務時間外」がありません。計画停止の決め方を見直してください。");
  if (both("av.hours", "op.support") && at("av.hours") === 2 && at("op.support") === 0)
    add("warning", ["av.hours", "op.support"], "24時間使うのに、問い合わせは平日の業務時間のみです。夜間・休日の障害時の連絡先を決めてください。");
  if (profile.data === 2) {
    if (at("sc.data") >= 0 && at("sc.data") < 2) add("error", ["sc.data"], "個人情報・機密情報を扱うので、保存しているデータも暗号化してください。");
    if (at("sc.audit") === 0) add("error", ["sc.audit"], "個人情報・機密情報を扱うので、操作の記録を残してください。");
    if (at("ev.law") === 0) add("error", ["ev.law"], "個人情報を扱う場合、個人情報保護法への対応が必要です。");
    if (at("sc.access") === 0) add("warning", ["sc.access"], "個人情報を全員が同じ権限で見られる状態です。権限を分けるか、理由を記録してください。");
  }
  if (profile.users === 2) {
    if (at("sc.auth") === 0) add("warning", ["sc.auth"], "社外の人が使うシステムで、ログインがIDとパスワードだけです。多要素認証を検討してください。");
    if (at("ev.devices") === 0) add("warning", ["ev.devices"], "社外の人が使うのに、会社のパソコンだけに対応する設定です。");
    if (at("sc.vuln") === 0) add("warning", ["sc.vuln"], "社外に公開するシステムは、定期的に脆弱性を修正してください。");
  }
  // 推奨より2段以上低い水準は、理由がなければエラー
  for (const item of NFR_ITEMS) {
    const i = at(item.key);
    if (i < 0) continue;
    const rec = item.levels.indexOf(recommendedLevel(item, profile));
    if (rec - i >= 2 && !d(item.key)!.rationale.trim()) add("error", [item.key], `「${item.name}」が推奨より大きく低い水準です。理由を記録してください。`);
    else if (rec - i === 1 && !d(item.key)!.rationale.trim()) add("warning", [item.key], `「${item.name}」が推奨より低い水準です。理由を記録しておくと後で判断を振り返れます。`);
  }
  for (const item of NFR_ITEMS) {
    const x = d(item.key);
    if (x?.status === "deferred" && !x.owner.trim()) add("warning", [item.key], `「${item.name}」が保留のままで、決める人が決まっていません。`);
    if (x?.status === "na" && !x.rationale.trim()) add("error", [item.key], `「${item.name}」を対象外にした理由を記録してください。`);
  }

  const counts: Record<NfrStatus, number> = { undecided: 0, decided: 0, na: 0, deferred: 0 };
  const byCategory = Object.fromEntries(Object.keys(NFR_CATEGORIES).map((c) => [c, { total: 0, considered: 0 }])) as Record<NfrCategory, { total: number; considered: number }>;
  let chosen = 0;
  let recommended = 0;
  for (const item of NFR_ITEMS) {
    const s = d(item.key)?.status ?? "undecided";
    counts[s]++;
    byCategory[item.category].total++;
    if (s !== "undecided") byCategory[item.category].considered++;
    const i = at(item.key);
    const rec = recommendedLevel(item, profile);
    recommended += rec.cost;
    chosen += i >= 0 ? item.levels[i]!.cost : rec.cost;
  }
  return { findings, coverage: (NFR_ITEMS.length - counts.undecided) / NFR_ITEMS.length, counts, byCategory, cost: { chosen, recommended } };
}

/** 決めた水準から EARS の非機能要件を作る（作らない項目は null） */
export function nfrRequirement(item: NfrItem, d: NfrDecision, system = "システム"): { title: string; ears: Ears } | null {
  if (d.status !== "decided" || item.organizational) return null;
  let part: EarsPart | null | undefined;
  if (d.level) {
    const lv = item.levels.find((l) => l.id === d.level);
    if (!lv) return null;
    part = lv.ears !== undefined ? lv.ears : item.template ? item.template(lv.value) : null;
  } else if (d.value.trim()) {
    part = item.template ? item.template(d.value.trim()) : { pattern: "ubiquitous", response: `${item.name}について「${d.value.trim()}」を満たさなければならない` };
  }
  if (!part) return null;
  const ears: Ears = { pattern: "ubiquitous", trigger: "", state: "", feature: "", ...part, system };
  return { title: renderEars(ears), ears };
}

/* ------------------------------------------------------------------ */
/* AIによる推奨水準の提案（複数AIの意見を比べる）                         */
/* ------------------------------------------------------------------ */

export const NfrSuggestionContent = z.object({
  items: z
    .array(
      z.object({
        key: z.string(),
        level: z.string().nullable().default(null),
        value: z.string().max(200).default(""),
        rationale: z.string().max(500).default(""),
        /** 利用者に確かめたいこと */
        question: z.string().max(300).default(""),
      }),
    )
    .max(60),
});

export const NFR_SYSTEM = `あなたは非機能要件の専門家です。システム開発に詳しくない利用者のために、非機能要件の各項目について、業務に見合った水準を提案します。
- 項目ごとに、選択肢の中から level（L1 など）を1つ選ぶ。どれにも当てはまらないときだけ level を null にして value に具体的な値を書く
- rationale には、その水準を選んだ理由を業務の言葉で1〜2文で書く。高すぎる水準は費用が増えることも考える
- 判断に必要な情報が足りないときは question に利用者への確認を書く
- 出力は次の形のJSONのみ。説明文やコードフェンスは付けない
{ "items": [{ "key": "av.rate", "level": "L2", "value": "", "rationale": "...", "question": "" }] }`;

export function buildNfrPrompt(input: { projectName: string; purpose: string; profile: NfrProfile; requirements: Array<{ code: string; type: string; title: string }>; keys?: string[] }): string {
  const g = gradesOf(input.profile);
  const prof = (Object.keys(PROFILE_QUESTIONS) as ProfileKey[])
    .map((k) => `- ${PROFILE_QUESTIONS[k].question} ${input.profile[k] === undefined ? "（未回答）" : PROFILE_QUESTIONS[k].options[input.profile[k]!]}`)
    .join("\n");
  const items = NFR_ITEMS.filter((i) => !input.keys || input.keys.includes(i.key))
    .map((i) => `## ${i.key} ${i.name}（${NFR_CATEGORIES[i.category]}）\n質問: ${i.question}\n${i.levels.map((l) => `- ${l.id}: ${l.label}`).join("\n")}\n目安: ${recommendedLevel(i, input.profile).id}`)
    .join("\n\n");
  return `# プロジェクト
名称: ${input.projectName}
目的: ${input.purpose || "（未記入）"}

# システムの性格
${prof}
重要度の目安: ${GRADE_LABELS[g.overall]}

# 確定している要件
${input.requirements.map((r) => `- ${r.code} [${r.type}] ${r.title}`).join("\n") || "（まだありません）"}

# 非機能要件の項目
${items}`;
}

export interface NfrSuggestion {
  key: string;
  /** 各AIの提案 */
  proposals: Array<{ providerId: string; level: string | null; value: string; rationale: string; question: string }>;
  /** AIの意見が分かれているか */
  split: boolean;
  /** 多数のAIが選んだ水準（同数なら高い方を避けて低い方） */
  consensus: string | null;
}

export async function suggestNfr(
  providers: AIProvider[],
  input: Parameters<typeof buildNfrPrompt>[0],
  opts: { timeoutMs?: number; onProgress?: (providerId: string, status: "running" | "done" | "failed", reason?: string) => void } = {},
): Promise<{ suggestions: NfrSuggestion[]; usages: Array<{ providerId: string; usage: Usage }>; failures: Array<{ providerId: string; reason: string }> }> {
  const prompt = buildNfrPrompt(input);
  const results = await Promise.all(
    providers.map(async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
      opts.onProgress?.(p.id, "running");
      try {
        const res = await p.complete({ system: NFR_SYSTEM, messages: [{ role: "user", content: prompt }], json: true, maxTokens: 8000, signal: ctrl.signal });
        const c = NfrSuggestionContent.parse(extractJson(res.text));
        opts.onProgress?.(p.id, "done");
        return { ok: true as const, providerId: p.id, items: c.items, usage: res.usage };
      } catch (e) {
        const reason = ctrl.signal.aborted ? "時間内に応答がありませんでした" : (e as Error).message;
        opts.onProgress?.(p.id, "failed", reason);
        return { ok: false as const, providerId: p.id, reason };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ok = results.filter((r): r is Extract<(typeof results)[number], { ok: true }> => r.ok);
  const failures = results.filter((r) => !r.ok).map((r) => ({ providerId: r.providerId, reason: (r as { reason: string }).reason }));
  if (!ok.length) {
    const err = new Error("非機能要件の提案を作れませんでした") as Error & { failures: typeof failures };
    err.failures = failures;
    throw err;
  }
  const suggestions: NfrSuggestion[] = [];
  for (const item of NFR_ITEMS.filter((i) => !input.keys || input.keys.includes(i.key))) {
    const proposals = ok
      .map((r) => {
        const s = r.items.find((x) => x.key === item.key);
        if (!s) return null;
        // 存在しない水準は自由入力として扱う
        const level = s.level && item.levels.some((l) => l.id === s.level) ? s.level : null;
        const value = level ? "" : s.value || (s.level ?? "");
        if (!level && !value) return null;
        return { providerId: r.providerId, level, value, rationale: s.rationale, question: s.question };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!proposals.length) continue;
    const votes = new Map<string, number>();
    for (const p of proposals) {
      const k = p.level ?? `value:${p.value}`;
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    const order = (k: string) => (k.startsWith("value:") ? 99 : item.levels.findIndex((l) => l.id === k));
    const top = [...votes].sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]))[0]!;
    suggestions.push({ key: item.key, proposals, split: votes.size > 1, consensus: top[0].startsWith("value:") ? null : top[0] });
  }
  return { suggestions, usages: ok.map((r) => ({ providerId: r.providerId, usage: r.usage })), failures };
}

/** 仕様書に載せる非機能要件シート（項目ごとの1行） */
export function nfrSheetLines(profile: NfrProfile, decisions: Record<string, NfrDecision>): string[] {
  const label = (s: NfrStatus) => ({ undecided: "未検討", decided: "決定", na: "対象外", deferred: "保留" })[s];
  return NFR_ITEMS.map((item) => {
    const d = decisions[item.key];
    const s = d?.status ?? "undecided";
    const lv = d?.level ? item.levels.find((l) => l.id === d.level)?.label : d?.value;
    const rec = recommendedLevel(item, profile);
    return `［${label(s)}］${NFR_CATEGORIES[item.category].replace(/（.*/, "")}／${item.name}：${s === "decided" ? (lv ?? "―") : s === "deferred" ? `保留（決める人：${d?.owner || "未定"}）` : s === "na" ? "対象外" : "―"}（推奨：${rec.label}）${d?.rationale ? ` 理由：${d.rationale}` : ""}`;
  });
}
