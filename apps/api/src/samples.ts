/**
 * サンプル事例: 本システム（要件ナビ）自身の要求事項。
 * 画面から読み込むと、次の状態のプロジェクトができる（AIの呼び出しはしない）。
 *   - 資料2件（振り返り会の議事録・今の進め方のメモ）と、その分析（現状の課題・業務の見直し）を採用済み
 *   - 要件（目的・利用者・機能・非機能・制約）。機能・非機能は EARS 記法
 *   - 非機能要件シート（システムの性格と26項目の決定・理由）。非機能要件はシートから作る
 * 要件定義は確定していないため、読み込んだ後に編集・確定・変更管理を試せる。
 */
import {
  AnalysisContent,
  NFR_ITEMS,
  nfrRequirement,
  normalizeAnalysis,
  renderEars,
  type AcceptanceCriteria,
  type BusinessRule,
  type GlossaryTerm,
  type Ears,
  type NfrDecision,
  type NfrProfile,
  type RequirementType,
  type SourceDocument,
} from "@arn/ai-core";
import type { AcceptanceSheet, AIConfig, GlossarySheet, Project, Store } from "./store.js";

const SYSTEM = "要件ナビ";
type Pattern = Ears["pattern"];
const e = (pattern: Pattern, response: string, extra: Partial<Pick<Ears, "trigger" | "state" | "feature">> = {}): Ears => ({
  pattern,
  trigger: "",
  state: "",
  feature: "",
  system: SYSTEM,
  response,
  ...extra,
});

interface SampleRequirement {
  type: RequirementType;
  priority: "must" | "should" | "could";
  title?: string;
  ears?: Ears;
  rule?: BusinessRule;
  description?: string;
}

/* ------------------------------------------------------------------ */
/* 資料                                                                */
/* ------------------------------------------------------------------ */

const MINUTES = `要件定義の進め方 振り返り会 議事録
出席：開発部、業務改革推進室、情報システム部

1. これまでの要件定義の問題
要件定義書はExcelとWordで作り、担当者ごとに書き方が違う。
業務部門の担当者は専門用語が分からず、ヒアリングの回答があいまいになりがちだ。
要件の抜け漏れは設計工程のレビューで見つかり、手戻りが多い。
非機能要件は前の案件の資料をコピーしており、稼働率99.99%など過大な値がそのまま残っていた。
今のシステムの画面と帳票をそのまま作り直す要件になり、業務の改善につながらなかった。

2. AIの試行
AIに要件を作らせたが、使うAIによって内容が大きく違い、どれが正しいか判断できなかった。
社外のAIに顧客の情報を送ってよいか、判断の基準がない。

3. 実装工程への引き渡し
設計書と課題管理ツールへの転記に毎回2日かかる。
確定後の変更はメールで依頼され、影響範囲の確認は担当者の経験に頼っている。`;

const CURRENT_FLOW = `今の要件定義の進め方（メモ）
プロジェクト管理者が業務部門にヒアリングし、議事録をWordで作る。
プロジェクト管理者が議事録をExcelの要件一覧に転記する。
設計者がUMLを手で描き、要件との対応をExcelで管理する。
レビュー会で要件の抜け漏れを確認する。
開発チームが要件一覧を見て、Jiraに課題を手で登録する。`;

export const SAMPLE_DOCUMENTS = [
  { name: "要件定義の進め方 振り返り会 議事録", kind: "minutes", text: MINUTES },
  { name: "今の要件定義の進め方（メモ）", kind: "existing", text: CURRENT_FLOW },
];

/* ------------------------------------------------------------------ */
/* 要件                                                                */
/* ------------------------------------------------------------------ */

export const SAMPLE_REQUIREMENTS: SampleRequirement[] = [
  // 目的
  { type: "BR", priority: "must", title: "専門家でない業務担当者が、AIの支援を受けて要件定義を完了できるようにする" },
  { type: "BR", priority: "must", title: "複数のAIの案を比べて評価し、特定のAIの偏りや誤りに左右されない要件にする" },
  { type: "BR", priority: "must", title: "要件・UML・仕様書・課題を、設計と実装の工程へ転記なしで引き渡す" },
  { type: "BR", priority: "should", title: "今の業務・システムの焼き増しや過大な非機能要件を避け、費用に見合うシステムにする" },
  // 利用者
  { type: "AC", priority: "must", title: "業務担当者：ヒアリングに答え、案を選んで要件を確定する" },
  { type: "AC", priority: "must", title: "プロジェクト管理者：プロジェクトとAIの構成を決め、要件定義を確定する" },
  { type: "AC", priority: "should", title: "レビュアー：要件・設計・変更要求を確認し、判断を記録する" },
  { type: "AC", priority: "must", title: "組織の管理者：AIのAPIキー・利用上限・連携先・利用者の権限を管理する" },
  { type: "AC", priority: "should", title: "開発チーム：確定した要件・UML・課題を受け取り、実装する" },
  // 機能要件
  { type: "FR", priority: "must", ears: e("event", "選ばれた生成AIそれぞれに要件案を作成させなければならない", { trigger: "利用者が質問に回答した" }) },
  { type: "FR", priority: "must", ears: e("event", "作成したAIを伏せて評価AIに採点させ、統合案と推奨を示さなければならない", { trigger: "2つ以上の要件案がそろった" }) },
  { type: "FR", priority: "must", ears: e("ubiquitous", "評価の合計点を、評価AIの申告ではなく定めた重みで計算しなければならない") },
  { type: "FR", priority: "must", ears: e("event", "採用した項目を番号を振って要件に登録し、採用の理由と作成したAIを記録しなければならない", { trigger: "利用者が案を採用した" }) },
  { type: "FR", priority: "must", ears: e("ubiquitous", "フェーズごとの確認すべき観点について、確定した要件で埋まった割合を表示しなければならない") },
  { type: "FR", priority: "should", ears: e("unwanted", "数値や条件で確かめる質問を示さなければならない", { trigger: "利用者の回答にあいまいな表現が含まれていた" }) },
  { type: "FR", priority: "should", ears: e("ubiquitous", "画面に出る専門用語に、平易な説明を添えて表示しなければならない") },
  { type: "FR", priority: "should", ears: e("event", "本文のテキストを取り出して資料として保存しなければならない", { trigger: "利用者が議事録や既存システムの資料を取り込んだ" }) },
  {
    type: "FR",
    priority: "should",
    ears: e("event", "現状の業務フロー・課題・業務の見直し案・見直し後の業務フロー・初回の要件案を作成しなければならない", { trigger: "利用者が資料の分析を指示した" }),
  },
  { type: "FR", priority: "should", ears: e("unwanted", "その引用を「資料に見つからない」と表示しなければならない", { trigger: "課題の根拠として引用した文が資料に見つからなかった" }) },
  { type: "FR", priority: "should", ears: e("unwanted", "今の業務の焼き増しになっていないか確認を促さなければならない", { trigger: "分析の見直し率が30%を下回った" }) },
  { type: "FR", priority: "must", ears: e("ubiquitous", "機能要件と非機能要件を EARS 記法の構造で保存し、その構造から要件文を組み立てなければならない") },
  { type: "FR", priority: "should", ears: e("unwanted", "問題の箇所と直し方を表示しなければならない", { trigger: "要件文に解釈が分かれる表現が含まれていた" }) },
  { type: "FR", priority: "must", ears: e("event", "非機能要件の各項目に推奨水準を示さなければならない", { trigger: "利用者がシステムの性格の質問に回答した" }) },
  { type: "FR", priority: "must", ears: e("unwanted", "矛盾する項目と理由を表示しなければならない", { trigger: "非機能要件の項目どうしに矛盾があった" }) },
  { type: "FR", priority: "should", ears: e("unwanted", "過大の可能性として理由の記録を求めなければならない", { trigger: "非機能要件の水準が推奨または似た事例より高かった" }) },
  {
    type: "FR",
    priority: "must",
    ears: e("event", "確定した要件からユースケース図・クラス図・シーケンス図・状態遷移図・アクティビティ図を作成しなければならない", { trigger: "利用者がUMLの作成を指示した" }),
  },
  { type: "FR", priority: "should", ears: e("event", "見た目の情報を含まない画面一覧と、クリックで移動できるワイヤーフレームを作成しなければならない", { trigger: "利用者が画面の作成を指示した" }) },
  { type: "FR", priority: "should", ears: e("event", "見た目の細部に関する意見を設計工程への申し送りとして記録しなければならない", { trigger: "利用者が画面への意見を送った" }) },
  { type: "FR", priority: "must", ears: e("event", "要件・UML・決定記録を含む仕様書を Word・PDF・Markdown で出力しなければならない", { trigger: "利用者が仕様書の出力を指示した" }) },
  { type: "FR", priority: "must", ears: e("event", "その時点の要件を確定版として保存しなければならない", { trigger: "利用者が要件定義を確定した" }) },
  { type: "FR", priority: "must", ears: e("state", "要件の直接の編集と削除を受け付けず、変更要求として登録させなければならない", { state: "要件定義が確定済みである" }) },
  {
    type: "FR",
    priority: "must",
    ears: e("event", "設計・画面・実装タスク・登録済みの課題への影響と、変更する・代替案・保留・変更しないの選択肢を示さなければならない", { trigger: "利用者が変更要求の影響分析を指示した" }),
  },
  { type: "FR", priority: "must", ears: e("unwanted", "確定を止め、残っている項目を表示しなければならない", { trigger: "非機能要件に未検討の項目または要対応の矛盾が残った状態で確定しようとした" }) },
  { type: "FR", priority: "should", ears: e("event", "確定した要件をエピック・ストーリー・作業タスクに分け、各ストーリーに元の要件を結び付けなければならない", { trigger: "利用者がタスク分解を指示した" }) },
  { type: "FR", priority: "should", ears: e("event", "選んだストーリーを GitHub・Jira・Backlog のいずれかに課題として登録しなければならない", { trigger: "利用者が課題の登録を指示した" }) },
  { type: "FR", priority: "should", ears: e("unwanted", "再実行したときに登録済みの課題を飛ばし、失敗した分だけを登録しなければならない", { trigger: "課題の登録が途中で失敗した" }) },
  { type: "FR", priority: "must", ears: e("event", "APIキーを暗号化して保存し、画面には末尾4文字だけを表示しなければならない", { trigger: "組織の管理者がAIを登録した" }) },
  { type: "FR", priority: "must", ears: e("unwanted", "そのAIの呼び出しを止め、利用者に知らせなければならない", { trigger: "組織またはAIの今月のトークン利用量が上限に達した" }) },
  { type: "FR", priority: "must", ears: e("ubiquitous", "AIへの送信・案の採用・設定の変更を、実行した利用者と日時とともに監査ログに記録しなければならない") },
  { type: "FR", priority: "must", ears: e("state", "ローカルLLM以外のAIにデータを送信しないようにしなければならない", { state: "プロジェクトが機密に指定されている" }) },
  // 業務ルール（計算・判定・制約・状態が変わる条件。具体例はそのままテストケースになる）
  {
    type: "RL",
    priority: "must",
    title: "評価の合計点は、網羅性・正確性を各25%、一貫性を20%、実現可能性・分かりやすさを各15%の重みで計算し、整数に四捨五入する",
    rule: {
      kind: "calc",
      examples: [
        { given: "網羅性80・正確性70・一貫性90・実現可能性60・分かりやすさ75", expected: "合計点76（75.75を四捨五入）" },
        { given: "5つの基準がすべて80", expected: "合計点80" },
        { given: "網羅性100・ほかの基準がすべて0", expected: "合計点25" },
      ],
      entities: ["評価"],
    },
  },
  {
    type: "RL",
    priority: "must",
    title: "非機能要件の水準が推奨より2段以上高く、理由が書かれていない項目は、要対応とする",
    rule: {
      kind: "judge",
      examples: [
        { given: "推奨L1・選んだ水準L3・理由なし", expected: "要対応" },
        { given: "推奨L1・選んだ水準L3・理由あり", expected: "要対応にしない（確認の表示のみ）" },
        { given: "推奨L1・選んだ水準L2・理由なし", expected: "要対応にしない（確認の表示のみ）" },
      ],
      entities: ["非機能要件シート"],
    },
  },
  {
    type: "RL",
    priority: "must",
    title: "要件定義を確定した後は、要件を直接は編集できず、変更要求を判断したときだけ変わる",
    rule: {
      kind: "transition",
      examples: [
        { given: "確定版がない状態で要件を編集する", expected: "編集できる" },
        { given: "確定版がある状態で要件を編集する", expected: "編集できず、変更要求を出すよう案内する" },
        { given: "変更要求を「変更する」と判断した", expected: "要件が変わり、確定版の番号が1つ上がる" },
      ],
      entities: ["要件", "確定版", "変更要求"],
    },
  },
  {
    type: "RL",
    priority: "should",
    title: "資料分析の見直し率が30%未満のときは、今の業務の焼き増しのおそれとして警告する",
    rule: {
      kind: "judge",
      examples: [
        { given: "課題10件のうち見直し案に結び付いたものが2件（20%）", expected: "警告する" },
        { given: "課題10件のうち見直し案に結び付いたものが3件（30%）", expected: "警告しない" },
      ],
      entities: ["資料分析"],
    },
  },
  // 非機能要件（シートからの分は読み込み時に作る。ここではシートにない項目だけ）
  { type: "NFR", priority: "must", ears: e("unwanted", "その生成AIを90秒で打ち切り、残りのAIの案で処理を続けなければならない", { trigger: "生成AIが応答しなかった" }) },
  { type: "NFR", priority: "must", ears: e("event", "処理を受け付けた後、進み具合を5秒以内に画面に表示しなければならない", { trigger: "利用者がAIの処理を開始した" }) },
  // 制約条件
  { type: "CN", priority: "must", title: "オープンソース（Apache-2.0）として公開し、GitHubのテンプレートとして再利用できるようにする" },
  { type: "CN", priority: "must", title: "再配布できる、または著作権表示で利用できるライセンスのOSSだけを使う（GPL・AGPL・SSPLなどは使わない）" },
  { type: "CN", priority: "must", title: "AWSとローカルのDockerの両方で、同じコンテナイメージで動作する" },
  { type: "CN", priority: "must", title: "AIのAPIキーは組織ごとに管理者が登録する" },
  { type: "CN", priority: "must", title: "利用するAIは Claude・GPT・Gemini・ローカルLLM から選べる" },
];

/* ------------------------------------------------------------------ */
/* 非機能要件シート                                                     */
/* ------------------------------------------------------------------ */

/** 社内と取引先が使い、止まっても手作業で代われる。要件には機密情報が含まれうる。予算は小さい（OSS） */
export const SAMPLE_NFR_PROFILE: NfrProfile = { users: 1, impact: 0, data: 2, hours: 1, scale: 1, purpose: 0, budget: 0 };

const D = (level: string, rationale: string): NfrDecision => ({ status: "decided", level, value: "", rationale, owner: "" });
export const SAMPLE_NFR_DECISIONS: Record<string, NfrDecision> = {
  "av.hours": D("L2", "業務時間の前後にも資料をまとめることがあるため、朝から夜までとする"),
  "av.rate": D("L2", "止まっても会議や紙で要件定義を続けられるため、月7時間程度の停止は許容する"),
  "av.rto": D("L2", "コンテナの再起動とデータベースの復元で、当日中に戻せれば業務への影響は小さい"),
  "av.rpo": D("L2", "数時間分の回答は議事録から入力し直せる"),
  "av.disaster": D("L2", "要件の記録は失うと作り直しが大きいため、別の場所にバックアップを置く（AWSのスナップショットを使う）"),
  "pf.users": D("L2", "組織全体で同時に100人程度の利用を見込む"),
  "pf.response": D("L2", "AIの処理は非同期で進み具合を表示するため、画面の操作は3秒以内で十分"),
  "pf.peak": D("L1", "利用が集中する時期は特にない（推奨より低いが、要件定義の作業は案件ごとに分散する）"),
  "pf.growth": D("L2", "案件が増えるにつれ、5年で数倍になる見込み"),
  "pf.batch": D("L1", "AIの処理は1件ずつの非同期ジョブで、夜間にまとめて行う処理はない"),
  "op.backup": D("L2", "AWSのRDSの自動バックアップを使うため、毎日の取得でも費用はほとんど増えない"),
  "op.monitoring": D("L1", "止まっても業務への影響が小さく、ヘルスチェックによる自動再起動で足りる"),
  "op.maintenance": D("L1", "業務時間外に更新すればよい"),
  "op.support": D("L1", "問い合わせは平日の業務時間に情報システム部が受ける"),
  "mg.data": D("L1", "新しく作るシステムで、移すデータはない（過去の要件一覧は資料として取り込める）"),
  "mg.cutover": D("L1", "新規の導入のため、使い始める日から切り替える"),
  "sc.auth": D("L3", "会社の共通ログイン（OIDC：Cognito / Keycloak）を使い、多要素認証は共通ログイン側で行う"),
  "sc.access": D("L3", "組織ごとにデータを分け、管理者・編集者・閲覧者の役割で操作を制限する"),
  "sc.data": D("L3", "APIキーと要件に機密情報が含まれうるため、通信と保存データを暗号化する（KMS）"),
  "sc.audit": D("L2", "ログインと重要な操作を記録し、保持期間は組織で設定する。改ざん防止は導入する組織の基準に合わせて追加する"),
  "sc.vuln": D("L2", "依存関係を自動で更新する（Dependabot）。第三者による診断は導入する組織が実施する"),
  "ev.devices": D("L1", "業務で使うパソコンの主要なブラウザで使えればよい（推奨より低いが、スマートフォンでの要件定義は想定しない）"),
  "ev.law": D("L2", "利用者や顧客の個人情報が要件や資料に含まれうるため、個人情報保護法に従う"),
  "ev.location": D("L1", "導入する組織が設置場所（AWSの国内リージョンや社内のDocker）を選べるため、システムとしては決めない"),
  "us.access": D("L2", "社内の多くの人が使うため、文字の拡大と色に頼らない表示に対応する"),
  "us.learn": D("L2", "質問・回答候補・用語解説があるため、30分程度の説明で使えることを目標にする"),
};

/* ------------------------------------------------------------------ */
/* 資料の分析（採用済みの状態で読み込む）                                */
/* ------------------------------------------------------------------ */

const ANALYSIS: unknown = {
  summary:
    "要件定義が担当者の経験とExcel・Wordへの転記に頼っており、書き方のばらつき・抜け漏れの後工程での発覚・過大な非機能要件・転記の手間が主な課題です。転記をやめてヒアリングの中で要件を確定し、抜け漏れの確認を前倒しすることで、レビュー会と転記の作業をなくせます。",
  asIs: [
    { id: "A1", actor: "プロジェクト管理者", action: "業務部門にヒアリングし、議事録を作る", tool: "Word", issueIds: ["I2"] },
    { id: "A2", actor: "プロジェクト管理者", action: "議事録を要件一覧に転記する", tool: "Excel", issueIds: ["I1"] },
    { id: "A3", actor: "設計者", action: "UMLを手で描き、要件との対応を管理する", tool: "Excel", issueIds: ["I6"] },
    { id: "A4", actor: "レビュアー", action: "レビュー会で抜け漏れを確認する", tool: "", issueIds: ["I3"] },
    { id: "A5", actor: "開発チーム", action: "要件一覧を見て課題を手で登録する", tool: "Jira", issueIds: ["I6"] },
  ],
  issues: [
    {
      id: "I1",
      title: "要件の書き方が担当者ごとに違う",
      category: "dependency",
      impact: "解釈の違いが設計工程まで残る",
      rootCause: "要件文の書き方の基準と、それを確かめる仕組みがない",
      evidence: [{ document: "D1", quote: "要件定義書はExcelとWordで作り、担当者ごとに書き方が違う。" }],
    },
    {
      id: "I2",
      title: "業務部門の回答があいまいになる",
      category: "other",
      impact: "数値のない要件が残り、後で決め直しになる",
      rootCause: "専門用語が分からず、何を答えればよいか分からない",
      evidence: [{ document: "D1", quote: "業務部門の担当者は専門用語が分からず、ヒアリングの回答があいまいになりがちだ。" }],
    },
    {
      id: "I3",
      title: "抜け漏れが設計工程で見つかる",
      category: "error",
      impact: "手戻りが多い",
      rootCause: "確認すべき観点がヒアリングの時点で見えていない",
      evidence: [{ document: "D1", quote: "要件の抜け漏れは設計工程のレビューで見つかり、手戻りが多い。" }],
    },
    {
      id: "I4",
      title: "非機能要件が過大になる",
      category: "other",
      impact: "費用と期間が膨らむ",
      rootCause: "前の案件の値をコピーし、規模や目的に照らして見直していない",
      evidence: [{ document: "D1", quote: "非機能要件は前の案件の資料をコピーしており、稼働率99.99%など過大な値がそのまま残っていた。" }],
    },
    {
      id: "I5",
      title: "AIの出力のどれが正しいか判断できない",
      category: "other",
      impact: "AIを使っても品質が安定しない",
      rootCause: "複数の出力を比べて評価する方法がない",
      evidence: [{ document: "D1", quote: "AIに要件を作らせたが、使うAIによって内容が大きく違い、どれが正しいか判断できなかった。" }],
    },
    {
      id: "I6",
      title: "設計書と課題管理ツールへの転記に時間がかかる",
      category: "duplicate",
      impact: "案件ごとに2日の作業が発生する",
      rootCause: "要件・設計・課題が別々のツールで管理されている",
      evidence: [{ document: "D1", quote: "設計書と課題管理ツールへの転記に毎回2日かかる。" }],
    },
  ],
  proposals: [
    { id: "P1", title: "Excelへの転記をやめ、ヒアリングの中で要件を確定する", approach: "eliminate", description: "ヒアリングの回答からAIが要件案を作り、その場で採用して要件一覧に登録する", issueIds: ["I1", "I6"], effect: "転記の作業がなくなる", tradeoff: "ヒアリングの場で判断する人が必要" },
    { id: "P2", title: "抜け漏れの確認をヒアリングの中に前倒しする", approach: "rearrange", description: "フェーズごとの観点の網羅率を見ながら質問し、レビュー会の前に抜けを埋める", issueIds: ["I3"], effect: "設計工程での手戻りが減る", tradeoff: "" },
    { id: "P3", title: "要件文を EARS 記法にそろえる", approach: "standardize", description: "機能要件・非機能要件を決まった文型で書き、あいまいな表現を自動で検査する", issueIds: ["I1", "I2"], effect: "書き方のばらつきと解釈の違いが減る", tradeoff: "慣れるまで文型に違和感がある" },
    { id: "P4", title: "複数のAIの案を匿名で比べて選ぶ", approach: "simplify", description: "評価AIが作成者を伏せて採点し、推奨と統合案を示す", issueIds: ["I5"], effect: "AIの偏りに左右されにくくなる", tradeoff: "AIの利用料が増える" },
    { id: "P5", title: "非機能要件を似た事例と比べて決める", approach: "standardize", description: "システムの性格から推奨水準を示し、似た事例より高い水準には理由を求める", issueIds: ["I4"], effect: "過大な非機能要件を避けられる", tradeoff: "" },
    { id: "P6", title: "課題の登録を自動にする", approach: "automate", description: "要件からタスクに分解し、課題管理ツールに直接登録する", issueIds: ["I6"], effect: "2日の転記がなくなる", tradeoff: "課題管理ツールとの接続の設定が必要" },
  ],
  toBe: [
    { id: "B1", actor: "業務担当者", action: "質問と回答候補を見ながらヒアリングに答える", change: "changed", fromAsIs: ["A1"], proposalIds: ["P2"] },
    { id: "B2", actor: "業務担当者", action: "複数のAIの案を比べて採用する", change: "new", fromAsIs: [], proposalIds: ["P1", "P4"] },
    { id: "B3", actor: "設計者", action: "要件から作られたUMLを確認する", change: "changed", fromAsIs: ["A3"], proposalIds: [] },
    { id: "B4", actor: "プロジェクト管理者", action: "非機能要件シートを確認して要件定義を確定する", change: "changed", fromAsIs: ["A4"], proposalIds: ["P5"] },
    { id: "B5", actor: "開発チーム", action: "自動で登録された課題から実装を始める", change: "changed", fromAsIs: ["A5"], proposalIds: ["P6"] },
  ],
  removed: [{ asIsId: "A2", reason: "要件はヒアリングの中で確定し、転記しない", proposalIds: ["P1"] }],
  notCarriedOver: [
    { item: "Excelの要件一覧のテンプレート", reason: "要件はシステムで管理し、仕様書として出力する" },
    { item: "要件とUMLの対応表（Excel）", reason: "要件とUML・課題のつながりはシステムがたどる" },
  ],
  requirements: [
    { type: "FR", priority: "must", ears: e("event", "採用した項目を番号を振って要件に登録し、採用の理由と作成したAIを記録しなければならない", { trigger: "利用者が案を採用した" }), proposalIds: ["P1"], issueIds: ["I6"], rationale: "転記をなくすため" },
    { type: "FR", priority: "must", ears: e("ubiquitous", "フェーズごとの確認すべき観点について、確定した要件で埋まった割合を表示しなければならない"), proposalIds: ["P2"], issueIds: ["I3"], rationale: "抜け漏れを前倒しで見つけるため" },
    { type: "FR", priority: "must", ears: e("ubiquitous", "機能要件と非機能要件を EARS 記法の構造で保存し、その構造から要件文を組み立てなければならない"), proposalIds: ["P3"], issueIds: ["I1"], rationale: "書き方をそろえるため" },
    { type: "FR", priority: "should", ears: e("unwanted", "過大の可能性として理由の記録を求めなければならない", { trigger: "非機能要件の水準が推奨または似た事例より高かった" }), proposalIds: ["P5"], issueIds: ["I4"], rationale: "過大な非機能要件を避けるため" },
  ],
  questions: ["社外のAIに送ってよい情報の基準を、組織として決めていますか"],
};

/* ------------------------------------------------------------------ */
/* 読み込み                                                            */
/* ------------------------------------------------------------------ */

export const SAMPLES = {
  "requirements-navigator": {
    name: "要件ナビ（サンプル事例）",
    purpose: "専門家でなくても、複数のAIと対話しながら、焼き増しでも過大でもない要件を定義し、UML・仕様書・課題として実装工程へ引き渡せるようにする",
  },
} as const;
export type SampleId = keyof typeof SAMPLES;

const TYPE_PHASE: Record<string, string> = { BR: "purpose", AC: "actors", FR: "functions", RL: "rules", NFR: "quality", CN: "constraints" };

/** EARS の構造がある要件は文を組み立てる */
const titleOf = (r: SampleRequirement) => (r.ears ? renderEars(r.ears) : r.title!);

export async function loadSample(store: Store, input: { orgId: string; aiConfig: AIConfig; actor: string }): Promise<{ project: Project; requirements: number; documents: number }> {
  const meta = SAMPLES["requirements-navigator"];
  const project = await store.createProject({ orgId: input.orgId, name: meta.name, purpose: meta.purpose, confidential: false, aiConfig: input.aiConfig });

  // 資料と分析
  const docs = [];
  for (const d of SAMPLE_DOCUMENTS) {
    docs.push(await store.addDocument({ projectId: project.id, name: d.name, kind: d.kind, format: "text", text: d.text, chars: d.text.length, truncated: false, createdBy: input.actor }));
  }
  const sources: SourceDocument[] = docs.map((d, i) => ({ key: `D${i + 1}`, name: d.name, kind: d.kind, text: d.text }));
  const analysis = normalizeAnalysis(AnalysisContent.parse(ANALYSIS), sources);

  // 要件（区分ごとに番号が振られる）。非機能要件は、シートにない2件に続けてシートから作る
  const added = await store.addRequirements(
    project.id,
    SAMPLE_REQUIREMENTS.map((r) => ({
      title: titleOf(r),
      description: r.description ?? "",
      type: r.type,
      priority: r.priority,
      ears: r.ears,
      rule: r.rule,
      roundId: null,
      source: "サンプル事例",
      phaseKey: TYPE_PHASE[r.type] ?? null,
    })),
  );
  const decisions: Record<string, NfrDecision> = JSON.parse(JSON.stringify(SAMPLE_NFR_DECISIONS));
  let nfrCount = 0;
  for (const item of NFR_ITEMS) {
    const d = decisions[item.key];
    if (!d) continue;
    const req = nfrRequirement(item, d, SYSTEM);
    if (!req) continue;
    const [r] = await store.addRequirements(project.id, [
      { title: req.title, description: d.rationale, type: "NFR", priority: "must", ears: req.ears, roundId: null, source: `非機能要件シート（${item.name}）`, phaseKey: "quality" },
    ]);
    d.requirementId = r!.id;
    nfrCount++;
  }
  await store.saveNfrSheet({ projectId: project.id, profile: SAMPLE_NFR_PROFILE, decisions, suggestions: null, review: null });

  // 分析の要件案は、すでにある要件（同じ文）に対応づけて採用済みにする
  const byTitle = new Map(added.map((r) => [r.title, r.code]));
  const rec = await store.saveAnalysis({
    projectId: project.id,
    documentIds: docs.map((d) => d.id),
    focus: "要件定義の手戻りと転記の手間",
    candidates: [{ label: "A", providerId: "サンプル事例", analysis }],
    evaluation: null,
    failures: [],
    warnings: [],
    notes: sources.map((s) => `${s.key} = ${s.name}`),
    createdBy: input.actor,
  });
  await store.adoptAnalysis(rec.id, {
    label: "A",
    proposalIds: analysis.proposals.map((p) => p.id),
    requirementCodes: analysis.requirements.map((r) => byTitle.get(r.title)).filter((c): c is string => Boolean(c)),
    changeCodes: [],
    reason: "サンプル事例として読み込み",
    by: input.actor,
    at: new Date().toISOString(),
  });
  // 用語集と受け入れ基準（要件定義で決めておくこと）
  await store.saveProjectSheet<GlossarySheet>(project.id, "glossary", { terms: SAMPLE_GLOSSARY }, input.actor);
  await store.saveProjectSheet<AcceptanceSheet>(project.id, "acceptance", SAMPLE_ACCEPTANCE, input.actor);
  return { project, requirements: added.length + nfrCount, documents: docs.length };
}

/* ------------------------------------------------------------------ */
/* 用語集・受け入れ基準                                                 */
/* ------------------------------------------------------------------ */

const term = (t: string, definition: string, synonyms: string[] = [], codeName = ""): GlossaryTerm => ({ term: t, definition, synonyms, codeName, source: "manual" });
export const SAMPLE_GLOSSARY: GlossaryTerm[] = [
  term("要件", "システムが満たすべきこと。目的・利用者・機能要件・業務ルール・非機能要件・制約条件に分ける", ["要求事項"], "Requirement"),
  term("確定版", "利用者が確定した時点の要件の一覧。以後の変更は変更要求を通して行い、版の番号が上がる", ["ベースライン"], "Baseline"),
  term("変更要求", "確定した後の要件の追加・変更・削除の申し出。影響分析の結果を見て判断する", ["変更依頼"], "ChangeRequest"),
  term("生成AI", "要件案・設計モデル・画面などの案を作るAI", [], "generator"),
  term("評価AI", "生成AIの案を、作ったAIを伏せて採点するAI", ["審査AI"], "evaluator"),
  term("非機能要件シート", "性能・可用性・セキュリティなど26項目の水準と理由をまとめた表", ["NFR表"], "NfrSheet"),
  term("業務ルール", "計算のしかた・判定の条件・制約・状態が変わる条件。具体例を添える", ["ビジネスルール"], ""),
];
export const SAMPLE_ACCEPTANCE: AcceptanceCriteria = {
  mustPassRate: 100,
  shouldPassRate: 90,
  maxFailedTests: 0,
  nfrAllRun: true,
  questionsClosed: true,
  custom: [
    { id: "C1", text: "業務部門の担当者が、資料の取り込みから要件定義書の出力までを、説明を受けずに通しで実施できた", checked: false, checkedBy: null, checkedAt: null },
    { id: "C2", text: "情報システム部門が、組織へのAIの登録と利用上限の設定を手順書どおりに実施できた", checked: false, checkedBy: null, checkedAt: null },
  ],
};
