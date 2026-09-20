// 计划建议关联侧车存储：planId → { basedOnPlanId, linkedAt }。
// AI「围绕已有计划出主意」新建的方案卡经 gift_plan_add 带 basedOnPlanId 登记关联，
// 工作台据此渲染「围绕某计划」徽标与一键删除这批建议的入口。
// 侧车方案不动 rust 计划表 schema；生命周期跟随计划：计划删除时清自身关联，
// 原计划被删时其名下建议的关联一并解除（建议卡保留，变为独立卡）。
import fs from 'node:fs';
import { PLAN_SUGGESTIONS_PATH, ensureDirs } from './config.js';

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(PLAN_SUGGESTIONS_PATH, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeAll(map) {
  ensureDirs();
  const tmp = PLAN_SUGGESTIONS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1));
  fs.renameSync(tmp, PLAN_SUGGESTIONS_PATH);
}

/** 取某计划卡的建议关联（basedOnPlanId）；无关联返回 ''。 */
export function planBase(planId) {
  const entry = readAll()[String(planId)];
  return entry?.basedOnPlanId || '';
}

/** 全量关联映射（列表批量化用：一次读文件，避免逐计划 IO）。 */
export function allPlanBases() {
  const map = {};
  for (const [id, entry] of Object.entries(readAll())) {
    if (entry?.basedOnPlanId) map[id] = entry.basedOnPlanId;
  }
  return map;
}

/** 登记建议关联：planId 是新建议卡，basedOnPlanId 是它围绕的原计划。 */
export function linkPlan(planId, basedOnPlanId) {
  const map = readAll();
  map[String(planId)] = { basedOnPlanId: String(basedOnPlanId), linkedAt: new Date().toISOString() };
  writeAll(map);
}

/** 清理计划的自身关联（计划被删时调用）。 */
export function removeLinks(planIds) {
  const map = readAll();
  let changed = false;
  for (const id of planIds) {
    if (map[String(id)]) { delete map[String(id)]; changed = true; }
  }
  if (changed) writeAll(map);
}

/** 解除指向某原计划的全部关联（原计划被删时调用，建议卡降级为独立卡）。 */
export function clearBaseReferences(basePlanId) {
  const map = readAll();
  let changed = false;
  for (const [id, entry] of Object.entries(map)) {
    if (entry?.basedOnPlanId === String(basePlanId)) { delete map[id]; changed = true; }
  }
  if (changed) writeAll(map);
}
