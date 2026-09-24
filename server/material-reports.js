// 素材整理报告侧车存储：material id → { report, reportedAt }。
// 报告是展示性元数据（AI 整理完提交、工作台素材卡展示），不参与 rust/json 的
// 关系数据——统一放一个 JSON 侧车文件，两种存储模式共用同一实现，防双实现漂移。
// 生命周期跟随素材：素材删除（含联系人级联删除）时由 store-facade 负责清理。
import { MATERIAL_REPORTS_PATH, ensureDirs } from './config.js';
import { readJsonFile, validateDataFile, atomicWriteFile } from './json-file.js';

function readAll() {
  return readJsonFile(MATERIAL_REPORTS_PATH, {}, (v) => validateDataFile('material-reports.json', v));
}

function writeAll(map) {
  ensureDirs();
  atomicWriteFile(MATERIAL_REPORTS_PATH, JSON.stringify(map, null, 1));
}

/** 取单条报告；无报告返回 null。 */
export function getMaterialReport(id) {
  const entry = readAll()[String(id)];
  return entry && entry.report ? { report: entry.report, reportedAt: entry.reportedAt || '' } : null;
}

/** 全量报告映射（列表批量化用：一次读文件，避免逐素材 IO）。 */
export function allMaterialReports() {
  return readAll();
}

/** 覆盖式提交报告，返回 { id, report, reportedAt }。 */
export function setMaterialReport(id, report) {
  const map = readAll();
  const entry = { report: String(report), reportedAt: new Date().toISOString() };
  map[String(id)] = entry;
  writeAll(map);
  return { id: String(id), ...entry };
}

/** 清理已删素材的报告（不存在的 id 静默忽略）。 */
export function removeMaterialReports(ids) {
  const map = readAll();
  let changed = false;
  for (const id of ids) {
    if (map[String(id)]) { delete map[String(id)]; changed = true; }
  }
  if (changed) writeAll(map);
}
