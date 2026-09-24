// Successful copying/sending is dispatch metadata, never an organization report.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonFile, atomicWriteFile, validateDataFile } from './json-file.js';

export function createMaterialDelivery({ store, dataDir = DATA_DIR }) {
  const file = path.join(dataDir, 'material-delivery.json');
  const read = () => readJsonFile(file, {}, (v) => validateDataFile('material-delivery.json', v));
  function write(data) {
    if (!validateDataFile('material-delivery.json', data)) throw store.httpError(400, '无效的素材发送记录');
    fs.mkdirSync(dataDir, { recursive: true });
    atomicWriteFile(file, JSON.stringify(data, null, 1));
  }
  function materialDelivery(id) {
    const data = read();
    return Object.hasOwn(data, id) ? data[id] : null;
  }
  function markMaterialDelivery(id, status) {
    if (!['copied', 'sent'].includes(status)) throw store.httpError(400, '发送状态必须是 copied 或 sent');
    if (typeof id !== 'string') throw store.httpError(400, '无效的素材 ID');
    const data = read();
    if (!store.getMaterial(id)) throw store.httpError(404, '素材不存在');
    const previous = Object.hasOwn(data, id) ? data[id] : { copiedAt: '', sentAt: '' };
    const record = { ...previous, [status === 'copied' ? 'copiedAt' : 'sentAt']: new Date().toISOString() };
    const next = new Map(Object.entries(data));
    next.set(id, record);
    write(Object.fromEntries(next));
    return record;
  }
  function remove(ids) {
    const data = read();
    const removed = new Set(ids);
    const kept = Object.entries(data).filter(([id]) => !removed.has(id));
    if (kept.length !== Object.keys(data).length) write(Object.fromEntries(kept));
  }
  return { allMaterialDeliveries: read, materialDelivery, markMaterialDelivery, validate: read, remove };
}
