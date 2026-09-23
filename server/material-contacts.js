// 素材涉及多人侧车存储：material id → [contactId, ...]。
// 素材行的 contactId 字段只存第一人（锚点，rust CLI --contact 有存在性校验，存不了多人），
// 完整多人列表放 JSON 侧车文件，两种存储模式共用同一实现，防双实现漂移。
// 生命周期跟随素材：素材删除（含联系人级联删除）时由 store-facade 负责清理；
// 侧车里指向已删联系人的 id 由展示层按名字查找失败自然过滤。
import fs from 'node:fs';
import { MATERIAL_CONTACTS_PATH, ensureDirs } from './config.js';

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(MATERIAL_CONTACTS_PATH, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeAll(map) {
  ensureDirs();
  const tmp = MATERIAL_CONTACTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1));
  fs.renameSync(tmp, MATERIAL_CONTACTS_PATH);
}

function clean(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))];
}

/** 取素材的多人涉及列表；未登记返回 null（调用方回退 contactId 单人）。 */
export function getMaterialContacts(id) {
  const v = clean(readAll()[String(id)]);
  return v.length ? v : null;
}

/** 全量映射（列表批量化用：一次读文件，避免逐素材 IO）。 */
export function allMaterialContacts() {
  return readAll();
}

/** 覆盖式登记素材涉及人列表。 */
export function setMaterialContacts(id, contactIds) {
  const map = readAll();
  const v = clean(contactIds);
  if (v.length) map[String(id)] = v;
  else delete map[String(id)];
  writeAll(map);
  return { id: String(id), contactIds: v };
}

/** 清理已删素材的登记（不存在的 id 静默忽略）。 */
export function removeMaterialContacts(ids) {
  const map = readAll();
  let changed = false;
  for (const id of ids) {
    if (map[String(id)]) { delete map[String(id)]; changed = true; }
  }
  if (changed) writeAll(map);
}
