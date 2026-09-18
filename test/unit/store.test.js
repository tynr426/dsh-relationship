import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-store-'));
process.env.REL_DATA_DIR = dataDir;
const store = await import('../../server/store.js');

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('createContact validates and normalizes fields', () => {
  assert.throws(() => store.createContact({}), /姓名不能为空/);
  assert.throws(() => store.createContact({ name: '张三', relation: 'boss' }), /relation 必须是/);
  assert.throws(() => store.createContact({ name: '张三', birthday: '2026/01/02' }), /生日格式无效/);
  const c = store.createContact({ name: '张三', relation: 'friend', birthday: '10-02', tags: [' x ', '', 'x', '大学同学'] });
  assert.equal(c.relation, 'friend');
  assert.equal(c.birthday, '10-02');
  assert.deepEqual(c.tags, ['x', '大学同学']);
  assert.equal(c.archived, false);
});

test('updateContact validates patches and archives', () => {
  const c = store.createContact({ name: '老王' });
  assert.throws(() => store.updateContact(c.id, { name: '  ' }), /姓名不能为空/);
  assert.throws(() => store.updateContact(c.id, { relation: 'x' }), /relation 必须是/);
  const updated = store.updateContact(c.id, { birthday: '每年-05-20', notes: '老朋友' });
  assert.equal(updated.birthday, '每年-05-20');
  const archived = store.updateContact(c.id, { archived: true });
  assert.equal(archived.archived, true);
  assert.equal(store.listContacts({ includeArchived: false }).some((x) => x.id === c.id), false);
  assert.equal(store.listContacts().some((x) => x.id === c.id), true);
  assert.throws(() => store.updateContact('c_missing', {}), /联系人不存在/);
});

test('memory state machine: user writes are confirmed, ai writes are pending', () => {
  const c = store.createContact({ name: '小李' });
  const userMem = store.createMemory({ contactId: c.id, type: 'preference', content: '喜欢岩茶', author: 'user' });
  assert.equal(userMem.status, 'confirmed');
  const aiMem = store.createMemory({ contactId: c.id, type: 'taboo', content: '对花生过敏', importance: 3 });
  assert.equal(aiMem.status, 'pending');
  assert.equal(aiMem.author, 'ai');
});

test('createMemory validates type/content/date/importance and contact existence', () => {
  const c = store.createContact({ name: '小陈' });
  assert.throws(() => store.createMemory({ contactId: 'c_missing', type: 'event', content: 'x' }), /联系人不存在/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'secret', content: 'x' }), /type 必须是/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: '   ' }), /内容不能为空/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x'.repeat(501) }), /500 字/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', date: '明天' }), /日期格式无效/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', importance: 9 }), /importance/);
  for (const date of ['2026-10-17', '2026-10', '2026-10-__', '每年-05-20', '10-02', '']) {
    const m = store.createMemory({ contactId: c.id, type: 'event', content: `日期 ${date}`, date });
    assert.equal(m.date, date);
  }
});

test('confirm applies edits, reject/restore roundtrip, only pending can transition', () => {
  const c = store.createContact({ name: '小赵' });
  const m1 = store.createMemory({ contactId: c.id, type: 'event', content: '女儿十月办婚礼', date: '2026-10-__' });
  const m2 = store.createMemory({ contactId: c.id, type: 'event', content: '十月婚礼' });
  store.createMemory({ contactId: c.id, type: 'event', content: '已确认事件', author: 'user' });

  const { confirmed, failed } = store.confirmMemories([m1.id, m2.id, 'm_missing'], { [m1.id]: { content: '女儿 2026 年 10 月办婚礼', importance: 3 } });
  assert.equal(confirmed.length, 2);
  assert.deepEqual(failed, [{ id: 'm_missing', error: '记忆不存在' }]);
  assert.equal(confirmed[0].content, '女儿 2026 年 10 月办婚礼');
  assert.equal(confirmed[0].importance, 3);
  assert.equal(confirmed[0].status, 'confirmed');
  assert.ok(confirmed[0].confirmedAt);

  assert.throws(() => store.rejectMemory(confirmed[0].id), /只有待确认记忆可以驳回/);
  const updated = store.updateMemory(confirmed[0].id, { content: '婚礼定在十月黄金周' });
  assert.equal(updated.content, '婚礼定在十月黄金周');

  const m3 = store.createMemory({ contactId: c.id, type: 'gift', content: '喜欢茶叶' });
  const rejected = store.rejectMemory(m3.id, '不确定');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, '不确定');
  const restored = store.restoreMemory(m3.id);
  assert.equal(restored.status, 'pending');
  assert.throws(() => store.restoreMemory(confirmed[0].id), /只有已驳回记忆可以恢复/);
  assert.throws(() => store.updateMemory(m3.id, { content: 'x' }), /只有已确认记忆/);
});

test('supersede and physical delete', () => {
  const c = store.createContact({ name: '小孙' });
  const c2 = store.createContact({ name: '小孙同学' });
  const keep = store.createMemory({ contactId: c.id, type: 'attribute', content: '在杭州工作', author: 'user' });
  const dup = store.createMemory({ contactId: c.id, type: 'attribute', content: '在杭州上班', author: 'user' });
  const pendingDup = store.createMemory({ contactId: c.id, type: 'attribute', content: '好像在杭州上班' });
  assert.throws(() => store.supersedeMemory(keep.id, keep.id), /不能指向自身/);

  // 校验：不能用 pending 作依据、不能跨联系人、被驳回的记忆无需取代
  assert.throws(() => store.supersedeMemory(dup.id, pendingDup.id), /必须是已确认记忆/);
  const foreign = store.createMemory({ contactId: c2.id, type: 'attribute', content: '在苏州工作', author: 'user' });
  assert.throws(() => store.supersedeMemory(dup.id, foreign.id), /同一联系人/);
  const rejected = store.createMemory({ contactId: c.id, type: 'attribute', content: '已驳回的记忆' });
  store.rejectMemory(rejected.id, '测试驳回');
  assert.throws(() => store.supersedeMemory(rejected.id, keep.id), /无需取代/);

  const superseded = store.supersedeMemory(dup.id, keep.id);
  assert.equal(superseded.supersededBy, keep.id);
  // 依据本身已被取代后不能再用
  assert.throws(() => store.supersedeMemory(pendingDup.id, dup.id), /已被取代/);

  // 被取代的确认记忆退出时间线；被取代的 pending 退出待确认队列
  const tl = store.timeline(c.id);
  assert.equal(tl.memories.some((m) => m.id === dup.id), false);
  assert.equal(tl.memories.some((m) => m.id === keep.id), true);
  store.supersedeMemory(pendingDup.id, keep.id);
  assert.equal(store.overview().pending.some((m) => m.id === pendingDup.id), false);

  const removed = store.deleteMemory(dup.id);
  assert.equal(removed.id, dup.id);
  assert.throws(() => store.deleteMemory(dup.id), /记忆不存在/);
});

test('deleteContact cascades memories physically', () => {
  const c = store.createContact({ name: '小周' });
  store.createMemory({ contactId: c.id, type: 'event', content: '乔迁', author: 'user' });
  store.createMemory({ contactId: c.id, type: 'gift', content: '送过乔迁礼', author: 'user' });
  const { contact, removedMemories } = store.deleteContact(c.id);
  assert.equal(contact.name, '小周');
  assert.equal(removedMemories, 2);
  assert.throws(() => store.deleteContact(c.id), /联系人不存在/);
  assert.equal(store.listMemories({ contactId: c.id }).length, 0);
});

test('timeline orders confirmed memories by fuzzy date descending', () => {
  const c = store.createContact({ name: '小吴' });
  store.createMemory({ contactId: c.id, type: 'event', content: '明年婚礼', date: '2027-05-01', author: 'user' });
  store.createMemory({ contactId: c.id, type: 'event', content: '今年生日宴', date: '2026-09-01', author: 'user' });
  store.createMemory({ contactId: c.id, type: 'gift', content: '没有日期的记忆', author: 'user' });
  store.createMemory({ contactId: c.id, type: 'event', content: '待确认不进时间线' });
  const { contact, memories } = store.timeline(c.id);
  assert.equal(contact.name, '小吴');
  assert.equal(memories.length, 3);
  assert.equal(memories[0].content, '明年婚礼');
  assert.equal(memories[1].content, '今年生日宴');
  assert.equal(memories[2].content, '没有日期的记忆');
});

test('listMemories filters by contact/status/type/query', () => {
  const c1 = store.createContact({ name: '阿大' });
  const c2 = store.createContact({ name: '阿二' });
  store.createMemory({ contactId: c1.id, type: 'preference', content: '喜欢徒步', author: 'user' });
  store.createMemory({ contactId: c1.id, type: 'taboo', content: '不吃辣', author: 'user' });
  store.createMemory({ contactId: c2.id, type: 'preference', content: '喜欢骑行', author: 'user' });
  assert.equal(store.listMemories({ contactId: c1.id }).length, 2);
  assert.equal(store.listMemories({ type: 'preference' }).length, 3); // 岩茶 + 徒步 + 骑行
  assert.equal(store.listMemories({ q: '徒步' }).length, 1);
  const pending = store.listMemories({ status: 'pending' });
  assert.equal(pending.every((m) => m.status === 'pending'), true);
});

test('overview counts, pending queue and upcoming birthdays', () => {
  const ov = store.overview();
  assert.equal(typeof ov.counts.contacts, 'number');
  assert.ok(Array.isArray(ov.pending));
  assert.ok(Array.isArray(ov.upcoming));
  // 队列只收未被取代的 pending（被取代的退出队列，见 supersede 用例）
  assert.equal(store.overview().pending.length, store.listMemories({ status: 'pending' }).filter((m) => !m.supersededBy).length);
});

test('materials save/link and persistence across reload', async () => {
  const c = store.createContact({ name: '持久化' });
  const m = store.createMemory({ contactId: c.id, type: 'event', content: '跨重启记忆', date: '2026-11-01' });
  const mt = store.saveMaterial({ text: '一段聊天记录原文'.repeat(30) });
  assert.equal(mt.kind, 'text');
  assert.ok(mt.excerpt.length <= 120);
  assert.throws(() => store.saveMaterial({ text: '  ' }), /素材内容不能为空/);
  assert.throws(() => store.saveMaterial({ text: 'x', contactId: 'c_none' }), /联系人不存在/);
  store.linkMaterial(mt.id, m.id);
  assert.equal(store.getMaterial(mt.id).extractedMemoryIds[0], m.id);
  assert.throws(() => store.linkMaterial(mt.id, 'm_none'), /记忆不存在/);

  store.flush();
  store.loadStore();
  assert.equal(store.listContacts().some((x) => x.name === '持久化'), true);
  assert.equal(store.getMemory(m.id).content, '跨重启记忆');
  assert.equal(store.getMaterial(mt.id).extractedMemoryIds.length, 1);
});

test('material v2: contactId association, derived status and sourceId auto-link', async () => {
  const c = store.createContact({ name: '素材关联' });
  const mt = store.saveMaterial({ text: '小李今天说女儿十月办婚礼，他还在学潜水。', contactId: c.id });
  assert.equal(mt.contactId, c.id);
  assert.equal(store.materialStatus(mt), 'raw');

  // 通过 sourceId 建记忆 → 自动回写素材提取清单，状态派生为 processed
  const m1 = store.createMemory({ contactId: c.id, type: 'event', content: '女儿十月办婚礼', sourceId: mt.id });
  const m2 = store.createMemory({ contactId: c.id, type: 'preference', content: '在学潜水', sourceId: mt.id });
  assert.deepEqual(store.getMaterial(mt.id).extractedMemoryIds, [m1.id, m2.id]);
  assert.equal(store.materialStatus(store.getMaterial(mt.id)), 'processed');
  assert.equal(store.materialMemories(store.getMaterial(mt.id)).length, 2);

  // 无效 sourceId 静默忽略（素材可能已删）
  const orphan = store.createMemory({ contactId: c.id, type: 'gift', content: '无关记忆', sourceId: 'mt_none' });
  assert.equal(orphan.sourceId, 'mt_none');

  // 列表按状态过滤
  assert.equal(store.listMaterials({ status: 'processed' }).some((x) => x.id === mt.id), true);
  assert.equal(store.listMaterials({ status: 'raw' }).some((x) => x.id === mt.id), false);

  // 删除素材不影响已提取记忆
  store.deleteMaterial(mt.id);
  assert.equal(store.getMemory(m1.id).content, '女儿十月办婚礼');
  assert.equal(store.getMaterial(mt.id), null);
  assert.throws(() => store.deleteMaterial(mt.id), /素材不存在/);
});

test('migration upgrades a v1 database (materials without contactId)', async () => {
  const { migrateDb, CURRENT_SCHEMA_VERSION } = await import('../../server/migrations.js');
  const legacy = {
    schemaVersion: 1,
    contacts: [{ id: 'c_1', name: '旧数据', relation: 'friend', tags: [], createdAt: '', updatedAt: '' }],
    memories: [],
    materials: [{ id: 'mt_1', kind: 'text', text: '旧素材', excerpt: '旧素材', capturedAt: '', extractedMemoryIds: [] }],
  };
  const migrated = migrateDb(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.materials[0].contactId, '');
  assert.equal(migrated.contacts[0].name, '旧数据');
});

test('saidAt v3: 话语时间与事实时间分离（含迁移）', async () => {
  // 合法：模糊日期 + 可选 HH:mm
  const c = store.createContact({ name: '时间维度' });
  const m1 = store.createMemory({ contactId: c.id, type: 'event', content: '明天生日', date: '2026-09-12', saidAt: '2026-09-11 20:07' });
  assert.equal(m1.saidAt, '2026-09-11 20:07');
  const m2 = store.createMemory({ contactId: c.id, type: 'interaction', content: '纯日期话语', saidAt: '2026-09-11' });
  assert.equal(m2.saidAt, '2026-09-11');
  const m3 = store.createMemory({ contactId: c.id, type: 'preference', content: '没有话语时间' });
  assert.equal(m3.saidAt, '');

  // 非法：乱文案、月越界、时越界、分越界
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', saidAt: '昨晚' }), /话语时间/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', saidAt: '2026-13-01 20:00' }), /话语时间/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', saidAt: '2026-09-11 25:00' }), /小时 00-23/);
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', saidAt: '2026-09-11 20:70' }), /分钟 00-59/);

  // 编辑已确认记忆可补话语时间
  store.confirmMemories([m3.id]);
  store.updateMemory(m3.id, { saidAt: '每年-01-01 09:00' });
  assert.equal(store.getMemory(m3.id).saidAt, '每年-01-01 09:00');

  // v1/v2 旧库迁移：记忆补 saidAt 空串
  const { migrateDb, CURRENT_SCHEMA_VERSION } = await import('../../server/migrations.js');
  const v2 = {
    schemaVersion: 2,
    contacts: [{ id: 'c_9', name: '旧', relation: 'friend', tags: [], createdAt: '', updatedAt: '' }],
    memories: [{ id: 'm_9', contactId: 'c_9', type: 'event', content: '旧记忆', importance: 2, author: 'ai', status: 'pending', createdAt: '', updatedAt: '' }],
    materials: [],
  };
  const migrated = migrateDb(v2);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.memories[0].saidAt, '');
});

test('V4: direction/lifespan/occasion 校验、继承与时间线分离', async () => {
  const c = store.createContact({ name: '四维记忆' });

  // direction 枚举校验
  const m1 = store.createMemory({ contactId: c.id, type: 'interaction', content: '我感谢了老师', direction: 'user_to_contact' });
  assert.equal(m1.direction, 'user_to_contact');
  const m2 = store.createMemory({ contactId: c.id, type: 'attribute', content: '老师教小主持' });
  assert.equal(m2.direction, ''); // 不填合法，默认空
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'interaction', content: 'x', direction: 'sideways' }), /direction 必须是/);

  // lifespan：short 合法，非法值拒绝，默认 long
  const m3 = store.createMemory({ contactId: c.id, type: 'event', content: '明天请假', lifespan: 'short' });
  assert.equal(m3.lifespan, 'short');
  assert.equal(store.createMemory({ contactId: c.id, type: 'event', content: '长期事实' }).lifespan, 'long');
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', lifespan: 'medium' }), /lifespan 必须是/);

  // occasion：归一化（大写→小写、空白→下划线），超长拒绝
  const m4 = store.createMemory({ contactId: c.id, type: 'interaction', content: '节日问候', occasion: 'Teacher Day' });
  assert.equal(m4.occasion, 'teacher_day');
  assert.throws(() => store.createMemory({ contactId: c.id, type: 'event', content: 'x', occasion: 'x'.repeat(41) }), /occasion 不能超过/);

  // 素材 occasion 继承：批量提取未显式给 occasion 时继承素材的
  const mt = store.saveMaterial({ text: '教师节聊天记录'.repeat(5), occasion: 'TeacherDay' });
  assert.equal(mt.occasion, 'teacherday');
  const inherited = store.createMemory({ contactId: c.id, type: 'interaction', content: '谢谢老师', sourceId: mt.id });
  assert.equal(inherited.occasion, 'teacherday');
  const explicit = store.createMemory({ contactId: c.id, type: 'interaction', content: '另说', sourceId: mt.id, occasion: 'daily' });
  assert.equal(explicit.occasion, 'daily'); // 显式优先

  // 时间线：short 不进主视图，进 shortItems
  store.confirmMemories([m1.id, m2.id, m3.id, m4.id]);
  const tl = store.timeline(c.id);
  assert.equal(tl.memories.some((m) => m.id === m3.id), false);
  assert.equal(tl.shortItems.some((m) => m.id === m3.id), true);
  assert.equal(tl.memories.length, 3);

  // listMemories 新过滤参数
  assert.equal(store.listMemories({ contactId: c.id, direction: 'user_to_contact', status: 'confirmed' }).length, 1);
  assert.equal(store.listMemories({ contactId: c.id, occasion: 'teacher_day' }).length, 1);
  assert.equal(store.listMemories({ contactId: c.id, lifespan: 'short' }).length, 1);

  // 编辑可改 direction/occasion
  store.updateMemory(m1.id, { direction: 'both', occasion: 'daily' });
  assert.equal(store.getMemory(m1.id).direction, 'both');

  // v3 旧库迁移到 v4
  const { migrateDb, CURRENT_SCHEMA_VERSION } = await import('../../server/migrations.js');
  const v3 = {
    schemaVersion: 3,
    contacts: [{ id: 'c_v3', name: '旧', relation: 'friend', tags: [], createdAt: '', updatedAt: '' }],
    memories: [{ id: 'm_v3', contactId: 'c_v3', type: 'event', content: '旧', importance: 2, saidAt: '', author: 'ai', status: 'pending', createdAt: '', updatedAt: '' }],
    materials: [{ id: 'mt_v3', kind: 'text', text: 't', excerpt: 't', capturedAt: '', extractedMemoryIds: [], contactId: '' }],
  };
  const migrated = migrateDb(v3);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.memories[0].direction, '');
  assert.equal(migrated.memories[0].lifespan, 'long');
  assert.equal(migrated.memories[0].occasion, '');
  assert.equal(migrated.materials[0].occasion, '');
});

test('V5: 礼物计划 CRUD、标已送闭环、回礼派生、台账与时机合并', async () => {
  const { createContact, createPlan, listPlans, updatePlan, deletePlan, getPlan, markPlanSent,
    giftReciprocity, giftLedger, giftOccasions, createMemory, confirmMemories, getMemory } = store;

  const c = createContact({ name: '礼赠王老师', relation: 'other', tags: ['老师'] });

  // CRUD + 校验
  const p = createPlan({ contactId: c.id, occasion: 'Teacher Day', occasionDate: '2099-09-10', idea: '岩茶礼盒', budget: '¥300', productName: '武夷岩茶大红袍礼盒', productPrice: '¥268', productUrl: 'https://e.test/item/1' });
  assert.equal(p.occasion, 'teacher_day');
  assert.equal(p.status, 'idea');
  assert.equal(p.source, 'user');
  assert.equal(p.productName, '武夷岩茶大红袍礼盒');
  assert.throws(() => createPlan({ contactId: c.id, idea: '' }), /礼物想法/);
  assert.throws(() => createPlan({ contactId: c.id, idea: 'ok', occasionDate: '明年' }), /YYYY-MM-DD/);
  assert.throws(() => createPlan({ contactId: c.id, idea: 'ok', status: 'done' }), /status/);
  assert.throws(() => createPlan({ contactId: 'c_missing', idea: 'ok' }), /联系人不存在/);
  assert.throws(() => createPlan({ contactId: c.id, idea: 'ok', productUrl: 'taobao.com/x' }), /http/);
  assert.equal(listPlans({ contactId: c.id }).length, 1);

  // 状态机：idea → decided → sent（sent 记 sentAt）
  updatePlan(p.id, { status: 'decided' });
  assert.equal(getPlan(p.id).status, 'decided');
  const { plan, memory } = markPlanSent(p.id);
  assert.equal(plan.status, 'sent');
  assert.ok(plan.sentAt);
  assert.ok(plan.memoryId);
  // 闭环：自动生成已确认 gift 记忆，方向我→TA；有商品时内容以商品为主
  assert.equal(memory.status, 'confirmed');
  assert.equal(memory.type, 'gift');
  assert.equal(memory.direction, 'user_to_contact');
  assert.equal(memory.occasion, 'teacher_day');
  assert.ok(memory.content.includes('武夷岩茶大红袍礼盒'));
  assert.ok(memory.content.includes('¥268'));
  assert.equal(getMemory(plan.memoryId).id, memory.id);
  // 重复标已送不产生第二条记忆
  const again = markPlanSent(p.id);
  assert.equal(again.memory.id, memory.id);

  // 回礼派生：TA 送我一条（晚于我的送出）→ 待回应；有 active plan 则带标记
  const received = createMemory({ contactId: c.id, type: 'gift', content: '王老师送了曦曦一套绘本', direction: 'contact_to_user', date: '2099-10-01', author: 'user' });
  confirmMemories([received.id]);
  let recip = giftReciprocity();
  const mine = recip.find((r) => r.contactId === c.id);
  assert.ok(mine, '有未回应的收礼');
  assert.equal(mine.memoryId, received.id);
  updatePlan(p.id, { status: 'idea' }); // 恢复一个未送计划
  assert.equal(giftReciprocity().find((r) => r.contactId === c.id).hasActivePlan, true);
  // 我回礼之后 → 消失
  const back = createMemory({ contactId: c.id, type: 'gift', content: '回赠点心', direction: 'user_to_contact', date: '2099-10-15', author: 'user' });
  confirmMemories([back.id]);
  assert.equal(giftReciprocity().find((r) => r.contactId === c.id), undefined);

  // 台账：送出/收到分列
  const ledger = giftLedger();
  assert.ok(ledger.given.some((m) => m.contactId === c.id && m.direction === 'user_to_contact'));
  assert.ok(ledger.received.some((m) => m.id === received.id));
  assert.ok(ledger.given.every((m) => m.contactName));

  // 时机合并：生日窗 + 老师匹配教师节 + 计划日期
  const occ = giftOccasions(3650);
  assert.ok(occ.some((o) => o.contactId === c.id && o.occasion === 'teacher_day'), '老师联系人匹配教师节');
  // 无标签联系人不出教师节
  const c2 = createContact({ name: '普通人', relation: 'friend' });
  assert.equal(giftOccasions(3650).some((o) => o.contactId === c2.id && o.occasion === 'teacher_day'), false);

  // 删除
  deletePlan(p.id);
  assert.equal(getPlan(p.id), null);

  // v4 旧库迁移到 v5：plans 补齐
  const { migrateDb, CURRENT_SCHEMA_VERSION } = await import('../../server/migrations.js');
  const v4 = {
    schemaVersion: 4,
    contacts: [], memories: [], materials: [],
    plans: [{ id: 'gp_old', contactId: 'c_x', occasion: 'Teacher Day', idea: '旧计划', status: 'weird' }],
  };
  const m5 = migrateDb(v4);
  assert.equal(m5.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(m5.plans[0].occasion, 'teacher_day');
  assert.equal(m5.plans[0].status, 'idea');
  assert.equal(m5.plans[0].source, 'user');
});

test('V6: 关系类型注册表 CRUD + 内置保护 + 占用检查 + 动态校验', () => {
  const { listRelationTypes, createRelationType, updateRelationType, deleteRelationType, createContact, updateContact } = store;

  // 播种：内置 6 类
  const initial = listRelationTypes();
  assert.ok(initial.length >= 6);
  assert.ok(initial.every((t) => typeof t.key === 'string' && typeof t.label === 'string'));
  const builtinKeys = initial.filter((t) => t.builtin).map((t) => t.key);
  assert.deepEqual([...builtinKeys].sort(), ['client', 'colleague', 'family', 'friend', 'other', 'partner']);

  // 新增自定义类型
  const t = createRelationType({ key: 'classmate', label: '同学' });
  assert.equal(t.key, 'classmate');
  assert.equal(t.label, '同学');
  assert.equal(t.builtin, false);
  assert.ok(listRelationTypes().some((x) => x.key === 'classmate'));

  // key 格式校验
  assert.throws(() => createRelationType({ key: 'Bad', label: 'x' }), /key 非法/);
  assert.throws(() => createRelationType({ key: '1bad', label: 'x' }), /key 非法/);
  assert.throws(() => createRelationType({ key: 'a'.repeat(33), label: 'x' }), /key 非法/);
  assert.throws(() => createRelationType({ key: 'ok', label: '' }), /显示名不能为空/);

  // 重复 key
  assert.throws(() => createRelationType({ key: 'classmate', label: '同学2' }), /关系类型已存在/);
  assert.throws(() => createRelationType({ key: 'friend', label: '老友' }), /关系类型已存在/);

  // 改名
  const renamed = updateRelationType('classmate', { label: '老同学' });
  assert.equal(renamed.label, '老同学');
  assert.throws(() => updateRelationType('classmate', { label: '' }), /显示名不能为空/);
  assert.throws(() => updateRelationType('nope', { label: 'x' }), /关系类型不存在/);

  // 用自定义类型建联系人
  const c = createContact({ name: '关系类型测试', relation: 'classmate' });
  assert.equal(c.relation, 'classmate');

  // 无效 relation 被拒
  assert.throws(() => createContact({ name: '坏关系', relation: 'boss' }), /relation 必须是/);
  assert.throws(() => updateContact(c.id, { relation: 'boss' }), /relation 必须是/);

  // 占用检查：被引用时不能删除
  assert.throws(() => deleteRelationType('classmate'), /正被 1 个联系人使用/);
  // 改掉联系人的关系后可删
  updateContact(c.id, { relation: 'friend' });
  const removed = deleteRelationType('classmate');
  assert.equal(removed.key, 'classmate');
  assert.equal(listRelationTypes().some((x) => x.key === 'classmate'), false);

  // 内置类型不可删除
  assert.throws(() => deleteRelationType('family'), /内置类型不可删除/);
  assert.throws(() => deleteRelationType('friend'), /内置类型不可删除/);
});

test('V6: 关系类型持久化跨重载', () => {
  const { listRelationTypes, createRelationType, flush, loadStore } = store;
  createRelationType({ key: 'neighbor', label: '邻居' });
  flush();
  loadStore();
  const list = listRelationTypes();
  assert.ok(list.some((t) => t.key === 'neighbor' && t.label === '邻居'));
  // 内置仍在
  assert.ok(list.some((t) => t.key === 'family' && t.builtin));
});
