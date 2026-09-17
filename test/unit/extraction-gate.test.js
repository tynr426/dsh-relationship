// 提取质量闸门测试：素材提取（带 sourceId）必须逐条通过闸门——
// sourceQuote 原话摘录逐字校验、saidAt 时间戳命中（含位置就近）、
// interaction/gift/promise 必带 direction、内容查重。
// 固定输入 → 固定拒绝/放行：回放 2026-09-17 教师节素材审计中出现过的问题模式
// （时间戳挪用、限定词丢失、方向缺失、重复登记），素材内容已脱敏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-gate-'));
process.env.REL_DATA_DIR = dataDir;
const tools = await import('../../server/tools.js');
const store = await import('../../server/store.js');

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

// 脱敏后的教师节聊天素材：中文时间戳逐消息分布、第三方转述、限定词、多方向往来
const CHAT = [
  '2026年09月10日 20:03 妈妈：方老师说周五想给孩子们办个小庆祝',
  '2026年09月10日 20:11 我：感觉孩子特别喜欢方老师',
  '2026年09月10日 21:53 妈妈：方老师可能对芒果过敏，我没细问',
  '2026年09月10日 22:00 我：那教师节礼物避开芒果吧',
].join('\n');

let contact;
let materialId;

test.before(async () => {
  contact = store.createContact({ name: '方老师', relation: 'colleague', tags: ['老师'] });
  const saved = await tools.executeTool('material_save', { text: CHAT, contactId: contact.id, occasion: 'teacher_day' });
  materialId = saved.material.id;
});

test('闸门：时间戳挪用与编造一律拒绝（位置就近校验）', async () => {
  const r = await tools.executeTool('memory_batch_add', { entries: [
    // 编造：23:30 不在素材时间戳里（原话在 20:03 消息，锚点即 20:03）
    { contactId: contact.id, type: 'event', content: '方老师说周五想给孩子们办个小庆祝', sourceId: materialId, sourceQuote: '方老师说周五想给孩子们办个小庆祝', saidAt: '2026-09-10 23:30' },
    // 挪用：原话在 21:53 消息里，saidAt 却写 20:03（审计中 m_a507ce68 的模式）
    { contactId: contact.id, type: 'taboo', content: '方老师可能对芒果过敏', importance: 3, sourceId: materialId, sourceQuote: '方老师可能对芒果过敏，我没细问', saidAt: '2026-09-10 20:03' },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.created.length, 0);
  assert.deepEqual(r.failed.map((f) => f.code), ['SAIDAT_MISPLACED', 'SAIDAT_MISPLACED']);
  assert.match(r.failed[0].error, /2026-09-10 20:03/);
  assert.match(r.failed[1].error, /2026-09-10 21:53/);
});

test('闸门：interaction/gift/promise 缺 direction 拒绝', async () => {
  const r = await tools.executeTool('memory_batch_add', { entries: [
    { contactId: contact.id, type: 'interaction', content: '我提议教师节礼物避开芒果', sourceId: materialId, sourceQuote: '那教师节礼物避开芒果吧', saidAt: '2026-09-10 22:00' },
    { contactId: contact.id, type: 'promise', content: '说好周五一起庆祝', sourceId: materialId, sourceQuote: '方老师说周五想给孩子们办个小庆祝', saidAt: '2026-09-10 20:03' },
  ] });
  assert.equal(r.created.length, 0);
  assert.deepEqual(r.failed.map((f) => f.code), ['MISSING_DIRECTION', 'MISSING_DIRECTION']);
});

test('闸门：sourceQuote 必填且逐字出自原文，素材含时间戳时 saidAt 必填', async () => {
  const r = await tools.executeTool('memory_batch_add', { entries: [
    // 缺摘录
    { contactId: contact.id, type: 'preference', content: '孩子喜欢方老师', sourceId: materialId, saidAt: '2026-09-10 20:11' },
    // 摘录不在原文（把「可能」升级成确定并复述，即限定词丢失 + 凭印象改写）
    { contactId: contact.id, type: 'taboo', content: '方老师对芒果过敏是确定的', sourceId: materialId, sourceQuote: '方老师对芒果过敏是确定的', saidAt: '2026-09-10 21:53' },
    // 有摘录但 saidAt 留空
    { contactId: contact.id, type: 'attribute', content: '方老师想给孩子们办庆祝', sourceId: materialId, sourceQuote: '想给孩子们办个小庆祝', saidAt: '' },
  ] });
  assert.equal(r.created.length, 0);
  assert.deepEqual(r.failed.map((f) => f.code), ['MISSING_QUOTE', 'QUOTE_MISMATCH', 'SAIDAT_REQUIRED']);
});

test('闸门：素材不存在与摘录超长', async () => {
  const ghost = await tools.executeTool('memory_add', { contactId: contact.id, type: 'event', content: '幽灵素材里的事', sourceId: 'mt_none', sourceQuote: '任意', saidAt: '2026-09-10 20:03' });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.code, 'MATERIAL_NOT_FOUND');

  const long = await tools.executeTool('memory_add', { contactId: contact.id, type: 'event', content: '打包记忆', sourceId: materialId, sourceQuote: 'x'.repeat(201), saidAt: '2026-09-10 20:03' });
  assert.equal(long.code, 'QUOTE_TOO_LONG');
});

test('放行：合格条目全部落库为 pending，sourceQuote 持久化、occasion 继承素材', async () => {
  const r = await tools.executeTool('memory_batch_add', { entries: [
    { contactId: contact.id, type: 'event', content: '方老师说周五想给孩子们办个小庆祝', direction: 'contact_to_user', sourceId: materialId, sourceQuote: '方老师说周五想给孩子们办个小庆祝', saidAt: '2026-09-10 20:03' },
    { contactId: contact.id, type: 'preference', content: '感觉孩子特别喜欢方老师', sourceId: materialId, sourceQuote: '感觉孩子特别喜欢方老师', saidAt: '2026-09-10 20:11' },
    { contactId: contact.id, type: 'taboo', content: '方老师可能对芒果过敏', importance: 3, sourceId: materialId, sourceQuote: '方老师可能对芒果过敏', saidAt: '2026-09-10 21:53' },
    { contactId: contact.id, type: 'interaction', content: '我提议教师节礼物避开芒果', direction: 'user_to_contact', sourceId: materialId, sourceQuote: '那教师节礼物避开芒果吧', saidAt: '2026-09-10 22:00' },
  ] });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.created.length, 4);
  for (const m of r.created) {
    assert.equal(m.status, 'pending');
    assert.equal(m.sourceQuote.length > 0, true);
    assert.equal(m.occasion, 'teacher_day', '未显式给 occasion 时继承素材场景');
  }
  // 中文时间戳规范化为 YYYY-MM-DD HH:mm
  assert.equal(r.created[0].saidAt, '2026-09-10 20:03');
  assert.equal(r.created[2].importance, 3);
  assert.equal(store.materialStatus(store.getMaterial(materialId)), 'processed');
});

test('闸门：查重——已确认记忆不重复登记，同批重复也拒', async () => {
  const target = store.listMemories({ contactId: contact.id }).find((m) => m.content === '方老师说周五想给孩子们办个小庆祝');
  store.confirmMemories([target.id]);

  const again = await tools.executeTool('memory_add', { contactId: contact.id, type: 'event', content: '方老师说周五想给孩子们办个小庆祝', direction: 'contact_to_user', sourceId: materialId, sourceQuote: '方老师说周五想给孩子们办个小庆祝', saidAt: '2026-09-10 20:03' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'DUPLICATE_CONTENT');
  assert.match(again.error, /已确认/);

  const batch = await tools.executeTool('memory_batch_add', { entries: [
    { contactId: contact.id, type: 'attribute', content: '妈妈没细问过敏的事', sourceId: materialId, sourceQuote: '我没细问', saidAt: '2026-09-10 21:53' },
    { contactId: contact.id, type: 'attribute', content: '妈妈没细问过敏的事', sourceId: materialId, sourceQuote: '我没细问', saidAt: '2026-09-10 21:53' },
  ] });
  assert.equal(batch.created.length, 1);
  assert.equal(batch.failed.length, 1);
  assert.equal(batch.failed[0].index, 1);
  assert.equal(batch.failed[0].code, 'DUPLICATE_CONTENT');
  assert.match(batch.failed[0].error, /本批前一条/);
});

test('闸门边界：摘录在首个时间戳之前（无锚点）只做集合命中；裸时分素材按时间命中；无时间戳素材 saidAt 须空', async () => {
  const c2 = store.createContact({ name: '边界联系人' });

  // 摘录位于所有时间戳之前：锚点不存在，退化为集合命中
  const m1 = await tools.executeTool('material_save', { text: '开场寒暄。\n2026-09-12 10:00 她说想学潜水', contactId: c2.id });
  const ghostTime = await tools.executeTool('memory_add', { contactId: c2.id, type: 'preference', content: '开场寒暄', sourceId: m1.material.id, sourceQuote: '开场寒暄', saidAt: '2026-09-12 11:00' });
  assert.equal(ghostTime.code, 'SAIDAT_NOT_IN_MATERIAL');

  // 裸时分素材：saidAt 的时间部分须命中
  const m2 = await tools.executeTool('material_save', { text: '20:30 她提到想学潜水\n21:10 又说周六要加班', contactId: c2.id });
  const bareOk = await tools.executeTool('memory_add', { contactId: c2.id, type: 'preference', content: '想学潜水', sourceId: m2.material.id, sourceQuote: '她提到想学潜水', saidAt: '2026-09-12 20:30' });
  assert.equal(bareOk.ok, true, JSON.stringify(bareOk));
  const bareBad = await tools.executeTool('memory_add', { contactId: c2.id, type: 'event', content: '周六加班', lifespan: 'short', sourceId: m2.material.id, sourceQuote: '又说周六要加班', saidAt: '2026-09-12 22:00' });
  assert.equal(bareBad.code, 'SAIDAT_NOT_IN_MATERIAL');

  // 无时间戳素材：saidAt 必须留空
  const m3 = await tools.executeTool('material_save', { text: '口述：她老家在成都，养了一只猫。', contactId: c2.id });
  const invented = await tools.executeTool('memory_add', { contactId: c2.id, type: 'attribute', content: '老家在成都', sourceId: m3.material.id, sourceQuote: '她老家在成都', saidAt: '2026-09-12 09:00' });
  assert.equal(invented.code, 'SAIDAT_NOT_IN_MATERIAL');
  const honest = await tools.executeTool('memory_add', { contactId: c2.id, type: 'attribute', content: '老家在成都', sourceId: m3.material.id, sourceQuote: '她老家在成都' });
  assert.equal(honest.ok, true);
});

test('会话直录（无 sourceId）：不做素材闸门，但方向校验仍生效', async () => {
  const c3 = store.createContact({ name: '会话联系人' });
  const noDir = await tools.executeTool('memory_add', { contactId: c3.id, type: 'interaction', content: '约了下周三吃饭' });
  assert.equal(noDir.ok, false);
  assert.equal(noDir.code, 'MISSING_DIRECTION');

  const ok = await tools.executeTool('memory_add', { contactId: c3.id, type: 'interaction', content: '约了下周三吃饭', direction: 'both', lifespan: 'short', saidAt: '2026-09-17 10:00' });
  assert.equal(ok.ok, true);
  assert.equal(ok.memory.status, 'pending');
  assert.equal(ok.memory.sourceQuote, '');
});
