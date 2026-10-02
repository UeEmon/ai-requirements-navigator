/** 専門用語の標準の解説。AIが返す解説と合わせて画面に表示する */
export interface GlossaryEntry {
  term: string;
  explanation: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: "要件", explanation: "システムが満たすべき条件。「何ができるか」「どのくらいの品質か」を決めたもの。" },
  { term: "要求", explanation: "利用者がシステムに望むこと。整理・具体化したものが要件になる。" },
  { term: "業務フロー", explanation: "仕事が始まってから終わるまでの手順の流れ。" },
  { term: "機能要件", explanation: "システムが「何をするか」の条件。例：予約を登録できる。" },
  { term: "非機能要件", explanation: "機能以外の品質の条件。速さ、止まらなさ、安全性、使いやすさなど。" },
  { term: "制約条件", explanation: "予算・期限・既存システム・法令など、選択肢を狭める前提条件。" },
  { term: "稼働率", explanation: "システムが使える状態にある時間の割合。99.5%なら月に約3.6時間まで停止を許容する。" },
  { term: "可用性", explanation: "止まらずに使い続けられること。稼働率で表すことが多い。" },
  { term: "排他制御", explanation: "同じデータを2人が同時に更新しても、矛盾が起きないようにする仕組み。" },
  { term: "認証", explanation: "利用者が本人であることを確認すること。ログインなど。" },
  { term: "権限", explanation: "利用者ごとに、見られる情報やできる操作を決めること。" },
  { term: "バックアップ", explanation: "障害に備えてデータの写しを別の場所に保存しておくこと。" },
  { term: "応答時間", explanation: "操作してから結果が表示されるまでの時間。" },
  { term: "リマインド", explanation: "予定を忘れないよう、事前に自動でお知らせすること。" },
  { term: "マスタ", explanation: "商品・顧客・社員など、業務で繰り返し使う基本情報の一覧。" },
  { term: "帳票", explanation: "請求書・一覧表など、印刷やファイルで出力する書類。" },
  { term: "CSV", explanation: "表計算ソフトで開ける、カンマ区切りのデータファイル。" },
  { term: "API", explanation: "システム同士がデータをやり取りするための窓口。" },
  { term: "個人情報", explanation: "氏名・連絡先など、特定の個人を識別できる情報。法令で取り扱いが定められている。" },
  { term: "暗号化", explanation: "データを第三者に読まれないよう、鍵がないと読めない形に変換すること。" },
];

/** 文章に出てくる用語の解説を集める（長い用語を優先、重複なし） */
export function findGlossary(texts: string[], extra: GlossaryEntry[] = []): GlossaryEntry[] {
  const all = [...extra, ...GLOSSARY].filter((e, i, a) => a.findIndex((x) => x.term === e.term) === i);
  // 長い用語から順に照合し、照合した部分は消す（「非機能要件」の中の「機能要件」を拾わない）
  let rest = texts.join("\n");
  const out: GlossaryEntry[] = [];
  for (const e of all.filter((x) => x.term).sort((a, b) => b.term.length - a.term.length)) {
    if (!rest.includes(e.term)) continue;
    out.push(e);
    rest = rest.split(e.term).join("\u0000");
  }
  return out;
}
