/* ============================================================
 * tools.js —— Function Calling / MCP 工具层
 * 设计要点：
 *   1. 工具以「JSON Schema 声明 + 执行函数」注册，Agent 只依赖声明做规划，
 *      与具体实现解耦（真实环境替换为 HTTP / MCP Server 即可）
 *   2. 每次调用写入 callLog，供「工具调用链路 / 可观测性」面板回放
 *   3. Mock API 内置可控延迟与失败率，用于验证 Agent 的降级与重试策略
 * ============================================================ */

const ToolRuntime = {
  latency: [180, 520],   // 模拟网络往返 ms
  failRate: 0.0,         // 演示用，默认不失败
  log: [],               // 调用日志
  seq: 0
};

function uid(p) { return p + '-' + (++ToolRuntime.seq).toString().padStart(4, '0'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function randLatency() {
  const [a, b] = ToolRuntime.latency;
  return Math.round(a + Math.random() * (b - a));
}

async function invoke(toolName, args) {
  const t0 = performance.now();
  const rec = { id: uid('call'), ts: new Date(), tool: toolName, args, status: 'running', ms: 0, size: 0, result: null, error: null };
  ToolRuntime.log.push(rec);
  if (window.__onToolCall) window.__onToolCall(rec);

  await sleep(randLatency());
  const tool = TOOLS[toolName];
  if (!tool) {
    rec.status = 'error'; rec.error = '未注册的工具：' + toolName;
  } else if (Math.random() < ToolRuntime.failRate) {
    rec.status = 'error'; rec.error = '上游数据源超时（Mock 注入故障）';
  } else {
    try {
      rec.result = await tool.exec(args || {});
      rec.status = 'ok';
      rec.size = JSON.stringify(rec.result || '').length;
    } catch (e) {
      rec.status = 'error'; rec.error = String(e.message || e);
    }
  }
  rec.ms = Math.round(performance.now() - t0);
  if (window.__onToolCall) window.__onToolCall(rec);
  return rec;
}

/* ---------- 工具注册表：声明即契约 ---------- */
const TOOLS = {
  get_company_profile: {
    label: '工商与主营数据查询',
    desc: '按公司名/代码查询上市板、主营、实控人、客户集中度、所属行业等工商与画像字段',
    params: [{ name: 'name', type: 'string', required: true, desc: '公司名或股票代码' }],
    exec: ({ name }) => {
      const c = companyByName(name);
      if (!c) throw new Error('未检索到标的：' + name);
      return { code: c.code, name: c.name, sector: c.sector, sub: c.sub, ...c.profile, 数据截止: AS_OF };
    }
  },

  get_financials: {
    label: '财务数据抓取',
    desc: '获取指定报告期的营收/净利/毛利率/ROE/现金流/资产负债率/合同负债等核心财务指标，并附同比',
    params: [
      { name: 'name', type: 'string', required: true, desc: '公司名或股票代码' },
      { name: 'period', type: 'string', required: false, desc: '报告期，如 2026H1 / 2025A / 2024A' }
    ],
    exec: ({ name, period }) => {
      const c = companyByName(name);
      if (!c) throw new Error('未检索到标的：' + name);
      const f = c.financials;
      const periods = Object.keys(f);
      if (period && f[period]) return { name: c.name, code: c.code, period, data: f[period] };
      return { name: c.name, code: c.code, 可选报告期: periods, data: f[periods[0]], period: periods[0] };
    }
  },

  get_market_quote: {
    label: '行情与估值快照',
    desc: '获取最新收盘价、涨跌幅、总市值、PE-TTM/PB/PS 及一致预期',
    params: [{ name: 'name', type: 'string', required: true, desc: '公司名或股票代码' }],
    exec: ({ name }) => {
      const c = companyByName(name);
      if (!c) throw new Error('未检索到标的：' + name);
      return { name: c.name, code: c.code, as_of: AS_OF, quote: c.quote, 一致预期: c.valuation };
    }
  },

  search_news: {
    label: '新闻与公告检索',
    desc: '按赛道/关键词/时间窗检索新闻与公司公告，返回标题、来源、日期、正文摘要与情绪标签',
    params: [
      { name: 'sector', type: 'string', required: false, desc: '赛道名，如 半导体设备' },
      { name: 'keywords', type: 'array', required: false, desc: '关键词数组' },
      { name: 'days', type: 'number', required: false, desc: '回溯天数，默认 30' }
    ],
    exec: ({ sector, keywords = [], days = 30 }) => {
      const cutoff = new Date('2026-09-25');
      cutoff.setDate(cutoff.getDate() - days);
      const cut = cutoff.toISOString().slice(0, 10);
      let list = NEWS.filter(n => n.date >= cut);
      if (sector) list = list.filter(n => n.sector === sector || n.sector === '宏观');
      if (keywords.length) {
        list = list.filter(n => {
          const hay = (n.title + n.body + n.tag + n.sector).toLowerCase();
          return keywords.some(k => hay.includes(String(k).toLowerCase()));
        });
      }
      return { count: list.length, items: list.sort((a, b) => b.date.localeCompare(a.date)) };
    }
  },

  search_research_reports: {
    label: '研报/公告知识库检索（RAG）',
    desc: '对私有研报、年报、业绩说明会纪要做混合检索（BM25 + 向量 + 重排），返回带引用出处的片段',
    params: [
      { name: 'query', type: 'string', required: true, desc: '检索问题' },
      { name: 'topK', type: 'number', required: false, desc: '返回条数，默认 5' }
    ],
    exec: ({ query, topK = 5 }) => RAG.search(query, topK)
  },

  get_industry_chain: {
    label: '产业链图谱',
    desc: '返回指定赛道的上游/中游/下游环节、主要玩家与当前核心矛盾',
    params: [{ name: 'sector', type: 'string', required: true, desc: '赛道名' }],
    exec: ({ sector }) => {
      const ch = CHAINS[sector];
      if (!ch) throw new Error('暂未覆盖该赛道：' + sector + '（已覆盖：' + Object.keys(CHAINS).join('、') + '）');
      return { sector, ...ch };
    }
  },

  calc_valuation: {
    label: '估值测算（本地计算）',
    desc: '按 PE / PS / ARR 三种方法做情景测算，输出对应股价区间与隐含假设',
    params: [
      { name: 'name', type: 'string', required: true, desc: '公司名或代码' },
      { name: 'method', type: 'string', required: false, desc: 'PE / PS / ARR，默认 PE' }
    ],
    exec: ({ name, method = 'PE' }) => {
      const c = companyByName(name);
      if (!c) throw new Error('未检索到标的：' + name);
      const shares = c.quote.mktcap / c.quote.price;   // 亿股
      const ni = c.valuation.一致预期归母净利_2026E;
      const out = { name: c.name, code: c.code, method, as_of: AS_OF, 情景: [] };
      if (method === 'ARR') {
        const arr = 25.0;
        [8, 10, 12].forEach(m => out.情景.push({ 假设: `ARR ${arr} 亿 × ${m}x`, 对应市值: +(arr * m).toFixed(1), 对应股价: +(arr * m / shares).toFixed(2) }));
      } else if (method === 'PS') {
        const rev = c.financials['2026H1'].营收 * 2.05;
        [6, 8, 10].forEach(m => out.情景.push({ 假设: `2026E 营收 ${rev.toFixed(1)} 亿 × ${m}x PS`, 对应市值: +(rev * m).toFixed(1), 对应股价: +(rev * m / shares).toFixed(2) }));
      } else {
        [35, 45, 55].forEach(m => out.情景.push({ 假设: `2026E 归母净利 ${ni} 亿 × ${m}x PE`, 对应市值: +(ni * m).toFixed(1), 对应股价: +(ni * m / shares).toFixed(2) }));
      }
      out.当前价 = c.quote.price;
      out.说明 = '测算基于一致预期与情景倍数，未考虑摊薄与股本变动；仅用于假设推演，不构成投资建议。';
      return out;
    }
  },

  compare_peers: {
    label: '同业横向对比',
    desc: '对同赛道/全池标的做营收增速、毛利率、净利增速、PE 的横向排序',
    params: [{ name: 'sector', type: 'string', required: false, desc: '赛道名；留空则对比全部' }],
    exec: ({ sector }) => {
      let list = sector ? UNIVERSE.filter(c => c.sector === sector) : UNIVERSE.slice();
      return {
        sector: sector || '全部',
        rows: list.map(c => {
          const f = c.financials['2026H1'];
          return { 名称: c.name, 代码: c.code, 赛道: c.sector, 营收增速: f.营收同比, 净利增速: f.净利同比, 毛利率: f.毛利率, 净利率: f.净利率, ROE: f.ROE, PE_TTM: c.quote.pe_ttm, 市值_亿: c.quote.mktcap };
        })
      };
    }
  }
};

const TOOL_LIST = Object.keys(TOOLS).map(k => ({
  name: k, label: TOOLS[k].label, desc: TOOLS[k].desc, params: TOOLS[k].params
}));
