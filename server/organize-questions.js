// 整理反问侧车存储：material id → { question, options: [{label, command}], askedAt,
// status: 'pending' | 'sent', sentAt, copiedAt }。
// AI 整理中确需用户拍板时经 organize_question 工具登记，工作台素材卡实时显示
// 「AI 在等你回答」横幅——反问只落在对话里会让工作台用户无感知（一直没反应）。
// 生命周期跟随素材：素材删除（含联系人级联删除）与整理报告提交时由 store-facade 清理。
// 送达语义：嵌入模式发送成功标 status='sent'；独立模式复制只记 copiedAt——复制不算送达。
// 标记本身不清除反问：权威清除只有 AI done=true、整理报告提交、用户手动放弃（DELETE），
// 发送/复制失败一律保留横幅待重试。
import { ORGANIZE_QUESTIONS_PATH, ensureDirs } from './config.js';
import { readJsonFile, validateDataFile, atomicWriteFile } from './json-file.js';

function readAll() {
  return readJsonFile(ORGANIZE_QUESTIONS_PATH, {}, (v) => validateDataFile('organize-questions.json', v));
}

function writeAll(map) {
  ensureDirs();
  atomicWriteFile(ORGANIZE_QUESTIONS_PATH, JSON.stringify(map, null, 1));
}

/** 取单条待答反问；无返回 null。 */
export function getOrganizeQuestion(id) {
  const entry = readAll()[String(id)];
  return entry && entry.question ? {
    question: entry.question,
    options: entry.options || [],
    askedAt: entry.askedAt || '',
    status: entry.status || 'pending',
    sentAt: entry.sentAt || '',
    copiedAt: entry.copiedAt || '',
  } : null;
}

/** 全量反问映射（素材列表批量化用：一次读文件，避免逐素材 IO）。 */
export function allOrganizeQuestions() {
  return readAll();
}

/** 覆盖式登记反问（新反问取代旧反问：AI 换问题时旧的已无意义）。options 为
 *  [{label, command}]，command 是自足作答指令（发到任意关系记忆会话都能据此
 *  继续，不依赖原提问会话上下文——登记里不记来源会话，靠自足指令兜底路由）。 */
export function setOrganizeQuestion(id, question, options) {
  const map = readAll();
  const entry = {
    question: String(question),
    options: options.map((o) => ({ label: String(o.label), command: String(o.command) })),
    askedAt: new Date().toISOString(),
    status: 'pending',
    sentAt: '',
    copiedAt: '',
  };
  map[String(id)] = entry;
  writeAll(map);
  return { id: String(id), ...entry };
}

/** 标记作答已送达宿主会话（嵌入模式发送成功）。复制不算送达，独立模式走 copied。
 *  登记不存在时静默忽略（AI done/报告可能已先清除，送达标记失去意义）。 */
export function markOrganizeQuestionSent(id) {
  return updateEntry(id, (entry) => {
    entry.status = 'sent';
    entry.sentAt = new Date().toISOString();
  });
}

/** 记录复制作答指令的时间（独立模式）。status 保持 pending——粘贴成功与否工作台
 *  无从得知，清除交给 AI done / 报告 / 用户手动放弃。 */
export function markOrganizeQuestionCopied(id) {
  return updateEntry(id, (entry) => {
    entry.copiedAt = new Date().toISOString();
  });
}

function updateEntry(id, mutate) {
  const map = readAll();
  const entry = map[String(id)];
  if (!entry) return null;
  mutate(entry);
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
