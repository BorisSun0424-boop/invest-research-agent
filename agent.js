/* ============================================================
 * agent.js —— Agent 编排层
 *   意图识别 → 实体抽取 → 工具调用计划(Plan) → 多步执行 →
 *   引用溯源 → 置信度评分 → 结构化回答生成
 * 关键设计：
 *   · Plan 与 Execute 分离：先出可解释的计划（用户可见），再逐步执行
 *   · 每条结论必须绑定 citation，引用来自工具返回的原文片段
 *   · 置信度可拆解为因子，低于阈值时明确提示"需人工复核"，不硬给结论
 * ============================================================ */

const Agent = {

  /* ---------- 意图规则表 ---------- */
  INTENT_RULES: [
    { id: 'valuation',  label: '估值测算',   kw: ['估值', '贵', '便宜', '多少钱', '目标价', '合理', 'pe', 'ps', '市值', '空间'], tools: ['get_market_quote', 'calc_valuation'] },
    { id: 'chain',      label: '产业链梳理', kw: ['产业链', '上下游', '格局', '国产化', '竞争', '环节', '渗透率'], tools: ['get_industry_chain'] },
    { id: 'news',       label: '动态监控',   kw: ['新闻', '最近', '动态', '消息', '公告', '发生了', '怎么了', '跟踪'], tools: ['search_news'] },
    { id: 'compare',    label: '同业对比',   kw: ['对比', '比较', '横向', '同业', '谁更', '排名'], tools: ['compare_peers'] },
    { id: 'brief',      label: '生成简报',   kw: ['简报', '日报', '晨会', '汇总', '总结今日', '盘前'], tools: [] },
    { id: 'research',   label: '研报观点',   kw: ['研报', '观点', '怎么看', '逻辑', '风险', '纪要', '深度', '为什么', '依据', '原因'], tools: ['search_research_reports'] },
    { id: 'fundamentals', label: '基本面',   kw: ['财务', '业绩', '营收', '利润', '毛利率', 'roe', '现金流', '半年报', '年报', '基本面', '经营'], tools: ['get_financials', 'get_market_quote'] },
    { id: 'profile',    label: '公司画像',   kw: ['做什么', '主营', '公司', '背景', '股东', '客户', '是谁'], tools: ['get_company_profile'] }
  ],

  /* ---------- 实体抽取 ---------- */
  extractEntities(q) {
    const companies = [];
    for (const c of UNIVERSE) {
      if (q.includes(c.name) || q.includes(c.code) || q.includes(c.code.split('.')[0])) companies.push(c);
    }
    const sectors = SECTORS.filter(s => q.includes(s) || (CHAINS[s] && companies.some(c => c.sector === s)));
    // 兜底：问题里没点名公司但点了赛道，取该赛道代表标的
    const sectorOnly = SECTORS.filter(s => q.includes(s));
    return { companies, sectors: [...new Set([...sectors, ...sectorOnly])] };
  },

  /* ---------- 意图识别 ---------- */
  classify(q) {
    const scored = this.INTENT_RULES.map(r => {
      const hits = r.kw.filter(k => q.toLowerCase().includes(k));
      return { ...r, hits, score: hits.length };
    }).sort((a, b) => b.score - a.score);
    const primary = scored[0].score > 0 ? scored[0] : { id: 'research', label: '研报观点', tools: ['search_research_reports'] };
    const secondary = scored.filter(s => s.score > 0 && s.id !== primary.id).slice(0, 2);
    return { primary, secondary, all: scored.filter(s => s.score > 0) };
  },

  /* ---------- 计划编排 ---------- */
  plan(q) {
    const ent = this.extractEntities(q);
    const cls = this.classify(q);
    const c = ent.companies[0];
    const sector = ent.sectors[0] || (c ? c.sector : null);

    const steps = [];
    const seen = new Set();
    const add = (tool, args, reason) => {
      if (seen.has(tool)) return;
      seen.add(tool);
      steps.push({ tool, args, reason });
    };

    // 1) 主意图工具
    for (const t of cls.primary.tools) {
      if (t === 'search_research_reports') add(t, { query: q, topK: 5 }, '检索私有研报/年报/纪要，作为结论依据');
      else if (t === 'get_industry_chain') add(t, { sector: sector || '半导体设备' }, '拉取产业链环节与竞争格局');
      else if (t === 'search_news') add(t, { sector: sector || undefined, keywords: this._newsKw(q, c), days: 30 }, '检索近 30 天新闻与公告');
      else if (t === 'compare_peers') add(t, { sector: sector || undefined }, '同业横向对比关键指标');
      else if (t === 'calc_valuation') add(t, { name: c ? c.name : (ent.companies[0] || {}).name, method: /ps|ARR/i.test(q) ? (/arr/i.test(q) ? 'ARR' : 'PS') : 'PE' }, '按情景倍数测算对应股价');
      else add(t, { name: c ? c.name : null, period: /半年|H1|中报/.test(q) ? '2026H1' : (/2025|年报/.test(q) ? '2025A' : undefined) }, '获取核心财务与行情数据');
    }
    // 2) 补充上下文
    if (c && !seen.has('get_market_quote')) add('get_market_quote', { name: c.name }, '补充最新价与估值分位');
    if (c && cls.primary.id !== 'profile' && !seen.has('get_company_profile')) add('get_company_profile', { name: c.name }, '确认主营与客户结构');
    if (!seen.has('search_research_reports')) add('search_research_reports', { query: q, topK: 4 }, '补充研报与公告依据');
    // 3) 过滤掉缺少必要参数的步骤
    return {
      intent: cls.primary, secondary: cls.secondary.map(s => s.label),
      entities: ent, steps: steps.filter(s => {
        const need = TOOLS[s.tool].params.filter(p => p.required).map(p => p.name);
        return need.every(n => s.args[n] !== undefined && s.args[n] !== null && s.args[n] !== '');
      })
    };
  },
  _newsKw(q, c) {
    const kw = [];
    if (c) kw.push(c.name);
    for (const k of ['订单', '扩产', '价格', '加工费', '减值', '回购', '定增', '政策', '库存', '认证']) if (q.includes(k)) kw.push(k);
    return kw.length ? kw : undefined;
  },

  /* ---------- 执行 ---------- */
  async run(q, onStep) {
    const p = this.plan(q);
    const executed = [];
    for (const s of p.steps) {
      if (onStep) onStep({ type: 'step', step: s });
      const rec = await invoke(s.tool, s.args);
      executed.push({ ...s, rec });
      if (onStep) onStep({ type: 'done', step: s, rec });
    }
    const result = this.synthesize(q, p, executed);
    if (onStep) onStep({ type: 'final', result });
    return { plan: p, executed, ...result };
  },

  /* ---------- 置信度评分 ---------- */
  confidence(executed) {
    const ok = executed.filter(e => e.rec.status === 'ok');
    const success = executed.length ? ok.length / executed.length : 0;

    const rag = ok.find(e => e.tool === 'search_research_reports');
    const hits = rag ? rag.rec.result.hits : [];
    const top1 = hits.length ? hits[0].scores.rerank : 0;
    const retrieval = hits.length ? Math.min(1, top1 * 1.35) : 0;      // 重排分 → 0~1
    const citeCover = Math.min(1, hits.length / 4);

    const dates = [];
    hits.forEach(h => dates.push(h.date));
    const news = ok.find(e => e.tool === 'search_news');
    if (news) (news.rec.result.items || []).forEach(n => dates.push(n.date));
    const latest = dates.sort().slice(-1)[0];
    const age = latest ? (new Date('2026-09-25') - new Date(latest)) / 86400000 : 999;
    const recency = age > 180 ? 0.35 : (age > 90 ? 0.6 : (age > 30 ? 0.8 : 1));

    const structured = ok.filter(e => ['get_financials', 'get_market_quote', 'calc_valuation', 'compare_peers', 'get_industry_chain'].includes(e.tool)).length;
    const structScore = Math.min(1, structured / 2);

    const factors = [
      { name: '检索质量（重排 top1）', weight: 0.30, value: +retrieval.toFixed(3), note: hits.length ? `top1 重排分 ${top1}，命中 ${hits.length} 段` : '未命中知识库' },
      { name: '引用覆盖度', weight: 0.20, value: +citeCover.toFixed(3), note: `引用片段 ${hits.length} 条（满额 4 条）` },
      { name: '工具调用成功率', weight: 0.20, value: +success.toFixed(3), note: `${ok.length}/${executed.length} 个工具成功返回` },
      { name: '数据时效性', weight: 0.15, value: +recency.toFixed(3), note: latest ? `最新数据 ${latest}，距今 ${Math.round(age)} 天` : '无时效数据' },
      { name: '结构化数据支撑', weight: 0.15, value: +structScore.toFixed(3), note: `${structured} 个结构化数据源（财务/行情/产业链/估值）` }
    ];
    const score = factors.reduce((a, f) => a + f.weight * f.value, 0);
    const level = score >= 0.75 ? 'high' : (score >= 0.55 ? 'mid' : 'low');
    return {
      score: +score.toFixed(3),
      level,
      levelText: { high: '高（可直接引用）', mid: '中（建议复核关键数字）', low: '低（需人工判断，勿直接对外）' }[level],
      factors,
      latest
    };
  },

  /* ---------- 回答生成 ---------- */
  synthesize(q, plan, executed) {
    const ok = executed.filter(e => e.rec.status === 'ok');
    const get = t => { const e = ok.find(x => x.tool === t); return e ? e.rec.result : null; };
    const c = plan.entities.companies[0];
    const sector = plan.entities.sectors[0] || (c ? c.sector : null);
    const rag = get('search_research_reports');
    const hits = rag ? rag.hits : [];

    const citations = hits.map((h, i) => ({
      n: i + 1, title: h.title, type: h.type, source: h.source, date: h.date,
      text: h.text, scores: h.scores, detail: h.detail, ranks: h.ranks, moved: h.moved, cid: h.cid
    }));

    const sections = [];
    const id = plan.intent.id;

    /* —— 通用：一句话结论 —— */
    sections.push({ type: 'conclusion', title: '核心结论', body: this._conclusion(id, c, sector, ok, hits) });

    /* —— 数据块 —— */
    const fin = get('get_financials'), qt = get('get_market_quote');
    if (fin || qt) {
      const rows = [];
      if (qt) rows.push(['最新价 / 涨跌', `${qt.quote.price} 元（${qt.quote.chg >= 0 ? '+' : ''}${qt.quote.chg}%）`], ['总市值 / PE-TTM', `${qt.quote.mktcap} 亿 / ${qt.quote.pe_ttm}x`], ['PB / PS', `${qt.quote.pb}x / ${qt.quote.ps}x`]);
      if (fin) {
        const d = fin.data;
        rows.push([`${fin.period} 营收`, `${d.营收} 亿（${d.营收同比 >= 0 ? '+' : ''}${d.营收同比}%）`],
                  [`${fin.period} 归母净利`, `${d.归母净利} 亿（${d.净利同比 >= 0 ? '+' : ''}${d.净利同比}%）`],
                  ['毛利率 / 净利率', `${d.毛利率}% / ${d.净利率}%`],
                  ['ROE / 资产负债率', `${d.ROE}% / ${d.资产负债率}%`],
                  ['经营性现金流 / 合同负债', `${d.经营现金流} 亿 / ${d.合同负债} 亿`]);
      }
      sections.push({ type: 'table', title: '关键数据', rows });
    }

    const news = get('search_news');
    if (news && news.items && news.items.length) {
      sections.push({
        type: 'news', title: `近期动态（${news.items.length} 条）`,
        items: news.items.slice(0, 6).map(n => ({ date: n.date, source: n.source, title: n.title, sentiment: n.sentiment, tag: n.tag }))
      });
    }

    const chain = get('get_industry_chain');
    if (chain) {
      sections.push({
        type: 'chain', title: `${chain.sector} 产业链`,
        up: chain.upstream, mid: chain.midstream, down: chain.downstream,
        players: chain.players, note: chain.note
      });
    }

    const val = get('calc_valuation');
    if (val) {
      sections.push({
        type: 'table', title: `估值情景测算（${val.method}）`,
        rows: val.情景.map(s => [s.假设, `${s.对应市值} 亿 / ${s.对应股价} 元`]).concat([['当前价', `${val.当前价} 元`]])
      });
    }

    const peers = get('compare_peers');
    if (peers && peers.rows.length > 1) {
      sections.push({
        type: 'table', title: `同业对比（${peers.sector}）`,
        rows: peers.rows.map(r => [r.名称, `营收${r.营收增速 > 0 ? '+' : ''}${r.营收增速}% · 净利${r.净利增速 > 0 ? '+' : ''}${r.净利增速}% · 毛利率${r.毛利率}% · PE ${r.PE_TTM}x`])
      });
    }

    const prof = get('get_company_profile');
    if (prof) {
      sections.push({ type: 'kv', title: '公司画像', rows: Object.entries(prof).filter(([k]) => !['name', 'code', 'sub', 'sector', '数据截止'].includes(k)) });
    }

    /* —— 引用依据 —— */
    if (citations.length) {
      sections.push({ type: 'evidence', title: '依据与出处（可溯源）', cites: citations });
    }

    /* —— 风险 & HITL —— */
    sections.push({ type: 'risk', title: '风险提示与人工复核项', body: this._risk(id, c, citations) });

    const conf = this.confidence(executed);
    return { sections, citations, confidence: conf, intent: plan.intent, entities: plan.entities };
  },

  _conclusion(id, c, sector, ok, hits) {
    const nm = c ? c.name : (sector || '该赛道');
    const fin = ok.find(e => e.tool === 'get_financials');
    const d = fin ? fin.rec.result.data : null;
    const qt = ok.find(e => e.tool === 'get_market_quote');
    const news = ok.find(e => e.tool === 'search_news');
    const nItems = news ? news.rec.result.items : [];
    const pos = nItems.filter(n => n.sentiment === 'positive').length;
    const neg = nItems.filter(n => n.sentiment === 'negative').length;

    if (id === 'fundamentals' && d) {
      const growth = d.营收同比, pg = d.净利同比;
      const tone = pg > 20 ? '利润端明显加速' : (pg > 0 ? '利润小幅增长' : '利润承压下滑');
      return `${nm} ${fin.rec.result.period} 营收 ${d.营收} 亿元（同比 ${growth >= 0 ? '+' : ''}${growth}%），归母净利 ${d.归母净利} 亿元（同比 ${pg >= 0 ? '+' : ''}${pg}%），${tone}。毛利率 ${d.毛利率}%、净利率 ${d.净利率}%，ROE ${d.ROE}%。${d.经营现金流 < d.归母净利 ? '需注意：经营性现金流低于净利润，利润含金量待观察。' : '经营性现金流与净利润匹配，利润质量较好。'}`;
    }
    if (id === 'news') {
      return `${nm} 近 30 天检索到 ${nItems.length} 条相关动态，正面 ${pos} 条、负面 ${neg} 条、中性 ${nItems.length - pos - neg} 条。${neg > pos ? '负面信息占优，建议优先核查利空事项的业务影响范围与持续性。' : (pos > neg ? '正面信息占优，但需区分"订单预期"与"已确认收入"。' : '正负信息基本均衡，暂无明显边际变化。')}`;
    }
    if (id === 'valuation' && qt) {
      const v = qt.rec.result;
      return `${nm} 当前 ${v.quote.price} 元，市值 ${v.quote.mktcap} 亿，PE-TTM ${v.quote.pe_ttm}x，位于 PE Band ${v.一致预期.pe_band[0]}-${v.一致预期.pe_band[1]}x 区间。一致预期 2026E 归母净利 ${v.一致预期.一致预期归母净利_2026E} 亿（${v.一致预期.一致预期增速 > 0 ? '+' : ''}${v.一致预期.一致预期增速}%），对应 PEG ${v.一致预期.peg ?? '—'}。估值是否匹配取决于预期增速能否兑现，需人工确认盈利预测假设。`;
    }
    if (id === 'chain') {
      return `${sector || nm} 环节的格局与国产化进度是判断个股 alpha 的主要变量。以下为产业链拆解，建议结合下游资本开支节奏交叉验证。`;
    }
    if (id === 'compare') {
      return `已按营收增速、净利增速、毛利率与 PE 对${sector || '全池'}标的做横向排序，用于定位景气度与估值的相对位置。`;
    }
    if (id === 'profile') {
      return `${nm} 的主营、股东与客户结构如上，重点留意客户集中度对收入波动的放大作用。`;
    }
    // research / 兜底
    if (hits.length) {
      const h = hits[0];
      return `基于知识库 ${hits.length} 段相关材料，与当前问题关联度最高的来源是《${h.title}》（${h.type}，${h.date}，重排分 ${h.scores.rerank}）。以下结论均附出处，可逐条溯源核对。`;
    }
    return `未在私有知识库中检索到与"${nm}"高度相关的材料，以下结论主要依赖结构化数据推导，置信度偏低，建议补充研报或调研纪要后再下判断。`;
  },

  _risk(id, c, citations) {
    const rs = [];
    if (c) {
      const d = c.financials['2026H1'];
      if (d.资产负债率 > 50) rs.push(`资产负债率 ${d.资产负债率}%，处于偏高水平，需关注财务费用与再融资压力。`);
      if (d.经营现金流 < d.归母净利) rs.push('经营性现金流低于归母净利润，收入确认与回款节奏需人工核实。');
      if (d.净利同比 < 0) rs.push('净利同比为负，一次性因素（如资产减值）与经营性下滑需拆分，本 Agent 不做自动拆分。');
    }
    rs.push('一致预期与情景倍数属于第三方假设，是否采纳由研究员判断；本 Agent 不输出买卖建议。');
    rs.push('所有引用片段来自已入库材料，若原始文档更新，需重新触发检索以保证时效。');
    if (!citations.length) rs.push('⚠ 本次未命中知识库，结论缺乏原文支撑，请勿直接对外引用。');
    return rs;
  }
};

/* 供 UI 使用的示例问题 */
const SAMPLE_QUERIES = [
  '星海智造最新业绩怎么样？ALD 设备进展到哪一步了',
  '恒川新能加工费下跌、又计提减值，该怎么理解',
  '云枢数据的订阅制转型成立吗？估值该怎么看',
  '半导体设备产业链格局和国产化率如何',
  '把这几家公司做个横向对比',
  '澜芯微电现在估值贵不贵',
  '帮我生成今天的盘前简报'
];
