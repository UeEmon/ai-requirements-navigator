/** 数値化を促すべき曖昧な表現（機能 F2-4） */
const VAGUE_TERMS: Record<string, string> = {
  速い: "何秒以内か",
  早く: "いつまでか、何秒以内か",
  たくさん: "何件・何人か",
  大量: "何件・何GBか",
  なるべく: "必須か、努力目標か",
  できるだけ: "必須か、努力目標か",
  適宜: "誰が、いつ行うか",
  簡単: "誰が、何分でできればよいか",
  使いやすい: "誰が、どの操作を、何分でできればよいか",
  安全: "何から何を守るか",
  すぐ: "何秒・何分以内か",
  柔軟: "何を変えられればよいか",
};

export interface AmbiguityHit {
  term: string;
  ask: string;
  index: number;
}

export function detectAmbiguity(text: string): AmbiguityHit[] {
  const hits: AmbiguityHit[] = [];
  for (const [term, ask] of Object.entries(VAGUE_TERMS)) {
    let i = text.indexOf(term);
    while (i >= 0) {
      hits.push({ term, ask, index: i });
      i = text.indexOf(term, i + term.length);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
