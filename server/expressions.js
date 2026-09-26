// 已发送表达复用既有 interaction 记忆；不新增类型、表或侧车。
import store from './store-facade.js';
import { FLOWS } from './prompts.js';
import { occasionKey } from './occasions.js';

export const EXPRESSION_PREFIX = '已发送表达：\n';
export const EXPRESSION_TEXT_MAX = 480;

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw store.httpError(400, '请求内容必须是对象');
  return body;
}

function losslessString(value) {
  // Rust 经 UTF-8 CLI 传参，拒绝 NUL 与孤立代理项，避免与 JSON 后端原文不一致。
  return typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString('utf8') === value;
}

function optionalText(value, max, label) {
  if (value == null) return '';
  if (!losslessString(value) || value.length > max) {
    throw store.httpError(400, `${label}须为不超过 ${max} 字的有效字符串，不能含 NUL 字符`);
  }
  return value;
}

function activeContact(contactId) {
  if (typeof contactId !== 'string' || !contactId.trim()) throw store.httpError(400, 'contactId 不能为空');
  const contact = store.getContact(contactId);
  if (!contact) throw store.httpError(404, '联系人不存在');
  if (contact.status !== 'confirmed' || contact.archived) {
    throw store.httpError(400, '联系人须已确认且未归档');
  }
  return contact;
}

function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validText(text) {
  // 长度同既有 store / 浏览器 maxlength 的 UTF-16 口径；U+0085 也会被 Rust trim。
  return losslessString(text) && Boolean(text.trim()) && text.length <= EXPRESSION_TEXT_MAX
    && !/[\s\u0085]$/u.test(text);
}

/** 只将有效、已确认且未取代的专用前缀记忆视为原文；普通互动仍只是事实摘要。 */
export function toExpression(memory) {
  if (!memory || memory.status !== 'confirmed' || memory.supersededBy
    || memory.type !== 'interaction' || memory.direction !== 'user_to_contact' || memory.lifespan !== 'long'
    || typeof memory.content !== 'string' || !memory.content.startsWith(EXPRESSION_PREFIX)) return null;
  const text = memory.content.slice(EXPRESSION_PREFIX.length);
  if (!validText(text) || !realDate(memory.date)) return null;
  return { ...memory, text };
}

const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '')
  || (b.createdAt || '').localeCompare(a.createdAt || '') || a.id.localeCompare(b.id);

export function listExpressions(contactId) {
  return store.listMemories({ contactId, status: 'confirmed' })
    .filter((memory) => memory.contactId === contactId).map(toExpression).filter(Boolean).sort(byDateDesc);
}

export function expressionPrompt(body) {
  const { contactId, occasion: rawOccasion, note: rawNote } = bodyObject(body);
  const contact = activeContact(contactId);
  const occasion = occasionKey(optionalText(rawOccasion, 40, 'occasion'));
  const note = optionalText(rawNote, 300, 'note');
  const memories = store.listMemories({ contactId, status: 'confirmed' })
    .filter((memory) => memory.contactId === contactId && memory.status === 'confirmed' && !memory.supersededBy)
    .sort(byDateDesc);
  const history = memories.map(toExpression).filter(Boolean);
  const cautions = memories.filter((memory) => ['taboo', 'dislike'].includes(memory.type))
    .map(({ id, content }) => ({ id, content }));
  const prompt = FLOWS.expressionDraft.build({
    contact: { id: contact.id, name: contact.name, relation: contact.relation, tags: contact.tags || [], birthday: contact.birthday || '' },
    occasion, note, cautions,
    confirmedMemories: memories.map(({ id, type, content, date, occasion, direction, lifespan }) => ({ id, type, content, date, occasion, direction, lifespan })),
    sameOccasionHistory: history.filter((memory) => occasionKey(memory.occasion) === occasion),
    otherOccasionHistory: history.filter((memory) => occasionKey(memory.occasion) !== occasion),
  });
  return { prompt, cautions, historyCount: history.length };
}

export function saveExpression(body) {
  const { contactId, occasion: rawOccasion, text, date, sent } = bodyObject(body);
  if (sent !== true) throw store.httpError(400, '请明确确认实际已发送（sent 必须为 true）');
  const contact = activeContact(contactId);
  const occasion = occasionKey(optionalText(rawOccasion, 40, 'occasion'));
  if (!validText(text)) {
    // 两种底层存储均 trim 内容；拒绝末尾空白，而非默默改动用户确认的最终原文。
    throw store.httpError(400, `正文须为非空有效字符串且不超过 ${EXPRESSION_TEXT_MAX} 字，不能含 NUL 或末尾空白；请修改后重新确认`);
  }
  if (!realDate(date)) throw store.httpError(400, 'date 必须是有效的真实日期 YYYY-MM-DD');
  const content = EXPRESSION_PREFIX + text;
  // 同一联系人、标准化场合、同日同文本视同一表达，用于丢响应重试。
  const existing = listExpressions(contact.id).find((memory) => occasionKey(memory.occasion) === occasion
    && memory.date === date && memory.content === content);
  const memory = existing ? store.getMemory(existing.id) : store.createMemory({
    contactId: contact.id, occasion, date, content,
    author: 'user', type: 'interaction', direction: 'user_to_contact', lifespan: 'long',
  });
  // 重试也 flush：前次落盘失败可能已在 JSON 内存态创建，不能仅命中内存就报告成功。
  store.flush();
  return { memory, reused: Boolean(existing) };
}
