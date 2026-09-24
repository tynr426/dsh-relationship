// 存储实现（Rust/SQLite）：与 store.js 完全同构的 API 面，业务校验在 Node 侧
// （与 JSON 版同一套文案），数据读写经 relstore-bridge 落到 SQLite（0600）。
// 启用方式：REL_STORE=rust（经 store-facade.js 选择本文件）。
// 说明：素材状态与回礼视图由 CLI 派生（v_material_status / v_gift_reciprocity），
// extractedMemoryIds 不再物理存储，按记忆 sourceId 反查。
import {
  relstoreAvailable,
  run as cli,
} from './relstore-bridge.js';
import { httpError, now } from './store-shared.js';
import { deriveOccasions, upcomingHolidays } from './occasions.js';

export const RELATIONS = ['family', 'friend', 'colleague', 'client', 'partner', 'other'];
export const MEMORY_TYPES = ['preference', 'dislike', 'taboo', 'event', 'gift', 'promise', 'interaction', 'attribute'];
export const MEMORY_STATUSES = ['pending', 'confirmed', 'rejected'];
export const DIRECTIONS = ['', 'user_to_contact', 'contact_to_user', 'both'];
export const LIFESPANS = ['long', 'short'];
export const PLAN_STATUSES = ['idea', 'decided', 'sent', 'done'];
export const FUZZY_DATE_RE = /^(?:\d{4}-\d{2}(?:-\d{2})?|\d{4}-\d{2}-__|每年-\d{2}-\d{2}|\d{2}-\d{2})$/;

export function uid(prefix = '') {
  return (prefix ? `${prefix}_` : '') + Math.random().toString(16).slice(2, 10);
}

export { httpError, now };

// ---------- 校验与归一化（与 JSON 版逐字对齐） ----------
export function normalizeOccasion(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!s) return '';
  if (s.length > 40) throw httpError(400, 'occasion 不能超过 40 字');
  return s;
}

export function normalizeDirection(v) {
  const s = String(v ?? '');
  if (!DIRECTIONS.includes(s)) throw httpError(400, `direction 必须是：${DIRECTIONS.filter(Boolean).join(' / ')} 或留空`);
  return s;
}

export function normalizeLifespan(v) {
  const s = String(v ?? 'long');
  if (!LIFESPANS.includes(s)) throw httpError(400, `lifespan 必须是：${LIFESPANS.join(' / ')}`);
  return s;
}

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

function normalizeFuzzyDate(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!FUZZY_DATE_RE.test(s)) throw httpError(400, `${label}格式无效：支持 YYYY-MM-DD / YYYY-MM / 2026-10-__ / 每年-MM-DD / MM-DD`);
  const nums = s.split('-').filter((x) => /^\d{2,4}$/.test(x));
  if (nums.length === 2 && /^\d{4}$/.test(nums[0])) {
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

function cleanTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw httpError(400, 'tags 必须是字符串数组');
  const cleaned = tags.map((t) => String(t).trim()).filter(Boolean);
  if (cleaned.length > 20) throw httpError(400, '标签最多 20 个');
  for (const t of cleaned) if (t.length > 20) throw httpError(400, '单个标签不能超过 20 字');
  return [...new Set(cleaned)];
}

// ---------- 关系类型（注册表：内置 6 类 + 工作台自定义，联系人 relation 的合法值来源） ----------
const RELATION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function listRelationTypes() {
  const { relationTypes } = cli(['relation-type', 'list']);
  return relationTypes;
}

/** 当前注册的全部 relation key（联系人校验用，动态） */
export function relationKeys() {
  return listRelationTypes().map((t) => t.key);
}

function assertRelation(relation) {
  const keys = relationKeys();
  if (!keys.includes(relation)) throw httpError(400, `relation 必须是：${keys.join(' / ')}`);
  return relation;
}

export function createRelationType({ key, label, sort } = {}) {
  const k = String(key ?? '').trim();
  if (!RELATION_KEY_RE.test(k)) throw httpError(400, 'key 非法：小写字母开头，仅含小写字母/数字/下划线，不超过 32 字');
  const name = String(label ?? '').trim();
  if (!name) throw httpError(400, '显示名不能为空');
  if (name.length > 40) throw httpError(400, '显示名不能超过 40 字');
  const s = sort == null || sort === '' ? undefined : Number(sort);
  if (s !== undefined && !Number.isInteger(s)) throw httpError(400, 'sort 必须是整数');
  if (RELATIONS.includes(k)) throw httpError(409, `关系类型已存在: ${k}`);
  const { relationType } = cli(['relation-type', 'add', '--key', k, '--label', name, ...(s !== undefined ? ['--sort', String(s)] : [])]);
  return relationType;
}

export function updateRelationType(key, patch = {}) {
  const args = ['relation-type', 'set', String(key)];
  if ('label' in patch) {
    const name = String(patch.label ?? '').trim();
    if (!name) throw httpError(400, '显示名不能为空');
    if (name.length > 40) throw httpError(400, '显示名不能超过 40 字');
    args.push('--label', name);
  }
  if ('sort' in patch) {
    const s = Number(patch.sort);
    if (!Number.isInteger(s)) throw httpError(400, 'sort 必须是整数');
    args.push('--sort', String(s));
  }
  if (args.length === 3) throw httpError(400, '未提供要更新的字段');
  const { relationType } = cli(args);
  return relationType;
}

export function deleteRelationType(key) {
  const k = String(key ?? '').trim();
  // 内置保护与占用检查在 Node 侧给出准确状态码（403/409），CLI 错误仅作兜底
  const type = listRelationTypes().find((t) => t.key === k);
  if (!type) throw httpError(404, '关系类型不存在');
  if (type.builtin) throw httpError(403, `内置类型不可删除: ${k}`);
  const using = listContacts({ includeArchived: true, includePending: true }).filter((c) => c.relation === k);
  if (using.length) {
    const names = using.slice(0, 5).map((c) => c.name).join('、');
    throw httpError(409, `该类型正被 ${using.length} 个联系人使用（${names}${using.length > 5 ? ' 等' : ''}），请先调整这些联系人的关系再删除`);
  }
  cli(['relation-type', 'remove', k]);
  return { key: k };
}

// ---------- 联系人 ----------
// 语义与 JSON 版一致：CLI 层如实返回存储（含 pending），是否纳入待确认联系人是 Node 的调用方决定
export function listContacts({ includeArchived = true, includePending = false } = {}) {
  const { contacts } = cli(['contact', 'list', ...(includeArchived ? ['--archived'] : [])]);
  let list = contacts;
  if (!includePending) list = list.filter((c) => (c.status || 'confirmed') !== 'pending');
  return list;
}

export function getContact(id) {
  return listContacts({ includeArchived: true, includePending: true }).find((c) => c.id === id) || null;
}

export function createContact(fields = {}) {
  const name = String(fields.name ?? '').trim();
  if (!name) throw httpError(400, '联系人姓名不能为空');
  if (name.length > 40) throw httpError(400, '姓名不能超过 40 字');
  const relation = fields.relation == null || fields.relation === '' ? 'other' : String(fields.relation);
  assertRelation(relation);
  // 收录状态：AI 通道显式传 'pending' 进待确认队列；其余（手动创建/缺省）一律 confirmed
  const status = fields.status == null || fields.status === '' ? 'confirmed' : String(fields.status);
  if (!['pending', 'confirmed'].includes(status)) throw httpError(400, 'status 必须是：pending / confirmed');
  const { contact } = cli(['contact', 'add',
    '--name', name,
    '--relation', relation,
    '--tags', cleanTags(fields.tags).join(','),
    '--birthday', normalizeFuzzyDate(fields.birthday ?? '', '生日'),
    '--notes', String(fields.notes ?? '').slice(0, 500),
    '--status', status,
  ]);
  return contact;
}

/** 拍板收录待确认联系人（只有 pending 可转正，AI 够不到这一步） */
export function confirmContact(id) {
  const c = getContact(id);
  if (!c) throw httpError(404, '联系人不存在');
  if ((c.status || 'confirmed') !== 'pending') throw httpError(400, '只有待确认联系人可以确认收录');
  const { contact } = cli(['contact', 'set', String(id), '--status', 'confirmed']);
  return contact;
}

export function updateContact(id, patch = {}) {
  const args = ['contact', 'set', String(id)];
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw httpError(400, '联系人姓名不能为空');
    if (name.length > 40) throw httpError(400, '姓名不能超过 40 字');
    args.push('--name', name);
  }
  if ('relation' in patch) {
    const relation = String(patch.relation ?? '');
    assertRelation(relation);
    args.push('--relation', relation);
  }
  if ('tags' in patch) args.push('--tags', cleanTags(patch.tags).join(','));
  if ('birthday' in patch) args.push('--birthday', normalizeFuzzyDate(patch.birthday, '生日'));
  if ('notes' in patch) args.push('--notes', String(patch.notes ?? '').slice(0, 500));
  if ('archived' in patch) args.push('--archived', patch.archived ? 'true' : 'false');
  const { contact } = cli(args);
  return contact;
}

export function deleteContact(id) {
  const { removed } = cli(['contact', 'remove', String(id)]);
  return { contact: removed, removedMemories: removed.removedMemories };
}

// ---------- 记忆 ----------
export function listMemories({ contactId, status, type, q, direction, occasion, lifespan } = {}) {
  const args = ['memory', 'list'];
  if (contactId) args.push('--contact', String(contactId));
  if (status) args.push('--status', String(status));
  if (type) args.push('--type', String(type));
  if (direction) args.push('--dir', String(direction));
  if (occasion) args.push('--occasion', String(occasion));
  if (lifespan) args.push('--lifespan', String(lifespan));
  if (q) args.push('--q', String(q));
  const { memories } = cli(args);
  return memories;
}

export function getMemory(id) {
  return listMemories().find((m) => m.id === id) || null;
}

export function validateMemoryFields({ type, content, date, importance, saidAt, direction, lifespan, occasion }) {
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

function memoryAddArgs(v, author, extra = {}) {
  const args = ['memory', 'add',
    '--contact', String(extra.contactId),
    '--type', v.type,
    '--content', v.content,
    '--date', v.date,
    '--saidAt', v.saidAt,
    '--dir', v.direction,
    '--lifespan', v.lifespan,
    '--occasion', v.occasion,
    '--importance', String(v.importance),
    '--author', author,
  ];
  if (extra.sourceId) args.push('--sourceId', String(extra.sourceId));
  if (extra.sourceQuote) args.push('--sourceQuote', String(extra.sourceQuote));
  return args;
}

export function createMemory(fields = {}) {
  const contactId = String(fields.contactId ?? '');
  if (!getContact(contactId)) throw httpError(404, '联系人不存在：请先 contact_search 定位或先建联系人');
  const v = validateMemoryFields(fields);
  const author = fields.author === 'user' ? 'user' : 'ai';
  // 场景继承：从素材提取且未显式给 occasion 时，继承素材的场合标签
  const sourceId = typeof fields.sourceId === 'string' ? fields.sourceId : '';
  const sourceQuote = typeof fields.sourceQuote === 'string' ? fields.sourceQuote.trim().slice(0, 200) : '';
  if (!v.occasion && sourceId) {
    const mt = getMaterial(sourceId);
    if (mt?.occasion) v.occasion = normalizeOccasion(mt.occasion);
  }
  const { memory } = cli(memoryAddArgs(v, author, { contactId, sourceId, sourceQuote }));
  return memory;
}

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

function applyMemoryEditArgs(id, edits = {}) {
  const m = getMemory(id);
  if (!m) throw httpError(404, '记忆不存在');
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
  return ['memory', 'set', String(id),
    '--type', v.type,
    '--content', v.content,
    '--date', v.date,
    '--saidAt', v.saidAt,
    '--dir', v.direction,
    '--lifespan', v.lifespan,
    '--occasion', v.occasion,
    '--importance', String(v.importance),
  ];
}

export function confirmMemories(ids = [], edits = {}) {
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids 不能为空');
  const confirmed = [];
  const failed = [];
  for (const id of ids) {
    const m = getMemory(String(id));
    if (!m) { failed.push({ id, error: '记忆不存在' }); continue; }
    if (m.status !== 'pending') { failed.push({ id, error: `状态为 ${m.status}，只有待确认记忆可以确认` }); continue; }
    try {
      const args = applyMemoryEditArgs(String(id), edits && typeof edits === 'object' ? edits[m.id] : undefined);
      args.push('--status', 'confirmed');
      const { memory } = cli(args);
      confirmed.push(memory);
    } catch (e) {
      failed.push({ id, error: e?.message || String(e) });
    }
  }
  return { confirmed, failed };
}

export function rejectMemory(id, reason = '') {
  const m = getMemory(String(id));
  if (!m) throw httpError(404, '记忆不存在');
  if (m.status !== 'pending') throw httpError(400, `状态为 ${m.status}，只有待确认记忆可以驳回`);
  const { memory } = cli(['memory', 'reject', String(id), '--reason', String(reason ?? '').slice(0, 200)]);
  return memory;
}

export function restoreMemory(id) {
  const m = getMemory(String(id));
  if (!m) throw httpError(404, '记忆不存在');
  if (m.status !== 'rejected') throw httpError(400, '只有已驳回记忆可以恢复');
  const { memory } = cli(['memory', 'restore', String(id)]);
  return memory;
}

export function updateMemory(id, patch = {}, { expected } = {}) {
  const m = getMemory(String(id));
  if (expected && (!m || m.status !== 'confirmed' || m.supersededBy)) {
    throw Object.assign(httpError(409, '原记忆已修改或删除，旧提案不能覆盖'), { code: 'MEMORY_CONFLICT' });
  }
  if (!m) throw httpError(404, '记忆不存在');
  if (m.status !== 'confirmed') throw httpError(400, `状态为 ${m.status}，只有已确认记忆可以直接编辑`);
  const args = applyMemoryEditArgs(String(id), patch);
  args.push('--expected', JSON.stringify(expected ?? m));
  const { memory } = cli(args);
  return memory;
}

export function deleteMemory(id) {
  const removed = getMemory(String(id));
  if (!removed) throw httpError(404, '记忆不存在');
  cli(['memory', 'remove', String(id)]);
  return removed;
}

export function supersedeMemory(id, keepId) {
  const m = getMemory(String(id));
  const keep = getMemory(String(keepId));
  if (!m || !keep) throw httpError(404, '记忆不存在');
  if (m.id === keep.id) throw httpError(400, '不能指向自身');
  // 校验与 JSON 版保持一致（契约测试锁定）：同联系人；依据必须是未被取代的已确认记忆
  if (m.contactId !== keep.contactId) throw httpError(400, '只能在同一联系人的记忆之间取代');
  if (keep.status !== 'confirmed') throw httpError(400, `取代依据（keepId）必须是已确认记忆，当前为 ${keep.status}`);
  if (keep.supersededBy) throw httpError(400, '取代依据本身已被取代，不能再作为依据');
  if (m.status !== 'pending' && m.status !== 'confirmed') throw httpError(400, `状态为 ${m.status} 的记忆无需取代`);
  const { memory } = cli(['memory', 'supersede', String(id), '--by', String(keep.id)]);
  return memory;
}

// ---------- 时间线 ----------
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
  return d.replace('-__', '-01').padEnd(10, '0') + 'T' + (m.createdAt || '');
}

// ---------- 礼物计划 ----------
function validatePlanFields({ occasion, occasionDate, idea, budget, productName, productPrice, productUrl }) {
  const text = String(idea ?? '').trim();
  if (!text) throw httpError(400, '礼物想法不能为空');
  if (text.length > 200) throw httpError(400, '礼物想法不能超过 200 字');
  const od = String(occasionDate ?? '').trim();
  if (od && !/^\d{4}-\d{2}-\d{2}$/.test(od)) throw httpError(400, 'occasionDate 必须是 YYYY-MM-DD（这一次的具体日期）');
  const pn = String(productName ?? '').trim().slice(0, 100);
  const pp = String(productPrice ?? '').trim().slice(0, 40);
  const pu = String(productUrl ?? '').trim();
  if (pu.length > 4096) throw httpError(400, '商品链接不能超过 4096 字');
  if (pu && !/^(https?:\/\/|\/\/)/i.test(pu)) throw httpError(400, '商品链接要以 http(s):// 开头');
  return { occasion: normalizeOccasion(occasion), occasionDate: od, idea: text, budget: String(budget ?? '').trim().slice(0, 40), productName: pn, productPrice: pp, productUrl: pu };
}

export function createPlan(fields = {}) {
  const contactId = String(fields.contactId ?? '');
  if (!getContact(contactId)) throw httpError(404, '联系人不存在');
  const v = validatePlanFields(fields);
  const status = String(fields.status ?? '').trim() || 'idea';
  if (!PLAN_STATUSES.includes(status)) throw httpError(400, `status 必须是：${PLAN_STATUSES.join(' / ')}`);
  const { plan } = cli(['plan', 'add',
    '--contact', contactId,
    '--idea', v.idea,
    '--occasion', v.occasion,
    '--date', v.occasionDate,
    '--budget', v.budget,
    '--product-name', v.productName,
    '--product-price', v.productPrice,
    '--product-url', v.productUrl,
    '--source', fields.source === 'ai' ? 'ai' : 'user',
    ...(status !== 'idea' ? ['--status', status] : []),
  ]);
  return plan;
}

export function listPlans({ contactId, status } = {}) {
  const args = ['plan', 'list'];
  if (contactId) args.push('--contact', String(contactId));
  if (status) args.push('--status', String(status));
  const { plans } = cli(args);
  return plans;
}

export function getPlan(id) {
  return listPlans().find((p) => p.id === id) || null;
}

export function updatePlan(id, patch = {}) {
  const p = getPlan(id);
  if (!p) throw httpError(404, '计划不存在');
  const args = ['plan', 'set', String(id)];
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
    args.push('--idea', v.idea, '--occasion', v.occasion, '--date', v.occasionDate, '--budget', v.budget,
      '--product-name', v.productName, '--product-price', v.productPrice, '--product-url', v.productUrl);
  }
  if ('status' in patch) {
    const status = String(patch.status ?? '').trim() || 'idea';
    if (!PLAN_STATUSES.includes(status)) throw httpError(400, `status 必须是：${PLAN_STATUSES.join(' / ')}`);
    if (['sent', 'done'].includes(p.status) && status !== p.status) {
      throw httpError(400, '已终结的计划不能更改状态');
    }
    args.push('--status', status);
  }
  const { plan } = cli(args);
  return plan;
}

export function deletePlan(id) {
  const removed = getPlan(id);
  if (!removed) throw httpError(404, '计划不存在');
  cli(['plan', 'remove', String(id)]);
  return removed;
}

export function markPlanDone(id) {
  const p = getPlan(id);
  if (!p) throw httpError(404, '计划不存在');
  if (p.status === 'sent') throw httpError(400, '已送出的计划不能标记完成');
  if (p.status === 'done') return p;
  return updatePlan(id, { status: 'done' });
}

export function markPlanSent(id) {
  const p = getPlan(id);
  if (!p) throw httpError(404, '计划不存在');
  if (p.status === 'done') throw httpError(400, '已完成的计划不能标记已送出');
  const { plan, memory } = cli(['plan', 'sent', String(id)]);
  return { plan: plan || p, memory };
}

// ---------- 礼赠视图 ----------
export function giftReciprocity() {
  // 排除 SQLite 视图中的被取代礼物；同日按创建顺序与 JSON 模式保持一致。
  const confirmed = listMemories({ type: 'gift', status: 'confirmed' }).filter((m) => !m.supersededBy)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const plans = listPlans();
  const stamp = (m) => (m.date || '').replace('每年-', '0000-') || (m.createdAt || '').slice(0, 10);
  const items = [];
  for (const c of listContacts({ includeArchived: false })) {
    const mine = confirmed.filter((m) => m.contactId === c.id && ['user_to_contact', 'both'].includes(m.direction));
    const theirs = confirmed.filter((m) => m.contactId === c.id && ['contact_to_user', 'both'].includes(m.direction));
    if (!theirs.length) continue;
    const latestTheirs = theirs.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
    const latestMine = mine.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
    if (latestMine && stamp(latestMine) >= stamp(latestTheirs)) continue;
    const hasActivePlan = plans.some((p) => p.contactId === c.id && !['sent', 'done'].includes(p.status));
    items.push({ contactId: c.id, name: c.name, memoryId: latestTheirs.id, content: latestTheirs.content, date: stamp(latestTheirs), hasActivePlan });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

export function giftLedger() {
  const { given, received } = cli(['ledger']);
  return { given, received };
}

export function giftOccasions(days = 30) {
  return deriveOccasions(listContacts({ includeArchived: false }), listPlans(), days);
}

export { upcomingHolidays };

export function fadingContacts(days = 90) {
  const { fading } = cli(['fading', '--days', String(days)]);
  return fading;
}

// ---------- 素材 ----------
export function saveMaterial({ kind = 'text', text = '', contactId = '', contactIds, occasion = '' } = {}) {
  const content = String(text ?? '');
  if (!content.trim()) throw httpError(400, '素材内容不能为空');
  if (content.length > 200_000) throw httpError(400, '素材过长（上限 20 万字符）');
  // 多人素材：contactId 字段只存第一人（锚点，rust CLI --contact 校验存在性存不了多人），
  // 完整列表由 facade 写侧车（material-contacts.js），与 JSON 路径共享同一约定
  let cid = String(contactId ?? '');
  if (Array.isArray(contactIds)) {
    const ids = [...new Set(contactIds.map(String).filter(Boolean))];
    if (ids.length > 10) throw httpError(400, '主要涉及人最多 10 个');
    if (ids.length && !ids.every((x) => getContact(x))) throw httpError(404, '关联的联系人不存在');
    cid = ids[0] || '';
  }
  if (cid && !getContact(cid)) throw httpError(404, '关联的联系人不存在');
  const { material } = cli(['material', 'add',
    '--text', content,
    '--contact', cid,
    '--occasion', normalizeOccasion(occasion),
    ...(kind === 'screenshot' || kind === 'file' ? ['--kind', kind] : []),
  ]);
  return material;
}

export function getMaterial(id) {
  try {
    const { material } = cli(['material', 'show', String(id)]);
    return material || null;
  } catch {
    return null;
  }
}

export function listMaterials({ status } = {}) {
  const args = ['material', 'list'];
  if (status) args.push('--status', String(status));
  const { materials } = cli(args);
  return materials;
}

/** 素材状态按派生计算：拆出过记忆 = processed，否则 raw（CLI 已派生，此处兜底反查）。 */
export function materialStatus(mt) {
  if (!mt) return 'raw';
  if (mt.status) return mt.status;
  return listMemories({}).some((m) => m.sourceId === mt.id) ? 'processed' : 'raw';
}

export function materialMemories(mt) {
  if (!mt) return [];
  return listMemories({}).filter((m) => m.sourceId === mt.id);
}

export function linkMaterial(id, memoryId) {
  const mt = getMaterial(id);
  if (!mt) throw httpError(404, '素材不存在');
  if (!getMemory(memoryId)) throw httpError(404, '记忆不存在');
  const { material } = cli(['material', 'link', String(id), '--memory', String(memoryId)]);
  return material;
}

export function deleteMaterial(id) {
  const removed = getMaterial(id);
  if (!removed) throw httpError(404, '素材不存在');
  cli(['material', 'remove', String(id)]);
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
  const memories = listMemories();
  const pendingContacts = listContacts({ includeArchived: false, includePending: true }).filter((c) => c.status === 'pending');
  const upcoming = listContacts({ includeArchived: false })
    .map((c) => ({ contactId: c.id, name: c.name, birthday: c.birthday, inDays: nextBirthdayDays(c.birthday) }))
    .filter((x) => x.inDays !== null)
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, 8);
  return {
    counts: {
      contacts: listContacts({ includeArchived: false }).length,
      memories: memories.length,
      confirmed: memories.filter((m) => m.status === 'confirmed').length,
      pending: pending.length,
      rejected: memories.filter((m) => m.status === 'rejected').length,
      pendingContacts: pendingContacts.length,
    },
    pending,
    pendingContacts,
    upcoming,
  };
}

export function counts() { return overview().counts; }

// ---------- 迁移 / 加载 ----------
/** JSON → SQLite 一次性迁移（把 data 目录的四个 JSON 导入 rel.db，源文件改名备份）。 */
export function migrateFromJson(dir) {
  return cli(['migrate', '--dir', dir, '--force']);
}

/** facades 兼容：JSON 版用 loadStore 预热内存库；Rust 版初始化建库（幂等）。 */
export function loadStore() {
  if (!relstoreAvailable()) return null;
  cli(['contact', 'list', '--archived']);
  return true;
}

/** 兼容：JSON 版 flush 强制落盘；SQLite 每写即落，无需处理。 */
export function flush() {}
