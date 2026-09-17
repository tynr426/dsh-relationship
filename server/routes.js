// HTTP 路由：静态前端 + REST API + SSE + AI 工具入口
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';
import * as store from './store.js';
import { sseHandler, broadcast } from './sse.js';
import { executeTool, TOOL_CN } from './tools.js';

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

  // ---------- 联系人 ----------
  if (p === '/api/contacts' && m('GET')) {
    const includeArchived = url.searchParams.get('includeArchived') !== 'false';
    ok(res, { contacts: store.listContacts({ includeArchived }).map(publicContact) });
    return true;
  }
  if (p === '/api/contacts' && m('POST')) {
    try {
      const c = store.createContact(body);
      broadcast('contact.changed', { action: 'created', contact: c });
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
    try { ok(res, store.timeline(parts[2])); } catch (e) { failFrom(res, e); }
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
    ok(res, { memories: list.map((x) => ({ ...x, contactName: store.getContact(x.contactId)?.name || '' })) });
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
      emitStats();
      ok(res, { confirmed, failed });
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

  // ---------- 礼物计划与礼赠视图 ----------
  if (p === '/api/plans' && m('GET')) {
    const list = store.listPlans({ contactId: url.searchParams.get('contact_id') || undefined, status: url.searchParams.get('status') || undefined })
      .map((p) => ({ ...p, contactName: store.getContact(p.contactId)?.name || '' }));
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
    ok(res, { occasions: store.giftOccasions(days), plans: store.listPlans().map((p) => ({ ...p, contactName: store.getContact(p.contactId)?.name || '' })) });
    return true;
  }
  if (p === '/api/gifts/reciprocity' && m('GET')) {
    ok(res, { items: store.giftReciprocity() });
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
      const evidences = ids
        .map((id) => store.getMemory(id))
        .filter((m) => m && m.contactId === c.id && m.status === 'confirmed');
      const lines = evidences.map((m) => {
        const label = { preference: '喜好', dislike: '不喜好', taboo: '禁忌', gift: '送过/收过', event: '事件', interaction: '往来', attribute: '基础', promise: '承诺' }[m.type] || m.type;
        const dir = m.direction === 'contact_to_user' ? '（TA对我）' : m.direction === 'user_to_contact' ? '（我对TA）' : '';
        return `- [${label}${dir}] ${m.content}`;
      });
      const budget = String(body.budget ?? '').trim();
      const occasion = String(body.occasion ?? '').trim();
      const plan = body.planId ? store.listPlans().find((p) => p.id === String(body.planId)) : null;
      const prompt = [
        `请为「${c.name}」准备礼物建议（relation: ${c.relation}${occasion ? `，场合：${occasion}` : ''}）。`,
        budget ? `预算：${budget}。` : '预算：不限。',
        plan ? `用户已有一个礼物计划：想法「${plan.idea}」${plan.budget ? `，预算 ${plan.budget}` : ''}${plan.productName ? `，已看中商品：${plan.productName}` : ''}。请在此基础上优化，或给出替代方案。` : '',
        evidences.length ? '已确认的记忆依据（必须围绕这些，不得编造记忆里没有的偏好）：' : '该联系人还没有可用记忆依据，请明确说明这一点，只给通用保守建议：',
        ...lines,
        '要求：',
        '1. 给出 2-3 个具体礼物方案，每个方案一句话理由，理由必须引用上面的记忆点；',
        '2. 禁忌/不喜好类记忆涉及的品类必须明确排除并说明原因；',
        '3. 曾送过的礼物不要重复建议；',
        '4. 每个方案用 gift_plan_add 创建为计划卡（contactId=' + c.id + '，idea=方案名与理由，budget，status=idea），创建完列出你建了哪几个计划。',
      ].filter(Boolean).join('\n');
      ok(res, { prompt, evidenceCount: evidences.length });
    } catch (e) { failFrom(res, e); }
    return true;
  }

  // ---------- 素材 ----------
  if (p === '/api/materials' && m('GET')) {
    const status = url.searchParams.get('status') || undefined;
    const materials = store.listMaterials({ status }).slice(0, 30).map((mt) => ({
      id: mt.id,
      status: store.materialStatus(mt),
      contactId: mt.contactId,
      contactName: mt.contactId ? store.getContact(mt.contactId)?.name || '' : '',
      occasion: mt.occasion || '',
      excerpt: mt.excerpt,
      capturedAt: mt.capturedAt,
      extracted: store.materialMemories(mt).map((mem) => ({ id: mem.id, type: mem.type, content: mem.content, status: mem.status, importance: mem.importance })),
    }));
    ok(res, { materials });
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
        ok(res, { material: { ...mt, status: store.materialStatus(mt) } });
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
