// AI 工具定义与执行器：DSH 原生会话（relationship preset）经 POST /api/tools
// 调用，或经 REST 端点复用同一校验路径。纪律：AI 写入一律 pending；
// contact_add 前必须 contact_search（同名即拒绝）；memory_search 只返回已确认记忆。
import * as store from './store.js';
import { RELATIONS, MEMORY_TYPES } from './store.js';
import { broadcast } from './sse.js';

export const TOOL_CN = {
  contact_search: '查找联系人',
  contact_add: '新建联系人',
  contact_update: '更新联系人',
  memory_add: '登记待确认记忆',
  memory_batch_add: '批量登记待确认记忆',
  memory_confirm: '确认记忆入库',
  memory_reject: '驳回记忆',
  memory_update: '编辑已确认记忆',
  memory_search: '检索长期记忆',
  timeline_get: '读取联系人时间线',
  gift_plan_add: '创建礼物计划卡',
  gift_plan_list: '列出礼物计划',
  gift_plan_update: '更新礼物计划',
  gift_plan_delete: '删除礼物计划',
  material_save: '存档原始素材',
  material_list: '列出待整理素材',
  material_get: '读取素材全文',
};

export const TOOL_DEFS = [
  { type: 'function', function: { name: 'contact_search', description: '按姓名或标签查找联系人。任何录入前必须先调用，避免建重', parameters: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: '姓名关键词或标签' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'contact_add', description: '新建联系人。若同名联系人已存在会拒绝，需先 contact_search 并与用户确认', parameters: { type: 'object', required: ['name', 'relation'], properties: {
      name: { type: 'string' }, relation: { type: 'string', enum: RELATIONS, description: '家人/朋友/同事/客户/伙伴/其他' },
      tags: { type: 'array', items: { type: 'string' } }, birthday: { type: 'string', description: 'MM-DD、YYYY-MM-DD 或 每年-MM-DD，未知则留空' },
      notes: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'contact_update', description: '更新联系人基础信息', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, name: { type: 'string' }, relation: { type: 'string', enum: RELATIONS },
      tags: { type: 'array', items: { type: 'string' } }, birthday: { type: 'string' }, notes: { type: 'string' }, archived: { type: 'boolean' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_add', description: '把对话中出现的一条关系事实登记为待确认记忆。一条记忆只含一个事实；用户确认后才进入长期记忆', parameters: { type: 'object', required: ['contactId', 'type', 'content'], properties: {
      contactId: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES, description: '喜好/不喜好/禁忌(如过敏)/事件/礼物/承诺/往来/基础事实' },
      content: { type: 'string', description: '保留原话语义，不演绎' }, date: { type: 'string', description: '事实时间：事情何时发生/发生。YYYY-MM-DD / YYYY-MM / 2026-10-__ / 每年-MM-DD / MM-DD，只保留已知精度' },
      importance: { type: 'integer', description: '1-3；3=关键事实（禁忌、重大事件）' },
      saidAt: { type: 'string', description: '话语时间：这句话什么时候说的，格式 YYYY-MM-DD HH:mm 或纯日期；聊天素材带时间戳时必填' },
      direction: { type: 'string', enum: ['', 'user_to_contact', 'contact_to_user', 'both'], description: '表达方向：交互/礼物/承诺类必填（user_to_contact=用户对联系人）；偏好等联系人自身属性留空' },
      lifespan: { type: 'string', enum: ['long', 'short'], description: '记忆寿命：long=长期（默认）；short=当前场景有效的临时事项（请假、约饭等），不进长期画像' },
      occasion: { type: 'string', description: '场景标签：teacher_day/birthday/thank_you/visit 等小写标签，可自由定义；能判断场景时填' },
      sourceId: { type: 'string', description: '来源素材 ID（从素材提取时必填，用于溯源）' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_batch_add', description: '一段素材拆出多条事实时批量登记，每条独立校验', parameters: { type: 'object', required: ['entries'], properties: {
      entries: { type: 'array', items: { type: 'object', properties: {
        contactId: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, content: { type: 'string' },
        date: { type: 'string', description: '事实时间' }, saidAt: { type: 'string', description: '话语时间，如 2026-09-11 20:03' },
        direction: { type: 'string', enum: ['', 'user_to_contact', 'contact_to_user', 'both'], description: '表达方向，交互/礼物/承诺类必填' },
        lifespan: { type: 'string', enum: ['long', 'short'], description: '记忆寿命，默认 long；临时事项用 short' },
        occasion: { type: 'string', description: '场景标签，如 teacher_day' },
        importance: { type: 'integer' }, sourceId: { type: 'string', description: '来源素材 ID' } },
        required: ['contactId', 'type', 'content'] } } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_confirm', description: '用户明确确认后调用：把待确认记忆转为长期记忆，可同时按用户口述修正内容', parameters: { type: 'object', required: ['ids'], properties: {
      ids: { type: 'array', items: { type: 'string' } },
      edits: { type: 'object', additionalProperties: { type: 'object', properties: {
        type: { type: 'string', enum: MEMORY_TYPES }, content: { type: 'string' }, date: { type: 'string' }, importance: { type: 'integer' }, saidAt: { type: 'string' }, direction: { type: 'string' }, lifespan: { type: 'string' }, occasion: { type: 'string' } } },
        description: '按记忆 ID 给出修正内容' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_reject', description: '用户驳回候选记忆时调用', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, reason: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_update', description: '编辑已确认的长期记忆（内容/类型/日期/重要度/话语时间/方向/寿命/场景）', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, content: { type: 'string' }, date: { type: 'string' }, importance: { type: 'integer' }, saidAt: { type: 'string' }, direction: { type: 'string' }, lifespan: { type: 'string' }, occasion: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_search', description: '检索某人的已确认长期记忆（生成祝福、礼物建议前必须调用）；支持按方向/场景/寿命过滤，检索为空要明说，不编造', parameters: { type: 'object', required: [], properties: {
      contactId: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, query: { type: 'string' },
      direction: { type: 'string', enum: ['user_to_contact', 'contact_to_user', 'both'], description: '表达方向过滤；查"我对TA说过什么"用 user_to_contact' },
      occasion: { type: 'string', description: '场景标签过滤，如 teacher_day' },
      lifespan: { type: 'string', enum: ['long', 'short'], description: '记忆寿命过滤' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'timeline_get', description: '读取某联系人的完整时间线（基础信息 + 已确认记忆）', parameters: { type: 'object', required: ['contactId'], properties: {
      contactId: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_add', description: '为联系人创建礼物计划卡（想法/已定/已送）。礼物建议必须基于已确认记忆（喜好/禁忌/送过记录），方案理由引用记忆点，禁忌品类明确排除', parameters: { type: 'object', required: ['contactId', 'idea'], properties: {
      contactId: { type: 'string' }, idea: { type: 'string', description: '礼物方案名与一句话理由（≤200 字）' },
      occasion: { type: 'string', description: '场景标签，如 teacher_day/birthday' },
      occasionDate: { type: 'string', description: '这一次的具体日期 YYYY-MM-DD，可留空' },
      budget: { type: 'string', description: '预算，可留空' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_list', description: '列出礼物计划（默认全部）', parameters: { type: 'object', required: [], properties: {
      contactId: { type: 'string' }, status: { type: 'string', enum: ['idea', 'decided', 'sent'] } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_update', description: '更新礼物计划（方案/预算/状态）', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, idea: { type: 'string' }, budget: { type: 'string' }, status: { type: 'string', enum: ['idea', 'decided', 'sent'] } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_delete', description: '删除礼物计划', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_save', description: '把用户主动提供的原始素材（粘贴的聊天记录、转发文本、口述长段）存档溯源，随后用 memory_batch_add 逐条提取', parameters: { type: 'object', required: ['text'], properties: {
      text: { type: 'string' }, contactId: { type: 'string', description: '素材主要涉及的联系人，可留空' }, occasion: { type: 'string', description: '素材所属场景，如 teacher_day/birthday；提取的记忆会继承' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_list', description: '列出素材（默认待整理 raw），用户说"整理素材"时先调用', parameters: { type: 'object', required: [], properties: {
      status: { type: 'string', enum: ['raw', 'processed'], description: 'raw=待整理，processed=已拆出记忆' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_get', description: '读取素材全文（提取前调用），返回 text 与已提取的记忆', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' } }, additionalProperties: false } } },
];

function contactBrief(c) { return { id: c.id, name: c.name, relation: c.relation, tags: c.tags, birthday: c.birthday, archived: c.archived }; }
function memoryOut(m) {
  const c = store.getContact(m.contactId);
  return { ...m, contactName: c?.name || '' };
}

function changedMemory(m, action, extra = {}) {
  broadcast('memory.changed', { action, memory: memoryOut(m), ...extra });
}
function changedContact(c, action) {
  broadcast('contact.changed', { action, contact: contactBrief(c) });
}
function changedStats() {
  broadcast('overview', { counts: store.counts() });
}

export async function executeTool(name, args = {}) {
  try {
    return await run(name, args);
  } catch (e) {
    return { ok: false, error: e?.message || String(e), status: e?.status || 400 };
  }
}

async function run(name, args) {
  switch (name) {
    case 'contact_search': {
      const q = String(args.query ?? '').trim().toLowerCase();
      if (!q) return { ok: false, error: 'query 不能为空' };
      const matches = store.listContacts()
        .filter((c) => c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))
        .map(contactBrief);
      return { ok: true, matches, 提示: matches.length ? '同名/近似联系人存在时先与用户确认是否为同一人' : '未找到；新建前先与用户确认' };
    }

    case 'contact_add': {
      const name = String(args.name ?? '').trim();
      const dup = store.listContacts().find((c) => c.name === name);
      if (dup) return { ok: false, code: 'DUPLICATE_NAME', status: 409, error: `已存在同名联系人「${dup.name}」（${dup.id}）。请先 contact_search 并与用户确认是否同一人；确为不同人可用 contact_update 区分标签后再建` };
      const c = store.createContact(args);
      changedContact(c, 'created');
      changedStats();
      return { ok: true, contact: contactBrief(c) };
    }

    case 'contact_update': {
      const c = store.updateContact(String(args.id ?? ''), args);
      changedContact(c, 'updated');
      changedStats();
      return { ok: true, contact: contactBrief(c) };
    }

    case 'memory_add': {
      const m = store.createMemory({ ...args, author: 'ai' });
      changedMemory(m, 'created');
      changedStats();
      return { ok: true, memory: memoryOut(m), 提示: '已登记为待确认记忆，用户在界面确认后进入长期记忆' };
    }

    case 'memory_batch_add': {
      const { created, failed } = store.createMemories(args.entries, 'ai');
      for (const m of created) changedMemory(m, 'created');
      changedStats();
      return { ok: true, created: created.map(memoryOut), failed, 提示: '已批量登记为待确认记忆，等待用户确认' };
    }

    case 'memory_confirm': {
      const { confirmed, failed } = store.confirmMemories(args.ids, args.edits);
      for (const m of confirmed) changedMemory(m, 'confirmed');
      changedStats();
      return { ok: confirmed.length > 0, confirmed: confirmed.map(memoryOut), failed };
    }

    case 'memory_reject': {
      const m = store.rejectMemory(String(args.id ?? ''), args.reason);
      changedMemory(m, 'rejected');
      changedStats();
      return { ok: true, memory: memoryOut(m) };
    }

    case 'memory_update': {
      const m = store.updateMemory(String(args.id ?? ''), args);
      changedMemory(m, 'updated');
      return { ok: true, memory: memoryOut(m) };
    }

    case 'memory_search': {
      const list = store.listMemories({
        contactId: args.contactId ? String(args.contactId) : undefined,
        type: args.type || undefined,
        q: args.query || undefined,
        direction: args.direction || undefined,
        occasion: args.occasion || undefined,
        lifespan: args.lifespan || undefined,
        status: 'confirmed',
      }).filter((m) => !m.supersededBy);
      return { ok: true, memories: list.slice(0, 50).map(memoryOut), total: list.length, 提示: '生成祝福/问候时先检索该场合 user_to_contact 的历史表达，避免重复去年说过的核心内容' };
    }

    case 'timeline_get': {
      const { contact, memories, shortItems } = store.timeline(String(args.contactId ?? ''));
      return { ok: true, contact, memories: memories.map(memoryOut), shortItems: (shortItems || []).map(memoryOut) };
    }

    case 'gift_plan_add': {
      const plan = store.createPlan({ ...args, source: 'ai' });
      broadcast('plan.changed', { action: 'created', planId: plan.id });
      return { ok: true, plan, 提示: '计划卡已创建（想法状态），用户会在礼赠页看到；方案理由须能对应到已确认记忆' };
    }
    case 'gift_plan_list': {
      const list = store.listPlans({ contactId: args.contactId ? String(args.contactId) : undefined, status: args.status || undefined });
      return { ok: true, plans: list.map((p) => ({ ...p, contactName: store.getContact(p.contactId)?.name || '' })) };
    }
    case 'gift_plan_update': {
      const plan = store.updatePlan(String(args.id ?? ''), args);
      broadcast('plan.changed', { action: 'updated', planId: plan.id });
      return { ok: true, plan };
    }
    case 'gift_plan_delete': {
      const removed = store.deletePlan(String(args.id ?? ''));
      broadcast('plan.changed', { action: 'deleted', planId: removed.id });
      return { ok: true, plan: removed };
    }

    case 'material_save': {
      const mt = store.saveMaterial({ text: args.text, contactId: args.contactId ? String(args.contactId) : '', occasion: args.occasion });
      broadcast('material.changed', { action: 'created', materialId: mt.id });
      return { ok: true, material: { id: mt.id, excerpt: mt.excerpt, contactId: mt.contactId, occasion: mt.occasion }, 提示: '素材已存档。请用 memory_batch_add 把其中每个事实拆成一条待确认记忆（sourceId 填本素材 ID，交互/礼物类标注 direction，临时事务 lifespan=short，能判断场景时填 occasion）；涉及的人先 contact_search 确认' };
    }

    case 'material_list': {
      const list = store.listMaterials({ status: args.status || undefined }).slice(0, 30)
        .map((mt) => ({ id: mt.id, status: store.materialStatus(mt), contactId: mt.contactId, contactName: mt.contactId ? store.getContact(mt.contactId)?.name || '' : '', occasion: mt.occasion || '', excerpt: mt.excerpt, capturedAt: mt.capturedAt, extractedCount: mt.extractedMemoryIds.length }));
      return { ok: true, materials: list };
    }

    case 'material_get': {
      const mt = store.getMaterial(String(args.id ?? ''));
      if (!mt) return { ok: false, error: '素材不存在', status: 404 };
      return { ok: true, material: { ...mt, status: store.materialStatus(mt), contactName: mt.contactId ? store.getContact(mt.contactId)?.name || '' : '', extracted: store.materialMemories(mt).map(memoryOut) } };
    }

    default:
      return { ok: false, error: `未知工具: ${name}。可用工具：${Object.keys(TOOL_CN).join('、')}` };
  }
}
