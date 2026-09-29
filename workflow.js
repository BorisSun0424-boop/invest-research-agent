/* ============================================================
 * workflow.js —— 定时任务编排 + 每日简报生成 + Human-in-the-loop
 *   抓取 → 去重 → 聚类 → 摘要 → 简报初稿 → 人工审校 → 发布留痕
 * 设计要点：
 *   · AI 只产出「初稿」，未经过研究员确认不得标记为已发布
 *   · 每个段落可单独 采纳 / 修改 / 驳回，驳回即进入 Bad Case 池
 *   · 全过程留痕：状态流转、编辑 diff、发布人与时间
 * ============================================================ */

const Workflow = {
  config: {
    name: '每日行业动态监控',
    cron: '0 7 * * 1-5',
    cronText: '工作日 07:00',
    lookback: 10,
    subs: JSON.parse(JSON.stringify(DEFAULT_SUBSCRIPTIONS)),
    pushChannel: '企业微信「投研晨会」群',
    autoPublish: false,       // 默认关闭：强调 HITL
    enabled: true
  },
  runs: [],
  briefs: [],
  badCases: [],
  seq: 0,

  /* ---------- 文本相似度（标题去重） ---------- */
  sim(a, b) {
    const g = s => new Set(RAG.bigrams(s));
    const A = g(a), B = g(b);
    let inter = 0; for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter || 1);
  },
  normUrl(u) { return String(u || '').replace(/[?#].*$/, '').replace(/\/$/, ''); },

  /* ---------- 主流程 ---------- */
  async trigger(onStage) {
    const runId = 'run-' + (++this.seq).toString().padStart(3, '0');
    const t0 = performance.now();
    const stages = [];
    const stage = async (name, fn) => {
      if (onStage) onStage({ runId, name, status: 'running' });
      const s = performance.now();
      const out = await fn();
      const rec = { name, ms: Math.round(performance.now() - s), ...out };
      stages.push(rec);
      if (onStage) onStage({ runId, name, status: 'done', rec });
      return rec;
    };

    const enabledSectors = this.config.subs.filter(s => s.enabled).map(s => s.sector);
    const date = new Date().toISOString().slice(0, 10);

    /* Stage 1 —— 抓取 */
    const fetched = await stage('抓取', async () => {
      const all = [];
      for (const sec of enabledSectors) {
        const kw = (this.config.subs.find(s => s.sector === sec) || {}).keywords || [];
        const r = await invoke('search_news', { sector: sec, days: this.config.lookback });
        if (r.status === 'ok') (r.result.items || []).forEach(n => all.push({ ...n, _sector: n.sector === '宏观' ? '宏观' : sec, _kw: kw }));
      }
      return { 条数: all.length, 赛道: enabledSectors.length, data: all };
    });

    /* Stage 2 —— 去重（URL 归一 + 标题相似度） */
    const dedup = await stage('去重', async () => {
      const items = fetched.data.slice().sort((a, b) => b.date.localeCompare(a.date));
      const kept = [], dropped = [], pairs = [];
      const byUrl = {};
      for (const it of items) {
        const u = this.normUrl(it.url);
        if (byUrl[u]) { dropped.push({ ...it, 原因: '同源 URL' }); pairs.push([byUrl[u].id, it.id, 'URL 一致']); continue; }
        const dup = kept.find(k => this.sim(k.title, it.title) >= 0.6);
        if (dup) { dropped.push({ ...it, 原因: `与《${dup.title.slice(0, 18)}…》标题相似度 ${this.sim(dup.title, it.title).toFixed(2)}` }); pairs.push([dup.id, it.id, this.sim(dup.title, it.title).toFixed(2)]); continue; }
        byUrl[u] = it; kept.push(it);
      }
      return { 原始: items.length, 保留: kept.length, 剔除: dropped.length, pairs, data: kept };
    });

    /* Stage 3 —— 聚类与情绪统计 */
    const cluster = await stage('聚类', async () => {
      const groups = {};
      for (const it of dedup.data) (groups[it._sector] = groups[it._sector] || []).push(it);
      const summary = Object.entries(groups).map(([sec, list]) => ({
        sector: sec, count: list.length,
        pos: list.filter(n => n.sentiment === 'positive').length,
        neg: list.filter(n => n.sentiment === 'negative').length,
        neu: list.filter(n => n.sentiment === 'neutral').length,
        items: list
      }));
      return { 赛道数: summary.length, data: summary, dropped: dedup.剔除 || 0 };
    });

    /* Stage 4 —— 知识库佐证检索 */
    const evidence = await stage('佐证检索', async () => {
      const out = {};
      for (const g of cluster.data) {
        if (g.sector === '宏观') continue;
        const r = await invoke('search_research_reports', { query: g.sector + ' ' + g.items.map(i => i.tag).join(' '), topK: 3 });
        out[g.sector] = r.status === 'ok' ? r.result.hits : [];
      }
      return { 赛道: Object.keys(out).length, data: out };
    });

    /* Stage 5 —— 简报初稿生成 */
    const draft = await stage('生成初稿', async () => {
      const sections = this.composeSections(date, cluster.data, evidence.data);
      return { 段落数: sections.length, data: sections };
    });

    const totalMs = Math.round(performance.now() - t0);
    const run = { id: runId, date, ts: new Date(), stages, ms: totalMs, 状态: '初稿已生成' };
    this.runs.push(run);

    const brief = {
      id: 'BR-' + date.replace(/-/g, '') + '-' + runId.slice(-3),
      runId, date,
      status: 'draft',                 // draft → reviewing → published / rejected
      sections: draft.data,
      stats: {
        抓取: fetched.条数, 去重剔除: dedup.剔除, 有效: dedup.保留,
        赛道: cluster.赛道数, 佐证片段: Object.values(evidence.data).reduce((a, b) => a + b.length, 0),
        耗时_ms: totalMs
      },
      meta: { 生成人: 'AI Agent', 复核人: null, 发布时间: null, 版本: 1 },
      history: [{ ts: new Date(), by: 'AI Agent', action: '生成初稿', note: `${draft.段落数} 个段落` }],
      edits: []
    };
    this.briefs.unshift(brief);
    return { run, brief };
  },

  /* ---------- 简报段落生成 ---------- */
  composeSections(date, groups, evid) {
    const secs = [];

    // 概览
    const total = groups.reduce((a, g) => a + g.count, 0);
    const pos = groups.reduce((a, g) => a + g.pos, 0);
    const neg = groups.reduce((a, g) => a + g.neg, 0);
    const macro = (groups.find(g => g.sector === '宏观') || { items: [] }).items;
    secs.push({
      id: 's0', title: '今日概览', type: 'overview', editable: true,
      text: `截至 ${date}，订阅赛道共抓取 ${total} 条有效信息（已去重），其中正面 ${pos} 条、负面 ${neg} 条。宏观侧：${macro.length ? macro.map(m => m.title.replace(/^.*?：/, '').slice(0, 40)).join('；') : '无重大宏观增量'}。${neg > 0 ? '需重点跟踪负面事项的持续性。' : '暂无明显负面冲击。'}`,
      cites: macro.map(m => ({ title: m.title, source: m.source, date: m.date, text: m.body })),
      confidence: 0.62
    });

    // 各赛道
    for (const g of groups) {
      if (g.sector === '宏观') continue;
      const ev = evid[g.sector] || [];
      const chain = CHAINS[g.sector];
      const bullets = g.items.slice(0, 4).map(it =>
        `· [${it.date}｜${it.source}] ${it.title}${it.sentiment === 'negative' ? '（负面）' : (it.sentiment === 'positive' ? '（正面）' : '')}`
      ).join('\n');
      const evText = ev.length
        ? `知识库佐证：${ev.map(e => `《${e.title}》${e.date}`).join('；')}。`
        : '知识库佐证：本次未命中相关材料，建议补充入库后再下判断。';
      const chainText = chain ? `环节提示：${chain.note}` : '';
      secs.push({
        id: 's-' + g.sector, title: g.sector, type: 'sector', editable: true,
        badge: { 条数: g.count, 正面: g.pos, 负面: g.neg },
        text: `${bullets}\n${evText}\n${chainText}`,
        cites: ev.map(e => ({ title: e.title, source: e.source, date: e.date, text: e.text, scores: e.scores })),
        confidence: ev.length ? Math.min(0.92, 0.45 + ev[0].scores.rerank * 0.55) : 0.35
      });
    }

    // 人工复核项
    secs.push({
      id: 's-rev', title: '需人工复核事项', type: 'review', editable: true,
      text: `1) 负面信息是否需要单独跟踪：本期负面 ${neg} 条，是否构成趋势性变化需研究员判断；\n2) 转载类信息已按标题相似度去重，若存在"同源改写"仍可能漏网；\n3) 涉及订单/定点类消息，需区分"预期订单"与"已确认收入"；\n4) 本简报由 AI 生成初稿，未经研究员确认不得对外发布。`,
      cites: [], confidence: 0.30
    });
    return secs;
  },

  /* ---------- HITL 操作 ---------- */
  markSection(briefId, secId, action, payload = {}) {
    const b = this.briefs.find(x => x.id === briefId);
    if (!b) return;
    const s = b.sections.find(x => x.id === secId);
    if (!s) return;
    if (action === 'accept') {
      s.review = 'accepted';
      b.history.push({ ts: new Date(), by: '研究员', action: '采纳段落', note: s.title });
    } else if (action === 'edit') {
      const before = s.text;
      s.text = payload.text;
      s.review = 'edited';
      b.edits.push({ secId, title: s.title, before, after: s.text, ts: new Date() });
      b.history.push({ ts: new Date(), by: '研究员', action: '修改段落', note: `${s.title}（+${Math.max(0, s.text.length - before.length)} 字）` });
    } else if (action === 'reject') {
      s.review = 'rejected';
      this.badCases.unshift({
        id: 'bc-' + Date.now(), ts: new Date(), briefId, section: s.title,
        type: '简报段落驳回', reason: payload.reason || '未提供',
        original: s.text.slice(0, 160), status: '待复盘'
      });
      b.history.push({ ts: new Date(), by: '研究员', action: '驳回段落', note: `${s.title}：${payload.reason || '未提供'}` });
    }
    return b;
  },

  publish(briefId, reviewer) {
    const b = this.briefs.find(x => x.id === briefId);
    if (!b) return { ok: false, msg: '简报不存在' };
    const rejected = b.sections.filter(s => s.review === 'rejected').length;
    const pending = b.sections.filter(s => !s.review).length;
    if (pending > 0) return { ok: false, msg: `仍有 ${pending} 个段落未审校，发布前需逐段确认` };
    if (rejected > 0) return { ok: false, msg: `存在 ${rejected} 个被驳回段落，需修改或删除后再发布` };
    b.status = 'published';
    b.meta.复核人 = reviewer || '研究员';
    b.meta.发布时间 = new Date();
    b.meta.版本 += 1;
    b.history.push({ ts: new Date(), by: reviewer || '研究员', action: '确认发布', note: `推送至 ${this.config.pushChannel}` });
    return { ok: true, msg: `已发布并推送至 ${this.config.pushChannel}` };
  },

  /* ---------- 下次执行时间 ---------- */
  nextRun() {
    const now = new Date();
    const d = new Date(now); d.setHours(7, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }
};
