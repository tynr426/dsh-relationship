import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-tools-'));
process.env.REL_DATA_DIR = dataDir;
const tools = await import('../../server/tools.js');
const store = await import('../../server/store.js');
// 计划建议关联（basedOnPlanId）是 facade 层侧车，不在 JSON store 上；与 tools 共用同一 DATA_DIR
const facade = (await import('../../server/store-facade.js')).default;

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('AI 计划仅允许 idea/decided，完成记录不阻挡新主意', async () => {
  const c = store.createContact({ name: 'AI 完成权限测试' });
  try {
    const plan = store.createPlan({ contactId: c.id, idea: '周末散步' });
    for (const status of ['sent', 'done', 'unknown']) {
      for (const name of ['gift_plan_add', 'gift_plan_update']) {
        const result = await tools.executeTool(name, { id: plan.id, contactId: c.id, idea: '不应写入', status });
        assert.equal(result.ok, false);
        assert.equal(result.status, 400);
      }
    }
    assert.equal(store.listPlans({ contactId: c.id }).length, 1);
    assert.equal(store.getPlan(plan.id).idea, '周末散步');
    assert.equal(store.getPlan(plan.id).status, 'idea');
    assert.equal((await tools.executeTool('gift_plan_update', { id: plan.id, status: 'decided' })).plan.status, 'decided');
    for (const name of ['gift_plan_add', 'gift_plan_update']) {
      assert.deepEqual(tools.TOOL_DEFS.find((d) => d.function.name === name).function.parameters.properties.status.enum, ['idea', 'decided']);
    }
    store.markPlanDone(plan.id);
    const next = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '周末散步', status: 'decided' });
    assert.equal(next.ok, true);
    assert.equal(next.plan.status, 'decided');
    assert.equal(next.plan.source, 'ai');
    assert.equal((await tools.executeTool('gift_plan_update', { id: plan.id, status: 'idea' })).status, 400);
    assert.equal((await tools.executeTool('gift_plan_list', { status: 'done' })).plans.some((p) => p.id === plan.id), true);
    store.updatePlan(next.plan.id, { status: 'sent' });
    assert.equal((await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '周末散步' })).ok, true);
    assert.equal(store.listMemories({ contactId: c.id }).length, 0);
  } finally {
    for (const p of store.listPlans({ contactId: c.id })) store.deletePlan(p.id);
    store.deleteContact(c.id);
  }
});

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
  // AI 通道新建一律进待确认队列（拍板收录是 GUI 动作）
  assert.equal(first.contact.status, 'pending');
  assert.ok(first.提示.includes('待确认联系人'));
  const dup = await tools.executeTool('contact_add', { name: '老李', relation: 'client' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'DUPLICATE_NAME');
  assert.match(dup.error, /contact_search/);
  const found = await tools.executeTool('contact_search', { query: '老李' });
  assert.equal(found.ok, true);
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].status, 'pending', 'contact_search 须如实标注 pending');
  const none = await tools.executeTool('contact_search', { query: '不存在的人' });
  assert.equal(none.ok, true);
  assert.equal(none.matches.length, 0);
});

test('AI 新建联系人进待确认队列：默认列表不可见、可挂记忆、拍板收录后转正', async () => {
  const added = await tools.executeTool('contact_add', { name: '熊猫', relation: 'friend', tags: ['朋友', '中转站'] });
  assert.equal(added.ok, true);
  const id = added.contact.id;

  // pending 联系人不进用户可见列表（联系人页/概览/生日提醒），显式 includePending 才纳入
  assert.equal(store.listContacts().some((c) => c.id === id), false);
  assert.ok(store.listContacts({ includePending: true }).some((c) => c.id === id));

  // 整理流程不等收录：pending 联系人可正常挂待确认记忆
  const mem = await tools.executeTool('memory_add', { contactId: id, type: 'attribute', content: '经营 GPT 中转站' });
  assert.equal(mem.ok, true);
  assert.equal(mem.memory.contactName, '熊猫');

  // pending_summary 同时汇报待确认联系人与记忆
  const summary = await tools.executeTool('pending_summary', {});
  assert.ok(summary.pendingContacts.some((c) => c.id === id && c.name === '熊猫'));
  assert.ok(summary.提示.includes('待确认联系人'));

  // overview：pendingContacts 列表与计数
  const ov = store.overview();
  assert.ok(ov.pendingContacts.some((c) => c.id === id));
  assert.ok(ov.counts.pendingContacts >= 1);

  // 拍板收录（store 层 = 工作台路径）→ 转正进入默认列表；重复确认拒绝
  const confirmed = store.confirmContact(id);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(store.listContacts().some((c) => c.id === id));
  assert.throws(() => store.confirmContact(id), /只有待确认联系人/);

  // 拒绝 = 删除：pending 联系人连同其待确认记忆一并清除
  const p2 = await tools.executeTool('contact_add', { name: '会被拒绝的人', relation: 'friend' });
  await tools.executeTool('memory_add', { contactId: p2.contact.id, type: 'attribute', content: '将被级联删除的属性' });
  const { removedMemories } = store.deleteContact(p2.contact.id);
  assert.equal(removedMemories, 1);
  assert.equal(store.getContact(p2.contact.id), null);
});

test('memory_add always creates pending; confirm is UI-only (AI channel refuses)', async () => {
  const c = store.createContact({ name: '工具小李' });
  const added = await tools.executeTool('memory_add', { contactId: c.id, type: 'event', content: '十月办婚礼', date: '2026-10-__' });
  assert.equal(added.ok, true);
  assert.equal(added.memory.status, 'pending');
  assert.ok(added.提示.includes('待确认'));

  // P0 安全闭环：AI 通道的 memory_confirm 一律拒绝（确认只能走工作台 /api/memories/confirm）
  const refused = await tools.executeTool('memory_confirm', { ids: [added.memory.id] });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.match(refused.error, /拍板/);

  // 确认经由界面路径（store 层，等价 /api/memories/confirm）正常生效
  const [confirmed] = store.confirmMemories([added.memory.id]).confirmed;
  assert.equal(confirmed.status, 'confirmed');

  // UI 确认后 AI 通道重复确认仍被拒绝
  const again = await tools.executeTool('memory_confirm', { ids: [added.memory.id] });
  assert.equal(again.ok, false);
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

test('material tools: save → list raw → get → batch extract with sourceId/Quote → processed', async () => {
  const c = store.createContact({ name: '素材工具' });
  const saved = await tools.executeTool('material_save', { text: '2026-09-11 20:03 和小李吃饭。\n2026-09-11 20:15 他说女儿十月办婚礼，自己在学潜水。\n2026-09-11 20:40 还抱怨最近腰疼。', contactId: c.id });
  assert.equal(saved.ok, true);
  const materialId = saved.material.id;

  const listed = await tools.executeTool('material_list', { status: 'raw' });
  assert.equal(listed.materials.some((mt) => mt.id === materialId), true);
  assert.equal(listed.materials.find((mt) => mt.id === materialId).contactName, '素材工具');

  const full = await tools.executeTool('material_get', { id: materialId });
  assert.equal(full.ok, true);
  assert.match(full.material.text, /女儿十月办婚礼/);
  assert.equal(full.material.status, 'raw');
  // P0 相对时间锚点：material_get 响应必须带当天日期
  assert.match(full.today, /^\d{4}-\d{2}-\d{2}（星期.）$/);

  const missing = await tools.executeTool('material_get', { id: 'mt_none' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  const empty = await tools.executeTool('material_save', { text: '   ' });
  assert.equal(empty.ok, false);

  const batch = await tools.executeTool('memory_batch_add', { entries: [
    { contactId: c.id, type: 'event', content: '女儿十月办婚礼', date: '2026-10-__', saidAt: '2026-09-11 20:15', sourceId: materialId, sourceQuote: '他说女儿十月办婚礼' },
    { contactId: c.id, type: 'preference', content: '在学潜水', saidAt: '2026-09-11 20:15', sourceId: materialId, sourceQuote: '自己在学潜水' },
    { contactId: c.id, type: 'attribute', content: '最近腰疼', saidAt: '2026-09-11 20:40', sourceId: materialId, sourceQuote: '还抱怨最近腰疼' },
  ] });
  assert.equal(batch.ok, true);
  assert.equal(batch.created.length, 3);
  assert.equal(batch.created[0].saidAt, '2026-09-11 20:15');
  assert.equal(batch.created[0].sourceQuote, '他说女儿十月办婚礼');
  assert.equal(batch.created[1].saidAt, '2026-09-11 20:15');
  assert.equal(batch.created[2].saidAt, '2026-09-11 20:40');
  assert.ok(batch.提示.includes('待确认'));

  // V4：direction/occasion 标注 + memory_search 过滤（确认走 store 层 = UI 路径）
  store.confirmMemories([batch.created[0].id]);
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
  // 查重闸门：同联系人相同想法（忽略空白差异）拒绝，防止 AI 出主意重复建卡
  const dupSame = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '小主持课体验卡（她非常喜欢小主持）' });
  assert.equal(dupSame.ok, false);
  assert.equal(dupSame.status, 409);
  const dupSpaces = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '小主持课体验卡 （她非常喜欢小主持）  ' });
  assert.equal(dupSpaces.ok, false, '空白差异不算新想法');
  const dupOther = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '完全不同的另一个方案' });
  assert.equal(dupOther.ok, true, '不同想法正常建卡');
  const planList = await tools.executeTool('gift_plan_list', { contactId: c.id });
  assert.equal(planList.plans.length, 2);
  assert.equal(planList.plans[0].contactName, c.name);
  await tools.executeTool('gift_plan_update', { id: planAdd.plan.id, status: 'decided' });
  assert.equal((await tools.executeTool('gift_plan_list', { status: 'decided' })).plans.length, 1);
  await tools.executeTool('gift_plan_delete', { id: planAdd.plan.id });
  await tools.executeTool('gift_plan_delete', { id: dupOther.plan.id });
  assert.equal((await tools.executeTool('gift_plan_list', {})).plans.length, 0);

  // basedOnPlanId：围绕已有计划出主意的新方案卡关联原计划（工作台「删这批建议」的数据源）
  const basePlan = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '中秋节伴手礼' });
  const sug1 = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '手作茶点礼盒', basedOnPlanId: basePlan.plan.id });
  const sug2 = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '手写感谢卡', basedOnPlanId: basePlan.plan.id });
  assert.equal(sug1.ok, true);
  assert.equal(sug2.ok, true);
  assert.equal(sug1.plan.basedOnPlanId, undefined, 'basedOnPlanId 是关联元数据，不得泄进计划实体');
  assert.equal(facade.planSuggestionBase(sug1.plan.id), basePlan.plan.id);
  assert.equal(facade.plansBasedOn(basePlan.plan.id).length, 2);
  const ghostBase = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '另一个方案', basedOnPlanId: 'gp_ghost' });
  assert.equal(ghostBase.ok, false);
  assert.equal(ghostBase.status, 404);
  // 删原计划：建议卡保留、关联解除（降级为独立卡）
  await tools.executeTool('gift_plan_delete', { id: basePlan.plan.id });
  assert.equal(facade.planSuggestionBase(sug1.plan.id), '');
  assert.equal((await tools.executeTool('gift_plan_list', {})).plans.length, 2);
  await tools.executeTool('gift_plan_delete', { id: sug1.plan.id });
  await tools.executeTool('gift_plan_delete', { id: sug2.plan.id });
  assert.equal((await tools.executeTool('gift_plan_list', {})).plans.length, 0);
  assert.equal(await tools.executeTool('material_list', { status: 'raw' }).then((r) => r.materials.some((mt) => mt.id === materialId)), false);
});

test('material_report 落库整理报告，material_get 随身携带', async () => {
  const c = store.createContact({ name: '报告小李' });
  const saved = await tools.executeTool('material_save', { text: '2026-09-11 20:30 小李说他女儿十月办婚礼', contactId: c.id });
  const mtId = saved.material.id;

  const empty = await tools.executeTool('material_report', { id: mtId, report: '  ' });
  assert.equal(empty.ok, false);
  const notFound = await tools.executeTool('material_report', { id: 'mt_none', report: 'x' });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.status, 404);

  const okRes = await tools.executeTool('material_report', { id: mtId, report: '拆出 1 条：女儿十月办婚礼；已有记忆覆盖 0 条；无冲突' });
  assert.equal(okRes.ok, true);
  assert.ok(okRes.report.reportedAt, '报告应带提交时间');
  assert.ok(okRes.提示.includes('工作台'));

  const got = await tools.executeTool('material_get', { id: mtId });
  assert.equal(got.material.report, '拆出 1 条：女儿十月办婚礼；已有记忆覆盖 0 条；无冲突');
  const listed = await tools.executeTool('material_list', {});
  assert.equal(listed.materials.find((mt) => mt.id === mtId).hasReport, true);

  // 二次提交覆盖旧报告（AI 重新整理同一素材）
  const again = await tools.executeTool('material_report', { id: mtId, report: '重新整理：无新增事实' });
  assert.equal(again.ok, true);
  assert.equal((await tools.executeTool('material_get', { id: mtId })).material.report, '重新整理：无新增事实');
});

test('pending_summary 供会话开始提醒：只读、计数与队列一致、不含被取代项', async () => {
  const c = store.createContact({ name: '待确认小李' });
  const baseline = (await tools.executeTool('pending_summary', {})).pendingCount;
  await tools.executeTool('memory_add', { contactId: c.id, type: 'event', content: 'pending_summary 测试事实' });
  const after = await tools.executeTool('pending_summary', {});
  assert.equal(after.ok, true);
  assert.equal(after.pendingCount, baseline + 1);
  assert.ok(after.提示.includes('回工作台确认'));
  assert.ok(after.items.some((m) => m.content === 'pending_summary 测试事实' && m.contactName === '待确认小李'));

  // 被取代的 pending 不再进入提醒（与待确认队列口径一致）
  const keep = store.createMemory({ contactId: c.id, type: 'event', content: '取代依据事实', author: 'user' });
  const target = store.listMemories({ contactId: c.id, status: 'pending' }).find((m) => m.content === 'pending_summary 测试事实');
  store.supersedeMemory(target.id, keep.id);
  const afterSupersede = await tools.executeTool('pending_summary', {});
  assert.equal(afterSupersede.pendingCount, baseline);
});

test('relation_type_list 只读工具返回当前可用类型', async () => {
  const r = await tools.executeTool('relation_type_list', {});
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.relationTypes));
  assert.ok(r.relationTypes.length >= 6);
  const keys = r.relationTypes.map((t) => t.key);
  assert.ok(keys.includes('family'));
  assert.ok(keys.includes('friend'));
  assert.ok(r.提示.includes('contact_add'));
});

test('contact_add 用自定义关系类型（先注册后使用）', async () => {
  store.createRelationType({ key: 'mentor', label: '导师' });
  const added = await tools.executeTool('contact_add', { name: '导师测试', relation: 'mentor' });
  assert.equal(added.ok, true);
  assert.equal(added.contact.relation, 'mentor');
  // 无效 relation 仍被拒
  const bad = await tools.executeTool('contact_add', { name: '坏关系', relation: 'boss' });
  assert.equal(bad.ok, false);
});
