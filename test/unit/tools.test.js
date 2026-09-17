import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-tools-'));
process.env.REL_DATA_DIR = dataDir;
const tools = await import('../../server/tools.js');
const store = await import('../../server/store.js');

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('tool registry exposes the documented tool set', () => {
  const names = tools.TOOL_DEFS.map((d) => d.function.name);
  assert.deepEqual(new Set(names), new Set(Object.keys(tools.TOOL_CN)));
  for (const def of tools.TOOL_DEFS) {
    assert.equal(def.type, 'function');
    assert.ok(def.function.description, `${def.function.name} 缺少描述`);
  }
});

test('contact_add rejects duplicates until confirmed via contact_search', async () => {
  const first = await tools.executeTool('contact_add', { name: '老李', relation: 'client' });
  assert.equal(first.ok, true);
  const dup = await tools.executeTool('contact_add', { name: '老李', relation: 'client' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'DUPLICATE_NAME');
  assert.match(dup.error, /contact_search/);
  const found = await tools.executeTool('contact_search', { query: '老李' });
  assert.equal(found.ok, true);
  assert.equal(found.matches.length, 1);
  const none = await tools.executeTool('contact_search', { query: '不存在的人' });
  assert.equal(none.ok, true);
  assert.equal(none.matches.length, 0);
});

test('memory_add always creates pending and memory_confirm transitions', async () => {
  const c = store.createContact({ name: '工具小李' });
  const added = await tools.executeTool('memory_add', { contactId: c.id, type: 'event', content: '十月办婚礼', date: '2026-10-__' });
  assert.equal(added.ok, true);
  assert.equal(added.memory.status, 'pending');
  assert.ok(added.提示.includes('待确认'));

  const early = await tools.executeTool('memory_confirm', { ids: [added.memory.id] });
  assert.equal(early.ok, true);
  assert.equal(early.confirmed[0].status, 'confirmed');

  const again = await tools.executeTool('memory_confirm', { ids: [added.memory.id] });
  assert.equal(again.ok, false);
  assert.equal(again.confirmed.length, 0);
  assert.match(again.failed[0].error, /只有待确认记忆/);
});

test('memory_batch_add validates per entry and reports failures', async () => {
  const c = store.createContact({ name: '批量' });
  const result = await tools.executeTool('memory_batch_add', { entries: [
    { contactId: c.id, type: 'taboo', content: '对花生过敏', importance: 3 },
    { contactId: c.id, type: 'event', content: '' },
    { contactId: 'c_none', type: 'event', content: '孤儿记忆' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].status, 'pending');
  assert.equal(result.failed.length, 2);
  assert.equal(await tools.executeTool('memory_batch_add', { entries: [] }).then((r) => r.ok), false);
});

test('memory_search returns only confirmed memories', async () => {
  const c = store.createContact({ name: '检索' });
  const pending = await tools.executeTool('memory_add', { contactId: c.id, type: 'preference', content: '想学潜水' });
  store.createMemory({ contactId: c.id, type: 'preference', content: '喜欢潜水', author: 'user' });
  const result = await tools.executeTool('memory_search', { contactId: c.id, query: '潜水' });
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.memories[0].content, '喜欢潜水');
  assert.equal(result.memories.some((m) => m.id === pending.memory.id), false);
});

test('timeline_get and error paths', async () => {
  const c = store.createContact({ name: '时间线' });
  store.createMemory({ contactId: c.id, type: 'event', content: '入职十周年', date: '2026-12-01', author: 'user' });
  const tl = await tools.executeTool('timeline_get', { contactId: c.id });
  assert.equal(tl.ok, true);
  assert.equal(tl.contact.name, '时间线');
  assert.equal(tl.memories.length, 1);

  const missing = await tools.executeTool('timeline_get', { contactId: 'c_none' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  const unknown = await tools.executeTool('no_such_tool', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知工具/);
  const empty = await tools.executeTool('contact_search', { query: '' });
  assert.equal(empty.ok, false);
});

test('contact_update via tool validates and broadcasts harmlessly', async () => {
  const c = store.createContact({ name: '更新' });
  const bad = await tools.executeTool('contact_update', { id: c.id, relation: 'x' });
  assert.equal(bad.ok, false);
  const good = await tools.executeTool('contact_update', { id: c.id, birthday: '02-14', tags: ['客户'] });
  assert.equal(good.ok, true);
  assert.equal(good.contact.birthday, '02-14');
});

test('material tools: save → list raw → get → batch extract with sourceId → processed', async () => {
  const c = store.createContact({ name: '素材工具' });
  const saved = await tools.executeTool('material_save', { text: '和小李吃饭。他说女儿十月办婚礼，自己在学潜水，还抱怨最近腰疼。', contactId: c.id });
  assert.equal(saved.ok, true);
  const materialId = saved.material.id;

  const listed = await tools.executeTool('material_list', { status: 'raw' });
  assert.equal(listed.materials.some((mt) => mt.id === materialId), true);
  assert.equal(listed.materials.find((mt) => mt.id === materialId).contactName, '素材工具');

  const full = await tools.executeTool('material_get', { id: materialId });
  assert.equal(full.ok, true);
  assert.match(full.material.text, /女儿十月办婚礼/);
  assert.equal(full.material.status, 'raw');

  const missing = await tools.executeTool('material_get', { id: 'mt_none' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  const empty = await tools.executeTool('material_save', { text: '   ' });
  assert.equal(empty.ok, false);

  const batch = await tools.executeTool('memory_batch_add', { entries: [
    { contactId: c.id, type: 'event', content: '女儿十月办婚礼', date: '2026-10-__', saidAt: '2026-09-11 20:03', sourceId: materialId },
    { contactId: c.id, type: 'preference', content: '在学潜水', saidAt: '2026-09-11 20:15', sourceId: materialId },
    { contactId: c.id, type: 'attribute', content: '最近腰疼', sourceId: materialId },
  ] });
  assert.equal(batch.ok, true);
  assert.equal(batch.created.length, 3);
  assert.equal(batch.created[0].saidAt, '2026-09-11 20:03');
  assert.equal(batch.created[1].saidAt, '2026-09-11 20:15');
  assert.equal(batch.created[2].saidAt, '');
  assert.ok(batch.提示.includes('待确认'));

  // V4：direction/occasion 标注 + memory_search 过滤
  await tools.executeTool('memory_confirm', { ids: [batch.created[0].id] });
  await tools.executeTool('memory_update', { id: batch.created[0].id, direction: 'user_to_contact', occasion: 'Wedding' });
  assert.equal((await tools.executeTool('memory_search', { contactId: c.id, direction: 'user_to_contact' })).memories.length, 1);
  assert.equal((await tools.executeTool('memory_search', { contactId: c.id, occasion: 'wedding' })).memories.length, 1);
  assert.equal((await tools.executeTool('memory_search', { contactId: c.id, direction: 'contact_to_user' })).memories.length, 0);
  // 素材级 occasion：material_save 带场合 → 归一化存储
  const occSaved = await tools.executeTool('material_save', { text: '生日聚餐的聊天记录', occasion: 'Birthday' });
  assert.equal(occSaved.material.occasion, 'birthday');

  const after = await tools.executeTool('material_get', { id: materialId });
  assert.equal(after.material.status, 'processed');
  assert.equal(after.material.extracted.length, 3);

  const processed = await tools.executeTool('material_list', { status: 'processed' });
  assert.equal(processed.materials.some((mt) => mt.id === materialId), true);

  // V5：AI 礼物计划工具（source=ai、列、改、删）
  const planAdd = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '小主持课体验卡（她非常喜欢小主持）', occasion: 'birthday' });
  assert.equal(planAdd.ok, true);
  assert.equal(planAdd.plan.source, 'ai');
  assert.equal(planAdd.plan.status, 'idea');
  const planList = await tools.executeTool('gift_plan_list', { contactId: c.id });
  assert.equal(planList.plans.length, 1);
  assert.equal(planList.plans[0].contactName, c.name);
  await tools.executeTool('gift_plan_update', { id: planAdd.plan.id, status: 'decided' });
  assert.equal((await tools.executeTool('gift_plan_list', { status: 'decided' })).plans.length, 1);
  await tools.executeTool('gift_plan_delete', { id: planAdd.plan.id });
  assert.equal((await tools.executeTool('gift_plan_list', {})).plans.length, 0);
  assert.equal(await tools.executeTool('material_list', { status: 'raw' }).then((r) => r.materials.some((mt) => mt.id === materialId)), false);
});
