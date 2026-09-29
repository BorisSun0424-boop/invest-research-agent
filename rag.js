/* ============================================================
 * rag.js —— 私有知识库检索链路
 *   解析 → 分块(chunk) → 向量化(embedding) → 混合检索(BM25 + 向量, RRF 融合)
 *   → 重排(rerank: 覆盖度 + 来源权威性 + 时效性 + 命中密度)
 * 说明：向量化使用本地 bigram hashing embedding（128 维），
 *       真实环境替换为 embedding API 即可，链路结构不变。
 * ============================================================ */

const RAG = {
  chunks: [],
  docs: [],
  built: false,
  stats: {},

  /* ---------- 1. 分词：中文单字 + bigram，英文/数字保留原词 ---------- */
  tokenize(text) {
    const t = [];
    const s = String(text || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
    for (const w of s.split(' ').filter(Boolean)) {
      if (/^[a-z0-9]+$/.test(w)) { t.push(w); continue; }
      for (const ch of w) t.push(ch);
      for (let i = 0; i < w.length - 1; i++) t.push(w.slice(i, i + 2));
    }
    return t;
  },
  bigrams(text) {
    const s = String(text || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
    const out = [];
    for (const w of s.split(' ').filter(Boolean)) {
      if (/^[a-z0-9]+$/.test(w)) { out.push(w); continue; }
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
    return out;
  },

  /* ---------- 2. 文档解析 → 分块（句级滑窗 + 重叠） ---------- */
  chunkText(text, opts = {}) {
    const minLen = opts.minLen || 120, maxLen = opts.maxLen || 260;
    const sentences = String(text).match(/[^。！？；\n]+[。！？；\n]?/g) || [String(text)];
    const out = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > maxLen && buf.length >= minLen) {
        out.push(buf);
        // overlap：保留上一块末尾一句，避免跨块语义断裂
        const parts = buf.match(/[^。！？；]+[。！？；]?/g) || [buf];
        const tail = parts.filter(Boolean).slice(-1)[0] || '';
        buf = (tail.length < 120 ? tail : '') + s;
      } else {
        buf += s;
      }
    }
    if (buf.trim()) out.push(buf);
    return out;
  },

  /* ---------- 3. 向量化：bigram hashing → 128 维，L2 归一 ---------- */
  DIM: 128,
  embed(text) {
    const v = new Array(this.DIM).fill(0);
    const bg = this.bigrams(text);
    for (const g of bg) {
      let h = 2166136261;
      for (let i = 0; i < g.length; i++) { h ^= g.charCodeAt(i); h = Math.imul(h, 16777619); }
      const idx = Math.abs(h) % this.DIM;
      v[idx] += 1;
    }
    // 亚线性 tf 平滑
    for (let i = 0; i < this.DIM; i++) if (v[i] > 0) v[i] = 1 + Math.log(v[i]);
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map(x => x / norm);
  },
  cosine(a, b) {
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  },

  /* ---------- 4. 建索引 ---------- */
  build() {
    const t0 = performance.now();
    this.chunks = [];
    let id = 0;
    for (const d of DOCS) {
      const parts = this.chunkText(d.text);
      parts.forEach((p, i) => {
        const toks = this.tokenize(p);
        this.chunks.push({
          cid: 'c' + (++id),
          docId: d.id, title: d.title, type: d.type, source: d.source,
          date: d.date, weight: d.weight, tags: d.tags,
          idx: i, total: parts.length,
          text: p, tokens: toks, len: toks.length,
          vec: this.embed(p), tf: this._tf(toks)
        });
      });
    }
    // BM25 全局统计
    const N = this.chunks.length;
    const df = {};
    for (const c of this.chunks) for (const t of new Set(c.tokens)) df[t] = (df[t] || 0) + 1;
    this.df = df; this.N = N;
    this.avgLen = this.chunks.reduce((a, c) => a + c.len, 0) / (N || 1);
    this.idf = {};
    for (const t in df) this.idf[t] = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
    this.built = true;
    const days = DOCS.map(d => (new Date('2026-09-25') - new Date(d.date)) / 86400000);
    this.stats = {
      文档数: DOCS.length, 切片数: this.chunks.length, 向量维度: this.DIM,
      平均块长: Math.round(this.chunks.reduce((a, c) => a + c.text.length, 0) / (this.chunks.length || 1)),
      词表规模: Object.keys(df).length,
      最新文档: DOCS.map(d => d.date).sort().slice(-1)[0],
      最旧文档: DOCS.map(d => d.date).sort()[0],
      平均文档年龄_天: Math.round(days.reduce((a, b) => a + b, 0) / days.length),
      建库耗时_ms: Math.round(performance.now() - t0)
    };
    return this.stats;
  },
  _tf(toks) { const m = {}; for (const t of toks) m[t] = (m[t] || 0) + 1; return m; },

  /* ---------- 5. BM25 ---------- */
  bm25(queryTokens, topN = 20) {
    const k1 = 1.5, b = 0.75;
    const scores = this.chunks.map(c => {
      let s = 0;
      const qt = new Set(queryTokens);
      for (const t of qt) {
        const tf = c.tf[t] || 0;
        if (!tf) continue;
        const idf = this.idf[t] || 0;
        s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * c.len / this.avgLen));
      }
      return { c, s };
    });
    return scores.sort((a, b) => b.s - a.s).slice(0, topN);
  },

  /* ---------- 6. 向量检索 ---------- */
  vector(query, topN = 20) {
    const qv = this.embed(query);
    return this.chunks
      .map(c => ({ c, s: this.cosine(qv, c.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, topN);
  },

  /* ---------- 7. 主检索：混合 → RRF → 重排 ---------- */
  search(query, topK = 5) {
    if (!this.built) this.build();
    const t0 = performance.now();
    const qt = this.tokenize(query);
    const qbg = new Set(this.bigrams(query));

    const bmL = this.bm25(qt, 20);
    const vcL = this.vector(query, 20);

    // RRF 融合
    const K = 60;
    const cand = new Map();
    bmL.forEach((r, i) => { const e = cand.get(r.c.cid) || { c: r.c, bm25: 0, vec: 0, rrf: 0 }; e.bm25 = r.s; e.rrf += 1 / (K + i + 1); e.rank_bm25 = i + 1; cand.set(r.c.cid, e); });
    vcL.forEach((r, i) => { const e = cand.get(r.c.cid) || { c: r.c, bm25: 0, vec: 0, rrf: 0 }; e.vec = r.s; e.rrf += 1 / (K + i + 1); e.rank_vec = i + 1; cand.set(r.c.cid, e); });

    const merged = [...cand.values()].sort((a, b) => b.rrf - a.rrf).slice(0, 10);
    merged.forEach((e, i) => e.rank_fused = i + 1);

    // 重排（cross-encoder 模拟）
    const now = new Date('2026-09-25');
    for (const e of merged) {
      const ct = new Set(e.c.tf ? Object.keys(e.c.tf) : []);
      let hit = 0; for (const g of qbg) if (ct.has(g)) hit++;
      const coverage = qbg.size ? hit / qbg.size : 0;
      const age = Math.max(0, (now - new Date(e.c.date)) / 86400000);
      const recency = 0.55 + 0.45 * Math.exp(-age / 420);
      const authority = e.c.weight;
      const density = Math.min(1, hit / Math.max(1, e.c.len * 0.18));
      const phrase = e.c.text.includes(query.slice(0, 6)) && query.length >= 6 ? 0.06 : 0;
      e.detail = {
        覆盖度: +coverage.toFixed(3), 来源权威性: +authority.toFixed(2),
        时效性: +recency.toFixed(3), 命中密度: +density.toFixed(3), 短语加成: +phrase.toFixed(2)
      };
      e.rerank = +(0.40 * coverage + 0.25 * authority + 0.20 * recency + 0.15 * density + phrase).toFixed(4);
    }
    const reranked = merged.slice().sort((a, b) => b.rerank - a.rerank).slice(0, topK);
    reranked.forEach((e, i) => e.rank_final = i + 1);

    return {
      query,
      pipeline: {
        分词数: qt.length, BM25候选: bmL.length, 向量候选: vcL.length,
        RRF候选: merged.length, 重排后: reranked.length,
        top1向量相似度: +(vcL[0] ? vcL[0].s : 0).toFixed(3),
        top1BM25: +(bmL[0] ? bmL[0].s : 0).toFixed(3),
        耗时_ms: Math.round(performance.now() - t0)
      },
      hits: reranked.map(e => ({
        cid: e.c.cid, docId: e.c.docId, title: e.c.title, type: e.c.type, source: e.c.source,
        date: e.c.date, tags: e.c.tags, idx: e.c.idx, total: e.c.total,
        text: e.c.text,
        scores: {
          bm25: +e.bm25.toFixed(3), vector: +e.vec.toFixed(3), rrf: +e.rrf.toFixed(4), rerank: e.rerank
        },
        detail: e.detail,
        ranks: { bm25: e.rank_bm25 || '-', vector: e.rank_vec || '-', fused: e.rank_fused, final: e.rank_final },
        moved: (e.rank_fused || 99) - e.rank_final
      })),
      allFused: merged.map(e => ({
        cid: e.c.cid, title: e.c.title, text: e.c.text.slice(0, 60) + '…',
        rrf: +e.rrf.toFixed(4), rerank: e.rerank
      }))
    };
  },

  /* ---------- 8. 高亮 ---------- */
  highlight(text, query) {
    let html = String(text).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    const terms = [...new Set(this.bigrams(query))].filter(g => g.length >= 2).slice(0, 40);
    terms.sort((a, b) => b.length - a.length);
    for (const t of terms) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      html = html.replace(re, m => '\u0001' + m + '\u0002');
    }
    return html.replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
  }
};
