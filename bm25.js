/**
 * BM25 检索引擎 + 题型分流策略。
 *
 * 来源：linghun-assembler/assemble.py（BEAM/100K 交叉验证固化的检索层）。
 * 三个已知缺陷及对应修复：
 *  1. 长文档惩罚：最新关键事实被长文档词频摊薄挤出 top-k → knowledge_update 类加时间保底；
 *  2. 时间保底无差别应用污染旧日期题 → 仅 knowledge_update 用 recent_safe，其他纯 BM25；
 *  3. 摘要/综合类 query 泛化、命中分散 → summarization 广覆盖（k=24）。
 */
const STOPWORDS = new Set(
  `a an and are as at be but by for if in into is it no not of on or such that the their then there these this to was will with i you your we our he she they them me my mine yours ours`.split(/\s+/),
);
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9_\-']*/g;

export function tokenize(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TOKEN_RE)) {
    const t = m[0].toLowerCase();
    if (!STOPWORDS.has(t) && t.length > 1) out.push(t);
  }
  return out;
}

/** 题型分流：检索策略按题型定制（BEAM 交叉验证 100K_1/100K_2 得出的泛化规律）。 */
export const STRATEGY = {
  // 知识更新类：最新数值最易被 BM25 长文档惩罚漏掉 → 时间保底
  knowledge_update: { k: 12, recentSafe: 6 },
  // 摘要/综合类：泛化 query 命中分散、要跨批次聚合 → 广覆盖
  summarization: { k: 24, recentSafe: 0 },
};

export class BM25 {
  constructor(docs, k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs.map((d) => tokenize(d));
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.N);
    const df = new Map();
    for (const d of this.docs) {
      for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.df = df;
    this.idf = new Map();
    for (const [t, f] of df) {
      this.idf.set(t, Math.log(1 + (this.N - f + 0.5) / (f + 0.5)));
    }
  }

  score(q, docIdx) {
    const doc = this.docs[docIdx];
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (f > 0) {
        const idf = this.idf.get(t) ?? 0;
        s += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / this.avgdl));
      }
    }
    return s;
  }

  /** 取 top-k 命中 + 可选时间保底（warm 为时间正序，最近 recentSafe 条强制并入）。 */
  top(query, k = 12, recentSafe = 0) {
    const q = tokenize(query);
    const ranked = [...Array(this.N).keys()].sort((a, b) => this.score(q, b) - this.score(q, a));
    const hit = ranked.filter((i) => this.score(q, i) > 0).slice(0, k);
    const recent = recentSafe > 0 ? [...Array(Math.min(recentSafe, this.N)).keys()].map((i) => this.N - 1 - i) : [];
    return [...new Set([...hit, ...recent])];
  }
}

/** 按题型取检索参数；未命中 STRATEGY 的题型纯 BM25 top-k（默认 12）。 */
export function retrievalParams(category, defaults = { k: 12, recentSafe: 0 }) {
  const s = STRATEGY[category];
  if (!s) return { k: defaults.k ?? 12, recentSafe: 0 };
  return { k: s.k, recentSafe: s.recentSafe };
}
