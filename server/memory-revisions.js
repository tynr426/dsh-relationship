// 先持久化原文日志，主库落盘后才发布历史，避免跨文件中断丢失原文。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DATA_DIR } from './config.js';
import { readJsonFile, atomicWriteFile, syncDirectory } from './json-file.js';
import { httpError } from './store-shared.js';

const FIELDS = ['type', 'content', 'date', 'importance', 'saidAt', 'direction', 'lifespan', 'occasion'];
const empty = () => ({ version: 1, proposals: [], history: [] });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.length > 0;
const stamp = (v) => text(v) && Number.isFinite(Date.parse(v));
const keys = (v, names) => object(v) && Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
const semantic = (m) => Object.fromEntries(FIELDS.map((k) => [k, m[k]]));
const withoutTime = (m) => { const copy = structuredClone(m); delete copy.updatedAt; return copy; };
const sameVersion = (a, b) => Boolean(a && b && isDeepStrictEqual(withoutTime(a), withoutTime(b)));

/** validator 为底层导出的纯 validateMemoryFields(fields)，不得调用真实写入做校验。 */
export function createMemoryRevisions({ store, validateMemoryFields, dataDir = DATA_DIR }) {
  const file = path.join(dataDir, 'memory-revisions.json');
  const journalFile = path.join(dataDir, 'memory-revisions.journal.json');

  function validSnapshot(m) {
    if (!object(m) || !text(m.id) || !text(m.contactId) || m.status !== 'confirmed'
      || m.supersededBy || !stamp(m.createdAt) || !stamp(m.updatedAt)) return false;
    try { validateMemoryFields(semantic(m)); return true; } catch { return false; }
  }
  function validPair(v) {
    if (!text(v.id) || !text(v.memoryId) || !stamp(v.createdAt)
      || !validSnapshot(v.before) || !validSnapshot(v.after)
      || v.before.id !== v.memoryId || v.after.id !== v.memoryId) return false;
    const immutable = (m) => {
      const copy = withoutTime(m);
      for (const k of FIELDS) delete copy[k];
      return copy;
    };
    return isDeepStrictEqual(immutable(v.before), immutable(v.after));
  }
  function validProposal(p) {
    return keys(p, ['id', 'memoryId', 'contactId', 'before', 'after', 'createdAt', 'status'])
      && validPair(p) && p.contactId === p.before.contactId
      && !isDeepStrictEqual(semantic(p.before), semantic(p.after))
      && ['pending', 'confirmed', 'rejected'].includes(p.status);
  }
  function validHistory(h) {
    return keys(h, ['id', 'memoryId', 'before', 'after', 'createdAt', 'source'])
      && validPair(h) && ['user', 'ai-confirmed', 'restore'].includes(h.source);
  }
  function validData(d) {
    return keys(d, ['version', 'proposals', 'history']) && d.version === 1
      && Array.isArray(d.proposals) && d.proposals.every(validProposal)
      && Array.isArray(d.history) && d.history.every(validHistory)
      && new Set([...d.proposals, ...d.history].map((v) => v.id)).size === d.proposals.length + d.history.length;
  }
  function validJournal(j) {
    if (!object(j) || j.version !== 1) return false;
    if (j.kind === 'update') return keys(j, ['version', 'kind', 'history', 'proposalId'])
      && validHistory(j.history) && (j.proposalId === null || text(j.proposalId))
      && (j.history.source === 'ai-confirmed') === Boolean(j.proposalId);
    return keys(j, ['version', 'kind', 'memoryIds', 'contactId']) && j.kind === 'delete'
      && Array.isArray(j.memoryIds) && j.memoryIds.every(text)
      && new Set(j.memoryIds).size === j.memoryIds.length
      && (j.contactId === null || text(j.contactId));
  }
  function read() { return readJsonFile(file, empty(), validData); }
  function readJournal() { return readJsonFile(journalFile, null, validJournal); }
  function write(target, data) {
    fs.mkdirSync(dataDir, { recursive: true });
    atomicWriteFile(target, JSON.stringify(data, null, 1));
  }
  function clearJournal() {
    try { fs.unlinkSync(journalFile); syncDirectory(dataDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  function save(d) {
    if (!validData(d)) throw new Error('修改侧车数据校验失败，未写入');
    write(file, d);
  }
  function nextTime(d) {
    // 同毫秒内编辑再恢复也会使旧提案失效，不仅依靠底层 updatedAt 判断 ABA。
    const last = [...d.proposals, ...d.history].reduce((n, v) => Math.max(n, Date.parse(v.createdAt)), 0);
    return new Date(Math.max(Date.now(), last + 1)).toISOString();
  }
  function finish(d, j, current) {
    if (!d.history.some((h) => h.id === j.history.id)) {
      d.history.push({ ...j.history, after: structuredClone(current) });
      if (j.proposalId) {
        const p = d.proposals.find((p) => p.id === j.proposalId);
        if (!p || p.status !== 'pending') throw httpError(409, '修改提案与恢复日志冲突，已保留日志，请核对数据');
        p.status = 'confirmed';
      }
      save(d);
    }
    clearJournal();
  }
  function clean(d, ids, contactId) {
    const removed = new Set(ids);
    d.proposals = d.proposals.filter((p) => !removed.has(p.memoryId) && p.contactId !== contactId);
    d.history = d.history.filter((h) => !removed.has(h.memoryId) && h.before.contactId !== contactId);
    save(d);
  }
  function recover({ allowConflict = false } = {}) {
    const d = read();
    const j = readJournal();
    if (!j) return d;
    if (j.kind === 'delete') {
      const contactGone = j.contactId && !store.getContact(j.contactId);
      if (contactGone) {
        for (const id of j.memoryIds) {
          const memory = store.getMemory(id);
          if (memory?.contactId === j.contactId) store.deleteMemory(id);
        }
      }
      const gone = j.memoryIds.filter((id) => !store.getMemory(id));
      store.flush();
      if (gone.length || contactGone) clean(d, gone, contactGone ? j.contactId : null);
      clearJournal();
      return d;
    }
    // 侧车已发布而 journal 删除前崩溃：不能重复入历史，也不能重做主库写入。
    const committed = d.history.find((h) => h.id === j.history.id);
    if (committed) {
      if (committed.memoryId !== j.history.memoryId || committed.source !== j.history.source
        || committed.createdAt !== j.history.createdAt || !isDeepStrictEqual(committed.before, j.history.before)
        || !sameVersion(committed.after, j.history.after)) {
        throw httpError(409, '修改历史与恢复日志不一致，已保留日志，请核对数据');
      }
      clearJournal();
      return d;
    }
    const current = structuredClone(store.getMemory(j.history.memoryId));
    if (sameVersion(current, j.history.before)) { store.flush(); clearJournal(); return d; }
    if (!sameVersion(current, j.history.after)) {
      // 冲突只阻止覆盖与成功历史发布，不应阻止查看/驳回旧提案。journal 保留原文供核对。
      if (allowConflict) return d;
      throw httpError(409, '主库与未完成的修改日志冲突，未发布成功历史；日志已保留，请核对数据');
    }
    store.flush();
    finish(d, j, current);
    return d;
  }
  function editable(id) {
    const m = structuredClone(store.getMemory(String(id)));
    if (!m) throw httpError(404, '记忆不存在');
    if (m.status !== 'confirmed') throw httpError(400, `状态为 ${m.status}，只有已确认记忆可以直接编辑或提议修改`);
    if (m.supersededBy) throw httpError(409, '记忆已被取代，不能修改');
    return m;
  }
  function planned(before, patch) {
    if (!object(patch)) throw httpError(400, '修改字段必须是对象');
    const fields = Object.fromEntries(FIELDS.map((k) => [k, patch[k] ?? before[k]]));
    return { ...structuredClone(before), ...validateMemoryFields(fields) };
  }
  function apply(d, before, after, source, proposalId = null) {
    if (source !== 'restore' && isDeepStrictEqual(semantic(before), semantic(after))) return structuredClone(before);
    const h = { id: `mh_${randomUUID()}`, memoryId: before.id, before, after, createdAt: nextTime(d), source };
    const j = { version: 1, kind: 'update', history: h, proposalId };
    if (!validJournal(j)) throw httpError(400, '原记忆字段不符合要求，未修改主库或写入日志，请先核对原始数据');
    // before 落盘失败时绝不碰主库；JSON 下需保留原引用，仅供真实写失败后的回退。
    write(journalFile, j);
    const live = store.getMemory(before.id);
    let current;
    try {
      current = structuredClone(store.updateMemory(before.id, semantic(after), { expected: before }));
      if (!sameVersion(current, after)) throw new Error('主库修改结果与建议不一致');
      store.flush();
    } catch (error) {
      if (error.code === 'MEMORY_CONFLICT') { clearJournal(); throw error; }
      try {
        if (live && store.getMemory(before.id) === live) {
          for (const k of Object.keys(live)) delete live[k];
          Object.assign(live, structuredClone(before));
        } else {
          const actual = store.getMemory(before.id);
          if (sameVersion(actual, after)) store.updateMemory(before.id, semantic(before), { expected: actual });
        }
        store.flush();
        if (!sameVersion(store.getMemory(before.id), before)) throw new Error('主库无法回退');
        clearJournal();
      } catch (rollbackError) {
        throw httpError(503, `修改未确认完成，回退失败，已保留恢复日志；请核对原文：${rollbackError.message}`);
      }
      throw error;
    }
    try { finish(d, j, current); }
    catch (error) {
      // 主库已 durable，不谎报失败且原文没变；保留 journal 供下一次读取/重启核对收尾。
      throw httpError(503, `主库可能已更新，修改历史尚待恢复；请刷新核对，勿重复提交：${error.message}`);
    }
    return structuredClone(current);
  }

  return {
    // loadStore 前先做纯读校验；loadStore 后 recover，不能对尚未加载的 JSON 空内存核对。
    validate() { read(); readJournal(); },
    recover,
    proposeMemoryUpdate(id, patch = {}) {
      const d = recover();
      const before = editable(id);
      const after = planned(before, patch);
      if (isDeepStrictEqual(semantic(before), semantic(after))) throw httpError(400, '建议与原文相同，无需提交修改提案');
      const p = { id: `mr_${randomUUID()}`, memoryId: before.id, contactId: before.contactId, before, after, createdAt: nextTime(d), status: 'pending' };
      // 先 flush 确保提案依赖的原文也持久化，但不修改原文。
      store.flush();
      d.proposals.push(p);
      save(d);
      return structuredClone(p);
    },
    listMemoryRevisions({ memoryId, status } = {}) {
      if (status && !['pending', 'confirmed', 'rejected'].includes(status)) throw httpError(400, '无效的提案状态');
      return structuredClone(recover({ allowConflict: true }).proposals.filter((p) => (!memoryId || p.memoryId === String(memoryId)) && (!status || p.status === status)).reverse());
    },
    confirmMemoryRevision(id) {
      const d = recover();
      const p = d.proposals.find((p) => p.id === String(id));
      if (!p || p.status !== 'pending') throw httpError(409, '提案不存在、已清理或已处理，请刷新待确认队列');
      const current = structuredClone(store.getMemory(p.memoryId));
      if (!current || current.status !== 'confirmed' || current.supersededBy
        || !isDeepStrictEqual(current, p.before)
        || d.history.some((h) => h.memoryId === p.memoryId && h.createdAt > p.createdAt)) {
        throw httpError(409, '原记忆已修改、删除或被取代，旧提案不能覆盖；请驳回后重新提议');
      }
      return apply(d, current, planned(current, p.after), 'ai-confirmed', p.id);
    },
    rejectMemoryRevision(id) {
      const d = recover({ allowConflict: true });
      const p = d.proposals.find((p) => p.id === String(id));
      if (!p || p.status !== 'pending') throw httpError(409, '提案不存在、已清理或已处理，请刷新待确认队列');
      p.status = 'rejected';
      save(d);
      return structuredClone(p);
    },
    updateMemory(id, patch = {}) {
      const d = recover();
      const before = editable(id);
      return apply(d, before, planned(before, patch), 'user');
    },
    memoryHistory(memoryId) {
      return structuredClone(recover().history.filter((h) => h.memoryId === String(memoryId)).reverse());
    },
    restoreMemoryHistory(memoryId, historyId) {
      const d = recover();
      const before = editable(memoryId); // 删除绝不能复活；不恢复身份、来源、status 等字段。
      const h = d.history.find((h) => h.id === String(historyId) && h.memoryId === before.id);
      if (!h) throw httpError(404, '修改历史不存在');
      return apply(d, before, planned(before, semantic(h.before)), 'restore');
    },
    deleteMemory(id) {
      const d = recover();
      id = String(id);
      if (!store.getMemory(id)) throw httpError(404, '记忆不存在');
      write(journalFile, { version: 1, kind: 'delete', memoryIds: [id], contactId: null });
      const removed = structuredClone(store.deleteMemory(id));
      store.flush();
      clean(d, [id], null);
      clearJournal();
      return removed;
    },
    deleteContact(id) {
      const d = recover();
      id = String(id);
      if (!store.getContact(id)) throw httpError(404, '联系人不存在');
      const memoryIds = store.listMemories({ contactId: id }).map((m) => m.id);
      write(journalFile, { version: 1, kind: 'delete', memoryIds, contactId: id });
      const result = store.deleteContact(id);
      store.flush();
      clean(d, memoryIds, id);
      clearJournal();
      return result;
    },
  };
}
