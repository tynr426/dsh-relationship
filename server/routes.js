// HTTP 路由：静态前端 + REST API + SSE + AI 工具入口
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';
import store from './store-facade.js';
import { sseHandler, broadcast } from './sse.js';
import { executeTool, TOOL_CN } from './tools.js';
import { FLOWS } from './prompts.js';
import { runAsync } from './relstore-bridge.js';
import { searchCachedMemoryVectors } from './memory-vectors.js';

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function ok(res, obj) { json(res, 200, { ok: true, ...obj }); }
function fail(res, code, error) { json(res, code, { ok: false, error }); }
function failFrom(res, e) { fail(res, e?.status || 500, e?.message || String(e)); }

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw store.httpError(400, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function emitStats() { broadcast('overview', { counts: store.counts() }); }

function publicContact(c) { return { ...c }; }

// 见面简报事实卡：纯派生聚合（互动间隔/时机/回礼/承诺/相处注意）。
// timeline 响应用它做原生渲染（零 AI、随 SSE 刷新）；POST /api/briefing 用它组装话术 prompt。
function briefingFacts(c) {
  const confirmed = store.listMemories({ contactId: c.id, status: 'confirmed' }).filter((m) => !m.supersededBy);
  const byDateDesc = (a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '');
  // 禁忌/不喜好与承诺全量保留（安全与跟进关键），其余类型只取最近 12 条，更深的让 AI 用 timeline_get 补读
  const promises = confirmed.filter((m) => m.type === 'promise').sort(byDateDesc)
    .map((m) => ({ id: m.id, content: m.content, date: m.date || '' }));
  const cautions = confirmed.filter((m) => m.type === 'taboo' || m.type === 'dislike').sort(byDateDesc)
    .map((m) => ({ id: m.id, type: m.type, content: m.content }));
  const factLines = confirmed.filter((m) => !['promise', 'taboo', 'dislike'].includes(m.type)).sort(byDateDesc).slice(0, 12);
  return {
    lastSeen: store.fadingContacts(1).find((f) => f.contactId === c.id) || null,
    occasions: store.giftOccasions(90).filter((o) => o.contactId === c.id)
      .map((o) => ({ label: o.label, date: o.date, inDays: o.inDays })),
    reciprocity: store.giftReciprocity().filter((r) => r.contactId === c.id)
      .map((r) => ({ content: r.content, date: r.date, hasActivePlan: r.hasActivePlan })),
    promises,
    cautions,
    factLines,
  };
}

// ---------- API 处理器（body 已由外层读取） ----------
async function api(req, res, url, body) {
  const p = url.pathname;
  const m = (method) => req.method === method;
  const parts = p.split('/').filter(Boolean); // [api, ...]

  if (p === '/api/events') { sseHandler(req, res); return true; }

  if (p === '/api/info' && m('GET')) {
    ok(res, { name: 'dsh-relationship', title: '关系记忆工作台', port: url.port, dataDir: DATA_DIR, tools: Object.keys(TOOL_CN), counts: store.counts() });
    return true;
  }

  if (p === '/api/overview' && m('GET')) { ok(res, store.overview()); return true; }

  if (p === '/api/tools' && m('POST')) {
    const name = String(body.name ?? '');
    const result = await executeTool(name, body.args && typeof body.args === 'object' ? body.args : {});
    json(res, result.ok ? 200 : (result.status || 400), result);
    return true;
  }

  // ---------- 关系类型 ----------
  if (p === '/api/relations' && m('GET')) {
    ok(res, { relationTypes: store.listRelationTypes() });
    return true;
  }
  if (p === '/api/relations' && m('POST')) {
    try {
      const t = store.createRelationType(body);
      broadcast('relation.changed', { action: 'created', key: t.key });
      ok(res, { relationType: t });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'relations' && parts[2] && !parts[3]) {
    try {
      if (m('PATCH')) {
        const t = store.updateRelationType(parts[2], body);
        broadcast('relation.changed', { action: 'updated', key: t.key });
        ok(res, { relationType: t });
        return true;
      }
      if (m('DELETE')) {
        const { key } = store.deleteRelationType(parts[2]);
        broadcast('relation.changed', { action: 'deleted', key });
        ok(res, { key });
        return true;
      }
    } catch (e) { failFrom(res, e); return true; }
  }

  // ---------- 联系人 ----------
  if (p === '/api/contacts' && m('GET')) {
    const includeArchived = url.searchParams.get('includeArchived') !== 'false';
    ok(res, { contacts: store.listContacts({ includeArchived }).map(publicContact) });
    return true;
  }
  if (p === '/api/contacts' && m('POST')) {
    try {
      // 手动建档即用户亲手操作，天然已拍板：status 一律强制 confirmed（pending 只来自 AI 通道）
      const c = store.createContact({ ...body, status: undefined });
      broadcast('contact.changed', { action: 'created', contact: c });
      emitStats();
      ok(res, { contact: publicContact(c) });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  // 拍板收录待确认联系人（GUI 专属动作，与确认记忆同层；AI 通道没有对应工具）
  if (parts[1] === 'contacts' && parts[2] && parts[3] === 'confirm' && m('POST')) {
    try {
      const c = store.confirmContact(parts[2]);
      broadcast('contact.changed', { action: 'confirmed', contact: c });
      emitStats();
      ok(res, { contact: publicContact(c) });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'contacts' && parts[2] && !parts[3]) {
    try {
      if (m('GET')) {
        const c = store.getContact(parts[2]);
        if (!c) throw store.httpError(404, '联系人不存在');
        ok(res, { contact: publicContact(c) });
        return true;
      }
      if (m('PATCH')) {
        const c = store.updateContact(parts[2], body);
        broadcast('contact.changed', { action: 'updated', contact: c });
        emitStats();
        ok(res, { contact: publicContact(c) });
        return true;
      }
      if (m('DELETE')) {
        const { contact, removedMemories } = store.deleteContact(parts[2]);
        broadcast('contact.changed', { action: 'deleted', contactId: contact.id });
        emitStats();
        ok(res, { removedMemories });
        return true;
      }
    } catch (e) { failFrom(res, e); return true; }
  }
  if (parts[1] === 'contacts' && parts[2] && parts[3] === 'timeline' && m('GET')) {
    try {
      const t = store.timeline(parts[2]);
      const c = store.getContact(parts[2]);
      // 见面简报事实卡搭 timeline 的车：打开联系人即到，SSE 刷新自动更新
      ok(res, c ? { ...t, briefing: briefingFacts(c) } : t);
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'contacts' && parts[2] && parts[3] === 'memory-search' && m('GET')) {
    try {
      const contact = store.getContact(parts[2]);
      if (!contact) throw store.httpError(404, '联系人不存在');
      const query = (url.searchParams.get('q') || '').slice(0, 100);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
      const memories = store.listMemories({ contactId: parts[2], status: 'confirmed' }).filter((x) => !x.supersededBy);
      ok(res, { contact: publicContact(contact), query, memories: searchCachedMemoryVectors(memories, query, { limit }) });
    } catch (e) { failFrom(res, e); }
    return true;
  }

  // ---------- 记忆 ----------
  if (p === '/api/memories' && m('GET')) {
    const list = store.listMemories({
      contactId: url.searchParams.get('contact_id') || undefined,
      status: url.searchParams.get('status') || undefined,
      type: url.searchParams.get('type') || undefined,
      q: url.searchParams.get('q') || undefined,
      direction: url.searchParams.get('direction') || undefined,
      occasion: url.searchParams.get('occasion') || undefined,
      lifespan: url.searchParams.get('lifespan') || undefined,
    });
    // 名字映射含待确认联系人：pending 记忆卡片要能显示出「AI 新建的那个人」的名字
    const contactNames = new Map(store.listContacts({ includeArchived: true, includePending: true }).map((c) => [c.id, c.name]));
    ok(res, { memories: list.map((x) => ({ ...x, contactName: contactNames.get(x.contactId) || '' })) });
    return true;
  }
  if (p === '/api/memories' && m('POST')) {
    try {
      const mem = store.createMemory({ ...body, author: 'user' });
      broadcast('memory.changed', { action: 'created', memory: mem });
      emitStats();
      ok(res, { memory: mem });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (p === '/api/memories/confirm' && m('POST')) {
    try {
      const { confirmed, failed } = store.confirmMemories(body.ids, body.edits);
      for (const mem of confirmed) broadcast('memory.changed', { action: 'confirmed', memory: mem });
      // 确认记忆即承认了这个人：涉及的待确认联系人一并转正（同一拍板动作的连带结果）
      const confirmedContacts = [];
      for (const cid of [...new Set(confirmed.map((mem) => mem.contactId).filter(Boolean))]) {
        const c = store.getContact(cid);
        if (c && (c.status || 'confirmed') === 'pending') {
          const cc = store.confirmContact(cid);
          confirmedContacts.push(cc);
          broadcast('contact.changed', { action: 'confirmed', contact: cc });
        }
      }
      emitStats();
      ok(res, { confirmed, failed, confirmedContacts });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  // 取代：旧事实被新事实修正（旧条标 supersededBy，退出检索与时间线，保留溯源）
  if (p === '/api/memories/supersede' && m('POST')) {
    try {
      const mem = store.supersedeMemory(String(body.id ?? ''), String(body.keepId ?? ''));
      broadcast('memory.changed', { action: 'superseded', memory: mem });
      emitStats();
      ok(res, { memory: mem });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'memories' && parts[2] && !parts[3]) {
    try {
      if (m('PATCH')) {
        const mem = store.updateMemory(parts[2], body);
        broadcast('memory.changed', { action: 'updated', memory: mem });
        ok(res, { memory: mem });
        return true;
      }
      if (m('DELETE')) {
        const removed = store.deleteMemory(parts[2]);
        broadcast('memory.changed', { action: 'deleted', memoryId: removed.id });
        emitStats();
        ok(res, {});
        return true;
      }
    } catch (e) { failFrom(res, e); return true; }
  }
  if (parts[1] === 'memories' && parts[2] && parts[3] === 'reject' && m('POST')) {
    try {
      const mem = store.rejectMemory(parts[2], body.reason);
      broadcast('memory.changed', { action: 'rejected', memory: mem });
      emitStats();
      ok(res, { memory: mem });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'memories' && parts[2] && parts[3] === 'restore' && m('POST')) {
    try {
      const mem = store.restoreMemory(parts[2]);
      broadcast('memory.changed', { action: 'restored', memory: mem });
      emitStats();
      ok(res, { memory: mem });
    } catch (e) { failFrom(res, e); }
    return true;
  }

  if (p === '/api/jd/status' && m('GET')) {
    try { ok(res, await runAsync(['jd', 'status'])); }
    catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'plans' && parts[2] && parts[3] === 'jd' && !parts[5]
    && ['search', 'select'].includes(parts[4]) && m('POST')) {
    try {
      const requireActivePlan = () => {
        const plan = store.getPlan(parts[2]);
        if (!plan) throw store.httpError(404, '计划不存在');
        if (plan.status === 'sent') throw store.httpError(400, '已送出的计划不能选品');
      };
      requireActivePlan();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw store.httpError(400, '请求内容无效');
      if (parts[4] === 'search') {
        const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
        if (!keyword || keyword.length > 80
          || /[\u0000-\u001f\u007f-\u009f]/.test(keyword)) throw store.httpError(400, '请填写 1–80 字商品关键词');
        const args = ['jd', 'search', '--keyword', keyword];
        for (const [field, flag] of [['minPrice', '--min-price'], ['maxPrice', '--max-price']]) {
          const value = body[field];
          if (value == null || value === '') continue;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) throw store.httpError(400, '价格范围须为 0–1000000 之间的数字');
          args.push(flag, String(value));
        }
        if (typeof body.minPrice === 'number' && typeof body.maxPrice === 'number' && body.minPrice > body.maxPrice) throw store.httpError(400, '最低价不能高于最高价');
        const result = await runAsync(args);
        requireActivePlan();
        ok(res, result);
      } else {
        if (typeof body.itemId !== 'string' || !body.itemId || body.itemId.length > 256
          || /[^A-Za-z0-9_+=-]/.test(body.itemId) || body.itemId.startsWith('--')) throw store.httpError(400, '请选择有效商品');
        const { product } = await runAsync(['jd', 'promote', '--item-id', body.itemId]);
        requireActivePlan();
        const plan = store.updatePlan(parts[2], product);
        broadcast('plan.changed', { action: 'updated', planId: plan.id });
        ok(res, { plan });
      }
    } catch (e) {
      if ([400, 404, 502, 503, 504].includes(e?.status)) failFrom(res, e);
      else fail(res, 502, '京东选品暂不可用，请稍后重试');
    }
    return true;
  }

  // ---------- 礼物计划与礼赠视图 ----------
  if (p === '/api/plans' && m('GET')) {
    const bases = store.allPlanBases();
    const list = store.listPlans({ contactId: url.searchParams.get('contact_id') || undefined, status: url.searchParams.get('status') || undefined })
      .map((p) => ({ ...p, contactName: store.getContact(p.contactId)?.name || '', basedOnPlanId: bases[p.id] || '' }));
    ok(res, { plans: list });
    return true;
  }
  if (p === '/api/plans' && m('POST')) {
    try {
      const plan = store.createPlan({ ...body, source: 'user' });
      broadcast('plan.changed', { action: 'created', planId: plan.id });
      ok(res, { plan });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'plans' && parts[2] && !parts[3]) {
    try {
      if (m('PATCH')) {
        const plan = store.updatePlan(parts[2], body);
        broadcast('plan.changed', { action: 'updated', planId: plan.id });
        ok(res, { plan });
        return true;
      }
      if (m('DELETE')) {
        store.deletePlan(parts[2]);
        broadcast('plan.changed', { action: 'deleted', planId: parts[2] });
        ok(res, {});
        return true;
      }
    } catch (e) { failFrom(res, e); return true; }
  }
  // 一键删除「围绕某计划出主意」产生的这批建议（原计划保留；已送的台账卡不动）
  if (parts[1] === 'plans' && parts[2] && parts[3] === 'suggestions' && m('DELETE')) {
    try {
      const doomed = store.plansBasedOn(parts[2]).filter((p) => p.status !== 'sent');
      for (const p of doomed) store.deletePlan(p.id);
      broadcast('plan.changed', { action: 'deleted', planId: parts[2] });
      ok(res, { deleted: doomed.length });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'plans' && parts[2] && parts[3] === 'sent' && m('POST')) {
    try {
      const { plan, memory } = store.markPlanSent(parts[2]);
      broadcast('plan.changed', { action: 'sent', planId: plan.id });
      broadcast('memory.changed', { action: 'created', memory });
      emitStats();
      ok(res, { plan, memory });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (p === '/api/gifts/occasions' && m('GET')) {
    const days = Number(url.searchParams.get('days')) || 30;
    const bases = store.allPlanBases();
    ok(res, { occasions: store.giftOccasions(days), plans: store.listPlans().map((p) => ({ ...p, contactName: store.getContact(p.contactId)?.name || '', basedOnPlanId: bases[p.id] || '' })) });
    return true;
  }
  if (p === '/api/gifts/reciprocity' && m('GET')) {
    ok(res, { items: store.giftReciprocity() });
    return true;
  }
  // 疏远预警：days 阈值默认 90（钳 1-365），limit 默认 20（钳 1-50）；tier 按天数分档（>=180 stale）
  if (p === '/api/fading' && m('GET')) {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 90));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const fading = store.fadingContacts(days).slice(0, limit)
      .map((f) => ({ ...f, tier: f.days >= 180 ? 'stale' : 'attention' }));
    ok(res, { fading, thresholdDays: days });
    return true;
  }
  // 值得关注 feed：四类派生（时机/疏远/待跟进承诺/回礼待回应）合成一条按紧急度排序的行动流。
  // 纯派生零 AI；每类先取各自最紧急的 KIND_CAP 条，再全局按天数升序（当天/逾期最久的排前）截 limit。
  if (p === '/api/attention' && m('GET')) {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 90));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const KIND_CAP = 8;
    const contacts = new Map(store.listContacts({ includeArchived: false }).map((c) => [c.id, c]));
    const daysSince = (d) => {
      const t = Date.parse(String(d || '').slice(0, 10));
      return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
    };
    const items = [];
    // ① 时机：生日/节日/计划日期（store 已按 inDays 升序、总量封顶）
    for (const o of store.giftOccasions(days).slice(0, KIND_CAP)) {
      const c = contacts.get(o.contactId);
      if (!c) continue;
      items.push({
        kind: 'occasion', action: 'gift', contactId: o.contactId, contactName: c.name, relation: c.relation,
        label: o.label, occasion: o.label, date: o.date, days: o.inDays,
        text: `${o.label}${o.inDays === 0 ? '就是今天' : `还有 ${o.inDays} 天`}`,
      });
    }
    // ② 疏远：store 按天数降序，取最疏远的前 KIND_CAP
    for (const f of store.fadingContacts(90).slice(0, KIND_CAP)) {
      const c = contacts.get(f.contactId);
      if (!c) continue;
      items.push({
        kind: 'fading', action: 'briefing', contactId: f.contactId, contactName: c.name, relation: c.relation,
        label: '疏远', date: f.lastDate, days: f.days,
        text: `${f.days} 天没有有记录的互动`,
      });
    }
    // ③ 待跟进承诺：已确认未取代的 promise 全量，按逾期天数降序取前 KIND_CAP
    const promises = store.listMemories({ type: 'promise', status: 'confirmed' })
      .filter((m) => !m.supersededBy && contacts.has(m.contactId))
      .map((m) => ({ m, d: daysSince(m.date) ?? daysSince((m.createdAt || '').slice(0, 10)) ?? 0 }))
      .sort((a, b) => b.d - a.d).slice(0, KIND_CAP);
    for (const { m, d } of promises) {
      const c = contacts.get(m.contactId);
      items.push({
        kind: 'promise', action: 'briefing', contactId: m.contactId, contactName: c.name, relation: c.relation,
        label: '待跟进', date: m.date || (m.createdAt || '').slice(0, 10), days: d,
        text: `答应过的事还没跟进：${m.content}`,
      });
    }
    // ④ 回礼待回应：按收礼时间降序取前 KIND_CAP
    const recip = store.giftReciprocity().filter((r) => contacts.has(r.contactId))
      .map((r) => ({ r, d: daysSince(r.date) ?? 0 })).sort((a, b) => b.d - a.d).slice(0, KIND_CAP);
    for (const { r, d } of recip) {
      const c = contacts.get(r.contactId);
      items.push({
        kind: 'reciprocity', action: 'gift', contactId: r.contactId, contactName: c.name, relation: c.relation,
        label: '回礼', date: r.date, days: d, hasActivePlan: r.hasActivePlan,
        text: `TA 送过「${r.content}」还没回礼${r.hasActivePlan ? '（已有礼物计划）' : ''}`,
      });
    }
    // 行内上下文：为什么是这个人（相处注意/同场合历史/送礼历史/已有计划/上次互动）。
    // 纯派生零 AI：行上只放真实记忆引用，「怎么避开重复、出什么主意」留给点击后的 AI 会话现场判断。
    const lastSeenBy = new Map(store.fadingContacts(1).map((f) => [f.contactId, f]));
    const givenBy = new Map(); // 每人最近一次送出（giftLedger.given 已按日期降序）
    for (const g of store.giftLedger().given) if (!givenBy.has(g.contactId)) givenBy.set(g.contactId, g);
    const plansBy = new Map(); // 每人进行中的计划（未送出）
    for (const p of store.listPlans()) {
      if (p.status === 'sent') continue;
      if (!plansBy.has(p.contactId)) plansBy.set(p.contactId, []);
      plansBy.get(p.contactId).push({ id: p.id, idea: p.idea, status: p.status, occasion: p.occasion || '' });
    }
    const byDateDesc = (a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '');
    for (const item of items) {
      const f = lastSeenBy.get(item.contactId);
      item.lastSeen = f ? { date: f.lastDate, days: f.days } : null;
      const confirmed = store.listMemories({ contactId: item.contactId, status: 'confirmed' }).filter((m) => !m.supersededBy);
      const evidence = [];
      const cautions = confirmed.filter((m) => m.type === 'taboo' || m.type === 'dislike');
      if (cautions.length) evidence.push({ kind: 'caution', text: `相处注意：${cautions.map((m) => m.content).join('；')}` });
      if (item.kind === 'occasion') {
        const sameOccasion = confirmed.filter((m) => item.occasion && m.occasion === String(item.occasion).toLowerCase());
        const past = sameOccasion.find((m) => m.direction === 'user_to_contact' || m.direction === 'both') || sameOccasion[0];
        if (past) evidence.push({ kind: 'history', text: `${past.date ? `${past.date}：` : ''}${past.content}` });
      }
      if (item.kind === 'fading') {
        const last = [...confirmed].sort(byDateDesc)[0];
        if (last) evidence.push({ kind: 'last', text: `上次互动${last.date ? `（${last.date}）` : ''}：${last.content}` });
      }
      if (item.kind === 'occasion' || item.kind === 'reciprocity') {
        const given = givenBy.get(item.contactId);
        if (given) evidence.push({ kind: 'gift', text: `上次送过：${given.content}${given.date ? `（${given.date}）` : ''}` });
      }
      item.evidence = evidence;
      if (item.action === 'gift') {
        const ps = plansBy.get(item.contactId) || [];
        item.plans = ps.slice(0, 3);
        item.plansTotal = ps.length;
      }
    }
    items.sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity));
    ok(res, { items: items.slice(0, limit), days });
    return true;
  }
  // 最近记住了：已确认记忆按确认时间倒序取前 N 条（确认闸门之后才进这里，pending 不出现）。
  // 强化产品核心体感「它真的在帮我记」；归档联系人的记忆不再出现在首页。
  if (p === '/api/memories/recent' && m('GET')) {
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 5));
    const activeContacts = new Map(store.listContacts({ includeArchived: false }).map((c) => [c.id, c]));
    const items = store.listMemories({ status: 'confirmed' })
      .filter((x) => !x.supersededBy && activeContacts.has(x.contactId))
      .sort((a, b) => (b.confirmedAt || b.createdAt || '').localeCompare(a.confirmedAt || a.createdAt || ''))
      .slice(0, limit)
      .map((x) => ({
        id: x.id, contactId: x.contactId, contactName: activeContacts.get(x.contactId).name,
        type: x.type, content: x.content, date: x.date || '', occasion: x.occasion || '',
        confirmedAt: x.confirmedAt || x.createdAt || '',
      }));
    ok(res, { items });
    return true;
  }
  if (p === '/api/gifts/ledger' && m('GET')) {
    ok(res, store.giftLedger());
    return true;
  }
  if (p === '/api/gift-suggest' && m('POST')) {
    try {
      const c = store.getContact(String(body.contactId ?? ''));
      if (!c) throw store.httpError(404, '联系人不存在');
      const ids = Array.isArray(body.memoryIds) ? body.memoryIds.map(String) : [];
      // auto=true：调用方没预选证据（如首页值得关注行）时，自动取该联系人最近 12 条已确认记忆作依据
      let evidences;
      if (ids.length) {
        evidences = ids.map((id) => store.getMemory(id))
          .filter((m) => m && m.contactId === c.id && m.status === 'confirmed');
      } else if (body.auto) {
        evidences = store.listMemories({ contactId: c.id, status: 'confirmed' })
          .filter((m) => !m.supersededBy)
          .sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || ''))
          .slice(0, 12);
      } else {
        evidences = [];
      }
      const lines = evidences.map((m) => {
        const label = { preference: '喜好', dislike: '不喜好', taboo: '禁忌', gift: '送过/收过', event: '事件', interaction: '往来', attribute: '基础', promise: '承诺' }[m.type] || m.type;
        const dir = m.direction === 'contact_to_user' ? '（TA对我）' : m.direction === 'user_to_contact' ? '（我对TA）' : '';
        return `- [${label}${dir}] ${m.content}`;
      });
      const budget = String(body.budget ?? '').trim();
      const occasion = String(body.occasion ?? '').trim();
      // 触发时机的日期（首页关注行传入）：AI 建卡必须沿用，防止日期漂移繁殖出重复提醒行
      const occasionDate = String(body.occasionDate ?? '').trim();
      const plan = body.planId ? store.listPlans().find((p) => p.id === String(body.planId)) : null;
      // prompt 由提示词注册表组装（纪律唯一出处）
      const prompt = FLOWS.giftSuggest.build({
        contactName: c.name, relation: c.relation, occasion, occasionDate, budget, plan, lines,
      });
      ok(res, { prompt, evidenceCount: evidences.length });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  // AI 出话术：事实卡已在工作台原生展示，此端点把同一份事实交给 DSH 会话生成话术建议，不落库
  if (p === '/api/briefing' && m('POST')) {
    try {
      const c = store.getContact(String(body.contactId ?? ''));
      if (!c) throw store.httpError(404, '联系人不存在');
      const f = briefingFacts(c);
      const label = (m) => ({ preference: '喜好', dislike: '不喜好', taboo: '禁忌', gift: '送过/收过', event: '事件', interaction: '往来', attribute: '基础', promise: '承诺' }[m.type] || m.type);
      const dirOf = (m) => (m.direction === 'contact_to_user' ? '（TA对我）' : m.direction === 'user_to_contact' ? '（我对TA）' : '');
      const line = (m) => `- [${label(m)}${dirOf(m)}] ${m.content}${m.date ? `（${m.date}）` : ''}`;
      const prompt = FLOWS.meetupBriefing.build({
        contactName: c.name, relation: c.relation,
        tags: (c.tags || []).join(' / '), birthday: c.birthday || '',
        lastSeen: f.lastSeen,
        occasions: f.occasions.map((o) => `${o.label}${o.inDays === 0 ? '就是今天' : `还有 ${o.inDays} 天`}`),
        reciprocity: f.reciprocity, promises: f.promises.map(line), taboos: f.cautions.map(line), facts: f.factLines.map(line),
      });
      ok(res, { prompt, evidenceCount: f.factLines.length + f.promises.length + f.cautions.length });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  // 空库首价值：名字+场景建联系人（用户主动建 → confirmed；同名复用不建重），返回先问后给的引导 prompt
  if (p === '/api/first-run' && m('POST')) {
    try {
      const name = String(body.name ?? '').trim().slice(0, 40);
      if (!name) throw store.httpError(400, '名字不能为空');
      const SCENARIOS = {
        say: '不知道该怎么开口（要发消息/见面想好说什么）',
        gift: '不知道送什么（要选礼物）',
        reconnect: '想重新联系（很久没联系了）',
      };
      const scenario = String(body.scenario ?? '');
      if (!SCENARIOS[scenario]) throw store.httpError(400, '未知场景');
      const note = String(body.note ?? '').trim().slice(0, 300);
      // 先查后建：用户忘了已建过时直接复用既有联系人
      const existing = store.listContacts({ includeArchived: false }).find((c) => c.name === name);
      const c = existing || store.createContact({ name });
      const prompt = FLOWS.firstRun.build({ contactName: c.name, scenario: SCENARIOS[scenario], note });
      ok(res, { prompt, contactId: c.id, created: !existing });
    } catch (e) { failFrom(res, e); }
    return true;
  }

  // ---------- 素材 ----------
  if (p === '/api/materials' && m('GET')) {
    const status = url.searchParams.get('status') || undefined;
    const mts = store.listMaterials({ status }).slice(0, 30);
    // 批量化：一次取全量记忆/联系人，按 sourceId/contactId 分组映射——
    // 不再逐素材各调 materialMemories/getContact（原实现 30 素材 ≈ 60+ 次 spawn）
    const allMemories = store.listMemories({});
    const memBySource = new Map();
    for (const mem of allMemories) {
      if (!mem.sourceId) continue;
      if (!memBySource.has(mem.sourceId)) memBySource.set(mem.sourceId, []);
      memBySource.get(mem.sourceId).push(mem);
    }
    const contactName = new Map(store.listContacts({ includeArchived: true, includePending: true }).map((c) => [c.id, c.name]));
    const reports = store.allMaterialReports();
    const questions = store.allOrganizeQuestions();
    const materials = mts.map((mt) => ({
      id: mt.id,
      status: store.materialStatus(mt),
      contactId: mt.contactId,
      contactName: contactName.get(mt.contactId) || '',
      occasion: mt.occasion || '',
      excerpt: mt.excerpt,
      capturedAt: mt.capturedAt,
      report: reports[mt.id]?.report || '',
      reportedAt: reports[mt.id]?.reportedAt || '',
      question: questions[mt.id] || null,
      extracted: (memBySource.get(mt.id) || []).map((mem) => ({ id: mem.id, type: mem.type, content: mem.content, status: mem.status, importance: mem.importance })),
    }));
    ok(res, { materials });
    return true;
  }
  // 复制整理指令：后端从提示词注册表拼装（前端不再手写模板，防漂移）
  if (parts[1] === 'materials' && parts[2] && parts[3] === 'organize-prompt' && m('GET')) {
    const toolsUrl = url.pathname.includes('/api/dsh-relationship/workbench')
      ? `${url.origin}/api/dsh-relationship/workbench/api/tools`
      : `${url.origin}/api/tools`;
    ok(res, { prompt: FLOWS.materialOrganize.build(parts[2], toolsUrl) });
    return true;
  }
  // 反问送达标记：嵌入模式发送成功（sent）/ 独立模式复制成功（copied）由前端上报。
  // 复制不算送达；标记不清除反问，清除只由 AI done / 整理报告 / 手动放弃触发。
  if (parts[1] === 'materials' && parts[2] && parts[3] === 'question' && parts[4] === 'sent' && m('POST')) {
    store.markOrganizeQuestionSent(parts[2]);
    broadcast('material.changed', { action: 'question-sent', materialId: parts[2] });
    ok(res, {});
    return true;
  }
  if (parts[1] === 'materials' && parts[2] && parts[3] === 'question' && parts[4] === 'copied' && m('POST')) {
    store.markOrganizeQuestionCopied(parts[2]);
    broadcast('material.changed', { action: 'question-copied', materialId: parts[2] });
    ok(res, {});
    return true;
  }
  // 反问手动放弃清除：权威清除是 AI done 与整理报告提交，这里是用户明确「不再等待」
  if (parts[1] === 'materials' && parts[2] && parts[3] === 'question' && m('DELETE')) {
    store.clearOrganizeQuestion(parts[2]);
    broadcast('material.changed', { action: 'question-cleared', materialId: parts[2] });
    ok(res, {});
    return true;
  }
  if (p === '/api/materials' && m('POST')) {
    try {
      const mt = store.saveMaterial({ text: body.text, contactId: body.contactId ? String(body.contactId) : '', occasion: body.occasion });
      broadcast('material.changed', { action: 'created', materialId: mt.id });
      ok(res, { material: { id: mt.id, excerpt: mt.excerpt, contactId: mt.contactId, occasion: mt.occasion } });
    } catch (e) { failFrom(res, e); }
    return true;
  }
  if (parts[1] === 'materials' && parts[2] && !parts[3]) {
    try {
      if (m('GET')) {
        const mt = store.getMaterial(parts[2]);
        if (!mt) throw store.httpError(404, '素材不存在');
        ok(res, { material: { ...mt, status: store.materialStatus(mt), ...(store.materialReport(parts[2]) || {}) } });
        return true;
      }
      if (m('DELETE')) {
        store.deleteMaterial(parts[2]);
        broadcast('material.changed', { action: 'deleted', materialId: parts[2] });
        ok(res, {});
        return true;
      }
    } catch (e) { failFrom(res, e); return true; }
  }

  return false;
}

// ---------- 静态文件 ----------
function staticFile(req, res, url) {
  let p = url.pathname;
  if (p === '/' || p === '/app' || p === '/index.html') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    (req.method === 'POST' || req.method === 'PATCH' ? readBody(req) : Promise.resolve({}))
      .then((body) => api(req, res, url, body))
      .then((handled) => { if (!handled) fail(res, 404, '接口不存在'); })
      .catch((e) => failFrom(res, e));
    return;
  }
  staticFile(req, res, url);
}
