/**
 * 着手前チェック（機能 F9-3）。
 *
 * 要件定義の成果物が、コーディングとテストの工程に引き渡せる状態かを規則で点検し、
 * 足りないものを「どの画面で何をすればよいか」と一緒に示す。AIは使わない。
 */
import { designCompleteness } from "./design-tables.js";
import { lintEars, EARS_TYPES, type Ears } from "./ears.js";
import type { UmlModel } from "./uml.js";

export type ReadinessStatus = "ok" | "warn" | "ng";
export type ReadinessArea = "requirements" | "design" | "test" | "management";
export const READINESS_AREAS: Record<ReadinessArea, string> = { requirements: "要件", design: "設計の材料", test: "テスト", management: "管理" };

export interface ReadinessCheck {
  key: string;
  area: ReadinessArea;
  title: string;
  status: ReadinessStatus;
  detail: string;
  /** 対象の要件IDや項目 */
  items: string[];
  /** どの画面で直すか（タブの名前） */
  where: string;
}

export interface ReadinessInput {
  requirements: Array<{ code: string; type: string; title: string; ears?: Ears | null }>;
  nfr: { coverage: number; errors: number; undecided: string[] } | null;
  uml: UmlModel | null;
  screens: { uncovered: string[] } | null;
  tasks: { uncovered: string[]; stories: number } | null;
  tests: { untested: string[]; methodUndecided: string[]; methodGuessed: string[]; withoutAcceptance: string[] };
  /** AIからの質問など、答えが出ていないこと */
  openQuestions: string[];
  baselined: boolean;
  pendingChanges: string[];
  /** 権限を分ける水準を選んだか（非機能要件シートの sc.access） */
  accessControl: boolean;
  /** 要件が変わった後に作り直していない成果物（例: 「タスク分解（FR-03 が変更）」） */
  stale?: string[];
}

export interface ReadinessReport {
  checks: ReadinessCheck[];
  /** ready: 引き渡せる / conditional: 確認事項を共有すれば着手できる / not-ready: 足りないものがある */
  verdict: "ready" | "conditional" | "not-ready";
  score: number;
  counts: Record<ReadinessStatus, number>;
}

const INTERFACE_WORDS = /連携|外部|送信|メール|通知|取り込|取込|出力|API|CSV|インポート|エクスポート|決済|他システム/;
const list = (xs: string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join("、")} ほか${xs.length - n}件` : xs.join("、"));

export function assessReadiness(x: ReadinessInput): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const add = (c: Omit<ReadinessCheck, "items"> & { items?: string[] }) => checks.push({ items: [], ...c });
  const target = x.requirements.filter((r) => EARS_TYPES.includes(r.type));
  const frs = x.requirements.filter((r) => r.type === "FR");

  /* 要件 */
  add({
    key: "req.fr",
    area: "requirements",
    title: "機能要件がある",
    status: frs.length ? "ok" : "ng",
    detail: frs.length ? `${frs.length}件` : "機能要件がありません。ヒアリングか資料分析で要件を作ってください。",
    where: "ヒアリング",
  });
  const badEars = target.filter((r) => !r.ears || !lintEars(r.title, r.type).ok).map((r) => r.code);
  add({
    key: "req.ears",
    area: "requirements",
    title: "要件文が EARS の文型で、あいまいな言葉がない",
    status: badEars.length ? "warn" : "ok",
    detail: badEars.length ? `${badEars.length}件の文に問題があります（${list(badEars)}）。実装者・テスト担当者によって解釈が分かれます。` : `${target.length}件すべて問題ありません`,
    items: badEars,
    where: "要件一覧",
  });
  add({
    key: "req.questions",
    area: "requirements",
    title: "未決事項がない",
    status: x.openQuestions.length ? "warn" : "ok",
    detail: x.openQuestions.length ? `${x.openQuestions.length}件の未決事項があります。着手前に答えるか、担当者と期限を決めて引き渡してください。` : "ありません",
    items: x.openQuestions,
    where: "ヒアリング",
  });
  add({
    key: "req.nfr",
    area: "requirements",
    title: "非機能要件をすべて検討した",
    status: !x.nfr ? "ng" : x.nfr.errors ? "ng" : x.nfr.coverage < 1 ? "warn" : "ok",
    detail: !x.nfr
      ? "非機能要件シートがありません。性能・セキュリティ・運用などが決まらないまま実装すると、後で作り直しになります。"
      : x.nfr.errors
        ? `要対応の指摘が${x.nfr.errors}件あります。`
        : x.nfr.coverage < 1
          ? `検討済み ${Math.round(x.nfr.coverage * 100)}%。未検討：${list(x.nfr.undecided)}`
          : "すべて検討済みです",
    items: x.nfr?.undecided ?? [],
    where: "非機能要件",
  });

  /* 設計の材料 */
  const d = designCompleteness(x.uml);
  add({
    key: "design.model",
    area: "design",
    title: "設計モデル（クラス・シーケンス・状態）がある",
    status: d.classes ? "ok" : "ng",
    detail: d.classes ? `エンティティ ${d.classes}・項目 ${d.attributes}` : "設計モデルがありません。データ項目定義と権限表もここから作ります。",
    where: "UML",
  });
  if (d.classes) {
    const issues: string[] = [];
    if (d.withPk < d.classes) issues.push(`主キーのないエンティティが${d.classes - d.withPk}個`);
    if (d.enumWithoutValues) issues.push(`区分値のない区分項目が${d.enumWithoutValues}個`);
    if (d.uncoded) issues.push(`コード上の名前がない項目が${d.uncoded}個（古い設計モデルです。作り直すと付きます）`);
    add({
      key: "design.data",
      area: "design",
      title: "データ項目定義（キー・必須・桁や形式・区分値）がそろっている",
      status: issues.length ? "warn" : "ok",
      detail: issues.length ? `${issues.join("、")}。` : `${d.attributes}項目の定義があります`,
      where: "UML",
    });
    const actors = x.requirements.filter((r) => r.type === "AC").length;
    const needPerm = x.accessControl || actors >= 2;
    add({
      key: "design.permissions",
      area: "design",
      title: "権限表（誰がどのデータを登録・参照・更新・削除できるか）がある",
      status: d.permissions ? "ok" : needPerm ? "warn" : "ok",
      detail: d.permissions ? `${d.permissions}件の定義があります` : needPerm ? "利用者の役割が複数あるのに権限表がありません。設計モデルを作り直すと付きます。" : "役割が1つのため不要です",
      where: "UML",
    });
    const ifReqs = x.requirements.filter((r) => ["FR", "CN"].includes(r.type) && INTERFACE_WORDS.test(r.title)).map((r) => r.code);
    add({
      key: "design.interfaces",
      area: "design",
      title: "外部とのやり取り（連携先・方向・タイミング・データ）が整理されている",
      status: d.interfaces || !ifReqs.length ? "ok" : "warn",
      detail: d.interfaces ? `${d.interfaces}件` : ifReqs.length ? `外部とのやり取りを含みそうな要件（${list(ifReqs)}）がありますが、一覧がありません。` : "外部とのやり取りはなさそうです",
      items: d.interfaces ? [] : ifReqs,
      where: "UML",
    });
  }
  add({
    key: "design.screens",
    area: "design",
    title: "画面一覧が機能要件をカバーしている",
    status: !x.screens ? "warn" : x.screens.uncovered.length ? "warn" : "ok",
    detail: !x.screens ? "画面一覧がありません（画面のないシステムなら不要です）。" : x.screens.uncovered.length ? `どの画面にも結びつかない機能要件：${list(x.screens.uncovered)}` : "すべての機能要件が画面に結びついています",
    items: x.screens?.uncovered ?? [],
    where: "画面",
  });

  /* テスト */
  add({
    key: "test.tasks",
    area: "test",
    title: "タスク分解（受け入れ条件つき）が要件をカバーしている",
    status: !x.tasks ? "warn" : x.tasks.uncovered.length ? "warn" : "ok",
    detail: !x.tasks ? "タスク分解がありません。受け入れテストの材料になります。" : x.tasks.uncovered.length ? `ストーリーのない要件：${list(x.tasks.uncovered)}` : `${x.tasks.stories}ストーリー`,
    items: x.tasks?.uncovered ?? [],
    where: "実装連携",
  });
  add({
    key: "test.cases",
    area: "test",
    title: "すべての機能・非機能要件にテストケースがある",
    status: x.tests.untested.length ? "warn" : "ok",
    detail: x.tests.untested.length ? `テストケースのない要件：${list(x.tests.untested)}` : "要件ごとのテストケースがあります",
    items: x.tests.untested,
    where: "テスト・引き継ぎ",
  });
  add({
    key: "test.acceptance",
    area: "test",
    title: "機能要件に受け入れテスト（ストーリーの受け入れ条件）がある",
    status: !x.tasks || x.tests.withoutAcceptance.length ? "warn" : "ok",
    detail: !x.tasks
      ? "タスク分解をすると、ストーリーの受け入れ条件が受け入れテストになります。"
      : x.tests.withoutAcceptance.length
        ? `受け入れテストのない機能要件：${list(x.tests.withoutAcceptance)}`
        : "すべての機能要件にあります",
    items: x.tests.withoutAcceptance,
    where: "実装連携",
  });
  const undecided = [...x.tests.methodUndecided, ...x.tests.methodGuessed];
  add({
    key: "test.nfr",
    area: "test",
    title: "非機能要件の確認方法が決まっている",
    status: x.tests.methodUndecided.length ? "warn" : "ok",
    detail: x.tests.methodUndecided.length
      ? `確認方法が決まっていない非機能要件：${list(x.tests.methodUndecided)}`
      : x.tests.methodGuessed.length
        ? `文の言葉から推定したもの：${list(x.tests.methodGuessed)}（非機能要件シートから作ると確定します）`
        : "すべて決まっています",
    items: undecided,
    where: "非機能要件",
  });

  /* 管理 */
  add({
    key: "mgmt.baseline",
    area: "management",
    title: "要件定義の確定版がある",
    status: x.baselined ? "ok" : "warn",
    detail: x.baselined ? "確定版があります。以後の変更は影響分析を経て反映されます。" : "確定版がありません。引き渡す版を確定してください。",
    where: "変更管理",
  });
  add({
    key: "mgmt.changes",
    area: "management",
    title: "判断待ちの変更要求がない",
    status: x.pendingChanges.length ? "warn" : "ok",
    detail: x.pendingChanges.length ? `判断待ち：${list(x.pendingChanges)}` : "ありません",
    items: x.pendingChanges,
    where: "変更管理",
  });

  const stale = x.stale ?? [];
  add({
    key: "mgmt.stale",
    area: "management",
    title: "要件の変更が、画面・タスクに反映されている",
    status: stale.length ? "warn" : "ok",
    detail: stale.length ? `要件の変更後に作り直していないもの：${list(stale)}` : "反映されています（テストケースは要件から毎回作るため常に最新です）",
    items: stale,
    where: "画面",
  });

  const counts = { ok: 0, warn: 0, ng: 0 } as Record<ReadinessStatus, number>;
  for (const c of checks) counts[c.status]++;
  return {
    checks,
    counts,
    score: Math.round(((counts.ok + counts.warn * 0.5) / checks.length) * 100),
    verdict: counts.ng ? "not-ready" : counts.warn ? "conditional" : "ready",
  };
}
