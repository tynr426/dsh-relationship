// 存储实现选择器：决定工作台数据落在 SQLite（store-rust.js + relstore CLI）还是 JSON 文件（store.js）。
// 顶层 await 动态 import，消费方统一 `import store from './store-facade.js'` 后照常 store.xxx() 调用。
//
// 选择规则（按优先级）：
// 1. 显式环境变量 REL_STORE=rust / json —— 最高优先，测试与排障用
// 2. 数据目录存在完整建库的 rel.db（>4KB，schema 就位，允许暂无数据）→ 自动用 rust（迁移/清空重录都算）
// 3. 其余情况 → json（默认，行为与历史版本完全一致）
//
// 注意：检测只在进程启动时做一次；回滚 json 的办法是 REL_STORE=json 重启（rel.db 原样保留）。
import { existsSync, statSync } from 'node:fs';
import { relstoreAvailable, relstoreDbPath, run as cli } from './relstore-bridge.js';
import * as materialReports from './material-reports.js';

let mode = process.env.REL_STORE;
if (mode !== 'rust' && mode !== 'json') {
  mode = 'json';
  try {
    const dbPath = relstoreDbPath();
    // 判据：rel.db 存在且是完整建的库（schema 就位后 >40KB；0 字节视为误触残留）。
    // 清空重来的库（schema 在、数据为空）也算 rust——用户清库是为了在 SQLite 里重新录入，
    // 若判回 json，第一批数据会写进 JSON 文件，永远回不到 SQLite。
    const size = existsSync(dbPath) ? statSync(dbPath).size : 0;
    if (size > 4096 && relstoreAvailable()) {
      mode = 'rust';
    }
  } catch {
    // rel.db 存在但不可用：宁可响亮失败也不悄悄回 json（json 模式会重建空文件，掩盖问题）
    throw new Error('检测到 rel.db 存在但 relstore CLI 读取失败；请检查 relstore 二进制或显式指定 REL_STORE=json');
  }
}

export const STORE_MODE = mode;
const impl = await import(mode === 'rust' ? './store-rust.js' : './store.js');

// ---------- 素材整理报告（facade 层，两种模式共用侧车存储） ----------
/** 提交/覆盖素材整理报告（AI 整理完经 material_report 工具调用）。 */
function saveMaterialReport(id, report) {
  if (!impl.getMaterial(String(id))) throw impl.httpError(404, '素材不存在');
  return materialReports.setMaterialReport(String(id), report);
}
function materialReport(id) {
  return materialReports.getMaterialReport(String(id));
}
function allMaterialReports() {
  return materialReports.allMaterialReports();
}
// 报告随素材清理：删素材必清；联系人级联删素材时（rust 模式）也清，
// JSON 模式联系人删除不动素材（既有行为），报告随素材保留。
function deleteMaterial(id) {
  const removed = impl.deleteMaterial(id);
  materialReports.removeMaterialReports([String(id)]);
  return removed;
}
function deleteContact(id) {
  const materialIds = impl.listMaterials({}).filter((mt) => mt.contactId === id).map((mt) => mt.id);
  const result = impl.deleteContact(id);
  materialReports.removeMaterialReports(materialIds.filter((mid) => !impl.getMaterial(mid)));
  return result;
}

export default {
  ...impl,
  saveMaterialReport,
  materialReport,
  allMaterialReports,
  deleteMaterial,
  deleteContact,
};
