// HTTP 路由：静态前端 + REST API + SSE + AI 工具入口
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';
import store from './store-facade.js';
import { sseHandler, broadcast } from './sse.js';
import { executeTool, TOOL_CN } from './tools.js';
import { FLOWS } from './prompts.js';

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
      // prompt 由提示词注册表组装（纪律唯一出处）
      const prompt = FLOWS.giftSuggest.build({
        contactName: c.name, relation: c.relation, occasion, budget, plan, lines,
      });
      ok(res, { prompt, evidenceCount: evidences.length });
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
