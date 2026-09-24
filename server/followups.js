// Reminder dispositions are separate from facts, keyed by the exact source version.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { readJsonFile, atomicWriteFile, validateDataFile, isRecord, isCalendarDate, FOLLOWUP_STATUSES } from './json-file.js';

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const fingerprint = (memory) => createHash('sha256').update(JSON.stringify(canonical(memory))).digest('hex');

export function createFollowups({ store, dataDir = DATA_DIR }) {
  const file = path.join(dataDir, 'followups.json');
  const read = () => readJsonFile(file, {}, (v) => validateDataFile('followups.json', v));
  function write(data) {
    if (!validateDataFile('followups.json', data)) throw store.httpError(400, '无效的提醒记录');
    fs.mkdirSync(dataDir, { recursive: true });
    atomicWriteFile(file, JSON.stringify(data, null, 1));
  }
  function candidates() {
    const contacts = new Map(store.listContacts({ includeArchived: false }).filter((c) =>
      !c.archived && (c.status || 'confirmed') === 'confirmed').map((c) => [c.id, c]));
    const memories = store.listMemories({ status: 'confirmed' }).filter((m) =>
      m.status === 'confirmed' && !m.supersededBy && contacts.has(m.contactId));
    const item = (kind, m, extra = {}) => {
      const c = contacts.get(m.contactId);
      return { id: `${kind}:${m.id}`, kind, memoryId: m.id, contactId: c.id, contactName: c.name,
        relation: c.relation || '', content: m.content, date: m.date || '', occasion: m.occasion || '',
        sourceVersion: fingerprint(m), ...extra };
    };
    const items = memories.filter((m) => m.type === 'promise').map((m) => item('promise', m));
    const byId = new Map(memories.filter((m) => m.type === 'gift').map((m) => [m.id, m]));
    for (const gift of store.giftReciprocity()) {
      const m = byId.get(gift.memoryId);
      if (m && m.contactId === gift.contactId) items.push(item('reciprocity', m,
        { date: gift.date, hasActivePlan: Boolean(gift.hasActivePlan) }));
    }
    return items;
  }
  function resolved(item, dispositions, today) {
    const saved = Object.hasOwn(dispositions, item.id) ? dispositions[item.id] : null;
    if (!saved || saved.sourceVersion !== item.sourceVersion || saved.contactId !== item.contactId) {
      return { ...item, status: 'active', until: '', updatedAt: '' };
    }
    const elapsed = saved.status === 'snoozed' && saved.until <= today;
    return { ...item, status: elapsed ? 'active' : saved.status, until: elapsed ? '' : saved.until, updatedAt: saved.updatedAt };
  }
  function listFollowups({ includeHandled = false, today = localToday() } = {}) {
    if (typeof includeHandled !== 'boolean' || !isCalendarDate(today)) throw store.httpError(400, '无效的提醒查询');
    const dispositions = read();
    return candidates().map((item) => resolved(item, dispositions, today))
      .filter((item) => includeHandled || item.status === 'active');
  }
  function updateFollowup(id, patch) {
    if (typeof id !== 'string') throw store.httpError(400, '无效的提醒 ID');
    if (!isRecord(patch) || Object.keys(patch).some((key) => !['status', 'until', 'sourceVersion'].includes(key))
      || !Object.hasOwn(patch, 'status') || !FOLLOWUP_STATUSES.includes(patch.status)
      || !Object.hasOwn(patch, 'sourceVersion') || typeof patch.sourceVersion !== 'string'
      || !/^[a-f0-9]{64}$/.test(patch.sourceVersion)) throw store.httpError(400, '无效的提醒状态或来源版本');
    const { status, sourceVersion, until = '' } = patch;
    const today = localToday();
    if (status === 'snoozed' ? !isCalendarDate(until) || until <= today : until !== '') {
      throw store.httpError(400, '稍后提醒必须指定有效的未来日期，其他状态不能指定日期');
    }
    const dispositions = read();
    const current = candidates().find((item) => item.id === id);
    if (!current) throw store.httpError(404, '提醒不存在或来源已失效');
    if (current.sourceVersion !== sourceVersion) throw store.httpError(409, '来源已修改，请刷新提醒');
    const record = { contactId: current.contactId, memoryId: current.memoryId, kind: current.kind,
      sourceVersion, status, until, updatedAt: new Date().toISOString() };
    // A candidate-derived key, never a caller-supplied object property.
    const next = new Map(Object.entries(dispositions));
    next.set(current.id, record);
    write(Object.fromEntries(next));
    return resolved(current, Object.fromEntries(next), today);
  }
  function remove({ memoryIds = [], contactId } = {}) {
    const data = read();
    const ids = new Set(memoryIds);
    const kept = Object.entries(data).filter(([, record]) => !ids.has(record.memoryId) && record.contactId !== contactId);
    if (kept.length !== Object.keys(data).length) write(Object.fromEntries(kept));
  }
  return { listFollowups, updateFollowup, validate: read, remove };
}
