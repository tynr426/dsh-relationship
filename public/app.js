// 关系记忆工作台前端：首页待确认队列、联系人时间线、手动录入
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const RELATION_CN = { family: '家人', friend: '朋友', colleague: '同事', client: '客户', partner: '伙伴', other: '其他' };
  const TYPE_CN = { preference: '喜好', dislike: '不喜好', taboo: '禁忌', event: '事件', gift: '礼物', promise: '承诺', interaction: '往来', attribute: '基础' };
  const TYPE_ORDER = ['event', 'preference', 'dislike', 'taboo', 'gift', 'promise', 'interaction', 'attribute'];

  const state = {
    view: 'home',
    contacts: [],
    overview: { counts: {}, pending: [], upcoming: [] },
    materials: [],
    activeContactId: null,
    timeline: { contact: null, memories: [] },
    typeFilter: 'all',
    editingPendingId: null,
    editingMemoryId: null,
    smartTab: 'single',
    // 嵌入 DSH（同源 iframe）时可直连宿主：建会话、发 prompt
    dshEmbedded: location.pathname.startsWith('/api/dsh-relationship/workbench'),
    info: {},
    plans: [],
    gift: { occasions: [], reciprocity: [], given: [], received: [] },
    editingPlanId: null,
    suggestContactId: null,
    suggestPlanId: null,
  };

  const DSH_SESSION_KEY = 'rel.dshSessionId';
  const REL_PRESET_ID = 'relationship';

  // ---------- 工具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function fmtDate(d) {
    if (!d) return '';
    return String(d).replace('每年-', '每年 ').replace('-__', '·下旬');
  }
  function initial(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
  const DIRECTION_CN = { user_to_contact: '我→TA', contact_to_user: 'TA→我', both: '双向' };
  function directionLabel(d) { return DIRECTION_CN[d] || ''; }
  const PLAN_STATUS_CN = { idea: '想法', decided: '已定', sent: '已送' };
  function relativeDays(n) {
    if (n === 0) return '今天';
    if (n === 1) return '明天';
    return `${n} 天后`;
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  async function api(path, opts = {}) {
    // 去掉根斜杠用相对路径：独立模式解析到本服务，嵌入 DSH iframe 时
    // 解析到 /api/dsh-relationship/workbench/… 由宿主反向代理转发。
    const res = await fetch(path.replace(/^\/+/, ''), {
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  // ---------- 宿主直连（嵌入 DSH 时）：client-request 桥，同 dsh-qa ----------
  async function dshRpc(endpoint, args = {}) {
    if (!state.dshEmbedded) throw new Error('独立模式下无法直连 DSH，请用「复制整理指令」');
    const rpcId = globalThis.crypto?.randomUUID?.() || `rel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const res = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`DSH 连接失败（${res.status}）`);
    if (data.rpcId && data.rpcId !== rpcId) throw new Error('DSH 响应校验失败');
    if (!data.result?.ok) throw new Error(data.result?.error?.message || 'DSH 调用失败');
    return data.result.value;
  }

  /** 复用上次的关系记忆整理会话；失效或首次则新建（带 relationship preset）。 */
  async function ensureDshSession() {
    const cwd = state.info?.dataDir || '.';
    const stored = localStorage.getItem(DSH_SESSION_KEY) || '';
    if (stored) {
      try {
        const sessions = await dshRpc('session/list', { _request: {} });
        if ((sessions.items || []).some((s) => s.sessionId === stored)) return stored;
      } catch { /* 会话清单不可用时直接新建 */ }
    }
    let agentPreset;
    try {
      const catalog = await dshRpc('agentPresets/list', {});
      const list = catalog.items || catalog.presets || catalog || [];
      agentPreset = Array.isArray(list) ? list.find((p) => p.id === REL_PRESET_ID)?.id : undefined;
    } catch { /* 无 preset 目录则不带 preset 建会话 */ }
    const created = await dshRpc('session/create', agentPreset ? { request: { cwd, agentPreset } } : { request: { cwd } });
    const sessionId = created.sessionId;
    if (!sessionId) throw new Error('DSH 会话创建失败');
    await dshRpc('session/rename', { request: { sessionId, title: '关系记忆｜素材整理' } }).catch(() => {});
    localStorage.setItem(DSH_SESSION_KEY, sessionId);
    return sessionId;
  }

  /** 素材卡一键 AI 整理：直连宿主会话发「整理素材」，模型跑完回工作台确认。 */
  async function organizeViaHost(materialId) {
    if (!state.dshEmbedded) {
      toast('独立模式：请点「复制整理指令」粘贴到 DSH 会话', true);
      return;
    }
    const sessionId = await ensureDshSession();
    const requestId = globalThis.crypto?.randomUUID?.() || `rel-prompt-${Date.now()}`;
    await dshRpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `整理素材 ${materialId}` }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    toast('已交给 AI 整理，完成后回工作台确认', false);
  }

  // ---------- 数据刷新 ----------
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  }

  async function refresh() {
    try {
      const [overview, contacts, materials, gifts] = await Promise.all([
        api('/api/overview'), api('/api/contacts'), api('/api/materials'),
        api('/api/gifts/occasions').catch(() => null),
      ]);
      state.overview = overview;
      state.contacts = contacts.contacts;
      state.materials = materials.materials;
      if (gifts) {
        state.gift.occasions = gifts.occasions || [];
        state.plans = gifts.plans || [];
      }
      if (state.view === 'gifts') {
        const [recip, ledger] = await Promise.all([
          api('/api/gifts/reciprocity').catch(() => ({ items: [] })),
          api('/api/gifts/ledger').catch(() => ({ given: [], received: [] })),
        ]);
        state.gift.reciprocity = recip.items || [];
        state.gift.given = ledger.given || [];
        state.gift.received = ledger.received || [];
      }
      if (state.activeContactId) {
        const stillThere = state.contacts.some((c) => c.id === state.activeContactId);
        if (!stillThere) state.activeContactId = null;
      }
      if (state.activeContactId) {
        try { state.timeline = await api(`/api/contacts/${state.activeContactId}/timeline`); }
        catch { state.timeline = { contact: null, memories: [] }; state.activeContactId = null; }
      } else {
        state.timeline = { contact: null, memories: [] };
      }
      render();
    } catch (e) {
      markStatus(false);
      toast(e.message || '刷新失败', true);
    }
  }

  function markStatus(up = true) {
    const el = $('#service-status');
    el.classList.toggle('off', !up);
    el.querySelector('span').textContent = up ? '本地 · 关系记忆' : '连接中断';
  }

  // ---------- 渲染 ----------
  function render() {
    renderNav();
    if (state.view === 'home') renderHome();
    else if (state.view === 'gifts') renderGifts();
    else renderContacts();
    markStatus(true);
  }

  function renderNav() {
    $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
    const pending = state.overview.counts.pending || 0;
    const navPending = $('#nav-pending-count');
    navPending.textContent = String(pending);
    navPending.classList.toggle('hidden', pending === 0);
    const contactCount = state.overview.counts.contacts || 0;
    const navContacts = $('#nav-contact-count');
    navContacts.textContent = String(contactCount);
    navContacts.classList.toggle('hidden', contactCount === 0);
  }

  function renderHome() {
    const c = state.overview.counts;
    $('#metric-cards').innerHTML = [
      { label: '联系人', value: c.contacts || 0 },
      { label: '长期记忆', value: c.confirmed || 0 },
      { label: '待确认', value: c.pending || 0, alert: (c.pending || 0) > 0 },
      { label: '已驳回', value: c.rejected || 0 },
    ].map((m) => `<div class="metric-card${m.alert ? ' alert' : ''}"><b>${m.value}</b><span>${m.label}</span></div>`).join('');

    $('#onboarding').classList.toggle('hidden', (c.contacts || 0) > 0);

    const queue = state.overview.pending || [];
    const queueEl = $('#pending-queue');
    if (!queue.length) {
      queueEl.innerHTML = `<div class="empty">${(c.contacts || 0) === 0 ? '还没有联系人。新建一个，或在 DSH 会话里对助手说出你想记住的事。' : '没有待确认的记忆，一切就绪。'}</div>`;
    } else {
      const toolbar = queue.length > 1
        ? `<div class="queue-toolbar"><button class="ghost-btn" data-action="confirm-all">全部确认（${queue.length} 条）</button></div>`
        : '';
      queueEl.innerHTML = toolbar + queue.map((m) => {
        const contact = state.contacts.find((x) => x.id === m.contactId);
        const editing = state.editingPendingId === m.id;
        return `
        <article class="pending-card" data-id="${esc(m.id)}">
          <div class="pending-main">
            <p class="pending-content">${editing
              ? `<textarea class="edit-area" data-role="pending-edit">${esc(m.content)}</textarea>`
              : esc(m.content)}</p>
            <div class="pending-meta">
              <span class="badge type">${TYPE_CN[m.type] || esc(m.type)}</span>
              <span class="badge">${esc(contact?.name || '未知联系人')}</span>
              ${directionLabel(m.direction) ? `<span class="badge dir">${directionLabel(m.direction)}</span>` : ''}
              ${m.occasion ? `<span class="badge occ">${esc(m.occasion)}</span>` : ''}
              ${m.date ? `<span class="badge date">事实 ${esc(fmtDate(m.date))}</span>` : ''}
              ${m.saidAt ? `<span class="badge">讲于 ${esc(m.saidAt)}</span>` : ''}
              ${m.lifespan === 'short' ? '<span class="badge short">临时</span>' : ''}
              ${m.importance === 3 ? '<span class="badge imp3">关键</span>' : ''}
              ${editing ? '' : `<span>AI 提取 · 待你确认</span>`}
            </div>
          </div>
          <div class="pending-actions">
            ${editing
              ? `<button class="primary-btn" data-action="save-edit" data-id="${esc(m.id)}">保存并确认</button>
                 <button class="ghost-btn" data-action="cancel-edit" data-id="${esc(m.id)}">取消</button>`
              : `<button class="primary-btn" data-action="confirm" data-id="${esc(m.id)}">确认</button>
                 <button class="ghost-btn" data-action="edit" data-id="${esc(m.id)}">编辑</button>
                 <button class="ghost-btn" data-action="reject" data-id="${esc(m.id)}">驳回</button>
                 <button class="ghost-btn" data-action="supersede-ask" data-id="${esc(m.id)}">被取代</button>`}
          </div>
        </article>`;
      }).join('');
    }

    renderMaterialBox();

    const upcoming = state.overview.upcoming || [];
    $('#upcoming-list').innerHTML = upcoming.length
      ? upcoming.map((u) => `<div class="upcoming-row"><span><b>${esc(u.name)}</b> <small>生日 ${esc(fmtDate(u.birthday))}</small></span><span class="badge date">${relativeDays(u.inDays)}</span></div>`).join('')
      : '<div class="empty">30 天内没有生日/纪念日。给联系人补上生日就会出现在这里。</div>';
  }

  function renderMaterialBox() {
    const box = $('#material-box');
    const list = state.materials || [];
    box.classList.toggle('hidden', list.length === 0);
    if (!list.length) return;
    $('#material-count').textContent = `· ${list.length}`;
    $('#material-list').innerHTML = list.map((mt) => {
      const pendingCount = (mt.extracted || []).filter((m) => m.status === 'pending').length;
      const statusBadge = mt.status === 'processed'
        ? `<span class="badge type">已拆出 ${mt.extracted.length} 条${pendingCount ? `，待确认 ${pendingCount} 条` : ''}</span>`
        : '<span class="badge">待 AI 整理</span>';
      return `
      <article class="material-card" data-id="${esc(mt.id)}">
        <div class="material-main">
          <p class="material-excerpt">${esc(mt.excerpt)}${mt.excerpt.length >= 120 ? '…' : ''}</p>
          <div class="material-meta">
            ${statusBadge}
            ${mt.contactName ? `<span class="badge">${esc(mt.contactName)}</span>` : ''}
            <span>${esc((mt.capturedAt || '').slice(0, 10))}</span>
          </div>
        </div>
        <div class="material-actions">
          ${pendingCount ? `<button class="primary-btn" data-action="confirm-material" data-id="${esc(mt.id)}">确认这 ${pendingCount} 条</button>` : ''}
          ${mt.status === 'raw' ? `<button class="primary-btn" data-action="organize-material" data-id="${esc(mt.id)}">AI 整理</button>` : ''}
          ${mt.status === 'raw' ? `<button class="ghost-btn" data-action="copy-material" data-id="${esc(mt.id)}">复制整理指令</button>` : ''}
          <button class="ghost-btn" data-action="delete-material" data-id="${esc(mt.id)}">删除</button>
        </div>
      </article>`;
    }).join('');
  }

  function planCard(p) {
    const productLine = p.productName || p.productUrl
      ? `<div class="occ-plan product">${p.productUrl ? `<a href="${esc(p.productUrl)}" target="_blank" rel="noreferrer">${esc(p.productName || '查看商品')} ↗</a>` : esc(p.productName)}${p.productPrice ? ` <span class="badge price">${esc(p.productPrice)}</span>` : ''}</div>`
      : '';
    return `
    <article class="occ-card">
      <div class="occ-main">
        <p class="occ-title"><b>${esc(p.contactName)}</b>${p.occasion ? ` · ${esc(p.occasion)}` : ''}${p.occasionDate ? ` · ${esc(fmtDate(p.occasionDate))}` : ''} <span class="badge type">${PLAN_STATUS_CN[p.status]}</span>${p.source === 'ai' ? ' <span class="badge">AI 建议</span>' : ''}</p>
        <div class="occ-plan">${esc(p.idea)}${p.budget ? ` <span class="muted">（预算 ${esc(p.budget)}）</span>` : ''}</div>
        ${productLine}
      </div>
      <div class="occ-actions">
        <button class="primary-btn" data-action="suggest-open" data-id="${esc(p.contactId)}" data-occasion="${esc(p.occasion || '')}" data-plan="${esc(p.id)}">AI 出主意</button>
        <span class="plan-actions">
          <button class="icon-btn" data-action="plan-edit" data-id="${esc(p.id)}">编辑</button>
          <button class="icon-btn" data-action="plan-sent" data-id="${esc(p.id)}">已送</button>
          <button class="icon-btn danger" data-action="plan-delete" data-id="${esc(p.id)}">删除</button>
        </span>
      </div>
    </article>`;
  }

  function renderGifts() {
    const { occasions, reciprocity, given, received } = state.gift;
    const plansOf = (contactId, occasion) => state.plans.filter((p) => p.contactId === contactId && (!occasion || p.occasion === occasion) && p.status !== 'sent');
    const productLine = (p) => {
      if (!p.productName && !p.productUrl) return '';
      const label = esc(p.productName || '查看商品');
      const inner = p.productUrl ? `<a href="${esc(p.productUrl)}" target="_blank" rel="noreferrer">${label} ↗</a>` : label;
      return `<div class="occ-plan product">${inner}${p.productPrice ? ` <span class="badge price">${esc(p.productPrice)}</span>` : ''}</div>`;
    };
    const planLine = (p) => `<div class="occ-plan"><span class="badge type">${PLAN_STATUS_CN[p.status]}</span> ${esc(p.idea)}${p.source === 'ai' ? ' <span class="badge">AI 建议</span>' : ''}
       ${productLine(p)}
       <span class="plan-actions"><button class="icon-btn" data-action="plan-edit" data-id="${esc(p.id)}">编辑</button><button class="icon-btn" data-action="plan-sent" data-id="${esc(p.id)}">已送</button><button class="icon-btn danger" data-action="plan-delete" data-id="${esc(p.id)}">删除</button></span></div>`;

    $('#occasions-count').textContent = `· ${occasions.length}`;
    $('#occasions-list').innerHTML = occasions.length ? occasions.map((o) => {
      const active = plansOf(o.contactId, o.occasion);
      const planLineHtml = active.length
        ? active.map(planLine).join('')
        : '<div class="occ-plan empty-plan">还没打算</div>';
      const others = state.plans.filter((p) => p.contactId === o.contactId && p.status !== 'sent' && (!o.occasion || p.occasion !== o.occasion));
      return `
      <article class="occ-card" data-contact="${esc(o.contactId)}" data-occasion="${esc(o.occasion || '')}" data-date="${esc(o.date || '')}">
        <div class="occ-main">
          <p class="occ-title"><b>${esc(o.name)}</b> · ${esc(o.label)}${o.date ? ` · ${esc(fmtDate(o.date))}` : ''} <span class="badge date">${o.inDays === 0 ? '就是今天' : `还有 ${o.inDays} 天`}</span></p>
          ${planLineHtml}
          ${others.length ? `<div class="occ-plan muted">其他计划：${others.map((p) => esc(p.idea)).join('；')}</div>` : ''}
        </div>
        <div class="occ-actions">
          <button class="primary-btn" data-action="suggest-open" data-contact="${esc(o.contactId)}" data-occasion="${esc(o.occasion || '')}" data-date="${esc(o.date || '')}">AI 出主意</button>
          ${active.length ? '' : `<button class="ghost-btn" data-action="plan-open" data-contact="${esc(o.contactId)}" data-occasion="${esc(o.occasion || '')}" data-date="${esc(o.date || '')}">记个想法</button>`}
        </div>
      </article>`;
    }).join('') : '<div class="empty">30 天内没有生日和相关节日。已有计划在下方「进行中的计划」，可以直接在计划卡上点「AI 出主意」。</div>';

    $('#reciprocity-count').textContent = `· ${reciprocity.length}`;
    $('#reciprocity-list').innerHTML = reciprocity.length ? reciprocity.map((r) => `
      <article class="occ-card reciprocity">
        <div class="occ-main">
          <p class="occ-title"><b>${esc(r.name)}</b> 在 ${esc(fmtDate(r.date))} 送了：${esc(r.content)} <span class="badge dir">TA→我</span></p>
          ${r.hasActivePlan ? '<div class="occ-plan muted">已有回礼计划 ✓</div>' : '<div class="occ-plan empty-plan">还没回礼</div>'}
        </div>
        <div class="occ-actions">
          ${r.hasActivePlan ? '' : `<button class="ghost-btn" data-action="plan-open" data-contact="${esc(r.contactId)}" data-occasion="thank_you">记回礼计划</button>`}
        </div>
      </article>`).join('') : '<div class="empty">没有待回应的人情。收到的礼物会记在台账里。</div>';

    const ledgerRow = (m, dirBadge) => `
      <div class="ledger-row" data-id="${esc(m.id)}">
        <span class="when">${esc(fmtDate(m.date))}</span>
        <span class="what"><b>${esc(m.contactName)}</b> · ${esc(m.content)} ${dirBadge ? `<span class="badge dir">${dirBadge}</span>` : ''}${m.occasion ? `<span class="badge occ">${esc(m.occasion)}</span>` : ''}</span>
      </div>`;
    $('#ledger-given').innerHTML = given.length ? given.map((m) => ledgerRow(m)).join('') : '<div class="empty">还没有送出记录。计划标「已送」后自动入账。</div>';
    $('#ledger-received').innerHTML = received.length ? received.map((m) => ledgerRow(m, 'TA→我')).join('') : '<div class="empty">还没有收礼记录。</div>';

    // 进行中的计划：未被时机窗口覆盖的未送计划也要有安身处
    const covered = new Set();
    for (const o of occasions) for (const p of plansOf(o.contactId, o.occasion)) covered.add(p.id);
    const rest = state.plans.filter((p) => p.status !== 'sent' && !covered.has(p.id));
    $('#plans-section').classList.toggle('hidden', !rest.length);
    $('#plans-list').innerHTML = rest.map(planCard).join('');
  }

  function renderContacts() {
    const listEl = $('#contact-list');
    if (!state.contacts.length) {
      listEl.innerHTML = '<div class="empty">还没有联系人。</div>';
    } else {
      listEl.innerHTML = state.contacts.map((c) => `
        <button type="button" class="contact-row${c.id === state.activeContactId ? ' active' : ''}" data-id="${esc(c.id)}">
          <span class="avatar">${esc(initial(c.name))}</span>
          <span class="who"><b>${esc(c.name)}</b><small>${RELATION_CN[c.relation] || esc(c.relation)}${c.tags.length ? ' · ' + esc(c.tags.join(' / ')) : ''}</small></span>
          ${c.archived ? '<span class="badge archived-tag">已归档</span>' : ''}
        </button>`).join('');
    }

    const detail = $('#contact-detail');
    const t = state.timeline;
    if (!t.contact) {
      detail.classList.add('hidden');
      detail.innerHTML = '';
      return;
    }
    detail.classList.remove('hidden');
    const c = t.contact;
    const types = new Set(t.memories.map((m) => m.type));
    const chips = [
      `<button type="button" class="chip${state.typeFilter === 'all' ? ' active' : ''}" data-type="all">全部 · ${t.memories.length}</button>`,
      ...TYPE_ORDER.filter((x) => types.has(x)).map((x) =>
        `<button type="button" class="chip${state.typeFilter === x ? ' active' : ''}" data-type="${x}">${TYPE_CN[x]} · ${t.memories.filter((m) => m.type === x).length}</button>`),
    ].join('');
    const shown = state.typeFilter === 'all' ? t.memories : t.memories.filter((m) => m.type === state.typeFilter);

    detail.innerHTML = `
      <div class="detail-head">
        <div>
          <h2>${esc(c.name)}</h2>
          <div class="detail-meta">
            <span class="badge type">${RELATION_CN[c.relation] || esc(c.relation)}</span>
            ${c.birthday ? `<span class="badge date">生日 ${esc(fmtDate(c.birthday))}</span>` : ''}
            ${c.tags.map((x) => `<span class="badge">${esc(x)}</span>`).join('')}
          </div>
        </div>
        <div class="detail-actions">
          <button class="ghost-btn" data-action="toggle-archive" data-id="${esc(c.id)}">${c.archived ? '取消归档' : '归档'}</button>
          <button class="ghost-btn" data-action="delete-contact" data-id="${esc(c.id)}">删除</button>
        </div>
      </div>
      <div class="chip-row">${chips}</div>
      <div class="timeline">
        ${shown.length ? shown.map((m) => {
          const editing = state.editingMemoryId === m.id;
          return `
          <div class="memory-row" data-id="${esc(m.id)}">
            <span class="when">${esc(fmtDate(m.date)) || esc((m.createdAt || '').slice(0, 10))}</span>
            <span class="what">${editing
              ? `<textarea class="edit-area" data-role="memory-edit">${esc(m.content)}</textarea>
                 <button class="icon-btn" data-action="save-memory" data-id="${esc(m.id)}">保存</button>
                 <button class="icon-btn" data-action="cancel-memory" data-id="${esc(m.id)}">取消</button>`
              : `${esc(m.content)} <span class="badge type">${TYPE_CN[m.type] || esc(m.type)}</span>${directionLabel(m.direction) ? ` <span class="badge dir">${directionLabel(m.direction)}</span>` : ''}${m.occasion ? ` <span class="badge occ">${esc(m.occasion)}</span>` : ''}${m.importance === 3 ? ' <span class="badge imp3">关键</span>' : ''}${m.saidAt ? ` <span class="badge">讲于 ${esc(m.saidAt)}</span>` : ''}`}</span>
            <span class="row-actions">
              ${editing ? '' : `<button class="icon-btn" data-action="edit-memory" data-id="${esc(m.id)}">编辑</button>
                                <button class="icon-btn danger" data-action="delete-memory" data-id="${esc(m.id)}">删除</button>`}
            </span>
          </div>`;
        }).join('') : '<div class="empty">还没有已确认的长期记忆。</div>'}
      </div>
      ${(t.shortItems || []).length ? `
      <div class="short-section">
        <h4>临时事项（不进长期画像）</h4>
        ${t.shortItems.map((m) => `
        <div class="memory-row short-row" data-id="${esc(m.id)}">
          <span class="when">${esc(fmtDate(m.date)) || esc((m.createdAt || '').slice(0, 10))}</span>
          <span class="what">${esc(m.content)} <span class="badge short">临时</span>${directionLabel(m.direction) ? ` <span class="badge dir">${directionLabel(m.direction)}</span>` : ''}</span>
          <span class="row-actions">
            <button class="icon-btn" data-action="delete-memory" data-id="${esc(m.id)}">删除</button>
          </span>
        </div>`).join('')}
      </div>` : ''}`;
  }

  // ---------- 事件 ----------
  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('.nav-item');
    if (nav) {
      state.view = nav.dataset.view;
      render();
      return;
    }

    const row = e.target.closest('.contact-row');
    if (row) {
      state.activeContactId = row.dataset.id;
      state.typeFilter = 'all';
      await refresh();
      return;
    }

    const chip = e.target.closest('.chip');
    if (chip) {
      state.typeFilter = chip.dataset.type;
      render();
      return;
    }

    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    const id = actionBtn.dataset.id;

    try {
      if (action === 'confirm') {
        await api('/api/memories/confirm', { method: 'POST', body: { ids: [id] } });
        toast('已确认进入长期记忆');
        await refresh();
      } else if (action === 'confirm-all') {
        const ids = (state.overview.pending || []).map((m) => m.id);
        if (!ids.length) return;
        await api('/api/memories/confirm', { method: 'POST', body: { ids } });
        toast(`已确认 ${ids.length} 条进入长期记忆`);
        await refresh();
      } else if (action === 'confirm-material') {
        const mt = state.materials.find((x) => x.id === id);
        const ids = (mt?.extracted || []).filter((m) => m.status === 'pending').map((m) => m.id);
        if (!ids.length) return;
        await api('/api/memories/confirm', { method: 'POST', body: { ids } });
        toast(`已确认 ${ids.length} 条素材记忆`);
        await refresh();
      } else if (action === 'organize-material') {
        // 一键交给宿主 AI：嵌入模式直连 DSH 会话；独立模式提示走复制指令
        await organizeViaHost(id);
      } else if (action === 'copy-material') {
        // 整理指令由后端从提示词注册表（server/prompts.js）拼装，前端不再手写模板
        try {
          const { prompt } = await api(`/api/materials/${id}/organize-prompt`);
          await navigator.clipboard.writeText(prompt);
          toast('整理提示词已复制，粘贴到 DSH 会话即可');
        } catch (e) { toast(e.message || '复制失败，请手动复制素材 ID：' + id, true); }
      } else if (action === 'delete-material') {
        if (!window.confirm('删除这段素材？已拆出的记忆不受影响。')) return;
        await api(`/api/materials/${id}`, { method: 'DELETE' });
        toast('已删除素材');
        await refresh();
      } else if (action === 'suggest-open') {
        // 时机卡按钮带 data-contact，计划卡按钮带 data-id，两处都可能是入口
        const contactId = id || actionBtn.dataset.contact;
        if (!contactId) { toast('缺少联系人信息', true); return; }
        const card = actionBtn.closest('[data-occasion]');
        const occasion = card?.dataset.occasion || actionBtn.dataset.occasion || '';
        $('#suggest-target').dataset.occasion = occasion;
        await openSuggestModal(contactId, occasion, actionBtn.dataset.plan || '');
      } else if (action === 'plan-open') {
        const card = actionBtn.closest('[data-contact]');
        openPlanModal(id, card?.dataset.occasion || '', card?.dataset.date || '');
      } else if (action === 'plan-edit') {
        openPlanModal(undefined, undefined, undefined, state.plans.find((p) => p.id === id));
      } else if (action === 'plan-delete') {
        if (!window.confirm('删除这个礼物计划？')) return;
        await api(`/api/plans/${id}`, { method: 'DELETE' });
        toast('已删除计划');
        await refresh();
      } else if (action === 'plan-sent') {
        await api(`/api/plans/${id}/sent`, { method: 'POST' });
        toast('已入台账，礼物记忆已记入时间线');
        await refresh();
      } else if (action === 'edit') {
        state.editingPendingId = id;
        render();
      } else if (action === 'cancel-edit') {
        state.editingPendingId = null;
        render();
      } else if (action === 'save-edit') {
        const card = actionBtn.closest('.pending-card');
        const content = $('[data-role="pending-edit"]', card).value.trim();
        if (!content) return toast('内容不能为空', true);
        await api('/api/memories/confirm', { method: 'POST', body: { ids: [id], edits: { [id]: { content } } } });
        state.editingPendingId = null;
        toast('已保存并确认');
        await refresh();
      } else if (action === 'reject') {
        await api(`/api/memories/${id}/reject`, { method: 'POST', body: {} });
        toast('已驳回（可在需要时恢复）');
        await refresh();
      } else if (action === 'supersede-ask') {
        const keepId = window.prompt('这条记忆被哪条已确认记忆取代了？粘贴那条记忆的 ID（m_ 开头，时间线里可查）：');
        if (!keepId) return;
        try {
          await api('/api/memories/supersede', { method: 'POST', body: { id, keepId: keepId.trim() } });
          toast('已标记被取代（不再出现在时间线与检索）');
          await refresh();
        } catch (e) { toast(e.message || '取代失败', true); }
      } else if (action === 'edit-memory') {
        state.editingMemoryId = id;
        render();
      } else if (action === 'cancel-memory') {
        state.editingMemoryId = null;
        render();
      } else if (action === 'save-memory') {
        const rowEl = actionBtn.closest('.memory-row');
        const content = $('[data-role="memory-edit"]', rowEl).value.trim();
        if (!content) return toast('内容不能为空', true);
        await api(`/api/memories/${id}`, { method: 'PATCH', body: { content } });
        state.editingMemoryId = null;
        toast('已保存');
        await refresh();
      } else if (action === 'delete-memory') {
        if (!window.confirm('删除这条记忆？删除即真删，不可恢复。')) return;
        await api(`/api/memories/${id}`, { method: 'DELETE' });
        toast('已删除');
        await refresh();
      } else if (action === 'toggle-archive') {
        const contact = state.contacts.find((x) => x.id === id);
        await api(`/api/contacts/${id}`, { method: 'PATCH', body: { archived: !contact?.archived } });
        toast(contact?.archived ? '已取消归档' : '已归档');
        await refresh();
      } else if (action === 'delete-contact') {
        if (!window.confirm('删除该联系人及其全部记忆？删除即真删，不可恢复。')) return;
        const r = await api(`/api/contacts/${id}`, { method: 'DELETE' });
        toast(`已删除联系人（含 ${r.removedMemories} 条记忆）`);
        await refresh();
      }
    } catch (err) {
      toast(err.message || '操作失败', true);
    }
  });

  // ---------- 弹窗 ----------
  function applyTab() {
    $$('.mtab').forEach((t) => t.classList.toggle('active', t.dataset.mtab === state.smartTab));
    $('#form-quick-memory').classList.toggle('hidden', state.smartTab !== 'single');
    $('#form-smart').classList.toggle('hidden', state.smartTab !== 'smart');
  }

  function fillContactSelects() {
    const options = state.contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#qm-contact').innerHTML = options;
    $('#qmt-contact').innerHTML = '<option value="">自动识别（可能涉及多人）</option>' + options;
  }

  function openModal(which) {
    $('#modal-backdrop').classList.remove('hidden');
    $('#form-contact').classList.toggle('hidden', which !== 'contact');
    const isMemory = which === 'memory';
    $$('.modal-tabs').forEach((t) => t.classList.toggle('hidden', !isMemory));
    if (isMemory) {
      state.smartTab = 'single';
      fillContactSelects();
      applyTab();
    }
    $('#form-plan').classList.toggle('hidden', which !== 'plan');
    $('#form-suggest').classList.toggle('hidden', which !== 'suggest');
    ($(`#${which === 'contact' ? 'nc-name' : which === 'plan' ? 'plan-contact' : which === 'suggest' ? 'suggest-list' : 'qm-content'}`))?.focus?.();
  }
  function closeModal() {
    $('#modal-backdrop').classList.add('hidden');
    $('#form-contact').reset();
    $('#form-quick-memory').reset();
    $('#form-plan').reset();
    $('#form-suggest').reset();
    state.editingPlanId = null;
    state.suggestContactId = null;
    state.suggestPlanId = null;
  }
  $('#btn-new-contact').addEventListener('click', () => openModal('contact'));
  $('#btn-quick-memory').addEventListener('click', () => {
    if (!state.contacts.length) { toast('先新建一个联系人', true); openModal('contact'); return; }
    openModal('memory');
  });
  $('#nc-cancel').addEventListener('click', closeModal);
  $('#qm-cancel').addEventListener('click', closeModal);
  $('#qmt-cancel').addEventListener('click', closeModal);
  $$('#modal-backdrop [data-role="plan-cancel"]').forEach((btn) => btn.addEventListener('click', closeModal));
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target === $('#modal-backdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.mtab');
    if (!tab) return;
    state.smartTab = tab.dataset.mtab;
    applyTab();
  });

  $('#form-contact').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tags = $('#nc-tags').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    try {
      await api('/api/contacts', { method: 'POST', body: { name: $('#nc-name').value, relation: $('#nc-relation').value, birthday: $('#nc-birthday').value.trim(), tags } });
      closeModal();
      toast('联系人已创建');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  $('#form-quick-memory').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/memories', {
        method: 'POST',
        body: {
          contactId: $('#qm-contact').value,
          type: $('#qm-type').value,
          content: $('#qm-content').value,
          date: $('#qm-date').value.trim(),
          importance: Number($('#qm-importance').value),
          direction: $('#qm-direction').value,
          occasion: $('#qm-occasion').value,
        },
      });
      closeModal();
      toast('已记录为长期记忆');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  $('#form-smart').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/materials', {
        method: 'POST',
        body: { text: $('#qmt-text').value, contactId: $('#qmt-contact').value, occasion: $('#qmt-occasion').value },
      });
      closeModal();
      toast('素材已保存，去 DSH 会话说「整理素材」');
      state.view = 'home'; // 素材卡在首页，保存后带用户回去看
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- 礼赠 ----------
  function fillPlanContacts(selected) {
    $('#plan-contact').innerHTML = state.contacts.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  function openPlanModal(contactId, occasion, occasionDate, plan) {
    if (!state.contacts.length) { toast('先到「联系人」新建一个联系人', true); return; }
    fillPlanContacts(contactId || state.contacts[0]?.id);
    $('#plan-occasion').value = occasion || plan?.occasion || '';
    $('#plan-date').value = occasionDate || plan?.occasionDate || '';
    $('#plan-idea').value = plan?.idea || '';
    $('#plan-budget').value = plan?.budget || '';
    $('#plan-product-name').value = plan?.productName || '';
    $('#plan-product-price').value = plan?.productPrice || '';
    $('#plan-product-url').value = plan?.productUrl || '';
    $('#plan-status').value = plan?.status && plan.status !== 'sent' ? plan.status : 'idea';
    state.editingPlanId = plan?.id || null;
    openModal('plan');
  }

  $('#btn-new-plan').addEventListener('click', () => openPlanModal());

  async function openSuggestModal(contactId, occasion, planId) {
    const c = state.contacts.find((x) => x.id === contactId);
    if (!c) { toast('联系人不存在', true); return; }
    const plan = planId ? state.plans.find((p) => p.id === planId) : null;
    state.suggestContactId = contactId;
    state.suggestPlanId = plan?.id || null;
    $('#suggest-target').innerHTML = `为 <b>${esc(c.name)}</b>${occasion ? ` · ${esc(occasion)}` : ''}${plan ? ` · 围绕已有计划「${esc(plan.idea)}」` : ''} 出主意`;
    const list = $('#suggest-list');
    list.innerHTML = '<div class="empty">正在读取记忆…</div>';
    openModal('suggest');
    try {
      const r = await api(`/api/memories?contact_id=${contactId}&status=confirmed`);
      const relevant = r.memories.filter((m) => ['preference', 'dislike', 'taboo', 'gift', 'attribute', 'event'].includes(m.type) && !m.supersededBy);
      if (!relevant.length) {
        list.innerHTML = '<div class="empty">该联系人还没有已确认记忆。先在聊天里让我记一些喜好/禁忌，AI 的建议才有依据。</div>';
        $('#suggest-ok').disabled = true;
        return;
      }
      $('#suggest-ok').disabled = false;
      list.innerHTML = relevant.map((m) => `
        <label class="suggest-item">
          <input type="checkbox" value="${esc(m.id)}" ${['preference', 'dislike', 'taboo', 'gift'].includes(m.type) ? 'checked' : ''}/>
          <span><span class="badge type">${TYPE_CN[m.type] || esc(m.type)}</span> ${esc(m.content)}</span>
        </label>`).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  $('#form-suggest').addEventListener('submit', async (e) => {
    e.preventDefault();
    const contactId = state.suggestContactId;
    const memoryIds = $$('#suggest-list input[type="checkbox"]:checked').map((x) => x.value);
    const budget = $('#suggest-budget').value.trim();
    const occasion = $('#suggest-target').dataset.occasion || '';
    try {
      const { prompt, evidenceCount } = await api('/api/gift-suggest', { method: 'POST', body: { contactId, memoryIds, budget, occasion, planId: state.suggestPlanId || undefined } });
      const sessionId = await ensureDshSession();
      const requestId = globalThis.crypto?.randomUUID?.() || `rel-gift-${Date.now()}`;
      await dshRpc('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      closeModal();
      toast(evidenceCount ? '已交给 AI 出主意，方案卡会出现在下面' : 'AI 会给通用建议，建议先为 TA 补些记忆');
    } catch (err) { toast(err.message, true); }
  });

  $('#form-plan').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      contactId: $('#plan-contact').value,
      occasion: $('#plan-occasion').value,
      occasionDate: $('#plan-date').value.trim(),
      idea: $('#plan-idea').value,
      budget: $('#plan-budget').value,
      productName: $('#plan-product-name').value,
      productPrice: $('#plan-product-price').value,
      productUrl: $('#plan-product-url').value.trim(),
      status: $('#plan-status').value,
    };
    try {
      if (state.editingPlanId) await api(`/api/plans/${state.editingPlanId}`, { method: 'PATCH', body });
      else await api('/api/plans', { method: 'POST', body });
      closeModal();
      toast('计划已保存');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- SSE ----------
  function connectEvents() {
    const es = new EventSource('api/events');
    const relevant = ['memory.changed', 'contact.changed', 'material.changed', 'plan.changed', 'overview'];
    for (const name of relevant) es.addEventListener(name, scheduleRefresh);
    es.onopen = () => markStatus(true);
    es.onerror = () => markStatus(false);
  }

  // ---------- 启动 ----------
  api('api/info').then((info) => { state.info = info || {}; }).catch(() => {});
  connectEvents();
  refresh();
})();
