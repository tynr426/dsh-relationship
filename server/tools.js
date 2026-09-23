// AI 工具定义与执行器：DSH 原生会话（relationship preset）经 POST /api/tools
// 调用，或经 REST 端点复用同一校验路径。纪律：AI 写入一律 pending——记忆进
// 待确认队列，新建联系人同样进待确认队列（工作台拍板收录）；contact_add 前
// 必须 contact_search（同名即拒绝）；memory_search 只返回已确认记忆。
// 素材提取另有「提取质量闸门」（gateError）：sourceQuote 原话摘录 + saidAt 时间戳
// 命中 + direction 必填 + 查重，坏条目拒绝落库——纪律从提示词约定升级为工具层硬校验。
import store from './store-facade.js';
import { RELATIONS, MEMORY_TYPES } from './store.js';
import { broadcast } from './sse.js';

export const TOOL_CN = {
  contact_search: '查找联系人',
  contact_add: '新建联系人',
  contact_update: '更新联系人',
  memory_add: '登记待确认记忆',
  memory_batch_add: '批量登记待确认记忆',
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
  material_report: '提交素材整理报告',
  organize_question: '登记/清除整理反问',
  relation_type_list: '列出关系类型',
  pending_summary: '查看待确认队列',
};

export const TOOL_DEFS = [
  { type: 'function', function: { name: 'contact_search', description: '按姓名或标签查找联系人（含待确认联系人，status=pending）。任何录入前必须先调用，避免建重', parameters: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: '姓名关键词或标签' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'contact_add', description: '新建联系人。AI 新建一律进入工作台待确认队列，由用户确认收录；不必等待确认，直接用返回的编号继续登记记忆。若同名联系人已存在会拒绝，需先 contact_search；tags 建议填身份标签（如 老师/同学/前同事/客户），教师节等节日与场合匹配依赖这些标签', parameters: { type: 'object', required: ['name', 'relation'], properties: {
      name: { type: 'string' }, relation: { type: 'string', description: '关系类型 key（小写英文标识）。先用 relation_type_list 查当前可用类型；默认内置：family/friend/colleague/client/partner/other' },
      tags: { type: 'array', items: { type: 'string' } }, birthday: { type: 'string', description: 'MM-DD、YYYY-MM-DD 或 每年-MM-DD，未知则留空' },
      notes: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'contact_update', description: '更新联系人基础信息', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, name: { type: 'string' }, relation: { type: 'string', description: '关系类型 key，先用 relation_type_list 查当前可用类型' },
      tags: { type: 'array', items: { type: 'string' } }, birthday: { type: 'string' }, notes: { type: 'string' }, archived: { type: 'boolean' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_add', description: '把对话中出现的一条关系事实登记为待确认记忆。一条记忆只含一个事实；用户确认后才进入长期记忆。从素材提取（带 sourceId）时必须附 sourceQuote 原话摘录，工具会校验摘录与时间戳', parameters: { type: 'object', required: ['contactId', 'type', 'content'], properties: {
      contactId: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES, description: '喜好/不喜好/禁忌(如过敏)/事件/礼物/承诺/往来/基础事实' },
      content: { type: 'string', description: '保留原话语义，不演绎' }, date: { type: 'string', description: '事实时间：事情何时发生/发生。YYYY-MM-DD / YYYY-MM / 2026-10-__ / 每年-MM-DD / MM-DD，只保留已知精度' },
      importance: { type: 'integer', description: '1-3；3=关键事实（禁忌、重大事件）' },
      saidAt: { type: 'string', description: '话语时间：这句话什么时候说的，格式 YYYY-MM-DD HH:mm 或纯日期；聊天素材带时间戳时必填' },
      direction: { type: 'string', enum: ['', 'user_to_contact', 'contact_to_user', 'both'], description: '表达方向：交互/礼物/承诺类必填（user_to_contact=用户对联系人）；偏好等联系人自身属性留空' },
      lifespan: { type: 'string', enum: ['long', 'short'], description: '记忆寿命：long=长期（默认）；short=当前场景有效的临时事项（请假、约饭等），不进长期画像' },
      occasion: { type: 'string', description: '场景标签：teacher_day/birthday/thank_you/visit 等小写标签，可自由定义；能判断场景时填' },
      sourceId: { type: 'string', description: '来源素材 ID（从素材提取时必填，用于溯源）' },
      sourceQuote: { type: 'string', description: '原话摘录：逐字摘自素材原文、只覆盖该条事实（≤200 字）；带 sourceId 时必填，闸门校验是否真在素材里' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'memory_batch_add', description: '一段素材拆出多条事实时批量登记，每条独立校验（含提取闸门：sourceQuote 原话摘录、saidAt 时间戳命中、direction 必填、查重、同一摘录对同一联系人不得复用且不得跨消息）；长素材分多批提取——每批只覆盖一段消息、从上一批结束处继续，被拒条目修正后单独重报，勿整批重发', parameters: { type: 'object', required: ['entries'], properties: {
      entries: { type: 'array', items: { type: 'object', properties: {
        contactId: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, content: { type: 'string' },
        date: { type: 'string', description: '事实时间' }, saidAt: { type: 'string', description: '话语时间，如 2026-09-11 20:03' },
        direction: { type: 'string', enum: ['', 'user_to_contact', 'contact_to_user', 'both'], description: '表达方向，交互/礼物/承诺类必填' },
        lifespan: { type: 'string', enum: ['long', 'short'], description: '记忆寿命，默认 long；临时事项用 short' },
        occasion: { type: 'string', description: '场景标签，如 teacher_day' },
        importance: { type: 'integer' }, sourceId: { type: 'string', description: '来源素材 ID' },
        sourceQuote: { type: 'string', description: '该条事实的素材原话摘录，逐字出自原文（带 sourceId 时必填）' } },
        required: ['contactId', 'type', 'content'] } } }, additionalProperties: false } } },
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
  { type: 'function', function: { name: 'gift_plan_add', description: '为联系人创建礼物计划卡（仅想法/已定，完成或已送须用户确认）。礼物建议必须基于已确认记忆（喜好/禁忌/送过记录），方案理由引用记忆点，禁忌品类明确排除；先 gift_plan_list 查已有计划——同联系人相同想法会被拒绝（409），优化已有计划用 gift_plan_update 更新原卡，不另建新卡', parameters: { type: 'object', required: ['contactId', 'idea'], properties: {
      contactId: { type: 'string' }, idea: { type: 'string', description: '礼物方案名与一句话理由（≤200 字）' },
      status: { type: 'string', enum: ['idea', 'decided'] },
      occasion: { type: 'string', description: '场景标签，如 teacher_day/birthday' },
      occasionDate: { type: 'string', description: '这一次的具体日期 YYYY-MM-DD，可留空' },
      budget: { type: 'string', description: '预算，可留空' },
      basedOnPlanId: { type: 'string', description: '围绕某个已有计划出主意时必填：该计划的 ID（出主意 prompt 会给出）——工作台会把这批新方案归到它名下，用户可一键删除这批建议；独立方案留空' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_list', description: '列出礼物计划（默认全部）', parameters: { type: 'object', required: [], properties: {
      contactId: { type: 'string' }, status: { type: 'string', enum: ['idea', 'decided', 'sent', 'done'] } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_update', description: '更新礼物计划（方案/预算/状态仅 idea 或 decided；完成或送出须用户确认）', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, idea: { type: 'string' }, budget: { type: 'string' }, status: { type: 'string', enum: ['idea', 'decided'] } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'gift_plan_delete', description: '删除礼物计划', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_save', description: '把用户主动提供的原始素材（粘贴的聊天记录、转发文本、口述长段）存档溯源，随后用 memory_batch_add 逐条提取', parameters: { type: 'object', required: ['text'], properties: {
      text: { type: 'string' }, contactId: { type: 'string', description: '素材主要涉及的联系人，可留空' }, contactIds: { type: 'array', items: { type: 'string' }, description: '素材涉及多人时传多个联系人编号（如送礼给多人），优先于 contactId' }, occasion: { type: 'string', description: '素材所属场景，如 teacher_day/birthday；提取的记忆会继承' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_list', description: '列出素材（默认待整理 raw），用户说"整理素材"时先调用；有已拆条数但无整理报告的素材是整理未完成，应续跑而非重拆', parameters: { type: 'object', required: [], properties: {
      status: { type: 'string', enum: ['raw', 'processed'], description: 'raw=待整理，processed=已拆出记忆' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_get', description: '读取素材全文（提取前调用），返回 text 与已提取的记忆（extracted 列表，续跑时对照它跳过已覆盖的消息）', parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'material_report', description: '素材整理完提交整理报告：拆出的记忆清单、哪些已被既有记忆覆盖而未重复登记、发现的冲突。报告会显示在工作台素材卡上，供用户逐条确认时对照——对话里的汇报说完就没了，这是它落进工作台的唯一通道', parameters: { type: 'object', required: ['id', 'report'], properties: {
      id: { type: 'string', description: '素材 ID' },
      report: { type: 'string', description: '整理报告全文（拆出清单 / 已覆盖未重复登记项 / 冲突说明）' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'organize_question', description: '素材整理中确需用户拍板才能继续时登记反问：先调本工具再在对话里提问，工作台素材卡会实时显示「AI 在等你回答」，用户可在工作台直接作答（嵌入模式一键发送、独立模式复制作答指令）。整理反问是最后手段——判断一律以当前库为准，已删除的素材与记忆视为不存在，库里没有的记忆直接照常登记（重复登记会被闸门拦下），不得为此反问。用户作答后（无论从哪个通道收到）调用本工具并带 done=true 清除登记', parameters: { type: 'object', required: ['materialId'], properties: {
      materialId: { type: 'string', description: '素材 ID' },
      question: { type: 'string', description: '反问内容（一句话说清要用户拍板什么）' },
      options: { type: 'array', items: { type: 'object', required: ['label', 'command'], properties: {
        label: { type: 'string', description: '选项短名，如 照常整理 / 跳过不登记' },
        command: { type: 'string', description: '该选项的自足作答指令：含素材 ID 与明确决定，发到任意关系记忆会话都能据此继续，如「素材 mt_xx 照常整理：当前库里没有这些记忆，直接全部登记」' } } }, description: '2-4 个选项' },
      done: { type: 'boolean', description: 'true=用户已作答，清除该素材的反问登记' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'relation_type_list', description: '列出当前可用的关系类型（内置 6 类 + 工作台自定义）。contact_add/contact_update 的 relation 字段必须取这里的 key；自定义类型由用户在工作台维护，AI 只读', parameters: { type: 'object', required: [], properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'pending_summary', description: '查看待确认队列概览（会话开始时先调用）：有待确认记忆或待确认联系人就主动提醒用户回工作台确认。只读——确认/驳回/收录是用户的拍板动作，没有对应 AI 工具', parameters: { type: 'object', required: [], properties: {}, additionalProperties: false } } },
];

function contactBrief(c) { return { id: c.id, name: c.name, relation: c.relation, tags: c.tags, birthday: c.birthday, archived: c.archived, status: c.status || 'confirmed' }; }
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

// ---------- 提取质量闸门（AI 通道） ----------
// 素材提取（带 sourceId）逐条硬校验，坏条目拒绝落库并给出可修正的错误：
// ① interaction/gift/promise 必带 direction；② sourceQuote 原话摘录必填且
// 逐字出自素材原文，内含完整时间戳（跨消息摘录）即拒；③ saidAt 必须命中素材
// 时间戳（摘录所在消息的时间就是话语时间，错位/编造一律拒）；④ 内容与既有
// 已确认/待确认记忆或同批条目重复即拒；⑤ 同一摘录对同一联系人只支撑一条
// 事实，复用即拒（跨联系人放行：素材里一句话可同时涉及多人；驳回后释放）。
const DIRECTION_REQUIRED_TYPES = ['interaction', 'gift', 'promise'];
export { DIRECTION_REQUIRED_TYPES };
const STAMP_RE = /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?\s*(\d{1,2})[：:](\d{2})/g;
export { STAMP_RE };
const STAMP_ONLY_RE = /^(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?\s*(\d{1,2})[：:](\d{2})$/;
const BARE_TIME_RE = /(?<![\d:])(\d{1,2})[：:](\d{2})(?![\d:])/g;

const pad2 = (s) => String(s).padStart(2, '0');
export { pad2 };
const stampOf = (y, mo, d, h, mi) => `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${mi}`;

export function extractStamps(text) {
  const full = [];
  for (const m of text.matchAll(STAMP_RE)) {
    full.push({ stamp: stampOf(m[1], m[2], m[3], m[4], m[5]), index: m.index, end: m.index + m[0].length });
  }
  // 掩掉完整时间戳后再找裸时分，避免把时间戳里的时分误当独立时间
  let masked = text;
  for (let i = full.length - 1; i >= 0; i--) {
    masked = masked.slice(0, full[i].index) + ' '.repeat(full[i].end - full[i].index) + masked.slice(full[i].end);
  }
  const bareTimes = [...masked.matchAll(BARE_TIME_RE)].map((m) => `${pad2(m[1])}:${m[2]}`);
  return { full, bareTimes };
}

export function normalizeSaidAtStamp(v) {
  const m = STAMP_ONLY_RE.exec(String(v ?? '').trim());
  return m ? stampOf(m[1], m[2], m[3], m[4], m[5]) : '';
}

/** 逐条校验；返回 { code, error } 或 null（通过）。ctx 见 gateContext。 */
function gateError(entry, ctx) {
  const type = String(entry.type ?? '');
  if (DIRECTION_REQUIRED_TYPES.includes(type) && !String(entry.direction ?? '').trim()) {
    return { code: 'MISSING_DIRECTION', error: `${type} 类记忆必须标注 direction（user_to_contact=我对TA / contact_to_user=TA对我 / both）` };
  }
  const sourceId = typeof entry.sourceId === 'string' ? entry.sourceId.trim() : '';
  if (!sourceId) return null; // 会话直录（无素材）只查方向，不做素材闸门

  const mt = ctx.material(sourceId);
  if (!mt) return { code: 'MATERIAL_NOT_FOUND', error: `素材 ${sourceId} 不存在：先 material_save 存档，再用返回的素材 ID 提取` };

  const quote = String(entry.sourceQuote ?? '').trim();
  if (!quote) return { code: 'MISSING_QUOTE', error: '素材提取必须带 sourceQuote：该条事实对应的素材原话摘录（逐字，≤200 字）' };
  if (quote.length > 200) return { code: 'QUOTE_TOO_LONG', error: 'sourceQuote 超过 200 字——一条记忆只含一个事实，摘录应只覆盖该事实的原话，疑似多条打包' };
  const text = String(mt.text ?? '');
  const exactAt = text.indexOf(quote);
  const looseOk = exactAt < 0 && quote.replace(/\s+/g, '') && text.replace(/\s+/g, '').includes(quote.replace(/\s+/g, ''));
  if (exactAt < 0 && !looseOk) {
    return { code: 'QUOTE_MISMATCH', error: 'sourceQuote 必须逐字摘自素材原文（不得改写、拼接或凭印象复述）' };
  }
  // 摘录内含完整时间戳 = 跨多条消息摘录，疑似把多条事实打包成一条
  if ([...quote.matchAll(STAMP_RE)].length > 0) {
    return { code: 'QUOTE_SPANS_STAMP', error: 'sourceQuote 内含完整时间戳，说明摘录跨越了多条消息：一条摘录只覆盖该条事实所在的单条消息原话' };
  }

  const { full, bareTimes } = ctx.stamps(sourceId, text);
  const saidAt = String(entry.saidAt ?? '').trim();
  const saidNorm = normalizeSaidAtStamp(saidAt);
  if (full.length) {
    if (!saidNorm) return { code: 'SAIDAT_REQUIRED', error: '素材含时间戳：saidAt 必须取素材中的时间戳（YYYY-MM-DD HH:mm）' };
    // 位置就近：摘录（含自身）之前最近的时间戳即该话语的时间
    const anchor = [...full].reverse().find((s) => exactAt >= 0 && s.end <= exactAt + quote.length);
    if (anchor && saidNorm !== anchor.stamp) {
      return { code: 'SAIDAT_MISPLACED', error: `saidAt=${saidAt} 与原话位置不符：这段原话对应素材时间戳 ${anchor.stamp}（saidAt 应取原话所在消息的时间）` };
    }
    if (!full.some((s) => s.stamp === saidNorm)) {
      return { code: 'SAIDAT_NOT_IN_MATERIAL', error: `saidAt=${saidAt} 不在素材时间戳里，不得编造话语时间` };
    }
  } else if (bareTimes.length) {
    const tm = /(\d{1,2})[：:](\d{2})\s*$/.exec(saidAt);
    if (!tm || !bareTimes.includes(`${pad2(tm[1])}:${tm[2]}`)) {
      return { code: 'SAIDAT_NOT_IN_MATERIAL', error: `素材只有时分时间（${bareTimes.join('、')}）：saidAt 的时间部分须取其中之一` };
    }
  } else if (saidAt) {
    return { code: 'SAIDAT_NOT_IN_MATERIAL', error: '素材没有时间戳：saidAt 留空即可，不得编造话语时间' };
  }

  const dup = ctx.dup(String(entry.contactId ?? ''), String(entry.content ?? '').trim());
  if (dup) {
    return { code: 'DUPLICATE_CONTENT', error: `与${dup.status === 'confirmed' ? '已确认' : '待确认'}记忆 ${dup.id}「${String(dup.content).slice(0, 40)}」重复：已被覆盖的事实不重复登记` };
  }
  // 一条摘录只支撑一条事实：同一摘录对同一联系人复用即拒；跨联系人放行
  // （素材里一句话可同时涉及多人），驳回/被取代的记忆不占摘录
  if (sourceId && ctx.quoteDup(mt, quote.replace(/\s+/g, ''), String(entry.contactId ?? ''))) {
    return { code: 'DUPLICATE_QUOTE', error: 'sourceQuote 已被该联系人的另一条记忆引用：一条摘录只支撑一条事实，请为本条另选只覆盖它的原话' };
  }
  return null;
}

/** 批量/单条共用的懒加载上下文：素材、时间戳集合、按联系人的既有记忆、摘录占用。 */
function gateContext() {
  const materials = new Map();
  const stamps = new Map();
  const existing = new Map();
  const seen = new Map();
  // 摘录占用：sourceId -> (规范化摘录 -> 引用过它的联系人集合)，懒加载自既有记忆
  const quoteOwners = new Map();
  return {
    material(id) {
      if (!materials.has(id)) materials.set(id, store.getMaterial(id) || null);
      return materials.get(id);
    },
    stamps(id, text) {
      if (!stamps.has(id)) stamps.set(id, extractStamps(text));
      return stamps.get(id);
    },
    dup(contactId, content) {
      if (!contactId || !content) return null;
      if (!existing.has(contactId)) existing.set(contactId, store.listMemories({ contactId }));
      const hit = existing.get(contactId).find((m) => !m.supersededBy && (m.status === 'confirmed' || m.status === 'pending') && String(m.content).trim() === content);
      if (hit) return hit;
      if ((seen.get(contactId) || new Set()).has(content)) return { id: '（本批前一条）', status: 'pending', content };
      return null;
    },
    mark(contactId, content) {
      if (!contactId || !content) return;
      if (!seen.has(contactId)) seen.set(contactId, new Set());
      seen.get(contactId).add(content);
    },
    quoteDup(mt, normQuote, contactId) {
      if (!quoteOwners.has(mt.id)) {
        const owners = new Map();
        for (const m of store.materialMemories(mt)) {
          if (m.supersededBy || (m.status !== 'confirmed' && m.status !== 'pending')) continue;
          const q = String(m.sourceQuote ?? '').replace(/\s+/g, '');
          if (!q) continue;
          if (!owners.has(q)) owners.set(q, new Set());
          owners.get(q).add(String(m.contactId));
        }
        quoteOwners.set(mt.id, owners);
      }
      const owners = quoteOwners.get(mt.id).get(normQuote);
      return owners ? owners.has(contactId) : false;
    },
    markQuote(sourceId, contactId, normQuote) {
      if (!sourceId || !contactId || !normQuote) return;
      if (!quoteOwners.has(sourceId)) quoteOwners.set(sourceId, new Map());
      const owners = quoteOwners.get(sourceId);
      if (!owners.has(normQuote)) owners.set(normQuote, new Set());
      owners.get(normQuote).add(contactId);
    },
  };
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
      // 含待确认联系人（status=pending）：AI 能看到以免建重，可直接复用其编号
      const matches = store.listContacts({ includePending: true })
        .filter((c) => c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))
        .map(contactBrief);
      return { ok: true, matches, 提示: matches.length
        ? '命中即复用返回的联系人编号；status=pending 的是待用户确认收录的新联系人，同样可直接用；同名/近似称呼命中多人时先与用户确认是否同一人'
        : '未找到；直接 contact_add 新建（会进入工作台待确认队列，用户确认后收录），拿到编号继续拆条登记' };
    }

    case 'contact_add': {
      const name = String(args.name ?? '').trim();
      // 查重含待确认联系人：pending 也占名字，防止同一人被重复建
      const dup = store.listContacts({ includePending: true }).find((c) => c.name === name);
      if (dup) return { ok: false, code: 'DUPLICATE_NAME', status: 409, error: `已存在同名联系人「${dup.name}」（${dup.id}）。请先 contact_search 并与用户确认是否同一人；确为不同人可用 contact_update 区分标签后再建` };
      const c = store.createContact({ ...args, status: 'pending' });
      changedContact(c, 'created');
      changedStats();
      return { ok: true, contact: contactBrief(c), 提示: '已建为待确认联系人，用户会在工作台确认收录；不必等待确认，直接用返回的编号继续登记记忆' };
    }

    case 'contact_update': {
      const c = store.updateContact(String(args.id ?? ''), args);
      changedContact(c, 'updated');
      changedStats();
      return { ok: true, contact: contactBrief(c) };
    }

    case 'memory_add': {
      const gateErr = gateError(args, gateContext());
      if (gateErr) return { ok: false, status: 422, ...gateErr };
      const m = store.createMemory({ ...args, author: 'ai' });
      changedMemory(m, 'created');
      changedStats();
      return { ok: true, memory: memoryOut(m), 提示: '已登记为待确认记忆，用户在界面确认后进入长期记忆' };
    }

    case 'memory_batch_add': {
      const entries = Array.isArray(args.entries) ? args.entries : [];
      if (!entries.length) throw Object.assign(new Error('entries 必须是非空数组'), { status: 400 });
      // 提取闸门先行：坏条目直接进 failed（带 index/code/error），好条目再走 store 校验
      const ctx = gateContext();
      const gateFailed = [];
      const valid = [];
      for (const [index, entry] of entries.entries()) {
        const err = entry && typeof entry === 'object' ? gateError(entry, ctx) : { code: 'BAD_ENTRY', error: '条目必须是对象' };
        if (err) gateFailed.push({ index, ...err });
        else {
          valid.push({ index, entry });
          ctx.mark(String(entry.contactId ?? ''), String(entry.content ?? '').trim());
          ctx.markQuote(String(entry.sourceId ?? '').trim(), String(entry.contactId ?? ''), String(entry.sourceQuote ?? '').trim().replace(/\s+/g, ''));
        }
      }
      let created = [];
      let storeFailed = [];
      if (valid.length) {
        const r = store.createMemories(valid.map((v) => v.entry), 'ai');
        created = r.created;
        storeFailed = r.failed.map((f) => ({ index: valid[f.index].index, ...f }));
      }
      for (const m of created) changedMemory(m, 'created');
      changedStats();
      const failed = [...gateFailed, ...storeFailed].sort((a, b) => a.index - b.index);
      return { ok: true, created: created.map(memoryOut), failed, 提示: failed.length
        ? `本批 ${entries.length} 条中 ${failed.length} 条被闸门或校验拒绝（见 failed 的 code/error）；请修正后只重报被拒条目，勿整批重发`
        : '已批量登记为待确认记忆，等待用户确认' };
    }

    case 'memory_confirm': {
      // P0 安全闭环：确认是人拍板动作，只允许工作台界面（/api/memories/confirm）执行。
      // AI 通道一律拒绝，防止「AI 写入后自我确认」绕过待确认队列。
      return { ok: false, status: 403, error: '确认属于用户的拍板动作，AI 不能代办。请引导用户回工作台待确认队列点击确认；如需修正内容请用 memory_update（仅限已确认记忆）' };
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
      if ('status' in args && !['idea', 'decided'].includes(args.status)) {
        throw store.httpError(400, 'AI 计划只能设置 idea / decided，完成或送出须由用户确认');
      }
      // 查重闸门：同联系人已有相同想法（忽略空白差异）的未终结计划直接拒绝——
      // AI 出主意可能重复建卡（曾一次生成 4 张同场合卡），提示词之外兜底
      const norm = (s) => String(s ?? '').replace(/\s+/g, '');
      const idea = norm(args.idea);
      const dup = store.listPlans({ contactId: String(args.contactId ?? '') })
        .find((p) => !['sent', 'done'].includes(p.status) && norm(p.idea) === idea);
      if (dup) {
        return { ok: false, error: `该联系人已有相同想法的计划卡 ${dup.id}（${dup.idea}）：不要重复建卡——要完善它就用 gift_plan_update 更新这张卡`, status: 409 };
      }
      // 围绕已有计划出主意时带 basedOnPlanId：工作台把这类建议归到原计划名下，可一键删除这批
      const { basedOnPlanId, ...rest } = args;
      const baseId = basedOnPlanId ? String(basedOnPlanId).trim() : '';
      const basePlan = baseId ? store.listPlans({}).find((p) => p.id === baseId) : null;
      if (baseId && !basePlan) {
        return { ok: false, error: `basedOnPlanId 对应的计划不存在：${baseId}（围绕已有计划出主意时才填，独立方案留空）`, status: 404 };
      }
      if (basePlan && basePlan.contactId !== String(args.contactId ?? '')) {
        return { ok: false, error: '建议与原计划必须属于同一联系人', status: 400 };
      }
      const plan = store.createPlan({ ...rest, source: 'ai' });
      if (baseId) store.linkPlanSuggestion(plan.id, baseId);
      broadcast('plan.changed', { action: 'created', planId: plan.id });
      return { ok: true, plan, 提示: baseId ? '计划卡已创建并关联到原计划（工作台可一键删除这批建议）；方案理由须能对应到已确认记忆' : '计划卡已创建（想法状态），用户会在礼赠页看到；方案理由须能对应到已确认记忆' };
    }
    case 'gift_plan_list': {
      const list = store.listPlans({ contactId: args.contactId ? String(args.contactId) : undefined, status: args.status || undefined });
      return { ok: true, plans: list.map((p) => ({ ...p, contactName: store.getContact(p.contactId)?.name || '' })) };
    }
    case 'gift_plan_update': {
      if ('status' in args && !['idea', 'decided'].includes(args.status)) {
        throw store.httpError(400, 'AI 计划只能设置 idea / decided，完成或送出须由用户确认');
      }
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
      const mt = store.saveMaterial({ text: args.text, contactId: args.contactId ? String(args.contactId) : '', contactIds: Array.isArray(args.contactIds) ? args.contactIds : undefined, occasion: args.occasion });
      broadcast('material.changed', { action: 'created', materialId: mt.id });
      return { ok: true, material: { id: mt.id, excerpt: mt.excerpt, contactId: mt.contactId, occasion: mt.occasion }, 提示: '素材已存档。请用 memory_batch_add 把其中每个事实拆成一条待确认记忆（sourceId 填本素材 ID；每条附 sourceQuote 原话摘录，逐字出自素材原文；saidAt 取素材时间戳；交互/礼物类标注 direction；临时事务 lifespan=short；能判断场景时填 occasion）；涉及的人先 contact_search 确认' };
    }

    case 'material_list': {
      // 批量化：一次取全量记忆做 sourceId 计数，避免逐素材 materialMemories 放大
      const sourceCount = new Map();
      for (const mem of store.listMemories({})) {
        if (mem.sourceId) sourceCount.set(mem.sourceId, (sourceCount.get(mem.sourceId) || 0) + 1);
      }
      const names = new Map(store.listContacts({ includeArchived: true, includePending: true }).map((c) => [c.id, c.name]));
      const reports = store.allMaterialReports();
      const extraContacts = store.allMaterialContacts();
      const idsOf = (mt) => {
        const v = Array.isArray(extraContacts[mt.id]) ? extraContacts[mt.id] : null;
        if (v && v.length) return v;
        return mt.contactId ? [mt.contactId] : [];
      };
      const list = store.listMaterials({ status: args.status || undefined }).slice(0, 30)
        .map((mt) => ({ id: mt.id, status: store.materialStatus(mt), contactId: mt.contactId, contactIds: idsOf(mt), contactName: idsOf(mt).map((x) => names.get(x) || '').filter(Boolean).join('、'), occasion: mt.occasion || '', excerpt: mt.excerpt, capturedAt: mt.capturedAt, extractedCount: mt.extractedMemoryIds?.length ?? sourceCount.get(mt.id) ?? 0, hasReport: Boolean(reports[mt.id]) }));
      return { ok: true, materials: list };
    }

    case 'material_get': {
      const mt = store.getMaterial(String(args.id ?? ''));
      if (!mt) return { ok: false, error: '素材不存在', status: 404 };
      // today = 相对时间锚点：「明天/下周三」等一律以它推算（每次调用新鲜计算，不落盘）
      const now = new Date();
      const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}（星期${week}）`;
      const contactIds = store.materialContactIds(mt);
      return { ok: true, today, material: { ...mt, status: store.materialStatus(mt), contactIds, contactName: contactIds.map((x) => store.getContact(x)?.name || '').filter(Boolean).join('、'), ...(store.materialReport(mt.id) || {}), extracted: store.materialMemories(mt).map(memoryOut) } };
    }

    case 'material_report': {
      const id = String(args.id ?? '');
      const mt = store.getMaterial(id);
      if (!mt) return { ok: false, error: '素材不存在', status: 404 };
      const report = String(args.report ?? '').trim();
      if (!report) return { ok: false, error: 'report 不能为空：整理报告应写清拆出的记忆清单、哪些已被既有记忆覆盖而未重复登记、发现的冲突' };
      if (report.length > 20_000) return { ok: false, error: '报告过长（上限 2 万字符）' };
      const saved = store.saveMaterialReport(id, report);
      broadcast('material.changed', { action: 'reported', materialId: id });
      return { ok: true, report: saved, 提示: '整理报告已提交，将显示在工作台素材卡上；请提示用户回工作台逐条确认这批记忆' };
    }

    case 'organize_question': {
      const id = String(args.materialId ?? '').trim();
      if (!id) return { ok: false, error: 'materialId 不能为空' };
      if (!store.getMaterial(id)) return { ok: false, error: `素材不存在：${id}`, status: 404 };
      if (args.done === true) {
        store.clearOrganizeQuestion(id);
        broadcast('material.changed', { action: 'question-cleared', materialId: id });
        return { ok: true, cleared: true };
      }
      const question = String(args.question ?? '').trim();
      if (!question) return { ok: false, error: 'question 不能为空：一句话说清要用户拍板什么' };
      if (question.length > 2000) return { ok: false, error: 'question 过长（上限 2000 字符）' };
      const norm = (Array.isArray(args.options) ? args.options : [])
        .map((o) => ({ label: String(o?.label ?? '').trim(), command: String(o?.command ?? '').trim() }))
        .filter((o) => o.label && o.command);
      if (norm.length < 2 || norm.length > 4) return { ok: false, error: 'options 须为 2-4 个，每个含 label（选项短名）与 command（自足作答指令：含素材 ID 与明确决定，发到任意关系记忆会话都能据此继续）' };
      const saved = store.saveOrganizeQuestion(id, question, norm);
      broadcast('material.changed', { action: 'question', materialId: id });
      return { ok: true, question: saved, 提示: '反问已登记，工作台素材卡会显示「AI 在等你回答」，用户可在工作台直接作答；请在对话里同步提问，用户从任一通道作答后调用 organize_question 带 done=true 清除登记' };
    }

    case 'relation_type_list': {
      const relationTypes = store.listRelationTypes();
      return { ok: true, relationTypes, 提示: `当前可用 ${relationTypes.length} 种关系类型；contact_add/contact_update 的 relation 取这里的 key` };
    }

    case 'pending_summary': {
      // 会话开始提醒用：只读概览。被取代的 pending 不再 nag（与待确认队列口径一致）。
      const pending = store.listMemories({ status: 'pending' }).filter((m) => !m.supersededBy);
      const all = store.listContacts({ includeArchived: true, includePending: true });
      const names = new Map(all.map((c) => [c.id, c.name]));
      const pendingContacts = all.filter((c) => c.status === 'pending');
      const items = pending.slice(0, 20).map((m) => ({ id: m.id, contactName: names.get(m.contactId) || '', type: m.type, content: m.content, sourceId: m.sourceId || '' }));
      const nMem = pending.length;
      const nContact = pendingContacts.length;
      return {
        ok: true,
        pendingCount: nMem,
        items,
        pendingContacts: pendingContacts.map((c) => ({ id: c.id, name: c.name, relation: c.relation, tags: c.tags })),
        提示: (nMem || nContact)
          ? `有 ${nMem} 条待确认记忆${nContact ? `、${nContact} 位待确认联系人（${pendingContacts.map((c) => c.name).join('、')}）` : ''}。请主动提醒用户回工作台确认（确认是用户的拍板动作，没有 AI 工具），可简述最重要的几条`
          : '没有待确认记忆或联系人',
      };
    }

    default:
      return { ok: false, error: `未知工具: ${name}。可用工具：${Object.keys(TOOL_CN).join('、')}` };
  }
}
