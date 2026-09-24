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
import * as materialContacts from './material-contacts.js';
import * as organizeQuestions from './organize-questions.js';
import * as planSuggestions from './plan-suggestions.js';
import { createMemoryRevisions } from './memory-revisions.js';
import { createFollowups } from './followups.js';
import { createMaterialDelivery } from './material-delivery.js';

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
const revisions = createMemoryRevisions({ store: impl, validateMemoryFields: (fields) => impl.validateMemoryFields(fields) });
const { proposeMemoryUpdate, listMemoryRevisions, confirmMemoryRevision, rejectMemoryRevision,
  memoryHistory, restoreMemoryHistory, updateMemory } = revisions;
const followups = createFollowups({ store: impl });
const { listFollowups, updateFollowup } = followups;
const deliveries = createMaterialDelivery({ store: impl });
const { allMaterialDeliveries, materialDelivery, markMaterialDelivery } = deliveries;

function loadStore() {
  revisions.validate();
  followups.validate();
  deliveries.validate();
  const result = impl.loadStore();
  revisions.recover({ allowConflict: true });
  return result;
}
function overview() {
  // 恢复 journal 后再计算主库统计，保证历史/提案与主库处于同一已确认状态。
  const pendingRevisions = listMemoryRevisions({ status: 'pending' });
  const result = impl.overview();
  return { ...result, pendingRevisions, counts: { ...result.counts, pendingRevisions: pendingRevisions.length } };
}
function counts() { return overview().counts; }

// ---------- 素材整理报告（facade 层，两种模式共用侧车存储） ----------
/** 保存素材：多人素材（contactIds 数组）的完整列表写侧车，contactId 字段只存第一人（锚点）。
 *  空数组 = 显式清除登记（回到自动识别）；校验（存在性/上限）由 impl 层抛错。 */
function saveMaterial(payload = {}) {
  const mt = impl.saveMaterial(payload);
  if (Array.isArray(payload.contactIds)) {
    materialContacts.setMaterialContacts(mt.id, payload.contactIds);
  }
  return mt;
}
/** 素材涉及人列表：优先侧车多人登记，回退 contactId 单人。 */
function materialContactIds(mt) {
  const extra = materialContacts.getMaterialContacts(mt.id);
  if (extra) return extra;
  return mt.contactId ? [mt.contactId] : [];
}
/** 全量多人登记映射（列表批量化用：一次读侧车文件，避免逐素材 IO）。 */
function allMaterialContacts() {
  return materialContacts.allMaterialContacts();
}
/** 提交/覆盖素材整理报告（AI 整理完经 material_report 工具调用）。
 *  报告落库即整理完成，同时清掉该素材的待答反问（问题已无意义）。 */
function saveMaterialReport(id, report) {
  if (!impl.getMaterial(String(id))) throw impl.httpError(404, '素材不存在');
  organizeQuestions.removeOrganizeQuestions([String(id)]);
  return materialReports.setMaterialReport(String(id), report);
}
function materialReport(id) {
  return materialReports.getMaterialReport(String(id));
}
function allMaterialReports() {
  return materialReports.allMaterialReports();
}
// ---------- 整理反问（facade 层，侧车存储；工作台素材卡横幅的数据源） ----------
function saveOrganizeQuestion(id, question, options) {
  if (!impl.getMaterial(String(id))) throw impl.httpError(404, '素材不存在');
  return organizeQuestions.setOrganizeQuestion(String(id), question, options);
}
function organizeQuestion(id) {
  return organizeQuestions.getOrganizeQuestion(String(id));
}
function allOrganizeQuestions() {
  return organizeQuestions.allOrganizeQuestions();
}
function clearOrganizeQuestion(id) {
  organizeQuestions.removeOrganizeQuestions([String(id)]);
}
// 送达标记：嵌入模式发送成功 / 独立模式复制成功由前端上报（复制不算送达，status 不变）。
// 标记不清除反问——清除只由 AI done、整理报告提交、用户手动放弃（DELETE）触发。
function markOrganizeQuestionSent(id) {
  if (!impl.getMaterial(String(id))) throw impl.httpError(404, '素材不存在');
  return organizeQuestions.markOrganizeQuestionSent(String(id));
}
function markOrganizeQuestionCopied(id) {
  if (!impl.getMaterial(String(id))) throw impl.httpError(404, '素材不存在');
  return organizeQuestions.markOrganizeQuestionCopied(String(id));
}
// ---------- 计划建议关联（facade 层，侧车存储） ----------
/** 登记建议关联：planId 围绕 basedOnPlanId 出的主意（gift_plan_add 带 basedOnPlanId 时调用）。 */
function linkPlanSuggestion(planId, basedOnPlanId) {
  planSuggestions.linkPlan(String(planId), String(basedOnPlanId));
}
/** 某计划卡的建议关联（basedOnPlanId），无关联返回 ''。 */
function planSuggestionBase(planId) {
  return planSuggestions.planBase(String(planId));
}
/** 全量关联映射（/api/plans 与 /api/gifts/occasions 批量附着用）。 */
function allPlanBases() {
  return planSuggestions.allPlanBases();
}
/** 围绕某计划出主意产生的全部建议卡。 */
function plansBasedOn(basePlanId) {
  const base = String(basePlanId);
  return impl.listPlans({}).filter((p) => planSuggestions.planBase(p.id) === base);
}
// 计划删除时清侧车：删建议卡清自身关联；删原计划解除其名下建议的关联（建议卡保留）
function deletePlan(id) {
  const removed = impl.deletePlan(id);
  planSuggestions.removeLinks([String(id)]);
  planSuggestions.clearBaseReferences(String(id));
  return removed;
}
function deleteMemory(id) {
  followups.validate();
  const removed = revisions.deleteMemory(id);
  followups.remove({ memoryIds: [String(id)] });
  return removed;
}
// 报告与反问随素材清理：删素材必清；联系人级联删素材时（rust 模式）也清，
// JSON 模式联系人删除不动素材（既有行为），报告随素材保留。
function deleteMaterial(id) {
  deliveries.validate();
  const removed = impl.deleteMaterial(id);
  materialReports.removeMaterialReports([String(id)]);
  materialContacts.removeMaterialContacts([String(id)]);
  organizeQuestions.removeOrganizeQuestions([String(id)]);
  deliveries.remove([String(id)]);
  return removed;
}
function deleteContact(id) {
  id = String(id);
  followups.validate();
  deliveries.validate();
  const materialIds = impl.listMaterials({}).filter((mt) => mt.contactId === id).map((mt) => mt.id);
  const result = revisions.deleteContact(id);
  followups.remove({ contactId: id });
  const gone = materialIds.filter((mid) => !impl.getMaterial(mid));
  materialReports.removeMaterialReports(gone);
  materialContacts.removeMaterialContacts(gone);
  organizeQuestions.removeOrganizeQuestions(gone);
  deliveries.remove(gone);
  return result;
}

export default {
  ...impl,
  loadStore,
  overview,
  counts,
  proposeMemoryUpdate,
  listMemoryRevisions,
  confirmMemoryRevision,
  rejectMemoryRevision,
  memoryHistory,
  restoreMemoryHistory,
  updateMemory,
  deleteMemory,
  listFollowups,
  updateFollowup,
  allMaterialDeliveries,
  materialDelivery,
  markMaterialDelivery,
  saveMaterial,
  materialContactIds,
  allMaterialContacts,
  saveMaterialReport,
  materialReport,
  allMaterialReports,
  saveOrganizeQuestion,
  organizeQuestion,
  allOrganizeQuestions,
  clearOrganizeQuestion,
  markOrganizeQuestionSent,
  markOrganizeQuestionCopied,
  linkPlanSuggestion,
  planSuggestionBase,
  allPlanBases,
  plansBasedOn,
  deletePlan,
  deleteMaterial,
  deleteContact,
};
