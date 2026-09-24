// 关系记忆工作台前端：首页待确认队列、联系人时间线、手动录入
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const RELATION_CN = { family: '家人', friend: '朋友', colleague: '同事', client: '客户', partner: '伙伴', other: '其他' };
  // 关系类型显示名：优先用服务端注册表的 label，回退到内置映射，再回退到原始 key（均已转义）
  function relationCn(key) {
    const t = state.relationTypes.find((x) => x.key === key);
    return esc(t?.label || RELATION_CN[key] || key);
  }
  const TYPE_CN = { preference: '喜好', dislike: '不喜好', taboo: '禁忌', event: '事件', gift: '礼物', promise: '承诺', interaction: '往来', attribute: '基础' };
  const TYPE_ORDER = ['event', 'preference', 'dislike', 'taboo', 'gift', 'promise', 'interaction', 'attribute'];

  const state = {
    view: 'home',
    contacts: [],
    overview: { counts: {}, pending: [], upcoming: [] },
    materials: [],
    attention: [],
    handledFollowups: [],
    followupBusy: new Set(),
    materialSending: new Set(),
    confirming: false,
    occasionGroups: [],
    disclosures: new Map(),
    holidays: [],
    opportunities: [],
    recent: [],
    firstScenario: 'say',
    activeContactId: null,
    timeline: { contact: null, memories: [] },
    typeFilter: 'all',
    memorySearchQuery: '',
    memorySearchResults: [],
    memorySearchLoading: false,
    editingPendingId: null,
    editingMemoryId: null,
    // 嵌入 DSH（同源 iframe）时可直连宿主：建会话、发 prompt
    dshEmbedded: location.pathname.startsWith('/api/dsh-relationship/workbench'),
    info: {},
    plans: [],
    gift: { occasions: [], reciprocity: [], given: [], received: [] },
    editingPlanId: null,
    editingContactId: null,
    suggestContactId: null,
    suggestPlanId: null,
    supersedeMemoryId: null,
    supersedeContactId: null,
    relationTypes: [],
    // 「AI 正在想」等待键（如 brief:c1 / gift:c1 / att:gift:c1）：存 state 而非 DOM，
    // SSE 重渲染换新节点也不丢等待态；askHostAi 收尾时清除
    aiWaiting: new Set(),
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
  const PLAN_STATUS_CN = { idea: '想法', decided: '已定', sent: '已送出礼物', done: '已完成' };
  const activePlan = (p) => !['sent', 'done'].includes(p.status);
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

  // 页面内确认/输入对话框：iframe 沙箱里 window.confirm/prompt 的返回值在 Electron
  // 下经常拿不回来（弹窗能弹、点击结果不回传，confirm() 返回 falsy 导致删除静默失效），
  // 一律改用 DOM 对话框。
  let dialogResolver = null;
  let dialogTrigger = null;
  let modalTrigger = null;
  let sendingSuggestion = false;
  function topModal() {
    return $('#rel-dialog') || $('#modal-backdrop:not(.hidden)');
  }
  function focusableIn(root) {
    return $$('button, input, select, textarea, a[href], summary, [tabindex]', root)
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert]'));
  }
  function syncModalBackground() {
    const dialog = $('#rel-dialog');
    const open = Boolean(topModal());
    $('#topbar').inert = open;
    $('#app-shell').inert = open;
    $('#modal-backdrop').inert = Boolean(dialog);
  }
  function restoreFocus(trigger) {
    const root = topModal();
    const target = trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]')
      ? trigger : (root ? focusableIn(root)[0] : $('.nav-item.active'));
    target?.focus({ preventScroll: true });
  }
  function closeDialog(value) {
    const bd = $('#rel-dialog');
    if (!bd) return;
    bd.remove();
    const r = dialogResolver; dialogResolver = null;
    syncModalBackground();
    restoreFocus(dialogTrigger);
    dialogTrigger = null;
    if (r) r(value);
  }
  // confirmDialog(msg) → Promise<boolean>；promptDialog(msg, placeholder) → Promise<string|null>
  function confirmDialog(msg, { danger = false } = {}) {
    return new Promise((resolve) => {
      closeDialog(null); // 顺带清掉残留对话框
      dialogResolver = resolve;
      dialogTrigger = document.activeElement;
      const bd = document.createElement('div');
      bd.id = 'rel-dialog';
      bd.className = 'modal-backdrop';
      bd.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true">
        <div class="modal-body">
          <h3>${danger ? '危险操作' : '请确认'}</h3>
          <p style="margin:0;font-size:13.5px;line-height:1.6;white-space:pre-wrap">${esc(msg)}</p>
          <div class="modal-actions">
            <button type="button" id="rel-dialog-cancel" class="ghost-btn">取消</button>
            <button type="button" id="rel-dialog-ok" class="primary-btn" ${danger ? 'style="background:#c0392b"' : ''}>确定</button>
          </div>
        </div></div>`;
      document.body.appendChild(bd);
      syncModalBackground();
      $('#rel-dialog-cancel').onclick = () => closeDialog(false);
      $('#rel-dialog-ok').onclick = () => closeDialog(true);
      bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeDialog(false); });
      $(danger ? '#rel-dialog-cancel' : '#rel-dialog-ok').focus();
    });
  }
  function promptDialog(msg, placeholder = '', { type = 'text', min = '', value = '' } = {}) {
    return new Promise((resolve) => {
      closeDialog(null);
      dialogResolver = resolve;
      dialogTrigger = document.activeElement;
      const bd = document.createElement('div');
      bd.id = 'rel-dialog';
      bd.className = 'modal-backdrop';
      bd.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <div class="modal-body">
          <h3>请输入</h3>
          <p style="margin:0;font-size:13.5px;line-height:1.6">${esc(msg)}</p>
          <input id="rel-dialog-input" type="${esc(type)}" aria-label="${esc(msg)}" placeholder="${esc(placeholder)}" min="${esc(min)}" value="${esc(value)}" ${type === 'date' ? 'required' : ''} style="padding:8px 10px;border:1px solid var(--border);border-radius:8px">
          <div class="modal-actions">
            <button type="button" id="rel-dialog-cancel" class="ghost-btn">取消</button>
            <button type="button" id="rel-dialog-ok" class="primary-btn">确定</button>
          </div>
        </div></div>`;
      document.body.appendChild(bd);
      syncModalBackground();
      const input = $('#rel-dialog-input');
      const submit = () => { if (input.reportValidity()) closeDialog(input.value.trim() || null); };
      $('#rel-dialog-cancel').onclick = () => closeDialog(null);
      $('#rel-dialog-ok').onclick = submit;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeDialog(null); });
      input.focus();
    });
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
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let memorySearchSeq = 0;
  let memorySearchTimer = null;
  let memorySearchComposing = false;
  async function runMemorySearch(query) {
    const contactId = state.activeContactId;
    const seq = ++memorySearchSeq;
    state.memorySearchQuery = query;
    state.memorySearchResults = [];
    if (!query.trim() || !contactId) {
      state.memorySearchLoading = false;
      render();
      return;
    }
    state.memorySearchLoading = true;
    render();
    try {
      const r = await api(`/api/contacts/${contactId}/memory-search?q=${encodeURIComponent(query.trim())}`);
      if (seq !== memorySearchSeq || contactId !== state.activeContactId) return;
      state.memorySearchResults = r.memories || [];
    } catch (e) {
      if (seq === memorySearchSeq) toast(e.message || '搜索失败', true);
    } finally {
      if (seq === memorySearchSeq) {
        state.memorySearchLoading = false;
        render();
      }
    }
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

  /** 直连宿主关系记忆会话发送一条文本（AI 整理 / 「再告诉我一点」作答共用）。 */
  async function sendToSession(text) {
    const sessionId = await ensureDshSession();
    const requestId = globalThis.crypto?.randomUUID?.() || `rel-prompt-${Date.now()}`;
    await dshRpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  async function deliverMaterial(materialId, copy = !state.dshEmbedded) {
    if (state.materialSending.has(materialId)) return;
    state.materialSending.add(materialId);
    render();
    try {
      try {
        if (copy) {
          const { prompt } = await api(`/api/materials/${materialId}/organize-prompt`);
          await navigator.clipboard.writeText(prompt);
        } else {
          await sendToSession(`整理素材 ${materialId}`);
        }
      } catch (error) {
        toast(`素材已保存，但指令未${copy ? '复制' : '发送'}；可在素材卡重试或选择「手动复制」。${error.message}`, true);
        return;
      }
      try {
        await api(`/api/materials/${materialId}/delivery`, { method: 'POST', body: { status: copy ? 'copied' : 'sent' } });
        toast(copy ? '素材已保存，整理指令已复制；粘贴到 DSH 会话后开始整理' : '素材已保存，整理指令已发送到 DSH；等待整理报告，核对后再确认');
      } catch {
        toast(`指令已${copy ? '复制' : '发送'}，但状态保存失败；不要重复发送，请先查看 DSH 会话`, true);
      }
    } finally {
      state.materialSending.delete(materialId);
      await refresh();
    }
  }

  /** 从 DSH 会话事件的内容块数组提取纯文本（同 dsh-qa contentText）。 */
  function contentText(content) {
    return (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n').trim();
  }

  /** 通过 WebSocket 获取 DSH 会话快照（session/follow，同 dsh-qa），用于读 AI 回复。 */
  function dshFollowSnapshot(sessionId, maxMessages = 30) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const streamId = globalThis.crypto?.randomUUID?.() || `rel-follow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${scheme}//${location.host}/api/remote.mux`);
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* ignore */ }
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('DSH 会话快照超时')), 10000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } },
      })));
      socket.addEventListener('message', (event) => {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.streamId !== streamId) return;
        if (frame.type === 'item' && frame.value?.type === 'snapshot') {
          clearTimeout(timer); finish(resolve, frame.value); return;
        }
        if (frame.type === 'error') { clearTimeout(timer); finish(reject, new Error(frame.error?.message || 'DSH 会话快照失败')); }
      });
      socket.addEventListener('error', () => { clearTimeout(timer); finish(reject, new Error('DSH 会话 WebSocket 连接失败')); });
      socket.addEventListener('close', () => { if (!settled) { clearTimeout(timer); finish(reject, new Error('DSH 会话 WebSocket 已关闭')); } });
    });
  }

  /**
   * 嵌入模式：把 prompt 交给宿主 AI 并轮询会话快照，等新 AI 回复就地弹层展示——
   * 解决「发完指令要手动切去 DSH 会话看结果」的动线断裂。
   * 等待态走 state.aiWaiting（SSE 重渲染不丢）；成功弹层并 refresh（AI 建的卡落到工作台），
   * 超时回退提示去会话看。
   */
  async function askHostAi(prompt, { title, waitingKey, onSent } = {}) {
    if (waitingKey) {
      if (state.aiWaiting.has(waitingKey)) { toast('AI 正在想，稍候…'); return; }
      state.aiWaiting.add(waitingKey);
      render();
    }
    try {
      const sessionId = await ensureDshSession();
      // 基线：发出前会话里最大的事件序号，之后只认 seq 更大的 AI 回复（不误收历史消息）
      let baseSeq = 0;
      try {
        const base = await dshFollowSnapshot(sessionId, 1);
        baseSeq = Math.max(0, ...(base.records || []).map((r) => r?.event?.seq ?? 0));
      } catch { /* 基线快照失败也能继续：退化为「会话里出现新 AI 回复即展示」 */ }
      await sendToSession(prompt);
      onSent?.();
      const deadline = Date.now() + 90000;
      for (;;) {
        if (Date.now() > deadline) { toast('AI 还在生成，稍后到 DSH 会话里看结果'); return; }
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const snap = await dshFollowSnapshot(sessionId, 12);
          const fresh = (snap.records || [])
            .filter((r) => r?.event?.type === 'assistant/message' && (r.event.seq ?? 0) > baseSeq)
            .map((r) => contentText(r.event.data?.message?.content))
            .filter(Boolean);
          if (fresh.length) { showAiResult(title, fresh.join('\n\n')); return; }
        } catch { /* 轮询中单次快照失败忽略，等下一轮 */ }
      }
    } finally {
      if (waitingKey) state.aiWaiting.delete(waitingKey);
      render();
      refresh().catch(() => {});
    }
  }

  /** 弹层展示 AI 回复正文（textContent 防注入，换行样式由 CSS pre-wrap 保留）。 */
  function showAiResult(title, text) {
    $('#airesult-title').textContent = title || 'AI 建议';
    $('#airesult-body').textContent = text || '（AI 没有给出文字回复，可到 DSH 会话查看）';
    openModal('airesult');
  }

  // ---------- 数据刷新 ----------
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  }

  async function refresh() {
    try {
      const [overview, contacts, materials, gifts, relations, attention, recent] = await Promise.all([
        api('/api/overview'), api('/api/contacts'), api('/api/materials'),
        api('/api/gifts/occasions').catch(() => null),
        api('/api/relations').catch(() => ({ relationTypes: [] })),
        api('/api/attention').catch(() => null),
        api('/api/memories/recent?limit=5').catch(() => null),
      ]);
      state.overview = overview;
      state.contacts = contacts.contacts;
      if (!$('#modal-backdrop').classList.contains('hidden') &&
          (!$('#form-smart').classList.contains('hidden') || !$('#form-quick-memory').classList.contains('hidden'))) {
        fillContactSelects({ preserveSelection: true });
      }
      state.materials = materials.materials;
      state.attention = attention === null ? null : (attention.items || []);
      state.handledFollowups = attention?.handledFollowups || [];
      state.occasionGroups = attention?.occasionGroups || [];
      state.holidays = attention === null ? [] : (attention.holidays || []);
      state.opportunities = attention === null ? [] : (attention.opportunities || []);
      state.recent = recent ? (recent.items || []) : [];
      state.relationTypes = relations.relationTypes || [];
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
        const contactId = state.activeContactId;
        try {
          const timeline = await api(`/api/contacts/${contactId}/timeline`);
          if (state.activeContactId === contactId) state.timeline = timeline;
          const query = state.memorySearchQuery.trim();
          if (query && state.activeContactId === contactId) {
            const seq = memorySearchSeq;
            const r = await api(`/api/contacts/${contactId}/memory-search?q=${encodeURIComponent(query)}`);
            if (state.activeContactId === contactId && memorySearchSeq === seq && state.memorySearchQuery.trim() === query) {
              state.memorySearchResults = r.memories || [];
              state.memorySearchLoading = false;
            }
          }
        }
        catch (e) {
          if (state.activeContactId === contactId) {
            state.timeline = { contact: null, memories: [] };
            if (e && e.status === 404) state.activeContactId = null;
          }
        }
      } else {
        state.timeline = { contact: null, memories: [] };
        state.memorySearchQuery = '';
        state.memorySearchResults = [];
        state.memorySearchLoading = false;
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
  function disclosureAttrs(key, defaultOpen = false) {
    const open = state.disclosures.get(key) ?? defaultOpen;
    return `data-disclosure="${esc(key)}"${open ? ' open' : ''}`;
  }

  function render() {
    $$('details[data-disclosure]').forEach((el) => state.disclosures.set(el.dataset.disclosure, el.open));
    // 保存全部在编字段，而非仅焦点所在的文本框；弹窗不参与重建。
    const active = document.activeElement;
    const focusedDisclosure = active?.matches('summary') ? active.parentElement.dataset.disclosure : null;
    const contactFocus = active?.closest('#view-contacts') ? {
      id: active.id, action: active.dataset.action, contactId: active.dataset.id,
      row: active.matches('.contact-row'),
    } : null;
    const drafts = $$('.pending-card, .memory-row')
      .filter((el) => el.dataset.id === state.editingPendingId || el.dataset.id === state.editingMemoryId)
      .map((el) => ({
        id: el.dataset.id,
        fields: $$('textarea[data-role], input[data-role], select[data-role]', el).map((field) => ({
          role: field.dataset.role, value: field.value, focused: field === active,
          s0: field.selectionStart, s1: field.selectionEnd,
        })),
      }));
    renderNav();
    if (state.view === 'home') renderHome();
    else if (state.view === 'gifts') renderGifts();
    else renderContacts();
    for (const draft of drafts) {
      const card = $$('.pending-card, .memory-row').find((el) => el.dataset.id === draft.id);
      if (!card) continue;
      for (const saved of draft.fields) {
        const again = $(`[data-role="${saved.role}"]`, card);
        if (!again) continue;
        again.value = saved.value;
        if (saved.focused) {
          again.focus({ preventScroll: true });
          try { again.setSelectionRange(saved.s0, saved.s1); } catch { /* select 无光标 */ }
        }
      }
    }
    if (contactFocus && !active.isConnected && state.view === 'contacts') {
      const target = contactFocus.id ? document.getElementById(contactFocus.id)
        : $$('#view-contacts button').find((el) => el.dataset.id === contactFocus.contactId
          && (contactFocus.row ? el.matches('.contact-row') : el.dataset.action === contactFocus.action));
      target?.focus({ preventScroll: true });
    }
    if (focusedDisclosure) {
      const details = $$('details[data-disclosure]').find((el) => el.dataset.disclosure === focusedDisclosure);
      if (details) $('summary', details)?.focus({ preventScroll: true });
    }
    markStatus(true);
  }

  const MEMORY_FIELD_LABELS = { content: '内容', type: '类型', date: '事实时间', importance: '重要度', saidAt: '话语时间', direction: '方向', lifespan: '寿命', occasion: '场景' };
  function memoryDiff(before, after) {
    const display = (key, value) => {
      if (key === 'type') return TYPE_CN[value] || value;
      if (key === 'direction') return DIRECTION_CN[value] || '无';
      if (key === 'lifespan') return value === 'short' ? '临时' : '长期';
      return value ?? '';
    };
    return `<dl class="revision-diff">${Object.entries(MEMORY_FIELD_LABELS)
      .filter(([key]) => (before?.[key] ?? '') !== (after?.[key] ?? ''))
      .map(([key, label]) => `<div><dt>${label}</dt><dd><span>原内容</span> ${esc(display(key, before?.[key])) || '（空）'}</dd><dd><span>修改后</span> ${esc(display(key, after?.[key])) || '（空）'}</dd></div>`).join('')}</dl>`;
  }

  function renderRevisions() {
    $('#revision-queue').innerHTML = (state.overview.pendingRevisions || []).map((p) => {
      const contact = state.contacts.find((c) => c.id === p.contactId);
      return `<article class="pending-card revision-card" data-revision="${esc(p.id)}">
        <div class="pending-main"><b>${esc(contact?.name || '联系人')} · AI 建议修改</b>
          <p class="material-hint">确认前原记忆仍然有效；本条修改不会随「全部确认」一起接受。</p>
          ${memoryDiff(p.before, p.after)}</div>
        <div class="pending-actions">
          <button type="button" class="primary-btn" data-action="confirm-revision" data-id="${esc(p.id)}">确认修改</button>
          <button type="button" class="ghost-btn" data-action="reject-revision" data-id="${esc(p.id)}">保留原内容</button>
        </div></article>`;
    }).join('');
  }

  function renderNav() {
    $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
    const pending = (state.overview.counts.pending || 0) + (state.overview.counts.pendingContacts || 0) + (state.overview.counts.pendingRevisions || 0);
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
    const pendingTotal = (c.pending || 0) + (c.pendingContacts || 0) + (c.pendingRevisions || 0);

    const attentionCount = (state.attention || []).length;
    const groupCount = state.occasionGroups.length;
    const materialStates = state.materials.map(materialState);
    const rawCount = materialStates.filter((m) => m.raw).length;
    const incompleteCount = materialStates.filter((m) => m.incomplete).length;
    const subParts = [];
    if (pendingTotal) subParts.push(`${pendingTotal} 条待确认`);
    if (attentionCount) subParts.push(`${attentionCount} 件记录可回顾`);
    if (groupCount) subParts.push(`${groupCount} 组安排与时机`);
    if (rawCount) subParts.push(`${rawCount} 份素材待整理`);
    if (incompleteCount) subParts.push(`${incompleteCount} 份整理未完成`);
    $('#home-sub').textContent = subParts.join(' · ') || '从一个人、一件小事开始';

    $('#onboarding').classList.toggle('hidden', (c.confirmed || 0) > 0 || state.materials.length > 0 || pendingTotal > 0);
    // 待确认队列动态权重：空态折叠（状态并入头部副标），有待确认才展开——确认闸门仍是最重要行动
    $('#pending-panel').classList.toggle('hidden', pendingTotal === 0);

    const queue = state.overview.pending || [];
    const pendingContacts = state.overview.pendingContacts || [];
    const queueEl = $('#pending-queue');
    if (!queue.length && !pendingContacts.length) {
      queueEl.innerHTML = '';
    } else {
      // AI 新建联系人也进拍板队列：确认收录 / 不要（连带删掉 AI 为 TA 挂的待确认记忆）
      const contactCards = pendingContacts.map((ct) => `
        <article class="pending-card contact-pending" data-id="${esc(ct.id)}">
          <div class="pending-main">
            <p class="pending-content"><b>${esc(ct.name)}</b> · ${relationCn(ct.relation)}${ct.tags?.length ? ' · ' + esc(ct.tags.join(' / ')) : ''}</p>
            ${ct.notes ? `<p class="pending-content">${esc(ct.notes)}</p>` : ''}
            <div class="pending-meta">
              <span class="badge type">AI 新建联系人</span>
              <span>AI 认为 TA 值得记住，待你确认收录</span>
            </div>
          </div>
          <div class="pending-actions">
            <button class="primary-btn" data-action="confirm-contact" data-id="${esc(ct.id)}">确认收录</button>
            <button class="ghost-btn" data-action="reject-contact" data-id="${esc(ct.id)}">不要</button>
          </div>
        </article>`).join('');
      const toolbar = queue.length > 1
        ? `<div class="queue-toolbar"><button class="ghost-btn" data-action="confirm-all">全部确认（${queue.length} 条）</button></div>`
        : '';
      queueEl.innerHTML = contactCards + toolbar + queue.map((m) => {
        // 待确认记忆可能挂在待确认联系人名下（AI 整理新建的人），两处一起找名字
        const contact = state.contacts.find((x) => x.id === m.contactId)
          || pendingContacts.find((x) => x.id === m.contactId);
        const editing = state.editingPendingId === m.id;
        const typeOptions = TYPE_ORDER.map((t) => `<option value="${t}"${m.type === t ? ' selected' : ''}>${TYPE_CN[t]}</option>`).join('');
        const dirOptions = [['', '无（自身属性）'], ['user_to_contact', '我对TA'], ['contact_to_user', 'TA对我'], ['both', '双向']]
          .map(([v, label]) => `<option value="${v}"${(m.direction || '') === v ? ' selected' : ''}>${label}</option>`).join('');
        return `
        <article class="pending-card" data-id="${esc(m.id)}">
          <div class="pending-main">
            ${editing
              ? `<textarea class="edit-area" data-role="pending-edit">${esc(m.content)}</textarea>
                 <div class="edit-grid">
                   <label>类型<select data-role="edit-type">${typeOptions}</select></label>
                   <label>方向<select data-role="edit-direction">${dirOptions}</select></label>
                   <label>寿命<select data-role="edit-lifespan">
                     <option value="long"${m.lifespan !== 'short' ? ' selected' : ''}>长期</option>
                     <option value="short"${m.lifespan === 'short' ? ' selected' : ''}>临时</option>
                   </select></label>
                   <label>重要度<select data-role="edit-importance">${[1, 2, 3].map((n) => `<option value="${n}"${(m.importance || 2) === n ? ' selected' : ''}>${n}${n === 3 ? '（关键）' : ''}</option>`).join('')}</select></label>
                   <label>事实时间<input data-role="edit-date" value="${esc(m.date || '')}" placeholder="YYYY-MM-DD / 每年-MM-DD"></label>
                   <label>话语时间<input data-role="edit-saidAt" value="${esc(m.saidAt || '')}" placeholder="YYYY-MM-DD HH:mm"></label>
                   <label>场景<input data-role="edit-occasion" value="${esc(m.occasion || '')}" placeholder="teacher_day / birthday …"></label>
                 </div>`
              : `<p class="pending-content">${esc(m.content)}</p>
                 ${m.sourceQuote ? `<blockquote class="source-quote">原话：${esc(m.sourceQuote)}</blockquote>` : ''}`}
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

    renderRevisions();
    renderMaterialBox();

    renderRecentRemembered();

    renderAttention();
    $$('#view-home .home-priority').forEach((el) => el.classList.remove('home-priority'));
    const priority = pendingTotal ? $('#pending-panel')
      : $('.followup-section') || $('.priority-occasions')
        || (materialStates.some((m) => m.raw || m.important) ? $('#material-box') : null);
    priority?.classList.add('home-priority');
  }

  // 最近记住了：已确认记忆的最近几条（确认闸门之后才出现），强化「它真的在帮我记」
  function renderRecentRemembered() {
    const box = $('#recent-box');
    const items = state.recent || [];
    box.classList.toggle('hidden', items.length === 0);
    if (!items.length) return;
    $('#recent-list').innerHTML = items.map((m) => `
      <div class="recent-row" data-id="${esc(m.contactId)}" role="button" tabindex="0">
        <div class="recent-main">
          <b>${esc(m.contactName)}</b>
          <p>${esc(m.content)}</p>
        </div>
        <div class="recent-meta">
          ${m.date ? `<span class="badge date">${esc(fmtDate(m.date))}</span>` : ''}
          <span class="badge type">${TYPE_CN[m.type] || esc(m.type)}</span>
        </div>
      </div>`).join('');
  }

  function findPlan(id) {
    if (!id) return undefined;
    for (const group of state.occasionGroups) {
      for (const person of group.people) {
        const plan = [...(person.plans || []), ...(person.aiIdeas || [])].find((p) => p.id === id);
        if (plan) return plan;
      }
    }
    return state.plans.find((p) => p.id === id);
  }

  function attentionAiButton(a, kind, label, occasion = '', date = '') {
    const key = `att:${kind}:${a.contactId}:${occasion}:${date}`;
    const waiting = state.aiWaiting.has(key);
    return `<button type="button" class="action-btn attention-ai" data-action="attention-ai" data-kind="${kind}" data-label="${esc(label)}" data-waiting-key="${esc(key)}" data-id="${esc(a.contactId)}" data-occasion="${esc(occasion)}" data-date="${esc(date)}"${waiting ? ' disabled' : ''}>${waiting ? 'AI 正在想…' : label}</button>`;
  }

  function attentionPlanStatus(p) {
    if (p.status === 'decided' && !p.occasionDate) return '想法已定 · 日期未定';
    return PLAN_STATUS_CN[p.status] || '想法';
  }

  function attentionPlan(p, contactId, ai = false) {
    return `<div class="att-plan" data-plan="${esc(p.id)}">
      <div class="att-plan-meta">
        <span class="badge type">${esc(attentionPlanStatus(p))}</span>
        ${ai ? '<span class="badge">AI 主意 · 未采纳</span>' : (p.source === 'ai' ? '<span class="badge">来自 AI</span>' : '')}
        <span>${p.occasionDate ? esc(fmtDate(p.occasionDate)) : '日期未定'}</span>${planBaseBadge(p)}
      </div>
      <p class="att-plan-idea">${esc(p.idea)}</p>
      ${p.budget ? `<p class="att-sub">预算 ${esc(p.budget)}</p>` : ''}
      ${planProductLine(p)}
      <div class="att-actions">
        <button type="button" class="ghost-btn" data-action="plan-edit" data-id="${esc(p.id)}" data-plan="${esc(p.id)}" data-occasion="${esc(p.occasion || '')}">编辑计划</button>
        <button type="button" class="ghost-btn" data-action="suggest-open" data-id="${esc(contactId)}" data-plan="${esc(p.id)}" data-occasion="${esc(p.occasion || '')}" data-date="${esc(p.occasionDate || '')}">送礼主意（可选）</button>
      </div>
    </div>`;
  }

  /** 场景化按钮文案：同一次 AI 简报，按时机/关系说人话——用户一看就知道能帮到哪一步 */
  function briefingLabel(a) {
    const occ = String(a.occasion || '');
    if (['teacher_day', 'mother_day', 'father_day', 'birthday'].includes(occ)) return '帮我写祝福';
    if (a.relation === 'client' || a.relation === 'partner') return '想怎么联系';
    return '想个问候';
  }

  function attentionPerson(a, group) {
    const plans = a.plans || [];
    const ideas = a.aiIdeas || [];
    const firstPlan = plans.find((p) => p.status === 'decided') || plans[0];
    const evidence = a.evidence || [];
    const cautions = evidence.filter((e) => ['caution', 'taboo', 'dislike'].includes(e.kind));
    const history = evidence.filter((e) => !cautions.includes(e));
    const key = `occasion-person:${group.id}:${a.contactId}`;
    const hasDetails = plans.length || ideas.length || history.length || a.lastSeen;
    const primary = firstPlan
      ? `<button type="button" class="action-btn" data-action="plan-edit" data-id="${esc(firstPlan.id)}" data-plan="${esc(firstPlan.id)}" data-occasion="${esc(firstPlan.occasion || '')}" data-date="${esc(firstPlan.occasionDate || '')}">继续计划</button>`
      : ideas.length
        ? `<button type="button" class="action-btn" data-action="attention-ideas" aria-expanded="${state.disclosures.get(key) || false}">查看AI主意</button>`
        : attentionAiButton(a, 'briefing', briefingLabel(a), a.occasion || '', a.date || '');
    return `<article class="attention-card" data-id="${esc(a.contactId)}">
      <div class="att-top"><b class="att-what">${esc(a.contactName)}</b><span class="badge">${relationCn(a.relation)}</span>${a.lastSeen && Number.isFinite(a.lastSeen.days) ? `<span class="badge date">上次互动 ${a.lastSeen.days} 天前</span>` : ''}</div>
      <p class="att-reason">${esc(!firstPlan && !ideas.length && a.source === 'birthday' ? '你记下的生日临近，可选是否联系' : a.reason)}</p>
      ${!firstPlan && !ideas.length && history.some((e) => e.kind === 'history') ? `<p class="att-sub">${esc(history.find((e) => e.kind === 'history').text)}</p>` : ''}
      ${!a.date ? '<p class="att-sub">日期未定，不代表本次已有安排</p>' : ''}
      ${firstPlan ? `<p class="att-plan-summary"><b>我的计划${firstPlan.status === 'decided' ? ` · ${esc(attentionPlanStatus(firstPlan))}` : ''}</b><span>${esc(firstPlan.idea)}</span></p>` : ''}
      ${ideas.length ? `<p class="att-plan-summary"><b>AI 主意 · 未采纳</b><span>${esc(ideas[0].idea)}</span></p>` : ''}
      ${cautions.length ? `<div class="att-why">${cautions.map((e) => `<p class="caution">${esc(e.text)}</p>`).join('')}</div>` : ''}
      <div class="att-actions">
        ${primary}
        <button type="button" class="ghost-btn" data-action="plan-open" data-contact="${esc(a.contactId)}" data-occasion="${esc(a.occasion || '')}" data-date="${esc(a.date || '')}">记个计划</button>
        <button type="button" class="ghost-btn" data-action="view-contact" data-id="${esc(a.contactId)}">查看关系</button>
      </div>
      ${hasDetails ? `<details class="home-disclosure att-details" ${disclosureAttrs(key)}>
        <summary>计划与关系依据${plans.length || ideas.length ? ` · ${plans.length} 个计划 / ${ideas.length} 个 AI 主意` : ''}</summary>
        <div class="att-detail-body">
          ${plans.length ? `<h4>我的计划</h4>${plans.map((p) => attentionPlan(p, a.contactId)).join('')}` : ''}
          ${ideas.length ? `<h4>AI 主意（未采纳）</h4>${ideas.map((p) => attentionPlan(p, a.contactId, true)).join('')}` : ''}
          ${history.length ? `<div class="att-why">${history.map((e) => `<p>${esc(e.text)}</p>`).join('')}</div>` : ''}
          ${a.lastSeen ? `<p class="att-sub">上次有记录的互动：${esc(fmtDate(a.lastSeen.date))}${Number.isFinite(a.lastSeen.days) ? ` · ${a.lastSeen.days} 天前` : ''}</p>` : ''}
        </div>
      </details>` : ''}
    </article>`;
  }

  function hasOccasionReason(person) {
    return person.source === 'birthday' || person.plans.length > 0 || person.aiIdeas.length > 0
      || person.evidence.some((e) => e.kind === 'history');
  }

  function attentionGroup(group) {
    const people = group.people || [];
    const relevant = people.filter(hasOccasionReason);
    const ordered = relevant.length ? [...relevant, ...people.filter((p) => !hasOccasionReason(p))] : people;
    const visibleCount = Math.min(3, relevant.length || people.length);
    const renderPerson = (a) => attentionPerson(a, group);
    // 组头派生摘要（零 AI）：用已有事实告诉用户「轻重已分过」，而不是让 5 张同款卡各自为政
    const recentN = people.filter((p) => p.lastSeen && Number.isFinite(p.lastSeen.days) && p.lastSeen.days <= 30).length;
    const plannedN = people.filter((p) => (p.plans?.length || 0) + (p.aiIdeas?.length || 0) > 0).length;
    const summaryParts = [`${people.length} 人`];
    if (plannedN) summaryParts.push(`${plannedN} 人已有安排或主意`);
    if (recentN) summaryParts.push(`${recentN} 人近 30 天有互动`);
    if (relevant.length < people.length) summaryParts.push(`${people.length - relevant.length} 人只是临近时机`);
    return `<section class="occasion-group" data-group="${esc(group.id)}">
      <div class="occasion-group-head">
        <h2>${esc(group.label)} · ${group.date && Number.isFinite(group.days) ? esc(relativeDays(group.days)) : '日期未定'}${group.date ? ` <time datetime="${esc(group.date)}">${esc(fmtDate(group.date))}</time>` : ''}</h2>
        <span>${summaryParts.join(' · ')}</span>
      </div>
      <div class="occasion-people">${ordered.slice(0, visibleCount).map(renderPerson).join('')}</div>
      ${people.length > visibleCount ? `<details class="home-disclosure people-more" ${disclosureAttrs(`occasion-people:${group.id}`)}>
        <summary>其余 ${people.length - visibleCount} 人 · 展开选择是否联系</summary>
        <div class="occasion-people">${ordered.slice(visibleCount).map(renderPerson).join('')}</div>
      </details>` : ''}
    </section>`;
  }

  const FOLLOWUP_STATUS_CN = { done: '已办妥', dismissed: '不再跟进', snoozed: '稍后提醒', active: '恢复提醒' };
  function followupActions(item) {
    if (!item.id || !item.sourceVersion) return '';
    const statuses = item.status === 'active' ? ['done', 'snoozed', 'dismissed'] : ['active'];
    return statuses.map((status) => `<button type="button" class="ghost-btn" data-action="followup-update" data-id="${esc(item.id)}" data-version="${esc(item.sourceVersion)}" data-status="${status}" ${state.followupBusy.has(item.id) ? 'disabled' : ''}>${FOLLOWUP_STATUS_CN[status]}</button>`).join('');
  }

  function attentionFollowup(a) {
    const label = { fading: '找个话题', promise: '想怎么跟进', reciprocity: '想个回礼' }[a.kind];
    const handled = a.status && a.status !== 'active';
    return `<article class="attention-card followup-card" data-id="${esc(a.contactId)}" data-followup="${esc(a.id || '')}">
      <div class="att-top"><b class="att-what">${esc(a.contactName)}</b><span class="badge">${relationCn(a.relation)}</span><span class="badge date">${esc(handled ? FOLLOWUP_STATUS_CN[a.status] : a.label)}</span></div>
      <p class="att-reason">${esc(a.text || a.content)}</p>
      ${a.date ? `<p class="att-sub">记录日期 ${esc(fmtDate(a.date))}</p>` : ''}
      ${a.status === 'snoozed' ? `<p class="att-sub">${esc(a.until)} 起重新出现在工作台</p>` : ''}
      <div class="att-actions">
        ${handled ? '' : attentionAiButton(a, a.kind === 'reciprocity' ? 'gift' : 'briefing', label || '想怎么跟进', a.kind === 'reciprocity' ? 'thank_you' : (a.occasion || ''))}
        ${followupActions(a)}
        ${handled ? '' : `<button type="button" class="ghost-btn" data-action="remember-open" data-id="${esc(a.contactId)}">记下进展</button>`}
        <button type="button" class="ghost-btn" data-action="view-contact" data-id="${esc(a.contactId)}">查看关系</button>
      </div>
    </article>`;
  }

  function renderAttention() {
    const listEl = $('#attention-list');
    const oppEl = $('#opportunity-list');
    oppEl.innerHTML = '';
    if (state.attention === null) {
      listEl.innerHTML = '<div class="empty">值得关注加载失败，稍后刷新重试。</div>';
      return;
    }
    if (!state.contacts.length) { listEl.innerHTML = ''; return; }
    const groups = state.occasionGroups.filter((g) => g.people.some(hasOccasionReason));
    const calendar = state.occasionGroups.filter((g) => !g.people.some(hasOccasionReason));
    const items = state.attention.filter((a) => a.kind !== 'fading');
    const fading = state.attention.filter((a) => a.kind === 'fading');
    const opportunities = state.opportunities || [];
    if (calendar.length || opportunities.length) {
      oppEl.innerHTML = `<details class="home-disclosure calendar-more" ${disclosureAttrs('calendar-more')}>
        <summary>节日与其他时机 · ${calendar.length + opportunities.length} 组（按需查看）</summary>
        <p class="material-hint">暂时没有对应安排或同场合记录，不代表你需要联系每个人，也不默认需要送礼。</p>
        <div class="occasion-groups">${calendar.map(attentionGroup).join('')}</div>
        ${opportunities.map((h) => `<div class="opp-row" role="note">
          <span>${h.inDays === 0 ? `${esc(h.label)}就是今天` : `${esc(h.label)}还有 ${h.inDays} 天`}，有想联系的人吗？</span>
          <button type="button" class="ghost-btn" data-action="first-run" data-scenario="say">想个问候</button>
        </div>`).join('')}
      </details>`;
    }
    listEl.innerHTML = (items.length ? `<section class="followup-section">
          <div class="occasion-group-head"><h2>有记录的待跟进</h2><span>${items.length} 件事项</span></div>
          <p class="material-hint">来自承诺和收礼记录；没有后续记录，不等于你还没做。处理提醒不改原始事实，也不会新增送礼记录；稍后提醒仅在工作台内展示。</p>
          <div class="occasion-people">${items.slice(0, 3).map(attentionFollowup).join('')}</div>
          ${items.length > 3 ? `<details class="home-disclosure" ${disclosureAttrs('followups-more')}>
            <summary>其余 ${items.length - 3} 件跟进事项</summary>
            <div class="occasion-people">${items.slice(3).map(attentionFollowup).join('')}</div>
          </details>` : ''}
        </section>` : '')
      + (groups.length ? `<section class="priority-occasions" aria-label="你的安排与重要日期">
          <div class="occasion-group-head"><h2>你的安排与重要日期</h2><span>${groups.length} 组</span></div>
          <p class="material-hint">已有计划、待选主意、你记下的生日和同场合记录优先；组内有依据的人先展示。</p>
          <div class="occasion-groups">${groups.slice(0, 3).map(attentionGroup).join('')}</div>
          ${groups.length > 3 ? `<details class="home-disclosure occasions-more" ${disclosureAttrs('occasions-more')}>
            <summary>更多安排与重要日期 · ${groups.length - 3} 组</summary>
            <div class="occasion-groups">${groups.slice(3).map(attentionGroup).join('')}</div>
          </details>` : ''}
        </section>` : '')
      + (!groups.length && !items.length ? '<div class="empty">暂时没有有记录的待跟进或安排，不必为了节日勉强联系。想起一件事时，随手记下来。</div>' : '')
      + (state.handledFollowups.length ? `<details class="home-disclosure handled-followups" ${disclosureAttrs('handled-followups')}>
          <summary>已处理与稍后提醒 · ${state.handledFollowups.length} 件</summary>
          <p class="material-hint">仅保留当前有效来源的处理状态；可随时恢复提醒，原始记录仍在联系人时间线。</p>
          <div class="occasion-people">${state.handledFollowups.map(attentionFollowup).join('')}</div>
        </details>` : '')
      + (fading.length ? `<details class="home-disclosure fading-more" ${disclosureAttrs('fading-more')}>
          <summary>久未更新的往来 · ${fading.length} 人（按需回顾）</summary>
          <p class="material-hint">只按本地互动记录间隔提示，不判断关系是否疏远。</p>
          <div class="occasion-people">${fading.map(attentionFollowup).join('')}</div>
        </details>` : '');
  }

  function materialState(mt) {
    const pendingCount = (mt.extracted || []).filter((m) => m.status === 'pending').length;
    const complete = Boolean(mt.report);
    const incomplete = mt.status === 'processed' && !complete;
    return { pendingCount, complete, incomplete, raw: mt.status === 'raw' && !complete, important: Boolean(mt.question || pendingCount || incomplete) };
  }

  function renderMaterialBox() {
    const box = $('#material-box');
    const list = state.materials || [];
    box.classList.toggle('hidden', list.length === 0);
    if (!list.length) return;
    const stats = list.map(materialState);
    const counts = [`共 ${list.length} 份`];
    for (const [key, label] of [['raw', '待整理'], ['incomplete', '整理未完成'], ['complete', '已整理']]) {
      const count = stats.filter((m) => m[key]).length;
      if (count) counts.push(`${count} 份${label}`);
    }
    $('#material-count').textContent = `· ${counts.join(' · ')}`;
    const renderCard = (mt) => {
      const { pendingCount, complete, incomplete, raw } = materialState(mt);
      const extractedCount = (mt.extracted || []).length;
      const status = complete ? '已整理' : incomplete ? '整理未完成' : '待 AI 整理';
      const statusBadge = `<span class="badge${complete || incomplete ? ' type' : ''}">${status}${extractedCount ? ` · 已拆出 ${extractedCount} 条` : ''}${pendingCount ? ` · 待确认 ${pendingCount} 条` : ''}</span>`;
      return `
      <article class="material-card" data-id="${esc(mt.id)}">
        <div class="material-main">
          <p class="material-excerpt">${esc(mt.excerpt.slice(0, 64))}${mt.excerpt.length > 64 ? '…' : ''}</p>
          <div class="material-meta">
            ${statusBadge}
            ${mt.contactName ? `<span class="badge">${esc(mt.contactName)}</span>` : ''}
            <span>${esc((mt.capturedAt || '').slice(0, 10))}</span>
          </div>
          ${!complete && mt.delivery ? `<p class="material-hint">${mt.delivery.sentAt
            ? '整理指令已发送到 DSH，尚未收到整理报告；发送不等于完成，请勿重复提交。'
            : '整理指令已复制，尚未确认发送；粘贴到 DSH 会话后才会开始整理。'}</p>` : ''}
          ${mt.question ? `<div class="material-question">
            <p class="mq-title">${`再告诉我一点 · ${mt.question.status === 'sent' ? '已发送作答' : '等你回答'}`}<button class="mq-dismiss" data-action="dismiss-question" data-id="${esc(mt.id)}">不再等待</button></p>
            <p class="mq-text">${esc(mt.question.question || '')}</p>
            ${mt.question.status === 'sent' ? '' : `<div class="mq-options">${(mt.question.options || []).map((o, i) => `
              <button class="mq-btn" data-action="answer-question" data-id="${esc(mt.id)}" data-index="${i}">${esc(o.label)}</button>`).join('')}
            </div>`}
            <p class="mq-hint">${mt.question.status === 'sent'
              ? '已发送到 DSH 会话，AI 继续整理并提交报告后自动清除'
              : mt.question.copiedAt
                ? '作答指令已复制，粘贴到 DSH 会话即可；AI 收到作答后会自动清除'
                : (state.dshEmbedded ? '点击即发送作答，AI 会继续整理' : '点击复制作答指令，粘贴到 DSH 会话')}</p>
          </div>` : ''}
          ${mt.report ? `<details class="material-report" ${disclosureAttrs(`material-report:${mt.id}`, pendingCount > 0)}>
            <summary>AI 整理报告${mt.reportedAt ? ` · ${esc((mt.reportedAt || '').slice(0, 10))}` : ''}</summary>
            <pre>${esc(mt.report)}</pre>
          </details>` : ''}
        </div>
        <div class="material-actions">
          ${pendingCount ? `<button class="primary-btn" data-action="confirm-material" data-id="${esc(mt.id)}">确认这 ${pendingCount} 条</button>` : ''}
          ${(raw || incomplete) && state.dshEmbedded ? `<button class="primary-btn" data-action="organize-material" data-id="${esc(mt.id)}" ${state.materialSending.has(mt.id) ? 'disabled' : ''}>${state.materialSending.has(mt.id) ? '发送中…' : incomplete ? '继续整理' : mt.delivery?.sentAt ? '重新发送整理指令' : 'AI 整理'}</button>` : ''}
          ${raw || incomplete ? `<button class="ghost-btn" data-action="copy-material" data-id="${esc(mt.id)}" ${state.materialSending.has(mt.id) ? 'disabled' : ''}>${incomplete ? '复制继续整理指令' : '复制整理指令'}</button>` : ''}
          ${raw || incomplete ? `<button class="ghost-btn" data-action="manual-material" data-id="${esc(mt.id)}">手动复制</button>` : ''}
          <button class="ghost-btn" data-action="delete-material" data-id="${esc(mt.id)}">删除</button>
        </div>
      </article>`;
    };
    const important = list.filter((mt) => materialState(mt).important);
    const ordinary = list.filter((mt) => !materialState(mt).important);
    $('#material-list').innerHTML = important.map(renderCard).join('') + (ordinary.length
      ? `<details class="home-disclosure materials-more" ${disclosureAttrs('materials-more')}>
          <summary>普通素材 · ${ordinary.length} 份</summary>
          <div class="material-list">${ordinary.map(renderCard).join('')}</div>
        </details>`
      : '');
  }

  /** 建议卡「围绕某计划」徽标文案：原计划被删后降级为「已删计划」。 */
  function planBaseBadge(p) {
    if (!p.basedOnPlanId) return '';
    const base = findPlan(p.basedOnPlanId);
    const label = base ? base.idea.slice(0, 12) : '已删计划';
    return ` <span class="badge">围绕「${esc(label)}」</span>`;
  }

  function safeProductUrl(value, httpsOnly = false) {
    try {
      if (!/^(https?:\/\/|\/\/)/i.test(value)) return '';
      const url = new URL(value, location.href);
      return (httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  // 纯前端生成二维码（vendor 的 qrcode-generator，MIT）：先 M 级纠错，内容超长自动降 L
  function qrSvg(text) {
    if (typeof qrcode !== 'function') return '';
    for (const level of ['M', 'L']) {
      try {
        const qr = qrcode(0, level);
        qr.addData(text);
        qr.make();
        return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, title: '商品链接二维码' });
      } catch { /* 内容过长时降低纠错级别重试 */ }
    }
    return '';
  }

  function planProductLine(p) {
    if (!p.productName && !p.productUrl) return '';
    const url = safeProductUrl(p.productUrl);
    const cps = url && ['u.jd.com', 'union-click.jd.com'].includes(new URL(url).hostname);
    const label = esc(p.productName || '查看商品');
    const inner = url
      ? `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${label} ↗</a><button type="button" class="ghost-btn qr-inline" data-action="qr-show" data-id="${esc(p.id)}">扫码买</button>`
      : label;
    return `<div class="occ-plan product">${inner}${p.productPrice ? ` <span class="badge price">${cps ? '参考价（非成交价） ' : ''}${esc(p.productPrice)}</span>` : ''}${cps ? ' <span class="badge">CPS 推广链接</span>' : ''}</div>`;
  }

  // 桌面选品、手机成交：计划卡与首页时机提醒卡共用 planProductLine，扫码入口全链路复用
  let qrCopyUrl = '';
  function openQrModal(plan) {
    const url = safeProductUrl(plan.productUrl);
    qrCopyUrl = url;
    $('#qr-product-line').textContent = `${plan.productName || '已选商品'}${plan.productPrice ? ` · 参考价 ${plan.productPrice}` : ''}`;
    $('#qr-image').innerHTML = url
      ? (qrSvg(url) || '<p class="muted">链接过长无法生成二维码，请复制链接使用。</p>')
      : '<p class="muted">商品链接无效，请重新关联商品。</p>';
    $('[data-qr-copy]').classList.toggle('hidden', !url);
    openModal('qr');
  }

  function jdPlanButton(p) {
    return activePlan(p) ? `<button type="button" class="ghost-btn" data-action="jd-open" data-id="${esc(p.id)}">京东找同款</button>` : '';
  }

  function planCard(p) {
    const sugCount = state.plans.filter((x) => x.basedOnPlanId === p.id && activePlan(x)).length;
    return `<article class="occ-card" data-plan="${esc(p.id)}">
      <div class="occ-main">
        <p class="occ-title"><b>${esc(p.contactName)}</b>${p.occasion ? ` · ${esc(p.occasion)}` : ''}${p.occasionDate ? ` · ${esc(fmtDate(p.occasionDate))}` : ' · 日期未定'} <span class="badge type">${PLAN_STATUS_CN[p.status]}</span>${p.source === 'ai' ? ' <span class="badge">AI 建议</span>' : ''}${planBaseBadge(p)}</p>
        <div class="occ-plan">${esc(p.idea)}${p.budget ? ` <span class="muted">（预算 ${esc(p.budget)}）</span>` : ''}</div>
        ${planProductLine(p)}
        ${activePlan(p) ? `<details class="home-disclosure gift-tools" ${disclosureAttrs(`gift-tools:${p.id}`)}>
          <summary>送礼时再用</summary>
          <div class="plan-actions">
            <button type="button" class="ghost-btn" data-action="suggest-open" data-id="${esc(p.contactId)}" data-occasion="${esc(p.occasion || '')}" data-plan="${esc(p.id)}">送什么</button>
            ${jdPlanButton(p)}
            <button type="button" class="ghost-btn" data-action="plan-sent" data-id="${esc(p.id)}">已送出礼物</button>
          </div>
        </details>` : ''}
      </div>
      <div class="occ-actions">
        ${activePlan(p) ? `<button type="button" class="action-btn" data-action="plan-edit" data-id="${esc(p.id)}">编辑</button>
          <button type="button" class="ghost-btn" data-action="plan-done" data-id="${esc(p.id)}">已完成</button>` : ''}
        ${sugCount ? `<button type="button" class="icon-btn danger" data-action="plan-delete-suggestions" data-id="${esc(p.id)}">删这批建议(${sugCount})</button>` : ''}
        <button type="button" class="icon-btn danger" data-action="plan-delete" data-id="${esc(p.id)}">删除</button>
      </div>
    </article>`;
  }

  function renderGifts() {
    const { reciprocity, given, received } = state.gift;
    const groups = state.occasionGroups.filter((g) => g.date && g.days >= 0 && g.days <= 30);
    const priority = groups.filter((g) => g.people.some(hasOccasionReason));
    const calendar = groups.filter((g) => !g.people.some(hasOccasionReason));
    const covered = new Set();
    const renderPerson = (p) => {
      const plans = [...p.plans, ...p.aiIdeas].filter((plan) => activePlan(plan) && (!p.date || plan.occasionDate === p.date));
      plans.forEach((plan) => covered.add(plan.id));
      return `<article class="gift-person" data-contact="${esc(p.contactId)}" data-occasion="${esc(p.occasion)}" data-date="${esc(p.date)}">
        <p class="occ-title"><b>${esc(p.contactName)}</b> · ${esc(p.reason)}</p>
        ${plans.map((plan) => planCard({ ...plan, contactName: p.contactName })).join('')}
        ${!plans.length ? '<p class="material-hint">没有对应安排，可选是否联系，不默认需要送礼。</p>' : ''}
        <div class="att-actions">
          ${!plans.length ? attentionAiButton(p, 'briefing', briefingLabel(p), p.occasion, p.date) : ''}
          <button type="button" class="ghost-btn" data-action="plan-open" data-contact="${esc(p.contactId)}" data-occasion="${esc(p.occasion)}" data-date="${esc(p.date)}">记个计划</button>
        </div>
      </article>`;
    };
    const renderGroup = (g) => {
      const relevant = g.people.filter(hasOccasionReason);
      const people = [...relevant, ...g.people.filter((p) => !hasOccasionReason(p))];
      const count = Math.min(3, relevant.length || people.length);
      return `<section class="occasion-group" data-group="${esc(g.id)}">
        <div class="occasion-group-head"><h3>${esc(g.label)} · ${esc(relativeDays(g.days))} <time>${esc(g.date)}</time></h3><span>${people.length} 人</span></div>
        ${people.slice(0, count).map(renderPerson).join('')}
        ${people.length > count ? `<details class="home-disclosure" ${disclosureAttrs(`gift-people:${g.id}`)}><summary>其余 ${people.length - count} 人 · 按需查看</summary>${people.slice(count).map(renderPerson).join('')}</details>` : ''}
      </section>`;
    };
    $('#occasions-count').textContent = `· ${groups.length} 组`;
    $('#occasions-list').innerHTML = state.attention === null
      ? '<div class="empty">近期安排加载失败，稍后刷新重试；计划仍可在下方查看。</div>'
      : `${priority.slice(0, 3).map(renderGroup).join('')}
        ${priority.length > 3 ? `<details class="home-disclosure" ${disclosureAttrs('gift-groups-more')}><summary>更多安排与重要日期 · ${priority.length - 3} 组</summary>${priority.slice(3).map(renderGroup).join('')}</details>` : ''}
        ${calendar.length ? `<details class="home-disclosure calendar-more" ${disclosureAttrs('gift-calendar-more')}><summary>节日与其他时机 · ${calendar.length} 组（按需查看）</summary>${calendar.map(renderGroup).join('')}</details>` : ''}
        ${!priority.length ? '<div class="empty">30 天内暂无有依据的安排。不必为了节日勉强联系。</div>' : ''}`;

    $('#reciprocity-count').textContent = `· ${reciprocity.length}`;
    $('#reciprocity-list').innerHTML = reciprocity.length ? reciprocity.map((r) => `
      <article class="occ-card reciprocity" data-followup="${esc(r.id)}">
        <div class="occ-main">
          <p class="occ-title"><b>${esc(r.name)}</b> 在 ${esc(fmtDate(r.date))} 送了：${esc(r.content)} <span class="badge dir">TA→我</span></p>
          ${r.hasActivePlan ? '<div class="occ-plan muted">已有相关计划</div>' : '<div class="occ-plan empty-plan">暂无后续送礼记录，不代表你还未回应</div>'}
        </div>
        <div class="occ-actions">
          ${r.hasActivePlan ? '' : `<button class="ghost-btn" data-action="plan-open" data-contact="${esc(r.contactId)}" data-occasion="thank_you">记回礼计划</button>`}
          ${followupActions(r)}
        </div>
      </article>`).join('') : '<div class="empty">没有待回应的人情。收到的礼物会记在台账里。</div>';

    const ledgerRow = (m, dirBadge) => `
      <div class="ledger-row" data-id="${esc(m.id)}">
        <span class="when">${esc(fmtDate(m.date))}</span>
        <span class="what"><b>${esc(m.contactName)}</b> · ${esc(m.content)} ${dirBadge ? `<span class="badge dir">${dirBadge}</span>` : ''}${m.occasion ? `<span class="badge occ">${esc(m.occasion)}</span>` : ''}</span>
      </div>`;
    $('#ledger-given').innerHTML = given.length ? given.map((m) => ledgerRow(m)).join('') : '<div class="empty">还没有送出记录。计划标「已送」后自动入账。</div>';
    $('#ledger-received').innerHTML = received.length ? received.map((m) => ledgerRow(m, 'TA→我')).join('') : '<div class="empty">还没有收礼记录。</div>';

    const rest = state.plans.filter((p) => activePlan(p) && !covered.has(p.id));
    $('#plans-section').classList.toggle('hidden', !rest.length);
    $('#plans-list').innerHTML = rest.map((p) => planCard({ ...p, ...findPlan(p.id) })).join('');
    const completed = state.plans.filter((p) => !activePlan(p));
    $('#completed-plans').classList.toggle('hidden', !completed.length);
    $('#completed-plans-count').textContent = String(completed.length);
    $('#completed-plans-list').innerHTML = completed.map(planCard).join('');
  }

  function renderContacts() {
    const listEl = $('#contact-list');
    if (!state.contacts.length) {
      listEl.innerHTML = '<div class="empty">还没有联系人。<br><button type="button" class="ghost-btn" data-action="new-contact-quick" style="margin-top:8px">＋ 新建联系人</button></div>';
    } else {
      listEl.innerHTML = state.contacts.map((c) => `
        <button type="button" class="contact-row${c.id === state.activeContactId ? ' active' : ''}" data-id="${esc(c.id)}">
          <span class="avatar">${esc(initial(c.name))}</span>
          <span class="who"><b>${esc(c.name)}</b><small>${relationCn(c.relation)}${c.tags.length ? ' · ' + esc(c.tags.join(' / ')) : ''}</small></span>
          ${c.archived ? '<span class="badge archived-tag">已归档</span>' : ''}
        </button>`).join('');
    }

    const detail = $('#contact-detail');
    const t = state.timeline;
    $('.contacts-layout').classList.toggle('has-detail', Boolean(t.contact));
    if (!t.contact) {
      detail.classList.add('hidden');
      detail.innerHTML = '';
      return;
    }
    detail.classList.remove('hidden');
    const c = t.contact;
    const searchInput = detail.dataset.contactId === c.id ? $('#memory-search-input', detail) : null;
    const searchFocused = searchInput && document.activeElement === searchInput;
    detail.dataset.contactId = c.id;
    const searchActive = Boolean(state.memorySearchQuery.trim());
    const baseMemories = searchActive ? state.memorySearchResults : t.memories;
    const types = new Set(baseMemories.map((m) => m.type));
    const chips = [
      `<button type="button" class="chip${state.typeFilter === 'all' ? ' active' : ''}" data-type="all">全部 · ${baseMemories.length}</button>`,
      ...TYPE_ORDER.filter((x) => types.has(x)).map((x) =>
        `<button type="button" class="chip${state.typeFilter === x ? ' active' : ''}" data-type="${x}">${TYPE_CN[x]} · ${baseMemories.filter((m) => m.type === x).length}</button>`),
    ].join('');
    const shown = state.typeFilter === 'all' ? baseMemories : baseMemories.filter((m) => m.type === state.typeFilter);
    const emptyText = searchActive
      ? (state.memorySearchLoading ? '正在向量检索相关记忆…' : '没有检索到相关记忆。')
      : '还没有已确认的长期记忆。';

    // 见面简报事实卡：纯派生（服务端聚合，搭 timeline 响应），零 AI 零延迟，SSE 自动刷新；全空则不渲染
    const bf = t.briefing;
    const bfRows = [];
    if (bf) {
      if (bf.lastSeen) bfRows.push(`<div class="briefing-row"><span class="badge type">间隔</span><span>距上次有记录的互动 <b>${bf.lastSeen.days}</b> 天（${esc(fmtDate(bf.lastSeen.lastDate))}）</span></div>`);
      for (const o of bf.occasions) bfRows.push(`<div class="briefing-row"><span class="badge occ">时机</span><span>${esc(o.label)}${o.inDays === 0 ? ' 就是今天' : ` · 还有 <b>${o.inDays}</b> 天`}</span></div>`);
      for (const r of bf.reciprocity) bfRows.push(`<div class="briefing-row"><span class="badge date">回礼</span><span>TA 送过「${esc(r.content)}」（${esc(fmtDate(r.date))}），暂无后续送礼记录${r.hasActivePlan ? '，已有相关计划' : ''}</span></div>`);
      for (const p of bf.promises) bfRows.push(`<div class="briefing-row"><span class="badge type">待跟进</span><span>${esc(p.content)}${p.date ? ` · ${esc(fmtDate(p.date))}` : ''}</span></div>`);
      for (const x of bf.cautions) bfRows.push(`<div class="briefing-row"><span class="badge imp3">注意</span><span>${esc(x.content)}</span></div>`);
    }
    const briefingHtml = bfRows.length
      ? `<div class="briefing-card"><h4>见面简报</h4>${bfRows.join('')}</div>`
      : '';

    detail.innerHTML = `
      <button type="button" class="ghost-btn contact-back" data-action="contacts-back">返回联系人列表</button>
      <div class="detail-head">
        <div>
          <h2>${esc(c.name)}</h2>
          <div class="detail-meta">
            <span class="badge type">${relationCn(c.relation)}</span>
            ${c.birthday ? `<span class="badge date">生日 ${esc(fmtDate(c.birthday))}</span>` : ''}
            ${c.tags.map((x) => `<span class="badge">${esc(x)}</span>`).join('')}
          </div>
        </div>
        <div class="detail-actions">
          <button class="primary-btn" data-action="briefing-open" data-id="${esc(c.id)}"${state.aiWaiting.has(`brief:${c.id}`) ? ' disabled' : ''}>${state.aiWaiting.has(`brief:${c.id}`) ? 'AI 正在想…' : '怎么说'}</button>
          <button class="ghost-btn" data-action="gift-open" data-id="${esc(c.id)}"${state.aiWaiting.has(`gift:${c.id}`) ? ' disabled' : ''}>${state.aiWaiting.has(`gift:${c.id}`) ? 'AI 正在想…' : '送什么'}</button>
          <button class="ghost-btn" data-action="edit-contact" data-id="${esc(c.id)}">编辑</button>
          <button class="ghost-btn" data-action="toggle-archive" data-id="${esc(c.id)}">${c.archived ? '取消归档' : '归档'}</button>
          <button class="ghost-btn" data-action="delete-contact" data-id="${esc(c.id)}">删除</button>
        </div>
      </div>
      ${briefingHtml}
      <div class="memory-search">
        <input id="memory-search-input" type="search" placeholder="关键词向量搜索相关记忆" value="${esc(state.memorySearchQuery)}" autocomplete="off">
        <span>${searchActive ? (state.memorySearchLoading ? '检索中…' : `找到 ${baseMemories.length} 条`) : '输入关键词检索该联系人的已确认记忆'}</span>
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
              : `${esc(m.content)} <span class="badge type">${TYPE_CN[m.type] || esc(m.type)}</span>${m.lifespan === 'short' ? ' <span class="badge short">临时</span>' : ''}${directionLabel(m.direction) ? ` <span class="badge dir">${directionLabel(m.direction)}</span>` : ''}${m.occasion ? ` <span class="badge occ">${esc(m.occasion)}</span>` : ''}${m.importance === 3 ? ' <span class="badge imp3">关键</span>' : ''}${m.saidAt ? ` <span class="badge">讲于 ${esc(m.saidAt)}</span>` : ''}`}</span>
            <span class="row-actions">
              ${editing ? '' : `<button class="icon-btn" data-action="edit-memory" data-id="${esc(m.id)}">编辑</button>
                                <button class="icon-btn" data-action="memory-history" data-id="${esc(m.id)}">修改历史</button>
                                <button class="icon-btn danger" data-action="delete-memory" data-id="${esc(m.id)}">删除</button>`}
            </span>
          </div>`;
        }).join('') : `<div class="empty">${emptyText}</div>`}
      </div>
      ${(t.shortItems || []).length && !searchActive ? `
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
    if (searchInput) {
      $('#memory-search-input', detail).replaceWith(searchInput);
      searchInput.value = state.memorySearchQuery;
      if (searchFocused) searchInput.focus({ preventScroll: true });
    }
  }

  // ---------- 事件 ----------
  document.addEventListener('toggle', (e) => {
    const el = e.target;
    if (!el.matches?.('details[data-disclosure]') || !el.isConnected) return;
    state.disclosures.set(el.dataset.disclosure, el.open);
    if (el.matches('.att-details')) {
      const button = $('[data-action="attention-ideas"]', el.closest('.attention-card'));
      button?.setAttribute('aria-expanded', String(el.open));
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.target.matches('.recent-row') || !['Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    e.target.click();
  });
  document.addEventListener('compositionstart', () => { memorySearchComposing = true; });
  document.addEventListener('compositionend', (e) => {
    memorySearchComposing = false;
    const search = e.target.closest('#memory-search-input');
    if (!search) return;
    const query = search.value;
    state.memorySearchQuery = query;
    state.typeFilter = 'all';
    clearTimeout(memorySearchTimer);
    if (!query.trim()) { runMemorySearch(''); return; }
    memorySearchTimer = setTimeout(() => runMemorySearch(query), 180);
  });
  document.addEventListener('input', (e) => {
    const search = e.target.closest('#memory-search-input');
    if (!search) return;
    if (memorySearchComposing) return;
    const query = search.value;
    state.memorySearchQuery = query;
    state.typeFilter = 'all';
    clearTimeout(memorySearchTimer);
    if (!query.trim()) {
      runMemorySearch('');
      return;
    }
    memorySearchTimer = setTimeout(() => runMemorySearch(query), 180);
  });

  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('.nav-item');
    if (nav) {
      state.view = nav.dataset.view;
      render();
      // 视图相关数据按当前视图拉取（如礼赠页 reciprocity/ledger 只在 gifts 视图取）
      scheduleRefresh();
      return;
    }

    // 人卡只通过显式按钮跳转，details 和计划操作不会误触导航。
    const attRow = e.target.closest('.recent-row, [data-action="view-contact"]');
    if (attRow) {
      state.view = 'contacts';
      state.activeContactId = attRow.dataset.id;
      state.typeFilter = 'all';
      state.memorySearchQuery = '';
      state.memorySearchResults = [];
      state.memorySearchLoading = false;
      clearTimeout(memorySearchTimer);
      memorySearchSeq++;
      await refresh();
      if (window.matchMedia('(max-width: 900px)').matches) {
        $('#contact-detail').scrollIntoView({ block: 'start' });
        $('.contact-back')?.focus({ preventScroll: true });
      }
      return;
    }

    const row = e.target.closest('.contact-row');
    if (row) {
      state.activeContactId = row.dataset.id;
      state.typeFilter = 'all';
      state.memorySearchQuery = '';
      state.memorySearchResults = [];
      state.memorySearchLoading = false;
      clearTimeout(memorySearchTimer);
      memorySearchSeq++;
      await refresh();
      if (window.matchMedia('(max-width: 900px)').matches) {
        $('#contact-detail').scrollIntoView({ block: 'start' });
        $('.contact-back')?.focus({ preventScroll: true });
      }
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
      if (action === 'contacts-back') {
        const previous = state.activeContactId;
        state.activeContactId = null;
        state.timeline = { contact: null, memories: [] };
        state.memorySearchQuery = '';
        state.memorySearchResults = [];
        state.memorySearchLoading = false;
        clearTimeout(memorySearchTimer);
        memorySearchSeq++;
        render();
        $$('.contact-row').find((el) => el.dataset.id === previous)?.focus();
      } else if (action === 'new-contact-quick') {
        openModal('contact');
      } else if (action === 'confirm') {
        await api('/api/memories/confirm', { method: 'POST', body: { ids: [id] } });
        toast('已确认进入长期记忆');
        await refresh();
      } else if (action === 'confirm-contact') {
        await api(`/api/contacts/${id}/confirm`, { method: 'POST' });
        toast('已收录该联系人');
        await refresh();
      } else if (action === 'reject-contact') {
        const r = await confirmDialog('不收录这位联系人？AI 为 TA 登记的待确认记忆会一并删除。', { danger: true });
        if (!r) return;
        const del = await api(`/api/contacts/${id}`, { method: 'DELETE' });
        toast(`已删除（连带 ${del.removedMemories} 条记忆）`);
        await refresh();
      } else if (action === 'confirm-revision' || action === 'reject-revision') {
        actionBtn.disabled = true;
        try {
          const operation = action === 'confirm-revision' ? 'confirm' : 'reject';
          await api(`/api/memory-revisions/${encodeURIComponent(id)}/${operation}`, { method: 'POST', body: {} });
          toast(operation === 'confirm' ? '修改已确认，原内容已保留在历史中' : '已保留原内容');
          await refresh();
        } catch (error) {
          toast(error.message, true);
          actionBtn.disabled = false;
        }
      } else if (action === 'memory-history') {
        await showMemoryHistory(id);
      } else if (action === 'confirm-all' || action === 'confirm-material') {
        if (state.confirming) return;
        const mt = state.materials.find((x) => x.id === id);
        const memories = action === 'confirm-all' ? state.overview.pending || [] : mt?.extracted || [];
        const ids = memories.filter((m) => m.status === 'pending').map((m) => m.id);
        if (!ids.length) return;
        state.confirming = true;
        actionBtn.disabled = true;
        try {
          const { confirmed, failed } = await api('/api/memories/confirm', { method: 'POST', body: { ids } });
          toast(`已确认 ${confirmed.length} 条${action === 'confirm-material' ? '素材记忆' : '进入长期记忆'}${failed.length ? `；${failed.length} 条未确认：${failed[0].error}` : ''}`, failed.length > 0);
        } finally {
          state.confirming = false;
          await refresh();
        }
      } else if (action === 'followup-update') {
        if (state.followupBusy.has(id)) return;
        const status = actionBtn.dataset.status;
        const sourceVersion = actionBtn.dataset.version;
        state.followupBusy.add(id);
        try {
          let until;
          if (status === 'snoozed') {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
            until = await promptDialog('哪天起再次提醒？仅在工作台内展示，不发送系统通知。', '', { type: 'date', min: date, value: date });
            if (!until) return;
          } else if (status !== 'active' && !(await confirmDialog(`将这条提醒标记为「${FOLLOWUP_STATUS_CN[status]}」？只处理当前事项，不修改原始记忆或新增送礼记录；之后可恢复提醒。`))) return;
          await api(`/api/followups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, sourceVersion, ...(until ? { until } : {}) } });
          toast(status === 'active' ? '已恢复提醒' : `已标记${FOLLOWUP_STATUS_CN[status]}，原始记录保留`);
        } finally {
          state.followupBusy.delete(id);
          await refresh();
        }
      } else if (action === 'remember-open') {
        openRemember(id);
      } else if (action === 'first-run') {
        state.firstScenario = actionBtn.dataset.scenario || 'say';
        $('#fr-title').textContent = FIRST_SCENARIOS[state.firstScenario];
        $('#fr-go').textContent = state.dshEmbedded ? '获取建议' : '复制建议指令';
        openModal('first');
      } else if (action === 'briefing-open') {
        // 怎么说：事实卡已原生展示，这里把同一份事实交给 AI 生成话术建议（不落库）。
        // 嵌入模式直发 DSH 会话并等 AI 回复就地弹层；独立模式复制指令。
        try {
          const { prompt } = await api('/api/briefing', { method: 'POST', body: { contactId: id } });
          if (state.dshEmbedded) {
            await askHostAi(prompt, { title: '怎么开口 · AI 建议', waitingKey: `brief:${id}` });
          } else {
            await navigator.clipboard.writeText(prompt);
            toast('话术指令已复制，粘贴到 DSH 会话即可');
          }
        } catch (e) { toast(e.message || '生成话术失败', true); }
      } else if (action === 'gift-open') {
        // 送什么：以该联系人最近已确认记忆为依据组装礼物建议 prompt（auto），嵌入直发/独立复制
        try {
          const { prompt } = await api('/api/gift-suggest', { method: 'POST', body: { contactId: id, auto: true } });
          if (state.dshEmbedded) {
            await askHostAi(prompt, { title: '送什么 · AI 建议', waitingKey: `gift:${id}` });
          } else {
            await navigator.clipboard.writeText(prompt);
            toast('礼物建议指令已复制，粘贴到 DSH 会话即可');
          }
        } catch (e) { toast(e.message || '生成失败', true); }
      } else if (action === 'attention-ideas') {
        const details = $('.att-details', actionBtn.closest('.attention-card'));
        if (details) {
          details.open = true;
          state.disclosures.set(details.dataset.disclosure, true);
          actionBtn.setAttribute('aria-expanded', 'true');
          $('summary', details).focus({ preventScroll: true });
        }
      } else if (action === 'attention-ai') {
        const kind = actionBtn.dataset.kind || 'briefing';
        const planId = actionBtn.dataset.plan;
        const plan = findPlan(planId);
        if (planId && (!plan || plan.contactId !== id)) { toast('计划已变化，请刷新后重试', true); return; }
        const body = {
          contactId: id,
          occasion: plan ? (plan.occasion || '') : (actionBtn.dataset.occasion || ''),
          occasionDate: plan ? (plan.occasionDate || '') : (actionBtn.dataset.date || ''),
          planId: plan?.id,
        };
        try {
          const { prompt } = await api(kind === 'gift' ? '/api/gift-suggest' : '/api/briefing', {
            method: 'POST', body: kind === 'gift' ? { ...body, auto: true } : body,
          });
          if (state.dshEmbedded) {
            await askHostAi(prompt, { title: `${actionBtn.dataset.label || '下一步'} · AI 建议`, waitingKey: actionBtn.dataset.waitingKey });
          } else {
            await navigator.clipboard.writeText(prompt);
            toast('指令已复制，粘贴到 DSH 会话即可');
          }
        } catch (e) { toast(e.message || '生成失败', true); }
      } else if (action === 'manual-material') {
        const { prompt } = await api(`/api/materials/${id}/organize-prompt`);
        showAiResult('手动复制整理指令', prompt);
        $('#airesult-body').setAttribute('tabindex', '0');
        $('#airesult-body').focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents($('#airesult-body'));
        selection.removeAllRanges();
        selection.addRange(range);
        toast('请复制选中的完整指令，再粘贴到 DSH 会话；查看指令不算已发送');
      } else if (action === 'organize-material' || action === 'copy-material') {
        if (state.materialSending.has(id)) return;
        const mt = state.materials.find((item) => item.id === id);
        if (action === 'organize-material' && mt?.delivery?.sentAt
          && !(await confirmDialog('这份素材的整理指令已经发送过。请先检查 DSH 会话，确认需要再次发送？'))) return;
        await deliverMaterial(id, action === 'copy-material');
      } else if (action === 'answer-question') {
        // AI 整理反问的工作台作答：嵌入模式直发宿主会话，独立模式复制作答指令。
        // 发送/复制失败横幅保留待重试；成功只标送达/已复制，不清横幅——
        // 权威清除是 AI done / 整理报告提交 / 用户手动放弃（复制不算送达）。
        const mt = state.materials.find((x) => x.id === id);
        const opt = mt?.question?.options?.[Number(actionBtn.dataset.index)];
        if (!opt) return;
        if (state.dshEmbedded) {
          try {
            await sendToSession(opt.command);
            await api(`/api/materials/${id}/question/sent`, { method: 'POST' });
            toast('已发送作答，AI 会继续整理；完成后横幅自动清除');
            await refresh();
          } catch (e) { toast(e.message || '发送失败，稍后重试或到 DSH 会话里直接回复', true); }
        } else {
          try {
            await navigator.clipboard.writeText(opt.command);
            await api(`/api/materials/${id}/question/copied`, { method: 'POST' });
            toast('作答指令已复制，粘贴到 DSH 会话；AI 收到会自动清除');
            await refresh();
          } catch { toast('复制失败，稍后重试或到 DSH 会话里直接回复', true); }
        }
      } else if (action === 'dismiss-question') {
        // 用户明确放弃等待：唯一的用户侧清除入口（AI 若还在等，到会话里直接回复它即可）
        if (!(await confirmDialog('不再等待这条「再告诉我一点」？清除后若 AI 还在等，请到 DSH 会话里直接回复。', { danger: true }))) return;
        await api(`/api/materials/${id}/question`, { method: 'DELETE' });
        toast('已清除');
        await refresh();
      } else if (action === 'delete-material') {
        if (!(await confirmDialog('删除这段素材？已拆出的记忆不受影响。', { danger: true }))) return;
        await api(`/api/materials/${id}`, { method: 'DELETE' });
        toast('已删除素材');
        await refresh();
      } else if (action === 'suggest-open') {
        const contactId = id || actionBtn.dataset.contact;
        if (!contactId) { toast('缺少联系人信息', true); return; }
        const card = actionBtn.closest('[data-occasion]');
        const occasion = actionBtn.dataset.occasion ?? card?.dataset.occasion ?? '';
        const date = actionBtn.dataset.date ?? card?.dataset.date ?? '';
        await openSuggestModal(contactId, occasion, actionBtn.dataset.plan || '', date);
      } else if (action === 'plan-open') {
        const card = actionBtn.closest('[data-contact]');
        openPlanModal(
          id || actionBtn.dataset.contact || card?.dataset.contact,
          actionBtn.dataset.occasion ?? card?.dataset.occasion ?? '',
          actionBtn.dataset.date ?? card?.dataset.date ?? '',
        );
      } else if (action === 'plan-edit') {
        const plan = state.plans.find((item) => item.id === id);
        if (!plan) { toast('计划不存在，请刷新后重试', true); return; }
        openPlanModal(undefined, undefined, undefined, plan);
      } else if (action === 'jd-open') {
        openJdModal(id);
      } else if (action === 'qr-show') {
        const plan = findPlan(id);
        if (plan) openQrModal(plan);
      } else if (action === 'plan-delete-suggestions') {
        // 一键删除「围绕该计划出主意」产生的这批建议（原计划保留，已送的台账卡不动）
        const n = state.plans.filter((x) => x.basedOnPlanId === id && activePlan(x)).length;
        if (!n) return;
        if (!(await confirmDialog(`删除围绕该计划的 ${n} 条 AI 建议？原计划保留。`, { danger: true }))) return;
        const r = await api(`/api/plans/${id}/suggestions`, { method: 'DELETE' });
        toast(`已删除 ${r.deleted} 条 AI 建议`);
        await refresh();
      } else if (action === 'plan-delete') {
        if (!(await confirmDialog('删除这个计划？', { danger: true }))) return;
        await api(`/api/plans/${id}`, { method: 'DELETE' });
        toast('已删除计划');
        await refresh();
      } else if (action === 'plan-done') {
        if (!(await confirmDialog('将这项计划标记为已完成？这只结束计划，不会自动生成送礼或其他记忆。'))) return;
        await api(`/api/plans/${id}/done`, { method: 'POST' });
        toast('计划已完成，未自动写入记忆');
        await refresh();
      } else if (action === 'plan-sent') {
        const plan = findPlan(id);
        if (!plan) return;
        if (!(await confirmDialog(`确认已经实际送出礼物「${plan.productName || plan.idea}」？这会创建已确认的送礼记忆并计入台账。普通见面、散步等安排请使用「已完成」。`))) return;
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
        // 全字段编辑：确认时一并修正类型/方向/寿命/重要度/两个时间/场景
        const edits = {
          content,
          type: $('[data-role="edit-type"]', card).value,
          direction: $('[data-role="edit-direction"]', card).value,
          lifespan: $('[data-role="edit-lifespan"]', card).value,
          importance: Number($('[data-role="edit-importance"]', card).value),
          date: $('[data-role="edit-date"]', card).value.trim(),
          saidAt: $('[data-role="edit-saidAt"]', card).value.trim(),
          occasion: $('[data-role="edit-occasion"]', card).value.trim(),
        };
        const r = await api('/api/memories/confirm', { method: 'POST', body: { ids: [id], edits: { [id]: edits } } });
        if (r.failed?.length) { toast(`保存失败：${r.failed[0].error}`, true); return; }
        state.editingPendingId = null;
        toast('已保存并确认');
        await refresh();
      } else if (action === 'reject') {
        await api(`/api/memories/${id}/reject`, { method: 'POST', body: {} });
        toast('已驳回（可在需要时恢复）');
        await refresh();
      } else if (action === 'supersede-ask') {
        const pending = state.overview.pending.find((m) => m.id === id);
        if (!pending) return;
        state.supersedeMemoryId = id;
        state.supersedeContactId = pending.contactId;
        $('#supersede-search').value = '';
        $('#supersede-list').innerHTML = '<div class="empty">正在读取记忆…</div>';
        openModal('supersede');
        try {
          const r = await api(`/api/memories?contact_id=${pending.contactId}&status=confirmed`);
          if (state.supersedeMemoryId !== id) return;
          const candidates = (r.memories || []).filter((m) => !m.supersededBy);
          $('#supersede-list').innerHTML = candidates.length ? candidates.map((m) =>
            `<button type="button" class="supersede-item" data-memory-id="${esc(m.id)}">
              <span class="badge type">${esc(TYPE_CN[m.type] || m.type)}</span>
              <span class="supersede-text">${esc(m.content)}</span>
              ${m.date ? `<span class="badge date">${esc(fmtDate(m.date))}</span>` : ''}
            </button>`).join('') : '<div class="empty">该联系人没有已确认的记忆，无法标记取代。</div>';
        } catch (error) {
          if (state.supersedeMemoryId === id) $('#supersede-list').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
        }
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
        if (!(await confirmDialog('删除这条记忆？删除即真删，不可恢复。', { danger: true }))) return;
        await api(`/api/memories/${id}`, { method: 'DELETE' });
        toast('已删除');
        await refresh();
      } else if (action === 'edit-contact') {
        // 编辑联系人：复用新建表单预填当前值，提交时按 editingContactId 走 PATCH
        const { contact: c } = await api(`/api/contacts/${id}`);
        state.editingContactId = id;
        $('#nc-name').value = c.name || '';
        $('#nc-relation').value = c.relation || 'friend';
        $('#nc-birthday').value = c.birthday || '';
        $('#nc-tags').value = (c.tags || []).join(' ');
        openModal('contact');
      } else if (action === 'toggle-archive') {
        const contact = state.contacts.find((x) => x.id === id);
        await api(`/api/contacts/${id}`, { method: 'PATCH', body: { archived: !contact?.archived } });
        toast(contact?.archived ? '已取消归档' : '已归档');
        await refresh();
      } else if (action === 'delete-contact') {
        if (!(await confirmDialog('删除该联系人及其全部记忆？删除即真删，不可恢复。', { danger: true }))) return;
        const r = await api(`/api/contacts/${id}`, { method: 'DELETE' });
        toast(`已删除联系人（含 ${r.removedMemories} 条记忆）`);
        await refresh();
      } else if (action === 'rel-rename') {
        const key = actionBtn.dataset.key;
        const t = state.relationTypes.find((x) => x.key === key);
        const label = await promptDialog(`把「${t?.label || key}」的显示名改为：`, t?.label || '');
        if (!label) return;
        await api(`/api/relations/${key}`, { method: 'PATCH', body: { label } });
        toast('已改名');
        await refresh();
        renderRelationTypes();
      } else if (action === 'rel-delete') {
        const key = actionBtn.dataset.key;
        const t = state.relationTypes.find((x) => x.key === key);
        if (!(await confirmDialog(`删除关系类型「${t?.label || key}」？被引用时将拒绝删除。`, { danger: true }))) return;
        await api(`/api/relations/${key}`, { method: 'DELETE' });
        toast('已删除');
        await refresh();
        renderRelationTypes();
      }
    } catch (err) {
      toast(err.message || '操作失败', true);
    }
  });

  // ---------- 弹窗 ----------
  function setMemoryMode(mode) {
    const manual = mode === 'manual';
    $('#form-quick-memory').classList.toggle('hidden', !manual);
    $('#form-smart').classList.toggle('hidden', manual);
    $('#modal-backdrop .modal').setAttribute('aria-label', manual ? '手动录入' : '记一笔');
    $('#qmt-ok').textContent = state.dshEmbedded ? '保存并让 AI 整理' : '保存原话';
    $('#capture-mode').textContent = state.dshEmbedded
      ? '素材保存在本机；保存后，你选择的内容会交给 DSH 配置的模型整理，确认前不会成为长期记忆。'
      : '素材保存在本机；复制指令后需粘贴到 DSH 会话才会开始整理，届时你选择的内容会交给配置的模型处理。';
    $(manual ? '#qm-content' : '#qmt-text').focus();
  }

  function openRemember(contactId) {
    openModal('memory');
    if (contactId) {
      $('#qm-contact').value = contactId;
      $('#qmt-contact').value = contactId;
    }
    if ($('#qmt-contact').selectedOptions.length) $('.capture-options').open = true;
  }

  function fillContactSelects({ preserveSelection = false } = {}) {
    const options = state.contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const contactId = preserveSelection ? $('#qm-contact').value : (state.view === 'contacts' ? state.activeContactId : null);
    const selectedIds = new Set(preserveSelection
      ? [...$('#qmt-contact').selectedOptions].map((option) => option.value)
      : (contactId ? [contactId] : []));
    $('#qm-contact').innerHTML = `<option value="">请选择联系人</option>${options}`;
    $('#qm-contact').value = contactId || '';
    $('#qm-contact-hint').classList.toggle('hidden', state.contacts.length > 0);
    $('#qm-ok').disabled = !state.contacts.length;
    $('#qmt-contact').innerHTML = options;
    for (const option of $('#qmt-contact').options) option.selected = selectedIds.has(option.value);
  }

  function fillRelationSelect(selected = 'friend') {
    if (!state.relationTypes.length) return; // 保留 HTML 静态 options 作为兜底
    const sel = $('#nc-relation');
    const cur = sel.value || selected;
    sel.innerHTML = state.relationTypes.map((t) => `<option value="${esc(t.key)}"${t.key === cur ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  }

  function renderRelationTypes() {
    const list = state.relationTypes;
    $('#relation-type-list').innerHTML = list.length ? list.map((t) => `
      <div class="rel-type-row" data-key="${esc(t.key)}">
        <span class="rel-type-label"><b>${esc(t.label)}</b> <small>${esc(t.key)}</small></span>
        ${t.builtin ? '<span class="badge">内置</span>' : ''}
        <span class="rel-type-actions">
          <button type="button" class="icon-btn" data-action="rel-rename" data-key="${esc(t.key)}">改名</button>
          ${t.builtin ? '' : `<button type="button" class="icon-btn danger" data-action="rel-delete" data-key="${esc(t.key)}">删除</button>`}
        </span>
      </div>`).join('') : '<div class="empty">还没有关系类型。</div>';
  }

  let safetyToken = '';
  let safetyBusy = false;
  let historyRequest = 0;

  function clearRestorePreview() {
    safetyToken = '';
    $('#safety-preview').replaceChildren();
    $('#safety-preview').classList.add('hidden');
    $('#safety-restore').classList.add('hidden');
  }

  async function safetyTask(operation) {
    if (safetyBusy) return;
    safetyBusy = true;
    $$('#form-safety button, #safety-file').forEach((el) => { el.disabled = true; });
    try { await operation(); }
    catch (error) { $('#safety-status').textContent = error.message || '操作失败，请重试'; }
    finally {
      safetyBusy = false;
      $$('#form-safety button, #safety-file').forEach((el) => { el.disabled = false; });
    }
  }

  function backupCounts(counts = {}) {
    return [['contacts', '位联系人'], ['memories', '条记忆'], ['materials', '份素材'], ['plans', '个计划'], ['followups', '条提醒处理'], ['materialDeliveries', '条发送记录']]
      .map(([key, label]) => `${Number(counts[key]) || 0} ${label}`).join(' · ');
  }

  async function loadBackupList() {
    const result = await api('/api/data/status');
    $('#safety-status').textContent = result.recoveryRequired
      ? '数据恢复未完成，已暂停业务读写。请先下载现有备份，再重启工作台；若仍无法启动，请保留原数据目录和恢复日志以便排查。'
      : result.backupError ? `自动备份失败：${result.backupError}`
      : `${result.backend === 'rust' ? 'SQLite' : 'JSON'} 存储 · 自动备份保留最近 7 份，手动与恢复前备份另行保留。`;
    $('#safety-backups').innerHTML = result.backups.length ? result.backups.map((b) =>
      `<article class="backup-row"><div><b>${esc(new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false }))}</b><p>${esc(backupCounts(b.counts))}</p></div>
        <div class="safety-actions"><button class="ghost-btn" type="button" data-backup-download="${esc(b.id)}">下载</button>
        <button class="ghost-btn" type="button" data-backup-preview="${esc(b.id)}">预览恢复</button></div></article>`).join('')
      : '<p class="empty">还没有备份，可以先点击「立即备份」。</p>';
  }

  async function downloadBackup(id) {
    const response = await fetch(`api/data/backups/${encodeURIComponent(id)}/download`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || '备份下载失败');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `relationship-backup-${Date.now()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function previewRestore(body) {
    clearRestorePreview();
    const result = await api('/api/data/restore/preview', { method: 'POST', body });
    safetyToken = result.token;
    $('#safety-preview').innerHTML = `<b>恢复预览 · 尚未修改当前数据</b><p>${esc(new Date(result.preview.createdAt).toLocaleString('zh-CN', { hour12: false }))}</p><p>${esc(backupCounts(result.preview.counts))}</p><p>恢复范围包含素材报告、反问、计划关联、修改历史、提醒处理及素材发送记录。旧版备份不含的提醒与发送状态将被清空。</p>`;
    $('#safety-preview').classList.remove('hidden');
    $('#safety-restore').classList.remove('hidden');
    $('#safety-status').textContent = '校验通过，请核对备份时间和数量后再确认。';
  }

  async function showMemoryHistory(memoryId) {
    const request = ++historyRequest;
    $('#memory-history').textContent = '正在读取修改历史…';
    openModal('history');
    try {
      const { history } = await api(`/api/memories/${encodeURIComponent(memoryId)}/history`);
      if (request !== historyRequest) return;
      $('#memory-history').innerHTML = history.length ? history.map((entry) =>
        `<article class="history-entry"><b>${esc(new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false }))}</b><span class="badge">${entry.source === 'ai-confirmed' ? 'AI 修改经确认' : entry.source === 'restore' ? '历史恢复' : '手动修改'}</span>
        ${memoryDiff(entry.before, entry.after)}<button class="ghost-btn" type="button" data-history-restore="${esc(entry.id)}" data-memory-id="${esc(memoryId)}">恢复到此次修改前</button></article>`).join('')
        : '<p class="empty">暂无修改历史；启用此功能后的修改会记录在这里。</p>';
    } catch (error) {
      if (request === historyRequest) $('#memory-history').textContent = error.message;
    }
  }

  $('#btn-data-safety').addEventListener('click', () => {
    clearRestorePreview();
    $('#safety-file').value = '';
    openModal('safety');
    safetyTask(loadBackupList);
  });
  $('#safety-create').addEventListener('click', () => safetyTask(async () => {
    await api('/api/data/backups', { method: 'POST', body: {} });
    await loadBackupList();
    $('#safety-status').textContent = '备份已保存到本机。';
  }));
  $('#safety-export').addEventListener('click', () => safetyTask(async () => {
    const { backup } = await api('/api/data/backups', { method: 'POST', body: {} });
    await downloadBackup(backup.id);
    await loadBackupList();
  }));
  $('#safety-backups').addEventListener('click', (event) => {
    const download = event.target.closest('[data-backup-download]');
    const preview = event.target.closest('[data-backup-preview]');
    if (download) safetyTask(() => downloadBackup(download.dataset.backupDownload));
    if (preview) safetyTask(() => previewRestore({ backupId: preview.dataset.backupPreview }));
  });
  $('#safety-file').addEventListener('change', () => safetyTask(async () => {
    clearRestorePreview();
    const file = $('#safety-file').files[0];
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) throw new Error('备份文件不能超过 64 MB');
    let backup;
    try { backup = JSON.parse(await file.text()); }
    catch { throw new Error('文件不是有效的 JSON 备份，未修改当前数据'); }
    await previewRestore({ backup });
  }));
  $('#safety-restore').addEventListener('click', async () => {
    if (safetyBusy || !safetyToken) return;
    if (!(await confirmDialog('恢复会替换当前联系人、记忆、素材和计划，并先备份现有数据。确定恢复已预览的备份？', { danger: true }))) return;
    await safetyTask(async () => {
      const token = safetyToken;
      clearRestorePreview();
      await api('/api/data/restore/confirm', { method: 'POST', body: { token } });
      state.editingMemoryId = null;
      state.editingPendingId = null;
      await loadBackupList();
      await refresh();
      $('#safety-status').textContent = '恢复完成，恢复前的数据已另行备份。';
    });
  });
  $('#safety-close').addEventListener('click', closeModal);
  $('#history-close').addEventListener('click', closeModal);
  $('#supersede-cancel').addEventListener('click', closeModal);
  $('#supersede-search').addEventListener('input', () => {
    const query = $('#supersede-search').value.trim().toLowerCase();
    $$('#supersede-list .supersede-item').forEach((el) => {
      el.classList.toggle('hidden', query && !el.textContent.toLowerCase().includes(query));
    });
  });
  $('#supersede-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.supersede-item');
    if (!item || item.disabled) return;
    const keepId = item.dataset.memoryId;
    const id = state.supersedeMemoryId;
    if (!id || !keepId) return;
    item.disabled = true;
    try {
      await api('/api/memories/supersede', { method: 'POST', body: { id, keepId } });
      state.supersedeMemoryId = null;
      state.supersedeContactId = null;
      closeModal();
      toast('已标记被取代（不再出现在时间线与检索）');
      await refresh();
    } catch (err) {
      item.disabled = false;
      toast(err.message || '取代失败', true);
    }
  });
  $('#memory-history').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-history-restore]');
    if (!button || button.disabled) return;
    if (!(await confirmDialog('将当前记忆恢复到这次修改前的内容？此次恢复也会记录在历史中。'))) return;
    button.disabled = true;
    try {
      await api(`/api/memories/${encodeURIComponent(button.dataset.memoryId)}/history/${encodeURIComponent(button.dataset.historyRestore)}/restore`, { method: 'POST', body: {} });
      await showMemoryHistory(button.dataset.memoryId);
      await refresh();
      toast('已恢复旧内容，并记录本次修改');
    } catch (error) { toast(error.message, true); button.disabled = false; }
  });

  let jdSession = null;
  function cancelJdSession() {
    jdSession?.controller.abort();
    jdSession = null;
  }

  function openModal(which) {
    if ($('#modal-backdrop').classList.contains('hidden')) modalTrigger = document.activeElement;
    cancelJdSession();
    $('#form-jd').classList.toggle('hidden', which !== 'jd');
    $('#form-quick-memory').classList.add('hidden');
    $('#form-smart').classList.add('hidden');
    $('#modal-backdrop').classList.remove('hidden');
    $('#form-contact').classList.toggle('hidden', which !== 'contact');
    if (which === 'contact') {
      fillRelationSelect();
      $('#nc-title-text').textContent = state.editingContactId ? '编辑联系人' : '新建联系人';
    }
    if (which === 'memory') {
      fillContactSelects();
      setMemoryMode('smart');
    }
    $('#form-plan').classList.toggle('hidden', which !== 'plan');
    $('#form-suggest').classList.toggle('hidden', which !== 'suggest');
    $('#form-relations').classList.toggle('hidden', which !== 'relations');
    $('#form-safety').classList.toggle('hidden', which !== 'safety');
    $('#form-history').classList.toggle('hidden', which !== 'history');
    $('#form-supersede').classList.toggle('hidden', which !== 'supersede');
    $('#form-first').classList.toggle('hidden', which !== 'first');
    $('#form-airesult').classList.toggle('hidden', which !== 'airesult');
    $('#form-qr').classList.toggle('hidden', which !== 'qr');
    if (which === 'relations') renderRelationTypes();
    syncModalBackground();
    const root = $('#modal-backdrop');
    $('.modal', root).setAttribute('aria-label', $('.modal-body:not(.hidden) h3', root)?.textContent || '记一笔');
    ($(`#${which === 'memory' ? 'qmt-text' : which === 'contact' ? 'nc-name' : which === 'plan' ? 'plan-contact' : which === 'suggest' ? 'suggest-list' : which === 'relations' ? 'rt-key' : which === 'first' ? 'fr-name' : which === 'airesult' ? 'airesult-close' : which === 'qr' ? 'form-qr [data-role="plan-cancel"]' : which === 'supersede' ? 'supersede-search' : 'qm-content'}`))?.focus?.();
    if (!root.contains(document.activeElement)) focusableIn(root)[0]?.focus();
  }
  function closeModal() {
    if (sendingSuggestion || $('#modal-backdrop').classList.contains('hidden')) return;
    if (safetyBusy && !$('#form-safety').classList.contains('hidden')) return;
    clearRestorePreview();
    historyRequest += 1;
    cancelJdSession();
    $('#form-jd').reset();
    $('#jd-results').replaceChildren();
    $('#modal-backdrop').classList.add('hidden');
    $('#form-contact').reset();
    $('#form-quick-memory').reset();
    $('#form-plan').reset();
    $('#form-suggest').reset();
    $('#form-relations').reset();
    $('#form-first').reset();
    state.editingPlanId = null;
    state.editingContactId = null;
    state.suggestContactId = null;
    state.suggestPlanId = null;
    qrCopyUrl = '';
    $('#airesult-body').textContent = '';
    syncModalBackground();
    restoreFocus(modalTrigger);
    modalTrigger = null;
  }
  $('#btn-new-contact').addEventListener('click', () => openModal('contact'));
  $('#btn-manage-relations').addEventListener('click', () => openModal('relations'));
  $('#btn-quick-memory').addEventListener('click', () => openRemember());
  $('#qmt-manual').addEventListener('click', () => setMemoryMode('manual'));
  $('#qm-create-contact').addEventListener('click', () => openModal('contact'));
  $('#qm-back').addEventListener('click', () => setMemoryMode('smart'));
  $('#nc-cancel').addEventListener('click', closeModal);
  $('#rt-cancel').addEventListener('click', closeModal);
  $('#qm-cancel').addEventListener('click', closeModal);
  $('#qmt-cancel').addEventListener('click', closeModal);
  $('#fr-cancel').addEventListener('click', closeModal);
  $('#airesult-close').addEventListener('click', closeModal);
  const FIRST_SCENARIOS = {
    say: '想想下一步',
    gift: '不知道送什么',
    reconnect: '重新联系',
  };
  $('#form-first').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#fr-go');
    if (button.disabled) return;
    const name = $('#fr-name').value.trim();
    if (!name) return;
    const note = $('#fr-note').value.trim();
    button.disabled = true;
    sendingSuggestion = true;
    try {
      const r = await api('/api/first-run', { method: 'POST', body: { name, scenario: state.firstScenario, note } });
      await refresh();
      if (state.dshEmbedded) {
        await askHostAi(r.prompt, { title: `下一步 · ${name}`, onSent: () => { sendingSuggestion = false; closeModal(); } });
      } else {
        await navigator.clipboard.writeText(r.prompt);
        sendingSuggestion = false;
        closeModal();
        toast('建议指令已复制，粘贴到 DSH 会话获取下一步建议');
      }
    } catch (error) { toast(`建议未发送，输入已保留，可重试。${error.message}`, true); }
    finally { sendingSuggestion = false; button.disabled = false; }
  });
  $$('#modal-backdrop [data-role="plan-cancel"]').forEach((btn) => btn.addEventListener('click', closeModal));
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target === $('#modal-backdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    const root = topModal();
    if (!root) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if ($('#rel-dialog')) closeDialog(null);
      else closeModal();
    } else if (e.key === 'Tab') {
      const items = focusableIn(root);
      const index = items.indexOf(document.activeElement);
      if (index < 0 || (e.shiftKey && index === 0) || (!e.shiftKey && index === items.length - 1)) {
        e.preventDefault();
        items[e.shiftKey ? items.length - 1 : 0]?.focus();
      }
    }
  });
  document.addEventListener('focusin', (e) => {
    const root = topModal();
    if (root && !root.contains(e.target)) focusableIn(root)[0]?.focus();
  });

  // 嵌入 DSH（sandbox iframe）时，桌面壳会静默吞掉来自 iframe 的 target=_blank——
  // 外链统一 postMessage 交给宿主页面代开（与聊天内链接同一条通路）；独立工作台保持原生新标签。
  document.addEventListener('click', (e) => {
    if (window.parent === window) return;
    const link = e.target.closest('a[target="_blank"]');
    if (!link) return;
    const url = safeProductUrl(link.getAttribute('href') || '');
    if (!url) return;
    e.preventDefault();
    window.parent.postMessage({ source: 'dsh-relationship', type: 'open-external', url }, window.location.origin);
  });
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    const data = e.data;
    if (!data || data.source !== 'dsh-relationship-host' || data.type !== 'open-external-blocked') return;
    const url = typeof data.url === 'string' ? safeProductUrl(data.url) : '';
    if (!url) return;
    navigator.clipboard.writeText(url)
      .then(() => toast('桌面端未能打开新窗口：商品链接已复制，请粘贴到浏览器打开'))
      .catch(() => toast('桌面端未能打开新窗口：请点「复制链接」后粘贴到浏览器打开', true));
  });

  $('#form-contact').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tags = $('#nc-tags').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    const payload = { name: $('#nc-name').value, relation: $('#nc-relation').value, birthday: $('#nc-birthday').value.trim(), tags };
    try {
      if (state.editingContactId) {
        await api(`/api/contacts/${state.editingContactId}`, { method: 'PATCH', body: payload });
        closeModal();
        toast('联系人已更新');
      } else {
        await api('/api/contacts', { method: 'POST', body: payload });
        closeModal();
        toast('联系人已创建');
      }
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  $('#form-relations').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('#rt-key').value.trim();
    const label = $('#rt-label').value.trim();
    if (!key || !label) { toast('标识和显示名都不能为空', true); return; }
    try {
      await api('/api/relations', { method: 'POST', body: { key, label } });
      $('#rt-key').value = '';
      $('#rt-label').value = '';
      toast('已添加');
      await refresh();
      renderRelationTypes();
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
    const button = $('#qmt-ok');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const r = await api('/api/materials', {
        method: 'POST',
        body: { text: $('#qmt-text').value, contactIds: [...$('#qmt-contact').selectedOptions].map((o) => o.value), occasion: $('#qmt-occasion').value },
      });
      closeModal();
      $('#form-smart').reset();
      $('.capture-options').open = false;
      state.view = 'home';
      const more = $('.materials-more');
      if (more) more.open = true;
      state.disclosures.set('materials-more', true);
      await refresh();
      $$('.material-card').find((card) => card.dataset.id === r.material.id)?.scrollIntoView({ block: 'center' });
      await deliverMaterial(r.material.id);
    } catch (err) { toast(err.message, true); }
    finally { button.disabled = false; }
  });

  function syncJdMode(session) {
    const hasKeyword = Boolean($('#jd-keyword').value.trim());
    $('#jd-min-price').disabled = session.busy || !hasKeyword;
    $('#jd-max-price').disabled = session.busy || !hasKeyword;
    $('#jd-search').disabled = session.busy || !session.configured;
    $('#jd-search').textContent = session.busy ? '处理中…' : (hasKeyword ? '搜索商品' : '查看热销榜');
    $('#jd-price-hint').textContent = (hasKeyword
      ? '价格仅适用于关键词搜索，价格范围按京东券后价筛选，参考标价可能高于筛选上限。'
      : '全部品类24小时热销榜前20不支持价格筛选；已填价格保留但不发送，输入关键词后恢复。')
      + '列表展示参考标价，并非成交价。优惠资格和实付金额以京东结算页为准。选择商品时仅发送商品编号至京东。';
  }

  function jdBusy(session, busy) {
    session.busy = busy;
    $('#form-jd').setAttribute('aria-busy', String(busy));
    $$('#form-jd input, #jd-results button').forEach((el) => { el.disabled = busy; });
    $('#jd-status-retry').disabled = busy;
    syncJdMode(session);
  }

  async function checkJdStatus(session) {
    if (jdSession !== session || session.busy) return;
    jdBusy(session, true);
    $('#jd-status').textContent = '正在检查本机京东配置…';
    $('#jd-status-retry').classList.add('hidden');
    try {
      const result = await api('/api/jd/status', { signal: session.controller.signal });
      if (jdSession !== session) return;
      session.configured = result.configured === true;
      const names = ['JD_APP_KEY', 'JD_APP_SECRET', 'JD_SITE_ID', 'JD_POSITION_ID'];
      const missing = (result.missing || []).filter((name) => names.includes(name));
      $('#jd-status').textContent = session.configured
        ? (session.prefilled ? '配置就绪，关键词已按原计划预填，可直接搜索或修改；清空可查看全部品类24小时热销榜前20。' : '配置就绪，可填写关键词搜索，或留空查看全部品类24小时热销榜前20。')
        : `京东尚未配置：请在运行 relstore 的本机环境设置 ${missing.join('、') || names.slice(0, 3).join('、')}，JD_POSITION_ID 可选；重启工作台后重新检查。请勿在此输入密钥。`;
      $('#jd-status-retry').classList.toggle('hidden', session.configured);
    } catch (err) {
      if (jdSession !== session) return;
      session.configured = false;
      $('#jd-status').textContent = err.message || '配置检查失败，请重试';
      $('#jd-status-retry').classList.remove('hidden');
    } finally {
      if (jdSession === session) jdBusy(session, false);
    }
  }

  function jdKeywordFromPlan(plan) {
    if (plan.productName) return plan.productName.slice(0, 80);
    // 商品词从想法首句派生；电话/见面类客套话（「联系一下」「约饭」）宁空不猜——
    // 弹窗留空时本就有手填与热销榜引导（见 #jd-status 文案）
    return PlanParse.giftKeyword(plan.idea || '');
  }

  function openJdModal(id) {
    const plan = state.plans.find((p) => p.id === id);
    if (!plan || !activePlan(plan)) { toast('计划不存在或已结束', true); return; }
    openModal('jd');
    $('#form-jd').reset();
    $('#jd-results').replaceChildren();
    $('#jd-plan-reference').textContent = `原计划（仅本地参考）：${plan.idea}${plan.budget ? `；预算参考：${plan.budget}（请自行填写价格范围）` : ''}`;
    const keyword = jdKeywordFromPlan(plan);
    $('#jd-keyword').value = keyword;
    const session = { planId: id, controller: new AbortController(), configured: false, busy: false, items: [], prefilled: Boolean(keyword) };
    jdSession = session;
    syncJdMode(session);
    checkJdStatus(session);
    $('#jd-keyword').focus();
  }

  $('#jd-keyword').addEventListener('input', () => { if (jdSession) syncJdMode(jdSession); });
  $('#jd-status-retry').addEventListener('click', () => { if (jdSession) checkJdStatus(jdSession); });
  $('#form-jd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const session = jdSession;
    if (!session || session.busy || !session.configured) return;
    const body = { keyword: $('#jd-keyword').value.trim() };
    const isRanking = !body.keyword;
    if (!isRanking) {
      for (const [field, id] of [['minPrice', 'jd-min-price'], ['maxPrice', 'jd-max-price']]) {
        const value = $(`#${id}`).value;
        if (value !== '') body[field] = Number(value);
      }
      if (body.minPrice > body.maxPrice) { $('#jd-status').textContent = '最低价不能高于最高价'; return; }
    }
    session.items = [];
    $('#jd-results').replaceChildren();
    $('#jd-status').textContent = isRanking ? '正在获取京东全部品类24小时热销榜前20…' : '正在京东搜索商品…';
    jdBusy(session, true);
    try {
      const result = await api(`/api/plans/${encodeURIComponent(session.planId)}/jd/search`, { method: 'POST', body, signal: session.controller.signal });
      if (jdSession !== session) return;
      session.items = (result.items || []).slice(0, 20);
      $('#jd-results').innerHTML = session.items.map((item, index) => {
        const image = safeProductUrl(item.imageUrl, true);
        return `<article class="occ-card"><div class="occ-main">${image ? `<img src="${esc(image)}" alt="" width="72" height="72" loading="lazy" referrerpolicy="no-referrer"/>` : ''}<p class="occ-title">${esc(item.name)}</p><p class="muted">参考标价 ¥${esc(item.price)}（非成交价）</p></div><button type="button" class="ghost-btn" data-jd-index="${index}">选中并关联</button></article>`;
      }).join('');
      $('#jd-status').textContent = isRanking
        ? (session.items.length ? `全部品类24小时热销榜前20：返回 ${session.items.length} 件候选商品，选中后生成 CPS 推广链接。` : '全部品类24小时热销榜前20暂无商品，可稍后重试或填写关键词搜索。')
        : (session.items.length ? `搜索找到 ${session.items.length} 件候选商品，选中后生成 CPS 推广链接。` : '搜索没有找到商品，请调整关键词或价格范围后重试。');
      await refresh();
    } catch (err) {
      if (jdSession === session) $('#jd-status').textContent = isRanking
        ? `全部品类24小时热销榜前20加载失败：${err.message || '请稍后重试'}；可再次查看热销榜重试。`
        : `商品搜索失败：${err.message || '请稍后重试'}；可修改条件后重新搜索。`;
    } finally {
      if (jdSession === session) jdBusy(session, false);
    }
  });

  $('#jd-results').addEventListener('click', async (e) => {
    if (e.target.closest('[data-jd-done]')) { closeModal(); return; }
    if (e.target.closest('[data-jd-copy]')) {
      const url = jdSession?.linkedUrl || '';
      if (!url) return;
      try { await navigator.clipboard.writeText(url); toast('商品链接已复制，可粘贴到浏览器打开'); }
      catch { toast('复制失败，请稍后重试或从计划卡的商品链接右键复制', true); }
      return;
    }
    const button = e.target.closest('[data-jd-index]');
    const session = jdSession;
    if (!button || !session || session.busy) return;
    const item = session.items[Number(button.dataset.jdIndex)];
    if (!item) return;
    jdBusy(session, true);
    $('#jd-status').textContent = '正在验证商品并生成 CPS 推广链接…关闭弹窗不会撤销已发出的关联请求。';
    try {
      const result = await api(`/api/plans/${encodeURIComponent(session.planId)}/jd/select`, { method: 'POST', body: { itemId: item.itemId, name: item.name, price: item.price }, signal: session.controller.signal });
      if (jdSession !== session) return;
      // 关联成功不自动跳转（await 之后 window.open 会被弹窗拦截静默吞掉），也不直接关弹窗：
      // 原地显示「立即查看商品」由用户点击新开标签，点「完成」再关。
      // 嵌入 DSH 沙箱 iframe 时桌面壳还会吞掉 target=_blank（点击无反应）——外链
      // 由下方全局监听改走宿主页面代开；「复制链接」是任何环境都有效的逃生口。
      session.items = [];
      const url = safeProductUrl(result?.plan?.productUrl);
      session.linkedUrl = url;
      $('#jd-results').innerHTML = `<div class="jd-linked"><p><b>已关联原计划 ✓</b>已生成 CPS 推广链接；未购买、未标记已送。</p>${url ? `<div class="jd-linked-actions"><a class="primary-btn" href="${esc(url)}" target="_blank" rel="noreferrer noopener">立即查看商品 ↗</a><button type="button" class="ghost-btn" data-jd-copy>复制链接</button></div>` : ''}${url ? '<div class="jd-qr" role="img" aria-label="商品链接二维码"></div>' : ''}<button type="button" class="ghost-btn" data-jd-done>完成</button><p class="muted">手机扫码直达京东下单（佣金归本链接）；桌面没弹出窗口时点「复制链接」粘贴到浏览器。想换商品，重新搜索选中即可覆盖当前关联。</p></div>`;
      const qrBox = $('#jd-results .jd-qr');
      if (qrBox) qrBox.innerHTML = qrSvg(url) || '<p class="muted">链接过长无法生成二维码，可复制链接使用。</p>';
      $('#jd-status').textContent = '';
      toast('已关联原计划（CPS 推广链接），未购买、未标记已送');
      await refresh();
    } catch (err) {
      if (jdSession === session) {
        // 关联是终点动作，失败不能只写状态行小字（用户会以为点了没反应）——toast 必须出来
        $('#jd-status').textContent = `${err.message || '关联失败'}；可再次选择重试。`;
        toast(err.message || '关联失败，请查看弹窗内提示后重试', true);
      }
    } finally {
      if (jdSession === session) jdBusy(session, false);
    }
  });

  $('[data-qr-copy]').addEventListener('click', async () => {
    if (!qrCopyUrl) return;
    try { await navigator.clipboard.writeText(qrCopyUrl); toast('商品链接已复制，可粘贴到浏览器打开'); }
    catch { toast('复制失败，请稍后重试', true); }
  });

  // ---------- 礼赠 ----------
  function fillPlanContacts(selected) {
    $('#plan-contact').innerHTML = '<option value="">请选择联系人</option>'
      + state.contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#plan-contact').value = selected || '';
  }

  function updatePlanDetailsSummary() {
    const details = [$('#plan-occasion').value.trim(), $('#plan-budget').value.trim(), $('#plan-status').value === 'decided' ? '已定' : ''].filter(Boolean);
    $('#plan-details-summary').textContent = details.length ? `· ${details.join(' · ')}` : '（可选）';
    const product = $('#plan-product-name').value.trim() || ($('#plan-product-price').value.trim() || $('#plan-product-url').value.trim() ? '已填商品信息' : '');
    $('#plan-product-summary').textContent = product ? `· ${product}` : '（仅送礼时选填）';
  }

  function openPlanModal(contactId, occasion, occasionDate, plan) {
    if (!state.contacts.length) { toast('先到「联系人」新建一个联系人', true); return; }
    $('#plan-say').value = '';
    $('#plan-say-hint').classList.add('hidden');
    fillPlanContacts(plan?.contactId || contactId || (state.view === 'contacts' ? state.activeContactId : ''));
    $('#plan-occasion').value = occasion ?? plan?.occasion ?? '';
    $('#plan-date').value = occasionDate ?? plan?.occasionDate ?? '';
    $('#plan-idea').value = plan?.idea || '';
    $('#plan-budget').value = plan?.budget || '';
    $('#plan-product-name').value = plan?.productName || '';
    $('#plan-product-price').value = plan?.productPrice || '';
    $('#plan-product-url').value = plan?.productUrl || '';
    $('#plan-status').value = plan && activePlan(plan) ? plan.status : 'idea';
    $('#plan-details').open = false;
    $('#plan-product-details').open = false;
    $('#plan-title').textContent = plan ? '编辑打算' : '记个打算';
    $('#plan-capture').classList.toggle('hidden', Boolean(plan));
    $('#plan-save').textContent = plan ? '保存修改' : '保存打算';
    updatePlanDetailsSummary();
    state.editingPlanId = plan?.id || null;
    openModal('plan');
    $(plan ? '#plan-idea' : '#plan-say').focus();
  }

  $('#btn-new-plan').addEventListener('click', () => openPlanModal());
  $('#btn-quick-plan').addEventListener('click', () => openPlanModal());
  $('#form-plan').addEventListener('input', updatePlanDetailsSummary);
  $('#form-plan').addEventListener('change', updatePlanDetailsSummary);

  $('#plan-say').addEventListener('input', () => {
    const text = $('#plan-say').value.trim();
    const hint = $('#plan-say-hint');
    if (!text) { hint.classList.add('hidden'); return; }
    const r = PlanParse.parse(text, { contacts: state.contacts });
    const bits = [];
    if (r.contactId) { $('#plan-contact').value = r.contactId; bits.push(`联系人 ${r.contactName}`); }
    else bits.push('没认出联系人，请核对选择');
    if (r.date) { $('#plan-date').value = r.date; bits.push(`日期 ${r.date}`); }
    else bits.push('日期可留空或手动补充');
    if (r.occasion) $('#plan-occasion').value = r.occasion;
    if (r.idea) $('#plan-idea').value = r.idea;
    hint.textContent = `${bits.join(' · ')}。保存前可修改。`;
    hint.classList.remove('hidden');
    updatePlanDetailsSummary();
  });

  async function openSuggestModal(contactId, occasion, planId, occasionDate = '') {
    const c = state.contacts.find((x) => x.id === contactId);
    if (!c) { toast('联系人不存在', true); return; }
    const plan = findPlan(planId);
    if (planId && (!plan || plan.contactId !== contactId)) { toast('计划已变化，请刷新后重试', true); return; }
    if (plan) {
      occasion = plan.occasion || '';
      occasionDate = plan.occasionDate || '';
    }
    state.suggestContactId = contactId;
    state.suggestPlanId = plan?.id || null;
    $('#suggest-target').dataset.occasion = occasion;
    $('#suggest-target').dataset.date = occasionDate;
    $('#suggest-target').innerHTML = `为 <b>${esc(c.name)}</b>${occasion ? ` · ${esc(occasion)}` : ''} · ${occasionDate ? esc(fmtDate(occasionDate)) : '日期未定'}${plan ? ` · 围绕已有计划「${esc(plan.idea)}」` : ''} 出主意`;
    const list = $('#suggest-list');
    list.innerHTML = '<div class="empty">正在读取记忆…</div>';
    openModal('suggest');
    try {
      const r = await api(`/api/memories?contact_id=${contactId}&status=confirmed`);
      const relevant = r.memories.filter((m) => ['preference', 'dislike', 'taboo', 'gift', 'attribute', 'event'].includes(m.type) && !m.supersededBy);
      if (!relevant.length) {
        // 零记忆不再是死路：后端 prompt 会带标签（职业/身份）给通用稳妥建议，放行让用户自己决定
        const tags = c.tags || [];
        list.innerHTML = `<div class="empty">还没有已确认记忆${tags.length ? `（TA 的标签：${tags.map((x) => esc(x)).join('、')}）` : ''}。可以直接继续，AI 会基于标签与关系给通用稳妥建议并明说没有记忆依据；想更贴合，先去「记一笔」补些喜好/禁忌。</div>`;
        $('#suggest-ok').disabled = false;
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
    const button = $('#suggest-ok');
    if (button.disabled) return;
    const contactId = state.suggestContactId;
    if (!contactId) return;
    const memoryIds = $$('#suggest-list input[type="checkbox"]:checked').map((x) => x.value);
    const budget = $('#suggest-budget').value.trim();
    const plan = findPlan(state.suggestPlanId);
    if (state.suggestPlanId && (!plan || plan.contactId !== contactId)) { toast('计划已变化，请重新打开建议', true); return; }
    const occasion = plan ? (plan.occasion || '') : ($('#suggest-target').dataset.occasion || '');
    const occasionDate = plan ? (plan.occasionDate || '') : ($('#suggest-target').dataset.date || '');
    button.disabled = true;
    sendingSuggestion = true;
    try {
      const { prompt, evidenceCount } = await api('/api/gift-suggest', { method: 'POST', body: { contactId, memoryIds, budget, occasion, occasionDate, planId: state.suggestPlanId || undefined } });
      if (!state.dshEmbedded) {
        await navigator.clipboard.writeText(prompt);
        sendingSuggestion = false;
        closeModal();
        toast(evidenceCount ? '礼物建议指令已复制，粘贴到 DSH 会话即可' : '暂无记忆依据，指令已复制；AI 会基于标签给通用建议');
        return;
      }
      await askHostAi(prompt, { title: '送什么 · AI 建议', onSent: () => { sendingSuggestion = false; closeModal(); } });
    } catch (err) { toast(`建议未发送，输入已保留，可重试。${err.message}`, true); }
    finally { sendingSuggestion = false; button.disabled = false; }
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
    const relevant = ['memory.changed', 'contact.changed', 'material.changed', 'plan.changed', 'followup.changed', 'relation.changed', 'overview'];
    for (const name of relevant) es.addEventListener(name, scheduleRefresh);
    es.addEventListener('data.restored', () => {
      state.editingMemoryId = null;
      state.editingPendingId = null;
      state.memorySearchQuery = '';
      state.memorySearchResults = [];
      clearRestorePreview();
      cancelJdSession();
      if (!safetyBusy) closeModal();
      scheduleRefresh();
    });
    es.onopen = () => markStatus(true);
    es.onerror = () => markStatus(false);
  }

  let reminderDay = new Date().toDateString();
  setInterval(() => {
    const today = new Date().toDateString();
    if (today === reminderDay) return;
    reminderDay = today;
    scheduleRefresh();
  }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });

  // ---------- 启动 ----------
  api('api/info').then((info) => { state.info = info || {}; }).catch(() => {});
  connectEvents();
  refresh();
})();
