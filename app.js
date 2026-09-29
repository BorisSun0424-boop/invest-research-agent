/* ============================================================
 * app.js —— UI 渲染与交互
 * ============================================================ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}
const chgCls = v => v > 0 ? 'up' : (v < 0 ? 'dn' : '');
const fmtPct = v => (v > 0 ? '+' : '') + v + '%';

/* ================= 初始化 ================= */
let ragIndexStats = null;
function init() {
  ragIndexStats = RAG.build();
  renderStats(); renderUniverse(); renderSubs(); renderSamples();
  renderToolCards(); renderRagStats(); renderDocFilter(); renderDesign();
  renderBriefPick(); renderLog(); renderWfMeta();
  bindEvents();
}

function renderStats() {
  const pending = Workflow.briefs.filter(b => b.status !== 'published').length;
  $('#stats').innerHTML = `
    <span class="stat">数据截止 <b>${AS_OF}</b></span>
    <span class="stat">知识库 <b>${ragIndexStats.切片数}</b> 切片</span>
    <span class="stat">工具 <b>${Object.keys(TOOLS).length}</b> 个</span>
    <span class="stat ${pending ? 'warn' : ''}">待复核简报 <b>${pending}</b></span>`;
}

function renderUniverse() {
  $('#universe').innerHTML = UNIVERSE.map(c => `
    <div class="stk" data-q="${esc(c.name)}最新业绩和估值怎么看">
      <div class="r1">
        <span class="nm">${esc(c.name)}</span><span class="cd">${esc(c.code)}</span>
        <span class="px ${chgCls(c.quote.chg)}">${c.quote.price} ${fmtPct(c.quote.chg)}</span>
      </div>
      <div class="r2">${esc(c.sector)} · 市值 ${c.quote.mktcap} 亿 · PE ${c.quote.pe_ttm}x</div>
    </div>`).join('');
  $$('#universe .stk').forEach(el => el.onclick = () => ask(el.dataset.q));
}

function renderSubs() {
  $('#subList').innerHTML = Workflow.config.subs.map((s, i) => `
    <div class="sub-row">
      <input type="checkbox" data-i="${i}" ${s.enabled ? 'checked' : ''}>
      <span>${esc(s.sector)}</span>
      <span class="kw">${esc(s.keywords.join(' / '))}</span>
    </div>`).join('');
  $$('#subList input').forEach(cb => cb.onchange = () => {
    Workflow.config.subs[+cb.dataset.i].enabled = cb.checked;
    toast('订阅已更新');
  });
}

function renderSamples() {
  $('#samples').innerHTML = SAMPLE_QUERIES.map(q => `<button class="sample-q">${esc(q)}</button>`).join('');
  $$('#samples .sample-q').forEach(b => b.onclick = () => ask(b.textContent));
}

/* ================= 对话 ================= */
let busy = false, lastQuery = '';

function mkBlock(trace, title) {
  const d = document.createElement('div'); d.className = 'trace-block';
  d.innerHTML = `<div class="tb-t">${title}</div><div class="tb-body"></div>`;
  trace.appendChild(d); return d.querySelector('.tb-body');
}

async function ask(q) {
  q = (q || $('#qInput').value || '').trim();
  if (!q || busy) return;
  busy = true; lastQuery = q;
  $('#btnAsk').disabled = true; $('#qInput').value = '';

  appendMsg('user', `<div class="bubble">${esc(q)}</div>`);
  const holder = appendMsg('bot', `<div class="bubble"><span class="dim">正在识别意图并编排工具调用计划…</span></div>`);

  const trace = $('#trace'); trace.innerHTML = '';

  // ① 先出计划（Plan），让用户看得见 Agent 的"想法"
  const plan = Agent.plan(q);
  const b1 = mkBlock(trace, '① 意图识别与实体抽取');
  b1.innerHTML = `
    <div class="step"><span class="dot ok"></span><div>
      <div class="s-name">主意图：${esc(plan.intent.label)}</div>
      <div class="s-args">${esc(plan.secondary.length ? '次意图：' + plan.secondary.join('、') : '无次意图')}</div>
    </div></div>
    <div class="step"><span class="dot ok"></span><div>
      <div class="s-name">${plan.entities.companies.length ? '标的：' + plan.entities.companies.map(c => esc(c.name)).join('、') : '未点名标的'}</div>
      <div class="s-args">赛道：${esc(plan.entities.sectors.length ? plan.entities.sectors.join('、') : '—')}</div>
    </div></div>`;

  // 简报类意图：转交定时任务工作流（Agent 不直接产出可发布内容）
  if (plan.intent.id === 'brief') {
    const b2b = mkBlock(trace, '② 转交定时任务工作流');
    b2b.innerHTML = `<div class="step"><span class="dot ok"></span><div>
      <div class="s-name">触发「${esc(Workflow.config.name)}」</div>
      <div class="s-args">抓取 → 去重 → 聚类 → 佐证检索 → 生成初稿 → 人工审校后发布</div></div></div>`;
    holder.querySelector('.bubble').innerHTML =
      `<div class="ans-sec"><div class="ans-title">已触发工作流 <span class="badge human">Human-in-the-loop</span></div>
       <div>正在执行「${esc(Workflow.config.name)}」（${esc(Workflow.config.cronText)}定时）。AI 只产出<b>初稿</b>，请到「简报审校与发布」逐段确认后才能发布。</div></div>`;
    busy = false; $('#btnAsk').disabled = false;
    triggerWF();
    return;
  }

  // ② 计划执行（逐步更新状态）
  const b2 = mkBlock(trace, '② 工具调用计划与执行');
  b2.innerHTML = plan.steps.length ? plan.steps.map((s, i) => `
    <div class="step" data-i="${i}">
      <span class="dot"></span>
      <div style="flex:1">
        <div class="s-name">${esc(TOOLS[s.tool].label)} <span class="dim" style="font-weight:400">${esc(s.tool)}</span></div>
        <div class="s-args">${esc(JSON.stringify(s.args))}</div>
        <div class="s-args s-reason">${esc(s.reason)}</div>
      </div>
      <span class="s-ms">排队</span>
    </div>`).join('') : `<div class="empty-sm">未匹配到可执行工具</div>`;

  let idx = 0;
  const res = await Agent.run(q, ev => {
    const el = b2.querySelector(`.step[data-i="${idx}"]`);
    if (ev.type === 'step') {
      if (el) { el.querySelector('.dot').className = 'dot run'; el.querySelector('.s-ms').textContent = '执行中'; }
    } else if (ev.type === 'done') {
      idx++;
      if (el) {
        const ok = ev.rec.status === 'ok';
        el.querySelector('.dot').className = 'dot ' + (ok ? 'ok' : 'err');
        el.querySelector('.s-ms').textContent = ev.rec.ms + 'ms';
        if (!ok) el.querySelector('.s-reason').textContent += ' · 失败：' + (ev.rec.error || '');
      }
    }
  });

  // ③ 置信度
  const c = res.confidence;
  const lvColor = c.level === 'high' ? 'var(--pass)' : (c.level === 'mid' ? 'var(--mid)' : 'var(--high)');
  const lvBadge = c.level === 'high' ? 'pass' : (c.level === 'mid' ? 'mid' : 'high');
  const b3 = mkBlock(trace, '③ 置信度拆解');
  b3.innerHTML = `<div class="conf-box">
    <div class="conf-top">
      <span class="conf-val" style="color:${lvColor}">${(c.score * 100).toFixed(0)}</span>
      <span class="badge ${lvBadge}">${esc(c.levelText)}</span>
    </div>
    <div class="conf-bar"><i style="width:${c.score * 100}%;background:${lvColor}"></i></div>
    <div class="conf-factors">${c.factors.map(f => `
      <div class="fr"><b>${esc(f.name)}</b><span>${f.value.toFixed(2)} × ${f.weight}</span>
      <span style="margin-left:auto">${esc(f.note)}</span></div>`).join('')}</div>
  </div>`;

  // ④ 引用
  const b4 = mkBlock(trace, '④ 引用溯源');
  b4.innerHTML = res.citations.length
    ? res.citations.map(ci => `<div class="step"><span class="dot ok"></span><div>
        <div class="s-name">[${ci.n}] ${esc(ci.title.slice(0, 20))}${ci.title.length > 20 ? '…' : ''}</div>
        <div class="s-args">${esc(ci.source)} · ${esc(ci.date)} · 重排 ${ci.scores.rerank}</div></div></div>`).join('')
    : `<div class="step"><span class="dot err"></span><div class="s-args">本次未命中知识库，结论缺少原文支撑</div></div>`;

  busy = false; $('#btnAsk').disabled = false;
  holder.querySelector('.bubble').innerHTML = renderAnswer(res);
  $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
  renderLog(); renderStats();
}

function appendMsg(who, html) {
  const d = document.createElement('div'); d.className = 'msg ' + who; d.innerHTML = html;
  $('#chatScroll').appendChild(d);
  $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
  return d;
}

function renderAnswer(res) {
  const parts = [];
  for (const s of res.sections) {
    if (s.type === 'conclusion') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)}</div><div>${esc(s.body)}</div></div>`);
    } else if (s.type === 'table') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)}</div>
        <table class="kv-table">${s.rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table></div>`);
    } else if (s.type === 'kv') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)}</div>
        <table class="kv-table">${s.rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table></div>`);
    } else if (s.type === 'news') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)}</div>
        ${s.items.map(n => `<div class="news-item">${esc(n.title)}
          <div class="meta">${esc(n.date)} · ${esc(n.source)} · ${esc(n.tag)} ·
          <span style="color:${n.sentiment === 'positive' ? 'var(--high)' : (n.sentiment === 'negative' ? 'var(--pass)' : 'var(--muted)')}">
          ${n.sentiment === 'positive' ? '正面' : (n.sentiment === 'negative' ? '负面' : '中性')}</span></div></div>`).join('')}</div>`);
    } else if (s.type === 'chain') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)}</div>
        <div class="chain-col">
          <div><div class="ct">上游</div>${s.up.map(x => esc(x)).join('<br>')}</div>
          <div><div class="ct">中游</div>${s.mid.map(x => esc(x)).join('<br>')}</div>
          <div><div class="ct">下游</div>${s.down.map(x => esc(x)).join('<br>')}</div>
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">${esc(s.note)}</div></div>`);
    } else if (s.type === 'evidence') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)}</div>
        ${s.cites.map(c => `<div class="cite">
          <div class="src">[${c.n}] ${esc(c.title)} · ${esc(c.type)} · ${esc(c.source)} · ${esc(c.date)} · 重排分 ${c.scores.rerank}</div>
          <div class="txt">${RAG.highlight(c.text.slice(0, 260), lastQuery)}</div>
        </div>`).join('')}</div>`);
    } else if (s.type === 'risk') {
      parts.push(`<div class="ans-sec"><div class="ans-title">${esc(s.title)} <span class="badge human">人工复核</span></div>
        <ul class="risk-list">${s.body.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
    }
  }
  // 置信度条
  const c = res.confidence;
  const color = c.level === 'high' ? 'var(--pass)' : (c.level === 'mid' ? 'var(--mid)' : 'var(--high)');
  parts.push(`<div class="conf-box">
    <div class="conf-top">
      <span class="dim" style="font-size:12px">置信度</span>
      <span class="conf-val" style="color:${color}">${(c.score * 100).toFixed(0)}</span>
      <span class="badge ${c.level === 'high' ? 'pass' : (c.level === 'mid' ? 'mid' : 'high')}">${esc(c.levelText)}</span>
      <span class="spacer"></span>
      <span class="dim" style="font-size:11.5px">${esc(res.intent.label)} · ${res.executed.length} 次工具调用</span>
    </div>
    <div class="conf-bar"><i style="width:${c.score * 100}%;background:${color}"></i></div>
  </div>`);
  return parts.join('');
}

/* ================= 工具页 ================= */
function renderToolCards() {
  $('#toolCards').innerHTML = TOOL_LIST.map(t => `
    <div class="tool-card">
      <div class="t-name">${esc(t.name)}</div>
      <div class="t-label">${esc(t.label)}</div>
      <p>${esc(t.desc)}</p>
      <div class="t-params">${t.params.map(p => `· ${esc(p.name)}<span style="color:var(--muted)">:${esc(p.type)}${p.required ? ' 必填' : ''}</span>`).join('<br>')}</div>
    </div>`).join('');
}

function renderLog() {
  const f = $('#logFilter') ? $('#logFilter').value : '';
  const log = ToolRuntime.log.filter(r => !f || r.status === f).slice().reverse();
  $('#logMeta').textContent = `共 ${ToolRuntime.log.length} 次调用`;
  if (!log.length) { $('#logTable').innerHTML = `<div class="empty">暂无调用记录，先在对话工作台提个问题</div>`; return; }
  $('#logTable').innerHTML = `<table class="log-table">
    <tr><th>时间</th><th>工具</th><th>入参</th><th>状态</th><th>耗时</th><th>返回大小</th></tr>
    ${log.map(r => `<tr>
      <td>${r.ts.toLocaleTimeString('zh-CN')}</td>
      <td class="mono">${esc(r.tool)}</td>
      <td class="mono" style="max-width:340px;word-break:break-all">${esc(JSON.stringify(r.args)).slice(0, 120)}</td>
      <td>${r.status === 'ok' ? '<span class="badge pass">成功</span>' : (r.status === 'running' ? '<span class="badge mid">执行中</span>' : `<span class="badge high">失败</span>`)}</td>
      <td>${r.ms}ms</td>
      <td>${r.size ? r.size + 'B' : '—'}</td></tr>`).join('')}
  </table>`;
}

/* ================= RAG 页 ================= */
function renderRagStats() {
  const s = ragIndexStats;
  $('#ragStats').innerHTML = Object.entries(s).map(([k, v]) => `<div class="kv-box"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
}
function renderDocFilter() {
  $('#docFilter').innerHTML = `<option value="">全部文档（${DOCS.length}）</option>` +
    DOCS.map(d => `<option value="${d.id}">${esc(d.title.slice(0, 34))}…（${d.type}）</option>`).join('');
}
function renderChunks(q) {
  const f = $('#docFilter').value;
  const list = RAG.chunks.filter(c => !f || c.docId === f);
  $('#chunkList').innerHTML = list.map(c => `
    <div class="chunk">
      <div class="c-meta">${esc(c.cid)} · ${esc(c.title)} · 第 ${c.idx + 1}/${c.total} 块 · ${c.text.length} 字 · 权重 ${c.weight}</div>
      <div>${q ? RAG.highlight(c.text, q) : esc(c.text)}</div>
    </div>`).join('');
}
function doRagSearch() {
  const q = $('#ragQ').value.trim();
  if (!q) { toast('请输入检索问题'); return; }
  const k = +$('#ragK').value;
  const r = RAG.search(q, k);
  $('#ragChips').innerHTML = Object.entries(r.pipeline).map(([kk, v]) => `<span class="chip">${esc(kk)}：${esc(v)}</span>`).join('');
  $('#ragResult').innerHTML = r.hits.length ? r.hits.map((h, i) => {
    const mv = h.moved > 0 ? `<span class="rank-move up">↑${h.moved}</span>` : (h.moved < 0 ? `<span class="rank-move down">↓${-h.moved}</span>` : `<span class="rank-move same">—</span>`);
    return `<div class="hit">
      <div class="h-head">
        <span class="h-title">#${i + 1} ${esc(h.title)}</span>
        <span class="badge cat">${esc(h.type)}</span>
        <span class="badge cat">${esc(h.date)}</span>
        ${mv}<span class="dim" style="font-size:11px">融合#${h.ranks.fused} → 重排#${h.ranks.final}</span>
      </div>
      <div class="h-txt">${RAG.highlight(h.text, q)}</div>
      <div class="score-row">
        <span>BM25 <b>${h.scores.bm25}</b>（#${h.ranks.bm25}）</span>
        <span>向量 <b>${h.scores.vector}</b>（#${h.ranks.vector}）</span>
        <span>RRF <b>${h.scores.rrf}</b></span>
        <span>重排 <b>${h.scores.rerank}</b></span>
        <span class="dim">覆盖 ${h.detail.覆盖度} · 权威 ${h.detail.来源权威性} · 时效 ${h.detail.时效性} · 密度 ${h.detail.命中密度}</span>
      </div>
    </div>`;
  }).join('') : `<div class="empty">未命中，换个问法试试</div>`;
  renderChunks(q);
}

/* ================= 工作流 ================= */
function renderWfMeta() {
  $('#wfName').textContent = Workflow.config.name;
  $('#wfCron').textContent = `${Workflow.config.cron} · ${Workflow.config.cronText}`;
  const n = Workflow.nextRun();
  $('#wfNext').textContent = `${n.toLocaleDateString('zh-CN')} 07:00`;
  $('#wfPush').textContent = Workflow.config.pushChannel;
}
const STAGE_LABEL = { 抓取: '抓取订阅赛道新闻/公告', 去重: 'URL 归一 + 标题相似度去重', 聚类: '按赛道聚类与情绪统计', 佐证检索: 'RAG 检索研报佐证', 生成初稿: '生成简报初稿（待审校）' };

async function triggerWF() {
  const btn = $('#btnTrigger'); btn.disabled = true; btn.textContent = '执行中…';
  Workflow.config.lookback = +$('#wfLookback').value;
  const box = $('#wfStages');
  box.innerHTML = `<div class="pipeline">${Object.keys(STAGE_LABEL).map((k, i) =>
    `<div class="pl-stage" data-k="${k}"><div class="p-n">Stage ${i + 1}</div><div class="p-t">${k}</div><div class="p-d">排队中…</div></div>`).join('')}</div>`;
  const map = {};
  $$('#wfStages .pl-stage').forEach(el => map[el.dataset.k] = el);

  const { run, brief } = await Workflow.trigger(ev => {
    const el = map[ev.name];
    if (!el) return;
    if (ev.status === 'running') { el.querySelector('.p-d').textContent = '执行中…'; }
    else {
      el.classList.add('done');
      const r = ev.rec;
      const detail = Object.entries(r).filter(([k]) => !['name', 'ms', 'data'].includes(k)).map(([k, v]) => `${k} ${v}`).join(' · ');
      el.querySelector('.p-d').innerHTML = `${detail || '完成'} <span class="dim">${r.ms}ms</span>`;
    }
  });

  toast(`执行完成：抓取 ${brief.stats.抓取} 条，去重 ${brief.stats.去重剔除} 条，生成 ${brief.sections.length} 段初稿`);
  btn.disabled = false; btn.textContent = '立即执行';
  renderRuns(); renderBriefPick(); renderStats();
  $('#briefPick').value = brief.id; renderBrief();
  switchTab('review');
}

function renderRuns() {
  $('#wfRuns').innerHTML = Workflow.runs.slice().reverse().map(r => `
    <div class="run-row">
      <b>${esc(r.id)}</b>
      <span class="dim">${esc(r.date)} ${r.ts.toLocaleTimeString('zh-CN')}</span>
      <span>${r.stages.map(s => `${s.name}(${s.ms}ms)`).join(' → ')}</span>
      <span class="badge mid">${esc(r.状态)}</span>
      <span class="dim">总耗时 ${r.ms}ms</span>
    </div>`).join('') || `<div class="empty">暂无执行记录</div>`;
}

/* ================= 简报审校 ================= */
function renderBriefPick() {
  const sel = $('#briefPick');
  const cur = sel.value;
  if (!Workflow.briefs.length) { sel.innerHTML = `<option value="">暂无简报，请先执行每日监控</option>`; $('#briefBody').innerHTML = `<div class="empty">还没有简报。到「每日监控工作流」点「立即执行」，AI 会生成初稿并出现在这里。</div>`; return; }
  sel.innerHTML = Workflow.briefs.map(b => `<option value="${b.id}">${esc(b.id)} · ${esc(b.date)} · ${b.sections.length}段</option>`).join('');
  if (cur && Workflow.briefs.some(b => b.id === cur)) sel.value = cur;
}
function renderBrief() {
  const id = $('#briefPick').value;
  const b = Workflow.briefs.find(x => x.id === id);
  if (!b) { $('#briefBody').innerHTML = `<div class="empty">请选择一份简报</div>`; return; }
  const stMap = { draft: ['mid', '初稿待审校'], reviewing: ['low', '审校中'], published: ['pass', '已发布'], rejected: ['high', '已驳回'] };
  const [cls, txt] = stMap[b.status] || ['cat', b.status];
  $('#briefStatus').innerHTML = `<span class="badge ${cls}">${txt}</span>
    <span class="dim" style="margin-left:8px">抓取 ${b.stats.抓取} · 去重 ${b.stats.去重剔除} · 有效 ${b.stats.有效} · 佐证 ${b.stats.佐证片段} 段 · ${b.stats.耗时_ms}ms</span>`;

  $('#briefBody').innerHTML = b.sections.map(s => {
    const badge = s.review === 'accepted' ? '<span class="badge pass">已采纳</span>'
      : s.review === 'edited' ? '<span class="badge low">已修改</span>'
      : s.review === 'rejected' ? '<span class="badge high">已驳回</span>' : '<span class="badge cat">待审校</span>';
    return `<div class="bs ${s.review === 'rejected' ? 'rejected' : ''}" data-id="${s.id}">
      <div class="bs-head">
        <span class="bs-title">${esc(s.title)}</span>
        ${s.badge ? `<span class="badge cat">${s.badge.条数}条 · 正${s.badge.正面}/负${s.badge.负面}</span>` : ''}
        <span class="dim" style="font-size:11.5px">置信度 ${(s.confidence * 100).toFixed(0)}</span>
        ${badge}
      </div>
      <textarea>${esc(s.text)}</textarea>
      <div class="bs-acts">
        <button class="btn small" data-act="accept">采纳</button>
        <button class="btn small primary" data-act="edit">保存修改</button>
        <button class="btn small danger" data-act="reject">驳回</button>
        <span class="dim" style="font-size:11.5px">引用 ${s.cites.length} 条</span>
      </div>
      ${s.cites.length ? `<div style="margin-top:8px">${s.cites.slice(0, 2).map(c => `<div class="cite"><div class="src">${esc(c.title)} · ${esc(c.source || '')} · ${esc(c.date)}</div><div class="txt">${esc(String(c.text).slice(0, 150))}…</div></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');

  $$('#briefBody .bs').forEach(el => {
    const secId = el.dataset.id;
    el.querySelectorAll('button').forEach(btn => btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'accept') Workflow.markSection(b.id, secId, 'accept');
      else if (act === 'edit') Workflow.markSection(b.id, secId, 'edit', { text: el.querySelector('textarea').value });
      else {
        const reason = prompt('驳回原因（将进入 Bad Case 池）：', '事实性错误');
        if (reason === null) return;
        Workflow.markSection(b.id, secId, 'reject', { reason });
      }
      renderBrief(); renderBc(); renderStats();
      toast(act === 'accept' ? '已采纳' : (act === 'edit' ? '修改已保存并留痕' : '已驳回，记入 Bad Case'));
    });
  });

  $('#briefHistory').innerHTML = b.history.slice().reverse().map(h =>
    `<div class="hist-row"><b>${esc(h.by)}</b> · ${esc(h.action)} · ${esc(h.note || '')} <span style="margin-left:auto">${h.ts.toLocaleTimeString('zh-CN')}</span></div>`).join('')
    + (b.edits.length ? `<div class="section-title">编辑 diff</div>` + b.edits.map(e =>
      `<div class="hist-row"><b>${esc(e.title)}</b><br><span style="color:var(--high)">- ${esc(e.before.slice(0, 80))}…</span><br><span style="color:var(--pass)">+ ${esc(e.after.slice(0, 80))}…</span></div>`).join('') : '');
}
function renderBc() {
  $('#bcList').innerHTML = Workflow.badCases.length ? Workflow.badCases.map(b =>
    `<div class="bc-card">
      <div class="bc-t"><b>${esc(b.section)}</b><span class="badge high">${esc(b.type)}</span><span class="bc-time">${b.ts.toLocaleTimeString('zh-CN')}</span></div>
      <div>原因：${esc(b.reason)}</div>
      <div class="dim">原文：${esc(b.original)}…</div>
    </div>`).join('') : `<div class="empty-sm">暂无驳回记录</div>`;
}

/* ================= 设计页 ================= */
function renderDesign() {
  $('#archDiagram').innerHTML = `
    <div class="arch">
      <div class="arch-row">
        <div class="arch-box"><div class="a-t">输入</div><div class="a-c">研究员提问 / 定时任务触发</div></div>
        <div class="arch-box"><div class="a-t">编排层</div><div class="a-c">意图识别 → 实体抽取 → 工具调用计划（Plan-then-Execute）</div></div>
      </div>
      <div class="arch-arrow">↓ 计划逐条执行</div>
      <div class="arch-row">
        <div class="arch-box"><div class="a-t">工具层（Function Calling / MCP）</div><div class="a-c">新闻检索 · 工商画像 · 财务抓取 · 行情估值 · 产业链 · 估值测算 · 同业对比</div></div>
      </div>
      <div class="arch-arrow">↓ 研报类问题走 RAG</div>
      <div class="arch-row">
        <div class="arch-box"><div class="a-t">RAG 链路</div><div class="a-c">解析 → 分块 → 向量化 → BM25 + 向量 → RRF 融合 → 重排（覆盖度/权威性/时效性/密度）</div></div>
      </div>
      <div class="arch-arrow">↓ 生成与门禁</div>
      <div class="arch-row">
        <div class="arch-box"><div class="a-t">生成层</div><div class="a-c">结论 + 数据表 + 引用出处 + 置信度拆解 + 风险提示</div></div>
        <div class="arch-box" style="border-color:#d9c2ef"><div class="a-t" style="color:var(--purple)">Human-in-the-loop</div><div class="a-c">简报初稿 → 逐段采纳/修改/驳回 → 全部审校 → 方可发布留痕</div></div>
      </div>
    </div>`;

  $('#sceneCards').innerHTML = [
    ['找数据', '工具调用自动化', '财务/行情/工商/新闻等结构化数据由 Agent 自主调用工具获取，指标口径统一，避免手工拼表'],
    ['读研报', 'RAG 混合检索 + 溯源', '研报/年报/纪要入库分块，BM25 与向量双路召回后 RRF 融合并重排，每条结论绑定原文出处'],
    ['记知识', '私有知识库沉淀', '文档按来源类型赋权威权重、按日期做时效衰减，检索时可解释排序依据'],
    ['写简报', '定时任务 + HITL', '定时抓取订阅赛道 → 去重 → 聚类 → 生成初稿 → 人工逐段确认后发布，全过程留痕']
  ].map(([t, s, d]) => `<div class="card"><div class="tag">${s}</div><h4>${t}</h4><p>${d}</p></div>`).join('');

  $('#confCards').innerHTML = [
    ['检索质量（重排 top1）', '0.30', '知识库 top1 片段的重排得分，衡量"有没有找到对的料"'],
    ['引用覆盖度', '0.20', '引用片段数量（满额 4 条），衡量结论是否有多源支撑'],
    ['工具调用成功率', '0.20', '本轮工具成功返回比例，数据源异常会直接拉低置信度'],
    ['数据时效性', '0.15', '最新引用距今天数，>90 天开始衰减，>180 天显著扣分'],
    ['结构化数据支撑', '0.15', '是否有财务/行情/产业链等可核验数据源参与']
  ].map(([n, w, d]) => `<div class="card"><h4>${n} <span class="tag">权重 ${w}</span></h4><p>${d}</p></div>`).join('')
    + `<div class="card" style="border-left:4px solid var(--pass)"><h4>分级与降级</h4><p>≥0.75 高（可直接引用）｜0.55-0.75 中（复核关键数字）｜&lt;0.55 低（提示需人工判断，禁止直接对外）</p></div>`;

  $('#designCards').innerHTML = [
    ['工具契约化', '工具以 JSON Schema 声明注册，Agent 只依赖声明做规划；真实环境替换为 HTTP / MCP Server 即可，编排逻辑零改动'],
    ['引用强制绑定', '回答模板要求"结论 → 原文片段"一一对应，未命中知识库时显式提示"结论缺乏原文支撑"'],
    ['置信度可拆解', '置信度不是黑盒分数，而是 5 个可解释因子的加权和，用户能看到是哪一项拖低了可信度'],
    ['降级而非硬答', '低置信度时输出"需人工判断"而非给出看似确定的结论，避免幻觉被当作事实传导'],
    ['任务编排与去重', '定时工作流内置 URL 归一与标题相似度去重，转载类信息不重复进入简报'],
    ['全过程留痕', '工具调用日志、Agent Trace、简报状态流转与编辑 diff 均可回溯，便于质量复盘与 Bad Case 归因']
  ].map(([t, d]) => `<div class="card"><h4>${t}</h4><p>${d}</p></div>`).join('');
}

/* ================= 事件绑定 ================= */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ['chat', 'tools', 'rag', 'wf', 'review', 'design'].forEach(n => {
    $('#tab-' + n).style.display = n === name ? '' : 'none';
  });
}
function bindEvents() {
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $('#btnAsk').onclick = () => ask();
  $('#qInput').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); ask(); } };
  $('#btnRunWF').onclick = () => { switchTab('wf'); triggerWF(); };
  $('#btnTrigger').onclick = triggerWF;
  $('#btnRag').onclick = doRagSearch;
  $('#ragQ').onkeydown = e => { if (e.key === 'Enter') doRagSearch(); };
  $('#docFilter').onchange = () => renderChunks($('#ragQ').value.trim());
  $('#logFilter').onchange = renderLog;
  $('#btnClearLog').onclick = () => { ToolRuntime.log = []; renderLog(); toast('日志已清空'); };
  $('#btnFault').onclick = () => { ToolRuntime.failRate = 0.5; toast('已注入故障：下一次工具调用将失败'); };
  $('#briefPick').onchange = renderBrief;
  $('#btnPublish').onclick = () => {
    const r = Workflow.publish($('#briefPick').value, $('#reviewer').value || '研究员');
    toast(r.msg); if (r.ok) { renderBrief(); renderStats(); renderBriefPick(); }
  };
  window.__onToolCall = () => { if ($('#tab-tools').style.display !== 'none') renderLog(); };
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  renderChunks('');
  renderRuns(); renderBc();
});
