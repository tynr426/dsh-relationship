// 数据层：内存态 + 原子落盘。contacts / memories / materials 三个 JSON 文件，
// meta.json 存 schemaVersion。单用户本地应用，删除即真删。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, MATERIALS_DIR, CONTACTS_PATH, MEMORIES_PATH, MATERIALS_PATH, PLANS_PATH, META_PATH, ensureDirs } from './config.js';
import { migrateDb, CURRENT_SCHEMA_VERSION } from './migrations.js';

export const RELATIONS = ['family', 'friend', 'colleague', 'client', 'partner', 'other'];
export const MEMORY_TYPES = ['preference', 'dislike', 'taboo', 'event', 'gift', 'promise', 'interaction', 'attribute'];
export const MEMORY_STATUSES = ['pending', 'confirmed', 'rejected'];

// 允许的模糊日期：2026-10-17 / 2026-10 / 2026-10-__ / 每年-05-20 / 10-02
export const FUZZY_DATE_RE = /^(?:\d{4}-\d{2}(?:-\d{2})?|\d{4}-\d{2}-__|每年-\d{2}-\d{2}|\d{2}-\d{2})$/;

export function uid(prefix = '') {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(4).toString('hex');
}
export const now = () => new Date().toISOString();

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

let db = migrateDb({ schemaVersion: 0, contacts: [], memories: [], materials: [], plans: [] });
let saveTimer = null;

function readJsonArray(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function loadStore() {
  ensureDirs();
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { /* first run */ }
  db = migrateDb({
    schemaVersion: Number.isInteger(meta.schemaVersion) ? meta.schemaVersion : 0,
    contacts: readJsonArray(CONTACTS_PATH),
    memories: readJsonArray(MEMORIES_PATH),
    materials: readJsonArray(MATERIALS_PATH),
    plans: readJsonArray(PLANS_PATH),
  });
  writeAll();
  return db;
}

function writeAll() {
  ensureDirs();
  const write = (file, value) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  };
  write(CONTACTS_PATH, db.contacts);
  write(MEMORIES_PATH, db.memories);
  write(MATERIALS_PATH, db.materials);
  write(PLANS_PATH, db.plans);
  write(META_PATH, { schemaVersion: CURRENT_SCHEMA_VERSION });
}

export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeAll, 80);
}
export function flush() {
  clearTimeout(saveTimer);
  writeNow();
}
function writeNow() {
  clearTimeout(saveTimer);
  writeAll();
}

// ---------- 联系人 ----------
export function listContacts({ includeArchived = true } = {}) {
  return includeArchived ? db.contacts : db.contacts.filter((c) => !c.archived);
}
export function getContact(id) { return db.contacts.find((c) => c.id === id) || null; }

function cleanTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw httpError(400, 'tags 必须是字符串数组');
  const cleaned = tags.map((t) => String(t).trim()).filter(Boolean);
  if (cleaned.length > 20) throw httpError(400, '标签最多 20 个');
  for (const t of cleaned) if (t.length > 20) throw httpError(400, '单个标签不能超过 20 字');
  return [...new Set(cleaned)];
}

function normalizeFuzzyDate(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!FUZZY_DATE_RE.test(s)) throw httpError(400, `${label}格式无效：支持 YYYY-MM-DD / YYYY-MM / 2026-10-__ / 每年-MM-DD / MM-DD`);
  const nums = s.split('-').filter((x) => /^\d{2,4}$/.test(x));
  if (nums.length === 2 && /^\d{4}$/.test(nums[0])) {
    // 年-月（2026-10）
    const month = Number(nums[1]);
    if (!(month >= 1 && month <= 12)) throw httpError(400, `${label}范围无效：月份 01-12`);
    return s;
  }
  const month = Number(nums[nums.length - 2]);
  const day = Number(nums[nums.length - 1]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    throw httpError(400, `${label}范围无效：月份 01-12、日期 01-31`);
  }
  return s;
}

function normalizeBirthday(v) {
  return normalizeFuzzyDate(v, '生日');
}

/**
 * 话语时间 saidAt：事实发生时间（date）之外，"这段话是什么时候说的"。
 * 支持模糊日期（规则同 date）加可选 HH:mm；聊天时间戳由 AI 规范化后传入。
 */
export function normalizeSaidAt(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = /^(\S+) (\d{2}):(\d{2})$/.exec(s);
  const datePart = m ? m[1] : s;
  const d = normalizeFuzzyDate(datePart, '话语时间');
  if (!m) return d;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) throw httpError(400, '话语时间范围无效：小时 00-23、分钟 00-59');
  return `${d} ${m[2]}:${m[3]}`;
}

export const DIRECTIONS = ['', 'user_to_contact', 'contact_to_user', 'both'];

/** 表达方向：交互/礼物/承诺类记忆标注是谁对谁；其余类型留空。 */
export function normalizeDirection(v) {
  const s = String(v ?? '').trim();
  if (!DIRECTIONS.includes(s)) throw httpError(400, `direction 必须是：${DIRECTIONS.filter(Boolean).join(' / ')} 或留空`);
  return s;
}

export const LIFESPANS = ['long', 'short'];

/** 记忆寿命：long=对未来关系维护可能有价值（默认）；short=当前场景有效的临时事项。 */
export function normalizeLifespan(v) {
  const s = String(v ?? '').trim() || 'long';
  if (!LIFESPANS.includes(s)) throw httpError(400, 'lifespan 必须是 long / short');
  return s;
}

/**
 * 场景标签 occasion：teacher_day / birthday / thank_you / visit…自由标签，
 * 只做归类软过滤；大小写与空白归一，上限 40 字。不承担时间职责（时间是 date）。
 */
export function normalizeOccasion(v) {
  let s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!s) return '';
  if (s.length > 40) throw httpError(400, 'occasion 不能超过 40 字');
  return s;
}

export function createContact(fields = {}) {
  const name = String(fields.name ?? '').trim();
  if (!name) throw httpError(400, '联系人姓名不能为空');
  if (name.length > 40) throw httpError(400, '姓名不能超过 40 字');
  const relation = fields.relation == null || fields.relation === '' ? 'other' : String(fields.relation);
  if (!RELATIONS.includes(relation)) throw httpError(400, `relation 必须是：${RELATIONS.join(' / ')}`);
  const t = now();
  const c = {
    id: uid('c'),
    name,
    relation,
    tags: cleanTags(fields.tags),
    birthday: normalizeBirthday(fields.birthday),
    notes: String(fields.notes ?? '').slice(0, 500),
    archived: false,
    createdAt: t,
    updatedAt: t,
  };
  db.contacts.push(c);
  persist();
  return c;
}

const CONTACT_PATCH_KEYS = ['name', 'relation', 'birthday', 'notes', 'archived'];
export function updateContact(id, patch = {}) {
  const c = getContact(id);
  if (!c) throw httpError(404, '联系人不存在');
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw httpError(400, '联系人姓名不能为空');
    if (name.length > 40) throw httpError(400, '姓名不能超过 40 字');
    c.name = name;
  }
  if ('relation' in patch) {
    const relation = String(patch.relation ?? '');
    if (!RELATIONS.includes(relation)) throw httpError(400, `relation 必须是：${RELATIONS.join(' / ')}`);
    c.relation = relation;
  }
  if ('tags' in patch) c.tags = cleanTags(patch.tags);
  if ('birthday' in patch) c.birthday = normalizeBirthday(patch.birthday);
  if ('notes' in patch) c.notes = String(patch.notes ?? '').slice(0, 500);
  if ('archived' in patch) c.archived = Boolean(patch.archived);
  c.updatedAt = now();
  persist();
  return c;
}

export function deleteContact(id) {
  const i = db.contacts.findIndex((c) => c.id === id);
  if (i < 0) throw httpError(404, '联系人不存在');
  const [removed] = db.contacts.splice(i, 1);
  const before = db.memories.length;
  db.memories = db.memories.filter((m) => m.contactId !== id);
  const removedMemories = before - db.memories.length;
  persist();
  return { contact: removed, removedMemories };
}

// ---------- 记忆 ----------
export function listMemories({ contactId, status, type, q, direction, occasion, lifespan } = {}) {
  let list = db.memories;
  if (contactId) list = list.filter((m) => m.contactId === contactId);
  if (status) list = list.filter((m) => m.status === status);
  if (type) list = list.filter((m) => m.type === type);
  if (direction) list = list.filter((m) => m.direction === direction);
  if (occasion) list = list.filter((m) => m.occasion === String(occasion).toLowerCase());
  if (lifespan) list = list.filter((m) => (m.lifespan || 'long') === lifespan);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((m) => m.content.toLowerCase().includes(needle));
  }
  return [...list].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
export function getMemory(id) { return db.memories.find((m) => m.id === id) || null; }

function validateMemoryFields({ type, content, date, importance, saidAt, direction, lifespan, occasion }) {
  if (!MEMORY_TYPES.includes(type)) throw httpError(400, `type 必须是：${MEMORY_TYPES.join(' / ')}`);
  const text = String(content ?? '').trim();
  if (!text) throw httpError(400, '记忆内容不能为空');
  if (text.length > 500) throw httpError(400, '记忆内容不能超过 500 字');
  const d = normalizeFuzzyDate(date, '日期');
  let imp = importance == null || importance === '' ? 2 : Number(importance);
  if (!Number.isInteger(imp) || imp < 1 || imp > 3) throw httpError(400, 'importance 必须是 1–3 的整数');
  const said = normalizeSaidAt(saidAt);
  return {
    type, content: text, date: d, importance: imp, saidAt: said,
    direction: normalizeDirection(direction),
    lifespan: normalizeLifespan(lifespan),
    occasion: normalizeOccasion(occasion),
  };
}

/**
 * 新增记忆。
 * @param {object} fields
 * @param {'ai'|'user'} fields.author AI 写入一律 pending；用户手动录入视为本人确认，直接 confirmed。
 */
export function createMemory(fields = {}) {
  const contactId = String(fields.contactId ?? '');
  const c = getContact(contactId);
  if (!c) throw httpError(404, '联系人不存在：请先 contact_search 定位或先建联系人');
  const v = validateMemoryFields(fields);
  const author = fields.author === 'user' ? 'user' : 'ai';
  const t = now();
  // 场景继承：从素材提取且未显式给 occasion 时，继承素材的场合标签
  let occasion = v.occasion;
  const sourceId = typeof fields.sourceId === 'string' ? fields.sourceId : '';
  const sourceQuote = typeof fields.sourceQuote === 'string' ? fields.sourceQuote.trim().slice(0, 200) : '';
  if (!occasion && sourceId) {
    const mt = getMaterial(sourceId);
    if (mt?.occasion) occasion = mt.occasion;
  }
  const m = {
    id: uid('m'),
    contactId,
    type: v.type,
    content: v.content,
    date: v.date,
    importance: v.importance,
    saidAt: v.saidAt,
    direction: v.direction,
    lifespan: v.lifespan,
    occasion,
    sourceId,
    sourceQuote,
    author,
    status: author === 'user' ? 'confirmed' : 'pending',
    reason: '',
    createdAt: t,
    confirmedAt: author === 'user' ? t : null,
    updatedAt: t,
    supersededBy: null,
  };
  db.memories.push(m);
  // 记忆来自素材提取时，回写素材的提取清单（素材状态派生为 processed）。
  if (m.sourceId) {
    const mt = getMaterial(m.sourceId);
    if (mt && !mt.extractedMemoryIds.includes(m.id)) mt.extractedMemoryIds.push(m.id);
  }
  persist();
  return m;
}

/** 批量新增（AI 素材提取）。逐条独立校验，返回 created / failed。 */
export function createMemories(entries = [], author = 'ai') {
  if (!Array.isArray(entries)) throw httpError(400, 'entries 必须是数组');
  if (!entries.length) throw httpError(400, 'entries 不能为空');
  if (entries.length > 50) throw httpError(400, '单批最多 50 条');
  const created = [];
  const failed = [];
  for (const [index, entry] of entries.entries()) {
    try {
      created.push(createMemory({ ...entry, author }));
    } catch (e) {
      failed.push({ index, error: e?.message || String(e) });
    }
  }
  return { created, failed };
}

/** 编辑补丁仅允许覆盖这些语义字段。 */
function applyMemoryEdit(m, edits = {}) {
  const v = validateMemoryFields({
    type: edits.type ?? m.type,
    content: edits.content ?? m.content,
    date: edits.date ?? m.date,
    importance: edits.importance ?? m.importance,
    saidAt: edits.saidAt ?? m.saidAt,
    direction: edits.direction ?? m.direction,
    lifespan: edits.lifespan ?? m.lifespan,
    occasion: edits.occasion ?? m.occasion,
  });
  m.type = v.type;
  m.content = v.content;
  m.date = v.date;
  m.importance = v.importance;
  m.saidAt = v.saidAt;
  m.direction = v.direction;
  m.lifespan = v.lifespan;
  m.occasion = v.occasion;
}

/** 确认入库（可带编辑）。返回 confirmed 列表与逐条失败原因。 */
export function confirmMemories(ids = [], edits = {}) {
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids 不能为空');
  const confirmed = [];
  const failed = [];
  for (const id of ids) {
    const m = getMemory(String(id));
    if (!m) { failed.push({ id, error: '记忆不存在' }); continue; }
    if (m.status !== 'pending') { failed.push({ id, error: `状态为 ${m.status}，只有待确认记忆可以确认` }); continue; }
    try {
      if (edits && typeof edits === 'object' && edits[m.id]) applyMemoryEdit(m, edits[m.id]);
    } catch (e) {
      failed.push({ id, error: e?.message || String(e) });
      continue;
    }
    m.status = 'confirmed';
    m.confirmedAt = now();
    m.updatedAt = now();
    confirmed.push(m);
  }
  if (confirmed.length) persist();
  return { confirmed, failed };
}

export function rejectMemory(id, reason = '') {
  const m = getMemory(String(id));
  if (!m) throw httpError(404, '记忆不存在');
  if (m.status !== 'pending') throw httpError(400, `状态为 ${m.status}，只有待确认记忆可以驳回`);
  m.status = 'rejected';
  m.reason = String(reason ?? '').slice(0, 200);
  m.updatedAt = now();
  persist();
  return m;
}

export function restoreMemory(id) {
  const m = getMemory(String(id));
  if (!m) throw httpError(404, '记忆不存在');
  if (m.status !== 'rejected') throw httpError(400, '只有已驳回记忆可以恢复');
  m.status = 'pending';
  m.reason = '';
  m.updatedAt = now();
  persist();
  return m;
}

export function updateMemory(id, patch = {}) {
  const m = getMemory(String(id));
  if (!m) throw httpError(404, '记忆不存在');
  if (m.status !== 'confirmed') throw httpError(400, `状态为 ${m.status}，只有已确认记忆可以直接编辑`);
  applyMemoryEdit(m, patch);
  m.updatedAt = now();
  persist();
  return m;
}

export function deleteMemory(id) {
  const i = db.memories.findIndex((m) => m.id === id);
  if (i < 0) throw httpError(404, '记忆不存在');
  const [removed] = db.memories.splice(i, 1);
  persist();
  return removed;
}

export function supersedeMemory(id, keepId) {
  const m = getMemory(String(id));
  const keep = getMemory(String(keepId));
  if (!m || !keep) throw httpError(404, '记忆不存在');
  if (m.id === keep.id) throw httpError(400, '不能指向自身');
  // 校验：同联系人；依据必须是未被取代的已确认记忆；被取代方只能是待确认/已确认
  // （UI 文案承诺「已确认记忆取代」，服务端必须同样强制——否则 toast 与时间线行为互相矛盾）
  if (m.contactId !== keep.contactId) throw httpError(400, '只能在同一联系人的记忆之间取代');
  if (keep.status !== 'confirmed') throw httpError(400, `取代依据（keepId）必须是已确认记忆，当前为 ${keep.status}`);
  if (keep.supersededBy) throw httpError(400, '取代依据本身已被取代，不能再作为依据');
  if (m.status !== 'pending' && m.status !== 'confirmed') throw httpError(400, `状态为 ${m.status} 的记忆无需取代`);
  m.supersededBy = keep.id;
  m.updatedAt = now();
  persist();
  return m;
}

// ---------- 时间线 ----------
// lifespan=short 的临时事项不进时间线主视图，单独挂在 shortItems（最近互动）。
// 被取代（supersededBy）的记忆退出时间线——与取代 toast 的承诺一致。
export function timeline(contactId) {
  const c = getContact(contactId);
  if (!c) throw httpError(404, '联系人不存在');
  const all = listMemories({ contactId, status: 'confirmed' }).filter((m) => !m.supersededBy);
  const memories = all.filter((m) => (m.lifespan || 'long') !== 'short');
  const shortItems = all.filter((m) => m.lifespan === 'short');
  memories.sort((a, b) => timelineKey(b).localeCompare(timelineKey(a)));
  shortItems.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { contact: c, memories, shortItems };
}
function timelineKey(m) {
  const d = (m.date || '').replace('每年-', '0000-');
  return (d.replace('-__', '-01').padEnd(10, '0')) + 'T' + (m.createdAt || '');
}

// ---------- 礼物计划（送礼工作流：想法 → 已定 → 已送；低风险意图，不进确认队列） ----------
export const PLAN_STATUSES = ['idea', 'decided', 'sent'];
const FIXED_HOLIDAYS = [
  { occasion: 'teacher_day', label: '教师节', md: '09-10', match: (c) => c.tags.some((t) => /老师|教师/.test(t)) || /老师|教师/.test(c.name) },
  { occasion: 'women_day', label: '妇女节', md: '03-08', match: () => false },
  { occasion: 'new_year', label: '元旦', md: '01-01', match: () => false },
  { occasion: 'christmas', label: '圣诞节', md: '12-25', match: () => false },
];

function normalizePlanStatus(v) {
  const s = String(v ?? '').trim() || 'idea';
  if (!PLAN_STATUSES.includes(s)) throw httpError(400, `status 必须是：${PLAN_STATUSES.join(' / ')}`);
  return s;
}

function validatePlanFields({ occasion, occasionDate, idea, budget, productName, productPrice, productUrl }) {
  const text = String(idea ?? '').trim();
  if (!text) throw httpError(400, '礼物想法不能为空');
  if (text.length > 200) throw httpError(400, '礼物想法不能超过 200 字');
  const od = String(occasionDate ?? '').trim();
  if (od && !/^\d{4}-\d{2}-\d{2}$/.test(od)) throw httpError(400, 'occasionDate 必须是 YYYY-MM-DD（这一次的具体日期）');
  const pn = String(productName ?? '').trim().slice(0, 100);
  const pp = String(productPrice ?? '').trim().slice(0, 40);
  const pu = String(productUrl ?? '').trim().slice(0, 500);
  if (pu && !/^(https?:\/\/|\/\/)/i.test(pu)) throw httpError(400, '商品链接要以 http(s):// 开头');
  return { occasion: normalizeOccasion(occasion), occasionDate: od, idea: text, budget: String(budget ?? '').trim().slice(0, 40), productName: pn, productPrice: pp, productUrl: pu };
}

export function createPlan(fields = {}) {
  const contactId = String(fields.contactId ?? '');
  if (!getContact(contactId)) throw httpError(404, '联系人不存在');
  const v = validatePlanFields(fields);
  const t = now();
  const p = {
    id: uid('gp'),
    contactId,
    occasion: v.occasion,
    occasionDate: v.occasionDate,
    idea: v.idea,
    budget: v.budget,
    productName: v.productName,
    productPrice: v.productPrice,
    productUrl: v.productUrl,
    status: normalizePlanStatus(fields.status),
    sentAt: '',
    memoryId: '',
    source: fields.source === 'ai' ? 'ai' : 'user',
    createdAt: t,
    updatedAt: t,
  };
  db.plans.push(p);
  persist();
  return p;
}

export function listPlans({ contactId, status } = {}) {
  let list = [...db.plans];
  if (contactId) list = list.filter((p) => p.contactId === contactId);
  if (status) list = list.filter((p) => p.status === status);
  return list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function getPlan(id) { return db.plans.find((p) => p.id === id) || null; }

export function updatePlan(id, patch = {}) {
  const p = getPlan(id);
  if (!p) throw httpError(404, '计划不存在');
  if ('idea' in patch || 'occasion' in patch || 'occasionDate' in patch || 'budget' in patch
    || 'productName' in patch || 'productPrice' in patch || 'productUrl' in patch) {
    const v = validatePlanFields({
      idea: patch.idea ?? p.idea,
      occasion: patch.occasion ?? p.occasion,
      occasionDate: patch.occasionDate ?? p.occasionDate,
      budget: patch.budget ?? p.budget,
      productName: patch.productName ?? p.productName,
      productPrice: patch.productPrice ?? p.productPrice,
      productUrl: patch.productUrl ?? p.productUrl,
    });
    p.idea = v.idea; p.occasion = v.occasion; p.occasionDate = v.occasionDate; p.budget = v.budget;
    p.productName = v.productName; p.productPrice = v.productPrice; p.productUrl = v.productUrl;
  }
  if ('status' in patch) {
    const status = normalizePlanStatus(patch.status);
    p.status = status;
    if (status === 'sent' && !p.sentAt) p.sentAt = now();
  }
  if ('sentAt' in patch) p.sentAt = String(patch.sentAt ?? '');
  p.updatedAt = now();
  persist();
  return p;
}

export function deletePlan(id) {
  const i = db.plans.findIndex((p) => p.id === id);
  if (i < 0) throw httpError(404, '计划不存在');
  const [removed] = db.plans.splice(i, 1);
  persist();
  return removed;
}

/** 标记已送：计划收尾 + 自动落一条已确认的 gift 记忆（用户动作即事实，author=user）。 */
export function markPlanSent(id) {
  const p = updatePlan(id, { status: 'sent' });
  if (p.memoryId && getMemory(p.memoryId)) return { plan: p, memory: getMemory(p.memoryId) };
  const today = now().slice(0, 10);
  const primary = p.productName || p.idea;
  const detail = [];
  if (p.productName && p.idea && p.idea !== p.productName) detail.push(p.idea);
  if (p.productPrice) detail.push(`¥${p.productPrice}`);
  const parts = [`送出礼物：${primary}${detail.length ? `（${detail.join('，')}）` : ''}`];
  if (p.occasion) parts.push(`（${p.occasion}）`);
  if (p.budget && !p.productPrice) parts.push(`预算 ${p.budget}`);
  const m = createMemory({
    contactId: p.contactId,
    type: 'gift',
    content: parts.join(''),
    date: today,
    direction: 'user_to_contact',
    occasion: p.occasion,
    importance: 2,
    author: 'user',
  });
  p.memoryId = m.id;
  p.updatedAt = now();
  persist();
  return { plan: p, memory: m };
}

/** 回礼派生：最近一次"收到"晚于最近一次"送出"的联系人 → 待回应。纯派生，不落库。 */
export function giftReciprocity() {
  const confirmed = db.memories.filter((m) => m.type === 'gift' && m.status === 'confirmed' && !m.supersededBy);
  const stamp = (m) => (m.date || '').replace('每年-', '0000-') || (m.createdAt || '').slice(0, 10);
  const items = [];
  for (const c of listContacts({ includeArchived: false })) {
    const mine = confirmed.filter((m) => m.contactId === c.id && (m.direction === 'user_to_contact' || m.direction === 'both'));
    const theirs = confirmed.filter((m) => m.contactId === c.id && (m.direction === 'contact_to_user' || m.direction === 'both'));
    if (!theirs.length) continue;
    const latestTheirs = theirs.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
    const latestMine = mine.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
    if (latestMine && stamp(latestMine) >= stamp(latestTheirs)) continue;
    const hasActivePlan = db.plans.some((p) => p.contactId === c.id && p.status !== 'sent');
    items.push({ contactId: c.id, name: c.name, memoryId: latestTheirs.id, content: latestTheirs.content, date: stamp(latestTheirs), hasActivePlan });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

/** 送礼台账：已确认 gift 记忆按方向分列，带联系人名。 */
export function giftLedger() {
  const confirmed = db.memories
    .filter((m) => m.type === 'gift' && m.status === 'confirmed' && !m.supersededBy)
    .sort((a, b) => (b.date || b.createdAt).slice(0, 10).localeCompare((a.date || a.createdAt).slice(0, 10)));
  const out = (m) => ({ id: m.id, contactId: m.contactId, contactName: getContact(m.contactId)?.name || '', content: m.content, date: m.date || (m.createdAt || '').slice(0, 10), occasion: m.occasion || '', direction: m.direction || 'user_to_contact' });
  return {
    given: confirmed.filter((m) => m.direction === 'user_to_contact' || m.direction === 'both').map(out),
    received: confirmed.filter((m) => m.direction === 'contact_to_user' || m.direction === 'both').map(out),
  };
}

/** 送礼时机（30 天窗）：生日 + 计划日期 + 相关固定节日（如教师节只匹配老师联系人）。 */
export function giftOccasions(days = 30) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDiff = (d) => Math.round((d - today) / 86_400_000);
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.contactId}|${item.occasion}|${item.date}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const c of listContacts({ includeArchived: false })) {
    // ① 生日（每年）
    const bd = nextBirthdayDays(c.birthday);
    if (bd !== null) push({ contactId: c.id, name: c.name, occasion: 'birthday', label: '生日', date: '', inDays: bd, source: 'birthday' });
    // ② 相关固定节日
    for (const h of FIXED_HOLIDAYS) {
      if (!h.match(c)) continue;
      for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
        const diff = dayDiff(new Date(year, Number(h.md.slice(0, 2)) - 1, Number(h.md.slice(3, 5))));
        if (diff >= 0 && diff <= days) push({ contactId: c.id, name: c.name, occasion: h.occasion, label: h.label, date: `${year}-${h.md}`, inDays: diff, source: 'holiday' });
      }
    }
    // ③ 计划里的具体日期
    for (const p of db.plans) {
      if (p.contactId !== c.id || !p.occasionDate || p.status === 'sent') continue;
      const [y, m, d] = p.occasionDate.split('-').map(Number);
      const diff = dayDiff(new Date(y, m - 1, d));
      if (diff >= 0 && diff <= days) push({ contactId: c.id, name: c.name, occasion: p.occasion || 'custom', label: p.occasion || '自定义', date: p.occasionDate, inDays: diff, source: 'plan', planId: p.id, idea: p.idea, status: p.status });
    }
  }
  return items.sort((a, b) => a.inDays - b.inDays).slice(0, 12);
}

// ---------- 素材（原始素材与结构化记忆分离，只作溯源存档） ----------
export function saveMaterial({ kind = 'text', text = '', contactId = '', occasion = '' } = {}) {
  const content = String(text ?? '');
  if (!content.trim()) throw httpError(400, '素材内容不能为空');
  if (content.length > 200_000) throw httpError(400, '素材过长（上限 20 万字符）');
  const cid = String(contactId ?? '');
  if (cid && !getContact(cid)) throw httpError(404, '关联的联系人不存在');
  const mt = {
    id: uid('mt'),
    kind: kind === 'screenshot' || kind === 'file' ? kind : 'text',
    text: content,
    excerpt: content.slice(0, 120),
    contactId: cid,
    occasion: normalizeOccasion(occasion),
    capturedAt: now(),
    extractedMemoryIds: [],
  };
  db.materials.push(mt);
  persist();
  return mt;
}
export function getMaterial(id) { return db.materials.find((m) => m.id === id) || null; }
export function listMaterials({ status } = {}) {
  let list = [...db.materials].sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''));
  if (status) list = list.filter((m) => materialStatus(m) === status);
  return list;
}
/** 素材状态按派生计算：拆出过记忆 = processed，否则 raw。 */
export function materialStatus(mt) {
  return (mt.extractedMemoryIds?.length ? 'processed' : 'raw');
}
export function materialMemories(mt) {
  return (mt.extractedMemoryIds || []).map((id) => getMemory(id)).filter(Boolean);
}
export function linkMaterial(id, memoryId) {
  const mt = getMaterial(id);
  if (!mt) throw httpError(404, '素材不存在');
  if (!getMemory(memoryId)) throw httpError(404, '记忆不存在');
  if (!mt.extractedMemoryIds.includes(memoryId)) mt.extractedMemoryIds.push(memoryId);
  persist();
  return mt;
}
export function deleteMaterial(id) {
  const i = db.materials.findIndex((m) => m.id === id);
  if (i < 0) throw httpError(404, '素材不存在');
  const [removed] = db.materials.splice(i, 1);
  persist();
  return removed;
}

// ---------- 首页总览 ----------
const TYPE_CN = { preference: '喜好', dislike: '不喜好', taboo: '禁忌', event: '事件', gift: '礼物', promise: '承诺', interaction: '往来', attribute: '基础' };
export function typeCn(t) { return TYPE_CN[t] || t; }

function nextBirthdayDays(birthday) {
  const match = /^(\d{4})?-(\d{2})-(\d{2})$/.exec(birthday.replace('每年-', '')) || /^(\d{2})-(\d{2})$/.exec(birthday);
  if (!match) return null;
  const month = Number(match[match.length - 2]);
  const day = Number(match[match.length - 1]);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    const next = new Date(year, month - 1, day);
    const diff = Math.round((next - today) / 86_400_000);
    if (diff >= 0 && diff <= 30) return diff;
  }
  return null;
}

export function overview() {
  // 被取代的 pending 不再进待确认队列（卡片上的「被取代」按钮点完即消失）
  const pending = listMemories({ status: 'pending' }).filter((m) => !m.supersededBy);
  const upcoming = listContacts({ includeArchived: false })
    .map((c) => ({ contactId: c.id, name: c.name, birthday: c.birthday, inDays: nextBirthdayDays(c.birthday) }))
    .filter((x) => x.inDays !== null)
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, 8);
  return {
    counts: {
      contacts: listContacts({ includeArchived: false }).length,
      memories: db.memories.length,
      confirmed: db.memories.filter((m) => m.status === 'confirmed').length,
      pending: pending.length,
      rejected: db.memories.filter((m) => m.status === 'rejected').length,
    },
    pending,
    upcoming,
  };
}

export function counts() { return overview().counts; }
