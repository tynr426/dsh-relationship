// 整理反问侧车存储：material id → { question, options: [{label, command}], askedAt }。
// AI 整理中确需用户拍板时经 organize_question 工具登记，工作台素材卡实时显示
// 「AI 在等你回答」横幅——反问只落在对话里会让工作台用户无感知（一直没反应）。
// 生命周期跟随素材：素材删除（含联系人级联删除）与整理报告提交时由 store-facade 清理。
import fs from 'node:fs';
import { ORGANIZE_QUESTIONS_PATH, ensureDirs } from './config.js';

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(ORGANIZE_QUESTIONS_PATH, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeAll(map) {
  ensureDirs();
  const tmp = ORGANIZE_QUESTIONS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1));
  fs.renameSync(tmp, ORGANIZE_QUESTIONS_PATH);
}

/** 取单条待答反问；无返回 null。 */
export function getOrganizeQuestion(id) {
  const entry = readAll()[String(id)];
  return entry && entry.question ? { question: entry.question, options: entry.options || [], askedAt: entry.askedAt || '' } : null;
}

/** 全量反问映射（素材列表批量化用：一次读文件，避免逐素材 IO）。 */
export function allOrganizeQuestions() {
  return readAll();
}

/** 覆盖式登记反问。options 为 [{label, command}]，command 是自足作答指令
 *  （发到任意关系记忆会话都能据此继续，不依赖原提问会话上下文）。 */
export function setOrganizeQuestion(id, question, options) {
  const map = readAll();
  const entry = {
    question: String(question),
    options: options.map((o) => ({ label: String(o.label), command: String(o.command) })),
    askedAt: new Date().toISOString(),
  };
  map[String(id)] = entry;
  writeAll(map);
  return { id: String(id), ...entry };
}

/** 清理已答/已删素材的反问登记（不存在的 id 静默忽略）。 */
export function removeOrganizeQuestions(ids) {
  const map = readAll();
  let changed = false;
  for (const id of ids) {
    if (map[String(id)]) { delete map[String(id)]; changed = true; }
  }
  if (changed) writeAll(map);
}
