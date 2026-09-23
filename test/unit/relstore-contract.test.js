// relstore 契约测试：对真实 relstore 二进制跑一遍完整业务流（联系人→记忆→素材→计划→台账）。
// 用独立临时库（RELSTORE_DB / REL_DATA_DIR），不碰用户数据；无二进制时整文件跳过（家法同款）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const candidates = [
  process.env.RELSTORE_BIN,
  path.join(homedir(), '.openclaw-shared', 'bin', 'relstore'),
  path.join(process.cwd(), 'rust', 'relstore', 'target', 'release', 'relstore'),
].filter(Boolean);
const bin = candidates.find((p) => fs.existsSync(p));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-relstore-'));
process.env.REL_DATA_DIR = dataDir;
process.env.RELSTORE_DB = path.join(dataDir, 'rel.db');
process.env.REL_STORE = 'rust';
if (bin) process.env.RELSTORE_BIN = bin;

const hasBinary = Boolean(bin);
const store = hasBinary ? (await import('../../server/store-facade.js')).default : null;

test('relstore 二进制缺失时所有契约用例跳过', (t) => {
  t.skip(!hasBinary, '未找到 relstore 二进制；先 npm run build:relstore');
});

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

(hasBinary ? test : test.skip)('relstore CLI 可执行且建库 0600', () => {
  execFileSync(bin, ['contact', 'list', '--json', '--db', process.env.RELSTORE_DB]);
  const stat = fs.statSync(process.env.RELSTORE_DB);
  assert.equal(stat.mode & 0o777, 0o600, '库文件应为 0600');
});

(hasBinary ? test : test.skip)('多人素材 contactIds 经 rust 往返：字段存第一人锚点，完整列表走侧车', () => {
  const c1 = store.createContact({ name: '多人甲', relation: 'friend' });
  const c2 = store.createContact({ name: '多人乙', relation: 'friend' });
  const mt = store.saveMaterial({ text: '中秋给多人甲送了岩茶，给多人乙送了月饼', contactIds: [c1.id, c2.id] });
  assert.equal(mt.contactId, c1.id, 'contactId 字段=第一人锚点（rust CLI 校验存在性）');
  const back = store.getMaterial(mt.id);
  assert.equal(back.contactId, c1.id, '锚点经真实二进制往返不丢');
  assert.deepEqual(store.materialContactIds(back), [c1.id, c2.id], '侧车保留完整多人列表');
  assert.throws(() => store.saveMaterial({ text: '坏素材', contactIds: [c1.id, 'c_none'] }), /联系人不存在/);
});

(hasBinary ? test : test.skip)('联系人增改查与校验', () => {
  const c = store.createContact({ name: '段老师', relation: 'colleague', tags: ['大学同学', '高数老师'], birthday: '每年-09-12' });
  assert.ok(c.id.startsWith('c_'));
  assert.deepEqual(c.tags, ['大学同学', '高数老师']);
  const u = store.updateContact(c.id, { notes: '班主任', tags: ['大学同学'] });
  assert.equal(u.notes, '班主任');
  assert.equal(u.tags.length, 1);
  assert.throws(() => store.createContact({ name: '张三', relation: 'boss' }), /relation 必须是/);
  const list = store.listContacts({ includeArchived: false });
  assert.ok(list.some((x) => x.id === c.id));
});

(hasBinary ? test : test.skip)('联系人待确认队列（status 列契约）：pending 默认不可见、拍板转正、级联拒绝', () => {
  const p = store.createContact({ name: '待确认熊猫', relation: 'friend', status: 'pending', tags: ['朋友'] });
  assert.equal(p.status, 'pending');
  assert.ok(p.id.startsWith('c_'));

  // 默认列表不含 pending（fail-safe：不漏进联系人页/概览/派生）；includePending 显式纳入
  assert.equal(store.listContacts().some((c) => c.id === p.id), false);
  assert.ok(store.listContacts({ includePending: true }).some((c) => c.id === p.id));

  // getContact 可见 pending：整理流程不等收录继续拆条挂记忆
  const m = store.createMemory({ contactId: p.id, type: 'attribute', content: '经营 GPT 中转站', author: 'ai' });
  assert.equal(m.status, 'pending');

  // overview：pendingContacts 列表与计数
  const o = store.overview();
  assert.ok(o.pendingContacts.some((c) => c.id === p.id));
  assert.ok(o.counts.pendingContacts >= 1);

  // 手动建档（无 status）恒 confirmed；非法 status 拒绝
  const manual = store.createContact({ name: '手动老王' });
  assert.equal(manual.status, 'confirmed');
  assert.throws(() => store.createContact({ name: '坏状态', status: 'maybe' }), /status 必须是/);

  // 拍板收录 → 转正进入默认列表；重复确认拒绝
  const cc = store.confirmContact(p.id);
  assert.equal(cc.status, 'confirmed');
  assert.ok(store.listContacts().some((c) => c.id === p.id));
  assert.throws(() => store.confirmContact(p.id), /只有待确认联系人/);

  // 拒绝 = 删除：级联清掉挂在该 pending 联系人上的记忆
  const p2 = store.createContact({ name: '被拒绝的熊猫', status: 'pending' });
  store.createMemory({ contactId: p2.id, type: 'attribute', content: '将被级联删除', author: 'ai' });
  const { removedMemories } = store.deleteContact(p2.id);
  assert.equal(removedMemories, 1);
});

(hasBinary ? test : test.skip)('记忆全生命周期（含场景继承/确认/驳回/恢复/取代/sourceQuote 溯源）', () => {
  const c = store.createContact({ name: '曦曦' });
  const mt = store.saveMaterial({ text: '聊天：曦曦想要一套绘本', contactId: c.id, occasion: 'birthday' });
  const m = store.createMemory({ contactId: c.id, type: 'gift', content: '想要绘本', author: 'ai', sourceId: mt.id, sourceQuote: '曦曦想要一套绘本' });
  assert.equal(m.status, 'pending');
  assert.equal(m.occasion, 'birthday', '未显式给 occasion 时继承素材场景');
  assert.equal(m.sourceQuote, '曦曦想要一套绘本', 'source_quote 列经 CLI 落库并回读');
  assert.equal(store.materialStatus(store.getMaterial(mt.id)), 'processed');

  const r = store.rejectMemory(m.id, '提取质量差');
  assert.equal(r.status, 'rejected');
  const restored = store.restoreMemory(m.id);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.reason, '');

  const u = store.createMemory({ contactId: c.id, type: 'event', content: '期末考试', date: '2026-06-30', author: 'user' });
  assert.equal(u.status, 'confirmed');
  assert.throws(() => store.updateMemory(m.id, { content: 'x' }), /只有已确认记忆可以直接编辑/);
  const edited = store.updateMemory(u.id, { content: '期末考试（6月30日）' });
  assert.equal(edited.content, '期末考试（6月30日）');

  const keep = store.createMemory({ contactId: c.id, type: 'event', content: '期末考试', author: 'user' });
  const sup = store.supersedeMemory(u.id, keep.id);
  assert.equal(sup.supersededBy, keep.id);

  // 取代校验与 JSON 版一致（契约锁定）：不能用 pending 作依据、不能跨联系人、依据已被取代不能再用
  const c2 = store.createContact({ name: '曦曦同学' });
  const foreign = store.createMemory({ contactId: c2.id, type: 'event', content: '别家的事实', author: 'user' });
  assert.throws(() => store.supersedeMemory(u.id, foreign.id), /同一联系人/);
  const pend = store.createMemory({ contactId: c.id, type: 'event', content: '另一条待确认' });
  assert.throws(() => store.supersedeMemory(u.id, pend.id), /必须是已确认记忆/);
  assert.throws(() => store.supersedeMemory(pend.id, u.id), /已被取代/);

  // 被取代的确认记忆退出时间线；被取代的 pending 退出待确认队列
  const tl = store.timeline(c.id);
  assert.equal(tl.memories.some((x) => x.id === u.id), false, '被取代的确认记忆应退出时间线');
  assert.ok(tl.memories.some((x) => x.id === keep.id));
  const dupPending = store.createMemory({ contactId: c.id, type: 'event', content: '重复的期末考试' });
  store.supersedeMemory(dupPending.id, keep.id);
  assert.equal(store.overview().pending.some((x) => x.id === dupPending.id), false, '被取代的 pending 应退出待确认队列');

  const { confirmed, failed } = store.confirmMemories([m.id, 'm_missing']);
  assert.equal(confirmed.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, '记忆不存在');
});

(hasBinary ? test : test.skip)('done 真实 Rust 契约：无记忆、终态不可重开、CLI 与 AI 闸门一致', async () => {
  const c = store.createContact({ name: 'Rust 普通完成' });
  const before = store.listMemories().length;
  const cli = (...args) => JSON.parse(execFileSync(bin, [...args, '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' }).trim());
  assert.ok(store.PLAN_STATUSES.includes('done'));
  for (const status of ['idea', 'decided']) {
    const p = store.createPlan({ contactId: c.id, idea: '一起散步', source: 'ai', status });
    const done = store.markPlanDone(p.id);
    assert.equal(done.status, 'done');
    assert.equal(done.sentAt, '');
    assert.equal(done.memoryId, '');
    assert.equal(done.source, 'ai');
    assert.equal('doneAt' in done, false);
    assert.equal('kind' in done, false);
    assert.ok(done.updatedAt);
    assert.deepEqual(store.markPlanDone(p.id), done);
    assert.deepEqual(cli('plan', 'set', p.id, '--status', 'done').plan, done);
    assert.deepEqual(store.listPlans({ status: 'done' }).find((x) => x.id === p.id), done);
    assert.throws(() => store.markPlanSent(p.id), { status: 400 });
    for (const target of ['idea', 'decided', 'sent']) assert.throws(() => store.updatePlan(p.id, { status: target, idea: '不应写入' }), { status: 400 });
    for (const args of [['plan', 'sent', p.id], ...['idea', 'decided', 'sent'].map((target) => ['plan', 'set', p.id, '--status', target, '--idea', '不应写入'])]) {
      const result = spawnSync(bin, [...args, '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /已完成|已终结/);
    }
    assert.deepEqual(store.getPlan(p.id), done);
  }
  const direct = store.createPlan({ contactId: c.id, idea: '创建完成', status: 'done' });
  assert.equal(direct.status, 'done');
  assert.equal(store.listMemories().length, before);
  assert.throws(() => store.markPlanDone('missing'), { status: 404 });
  assert.throws(() => store.createPlan({ contactId: c.id, idea: '非法状态', status: 'unknown' }), { status: 400 });
  for (const viaUpdate of [false, true]) {
    const p = store.createPlan({ contactId: c.id, idea: '茶叶', status: viaUpdate ? 'idea' : 'sent' });
    if (viaUpdate) store.updatePlan(p.id, { status: 'sent' });
    assert.equal(store.getPlan(p.id).memoryId, '');
    const { plan, memory } = store.markPlanSent(p.id);
    assert.equal(memory.type, 'gift');
    assert.equal(memory.status, 'confirmed');
    assert.equal(memory.author, 'user');
    assert.throws(() => store.markPlanDone(p.id), { status: 400 });
    for (const status of ['idea', 'decided', 'done']) {
      assert.throws(() => store.updatePlan(p.id, { status }), { status: 400 });
      const result = spawnSync(bin, ['plan', 'set', p.id, '--status', status, '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
    }
    assert.deepEqual(store.markPlanSent(p.id).plan, plan);
    assert.equal(store.markPlanSent(p.id).memory.id, memory.id);
    store.deleteMemory(memory.id);
    assert.equal(store.markPlanSent(p.id).memory, null);
  }
  assert.equal(store.listMemories().length, before);
  store.createMemory({ contactId: c.id, type: 'gift', content: '收到点心', direction: 'contact_to_user', author: 'user' });
  assert.equal(store.giftReciprocity().find((r) => r.contactId === c.id).hasActivePlan, false);
  const tools = await import('../../server/tools.js');
  for (const name of ['gift_plan_add', 'gift_plan_update']) {
    for (const status of ['sent', 'done']) {
      const result = await tools.executeTool(name, { id: direct.id, contactId: c.id, idea: '伪造完成', status });
      assert.equal(result.status, 400);
    }
  }
  const next = await tools.executeTool('gift_plan_add', { contactId: c.id, idea: '一起散步' });
  assert.equal(next.ok, true, 'done 不阻挡同想法的新主意');
  assert.equal(store.giftReciprocity().find((r) => r.contactId === c.id).hasActivePlan, true);
});

(hasBinary ? test : test.skip)('旧 SQLite plans CHECK 迁移：全字段、索引、视图保留，重复初始化不丢数据', () => {
  const schema = fs.readFileSync(new URL('../../rust/relstore/resource/sql/initialize.sql', import.meta.url), 'utf8');
  for (const [variant, check] of [
    ['quoted', `CHECK ("status" IN ('idea','decided','sent'))`],
    ['spaced', `CHECK ( status IN ( 'idea', 'decided', 'sent' ) )`],
  ]) {
    const db = path.join(dataDir, `legacy-${variant}.db`);
    const sqlite = (sql) => JSON.parse(execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }).trim() || '[]');
    const oldSchema = schema.replace(`CHECK ("status" IN ('idea','decided','sent','done'))`, check);
    assert.notEqual(oldSchema, schema);
    execFileSync('sqlite3', [db], { input: oldSchema + `
      ALTER TABLE plans ADD COLUMN extra_payload TEXT DEFAULT '';
      INSERT INTO contacts (id,name,tags) VALUES ('c_old','旧联系人','["保留标签"]');
      INSERT INTO materials (id,text,contact_id) VALUES ('mt_old','旧素材','c_old');
      INSERT INTO memories (id,contact_id,mem_type,content,source_id,source_quote,author,status)
        VALUES ('m_old','c_old','gift','历史送礼','mt_old','保留摘录','user','confirmed');
      INSERT INTO plans (id,contact_id,occasion,occasion_date,idea,budget,product_name,product_price,product_url,status,sent_at,memory_id,source,created_at,updated_at,extra_payload)
        VALUES ('gp_old','c_old','birthday','2026-09-22','历史计划','300','礼盒','268','https://example.test/item','sent','2026-09-22T12:00:00Z','m_old','ai','2026-09-01','2026-09-22','扩展字段不能丢');
      INSERT INTO plans (id,contact_id,idea,status) VALUES ('gp_active','c_old','普通散步','decided');
      CREATE INDEX plans_extra ON plans(extra_payload) WHERE status='sent';
      CREATE VIEW v_plan_archive AS SELECT * FROM plans;
      CREATE VIEW v_plan_chain AS SELECT id,status FROM v_plan_archive;
      CREATE TRIGGER view_keep_extra INSTEAD OF UPDATE OF extra_payload ON v_plan_archive BEGIN UPDATE plans SET extra_payload=new.extra_payload WHERE id=new.id; END;
      CREATE TRIGGER plans_keep_extra AFTER UPDATE OF idea ON plans BEGIN UPDATE plans SET extra_payload='trigger works' WHERE id=new.id; END;
      CREATE TRIGGER contacts_keep_plans AFTER UPDATE OF notes ON contacts BEGIN UPDATE plans SET extra_payload='cross-table trigger works' WHERE contact_id=new.id; END;
    `, encoding: 'utf8' });
    const rows = () => Object.fromEntries(['contacts', 'materials', 'memories', 'plans', 'relation_types'].map((table) => [table, sqlite(`SELECT * FROM ${table} ORDER BY 1`)]));
    const objects = () => sqlite(`SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','view','trigger') ORDER BY type,name`);
    const before = rows();
    const beforeObjects = objects();
    const cli = (...args) => JSON.parse(execFileSync(bin, [...args, '--json', '--db', db], { encoding: 'utf8' }).trim());
    // 模拟重建中途失败：已删视图/触发器必须随事务回滚，而非留下半迁移状态。
    sqlite('CREATE TABLE plans_rebuild_legacy (id TEXT)');
    const failed = spawnSync(bin, ['plan', 'list', '--json', '--db', db], { encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(rows(), before);
    assert.deepEqual(objects(), beforeObjects);
    sqlite('DROP TABLE plans_rebuild_legacy');
    const result = cli('plan', 'list'); // 首次成功初始化触发旧约束迁移
    assert.equal(result.plans.length, 2);
    assert.equal(result.plans.find((p) => p.id === 'gp_old').memoryId, 'm_old');
    assert.deepEqual(rows(), before);
    assert.deepEqual(objects(), beforeObjects);
    assert.match(sqlite(`SELECT sql FROM sqlite_master WHERE name='plans'`)[0].sql, /'done'/);
    const version = sqlite('PRAGMA schema_version');
    for (let i = 0; i < 3; i++) cli('contact', 'list');
    assert.deepEqual(rows(), before);
    assert.deepEqual(objects(), beforeObjects);
    assert.deepEqual(sqlite('PRAGMA schema_version'), version, '重复初始化不重建表');
    assert.equal(cli('plan', 'set', 'gp_active', '--date', new Date().toISOString().slice(0, 10), '--status', 'done').plan.status, 'done');
    assert.ok(!cli('occasion', '--days', '1').occasions.some((o) => o.planId === 'gp_active'), '原生 CLI 时机同样排除 done');
    const completed = rows();
    assert.deepEqual(completed.memories, before.memories);
    assert.deepEqual(completed.plans.find((p) => p.id === 'gp_old'), before.plans.find((p) => p.id === 'gp_old'));
    assert.equal(sqlite(`SELECT status FROM v_plan_chain WHERE id='gp_active'`)[0].status, 'done');
    assert.equal(sqlite('PRAGMA integrity_check')[0].integrity_check, 'ok');
    for (let i = 0; i < 2; i++) cli('plan', 'list');
    assert.deepEqual(rows(), completed, 'done 在重复初始化后仍完整保留');
    assert.deepEqual(cli('plan', 'sent', 'gp_old').memory.id, 'm_old', '历史 AI 来源已送记录不猜类型、不重复生成');
    assert.deepEqual(rows().memories, before.memories);
    cli('plan', 'set', 'gp_active', '--idea', '修正文案');
    assert.equal(sqlite(`SELECT extra_payload FROM plans WHERE id='gp_active'`)[0].extra_payload, 'trigger works');
    sqlite(`UPDATE contacts SET notes='测试跨表触发器' WHERE id='c_old'`);
    assert.equal(sqlite(`SELECT extra_payload FROM plans WHERE id='gp_active'`)[0].extra_payload, 'cross-table trigger works');
    sqlite(`UPDATE v_plan_archive SET extra_payload='view trigger works' WHERE id='gp_active'`);
    assert.equal(sqlite(`SELECT extra_payload FROM plans WHERE id='gp_active'`)[0].extra_payload, 'view trigger works');
  }
});

(hasBinary ? test : test.skip)('计划全生命周期与礼赠派生', () => {
  const c = store.createContact({ name: '段段' });
  const p = store.createPlan({ contactId: c.id, idea: '绘本礼盒', occasion: '生日', occasionDate: '2026-10-20', budget: '300-500' });
  assert.equal(p.status, 'idea');
  const d = store.updatePlan(p.id, { status: 'decided' });
  assert.equal(d.status, 'decided');
  const { plan, memory } = store.markPlanSent(p.id);
  assert.equal(plan.status, 'sent');
  assert.ok(plan.memoryId);
  assert.match(memory.content, /送出礼物：绘本礼盒/);
  // 幂等：再标一次返回同一记忆
  const again = store.markPlanSent(p.id);
  assert.equal(again.memory.id, memory.id);

  const led = store.giftLedger();
  assert.ok(led.given.some((g) => g.id === memory.id));
  // 回礼：段段有 contact_to_user gift 时才出现在待回应，这里只验证接口形状
  const rec = store.giftReciprocity();
  assert.ok(Array.isArray(rec));
  const occ = store.giftOccasions(365);
  assert.ok(Array.isArray(occ));
  assert.ok(!occ.some((o) => o.planId === p.id));

  assert.throws(() => store.createPlan({ contactId: c.id, idea: 'x', productUrl: 'ftp://a' }), /商品链接/);
  assert.equal(store.deletePlan(p.id).id, p.id);
});

(hasBinary ? test : test.skip)('Rust SQLite 完整保存 4096 字 CPS 链接，直接 CLI 也拒绝超长写入', () => {
  const c = store.createContact({ name: '长链接隔离测试' });
  const url = 'https://u.jd.com/'.padEnd(4096, 'x');
  const plan = store.createPlan({ contactId: c.id, idea: '长推广链接计划', source: 'ai', productUrl: url });
  assert.equal(plan.productUrl, url);
  const updatedUrl = url.slice(0, -1) + 'y';
  assert.equal(store.updatePlan(plan.id, { productUrl: updatedUrl }).productUrl, updatedUrl);
  assert.equal(store.getPlan(plan.id).productUrl, updatedUrl);
  const beforeCount = store.listPlans().length;
  for (const args of [
    ['plan', 'add', '--contact', c.id, '--idea', '不能截断', '--product-url', url + 'x'],
    ['plan', 'set', plan.id, '--product-url', url + 'x'],
  ]) {
    const result = spawnSync(bin, [...args, '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /4096/);
  }
  assert.equal(store.getPlan(plan.id).productUrl, updatedUrl);
  assert.equal(store.listPlans().length, beforeCount);
  assert.equal(store.getPlan(plan.id).source, 'ai');
  assert.equal(store.getPlan(plan.id).status, 'idea');
});

(hasBinary ? test : test.skip)('删除联系人级联（记忆/素材/计划）', () => {
  const c = store.createContact({ name: '临时联系人' });
  store.createMemory({ contactId: c.id, type: 'attribute', content: '在杭州工作', author: 'user' });
  store.saveMaterial({ text: '临时素材', contactId: c.id });
  store.createPlan({ contactId: c.id, idea: '伴手礼' });
  const { contact, removedMemories } = store.deleteContact(c.id);
  assert.equal(contact.id, c.id);
  assert.equal(removedMemories, 1);
  assert.equal(store.listMaterials().filter((mt) => mt.contactId === c.id).length, 0);
  assert.equal(store.listPlans({ contactId: c.id }).length, 0);
  assert.equal(store.listMemories({ contactId: c.id }).length, 0);
});

(hasBinary ? test : test.skip)('多条件过滤不串台（联系人+状态/关键字，回归 r#where 覆盖问题）', () => {
  const [c1, c2] = store.listContacts().slice(0, 2);
  const m1 = store.createMemory({ contactId: c1.id, type: 'event', content: '过滤回归-甲专属事件', author: 'user' });
  const m2 = store.createMemory({ contactId: c2.id, type: 'event', content: '过滤回归-乙专属事件', author: 'user' });
  try {
    // 联系人+状态+关键字三条件：各人只命中自己那条
    // （旧版 deck r#where 链式调用是「整体替换」，多条件只剩最后一个 → 切联系人时间线串台）
    const l1 = store.listMemories({ contactId: c1.id, status: 'confirmed', q: '过滤回归' });
    const l2 = store.listMemories({ contactId: c2.id, status: 'confirmed', q: '过滤回归' });
    assert.equal(l1.length, 1, `c1 应恰好命中 1 条，实际 ${l1.length}`);
    assert.equal(l1[0].contactId, c1.id);
    assert.equal(l2.length, 1, `c2 应恰好命中 1 条，实际 ${l2.length}`);
    assert.equal(l2[0].contactId, c2.id);
    // 类型过滤走 mem_type 物理列
    assert.ok(store.listMemories({ type: 'event', q: '过滤回归' }).length >= 2);
  } finally {
    store.deleteMemory(m1.id);
    store.deleteMemory(m2.id);
  }
});

(hasBinary ? test : test.skip)('回礼提示包含最近已确认收礼的原文和记忆 ID', () => {
  const c = store.createContact({ name: '回礼内容契约' });
  store.createMemory({ contactId: c.id, type: 'gift', content: '早些收到茶叶', date: '2026-01-01', direction: 'contact_to_user', author: 'user' });
  const gift = store.createMemory({ contactId: c.id, type: 'gift', content: '后来收到围巾', date: '2026-02-01', direction: 'contact_to_user', author: 'user' });
  store.createMemory({ contactId: c.id, type: 'gift', content: '待确认的不算', date: '2026-03-01', direction: 'contact_to_user', author: 'ai' });
  const row = store.giftReciprocity().find((r) => r.contactId === c.id);
  assert.equal(row.content, '后来收到围巾');
  assert.equal(row.memoryId, gift.id);
  assert.equal(row.date, gift.date);
});

(hasBinary ? test : test.skip)('overview/counts/timeline 形状', () => {
  const o = store.overview();
  assert.ok(['contacts', 'memories', 'confirmed', 'pending', 'rejected'].every((k) => k in o.counts));
  assert.ok(Array.isArray(o.upcoming));
  const t = store.timeline(store.listContacts()[0].id);
  assert.ok(Array.isArray(t.memories) && Array.isArray(t.shortItems));
});

(hasBinary ? test : test.skip)('素材整理报告（facade 侧车）：rust 模式同样读写与随删清理', () => {
  const c = store.createContact({ name: '报告老师' });
  const mt = store.saveMaterial({ text: '报告素材正文', contactId: c.id });
  const saved = store.saveMaterialReport(mt.id, '拆出 1 条；无冲突');
  assert.ok(saved.reportedAt);
  assert.equal(store.materialReport(mt.id).report, '拆出 1 条；无冲突');
  assert.ok(store.allMaterialReports()[mt.id]);
  // 素材删除 → 报告随之清理
  store.deleteMaterial(mt.id);
  assert.equal(store.materialReport(mt.id), null);
  // 联系人级联删除素材（rust 模式素材随删）→ 报告随之清理
  const mt2 = store.saveMaterial({ text: '报告素材正文 2', contactId: c.id });
  store.saveMaterialReport(mt2.id, '第二条报告');
  store.deleteContact(c.id);
  assert.equal(store.materialReport(mt2.id), null);
});

// tools 层提取闸门 × rust 后端端到端：闸门（server/tools.js）在后端无关的
// facade 之上，这里验证 rust 路径同样拒绝坏条目、放行合格条目并持久化 sourceQuote。
(hasBinary ? test : test.skip)('提取闸门对 rust 后端同样生效（tools 层端到端）', async () => {
  const tools = await import('../../server/tools.js');
  const c = store.createContact({ name: '闸门老师' });
  const mt = store.saveMaterial({ text: '2026-09-10 20:03 方老师说周五办庆祝', contactId: c.id, occasion: 'teacher_day' });
  const bad = await tools.executeTool('memory_add', { contactId: c.id, type: 'event', content: '周五办庆祝', sourceId: mt.id, sourceQuote: '方老师说周五办庆祝', saidAt: '2026-09-10 21:00' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'SAIDAT_MISPLACED');
  const good = await tools.executeTool('memory_add', { contactId: c.id, type: 'event', content: '方老师说周五办庆祝', sourceId: mt.id, sourceQuote: '方老师说周五办庆祝', saidAt: '2026-09-10 20:03' });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.memory.status, 'pending');
  assert.equal(good.memory.sourceQuote, '方老师说周五办庆祝');
  assert.equal(good.memory.occasion, 'teacher_day', '场景继承在 rust 路径同样生效');
});

(hasBinary ? test : test.skip)('关系类型注册表 CRUD + 内置保护 + 占用检查（rust 契约）', () => {
  // 内置 6 类
  const initial = store.listRelationTypes();
  assert.ok(initial.length >= 6);
  const builtinKeys = initial.filter((t) => t.builtin).map((t) => t.key);
  assert.deepEqual([...builtinKeys].sort(), ['client', 'colleague', 'family', 'friend', 'other', 'partner']);

  // 新增自定义
  const t = store.createRelationType({ key: 'classmate', label: '同学' });
  assert.equal(t.key, 'classmate');
  assert.equal(t.builtin, false);
  assert.throws(() => store.createRelationType({ key: 'classmate', label: 'x' }), /关系类型已存在/);
  assert.throws(() => store.createRelationType({ key: 'Bad', label: 'x' }), /key 非法/);

  // 改名
  assert.equal(store.updateRelationType('classmate', { label: '老同学' }).label, '老同学');
  assert.throws(() => store.updateRelationType('nope', { label: 'x' }), /关系类型不存在/);

  // 用自定义类型建联系人
  const c = store.createContact({ name: '关系类型rust测试', relation: 'classmate' });
  assert.equal(c.relation, 'classmate');
  assert.throws(() => store.createContact({ name: '坏关系', relation: 'boss' }), /relation 必须是/);

  // 占用检查
  assert.throws(() => store.deleteRelationType('classmate'), /正被 1 个联系人使用/);
  store.updateContact(c.id, { relation: 'friend' });
  assert.equal(store.deleteRelationType('classmate').key, 'classmate');

  // 内置不可删
  assert.throws(() => store.deleteRelationType('family'), /内置类型不可删除/);
});

(hasBinary ? test : test.skip)('疏远预警：rust 链路与 JSON 口径一致（阈值/降序/排除近期）', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const c = store.createContact({ name: '疏远老鲍', relation: 'friend' });
  store.createMemory({ contactId: c.id, type: 'event', content: '一起爬过山', date: daysAgo(200), author: 'user' });
  const recent = store.createContact({ name: '常联系老崔', relation: 'friend' });
  store.createMemory({ contactId: recent.id, type: 'event', content: '刚吃过饭', date: daysAgo(2), author: 'user' });

  const items = store.fadingContacts(90);
  const hit = items.find((f) => f.contactId === c.id);
  assert.ok(hit, '200 天未联系上榜');
  assert.ok(hit.days >= 195 && hit.days <= 205, `天数在容忍区间：${hit.days}`);
  assert.equal(hit.name, '疏远老鲍');
  assert.equal(hit.relation, 'friend');
  assert.match(hit.lastDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!items.some((f) => f.contactId === recent.id), '刚联系过的不上榜');
  assert.ok(items.every((f, i) => i === 0 || items[i - 1].days >= f.days), '按天数降序');
  const strict = store.fadingContacts(150);
  assert.ok(strict.some((f) => f.contactId === c.id));
  assert.ok(!strict.some((f) => f.contactId === recent.id));
});

(hasBinary ? test : test.skip)('rust 时机按联系人、场合、日期合并，无 CLI 截断或每人配额', (t) => {
  const NativeDate = Date;
  const stamp = new NativeDate('2026-09-21T15:30:00').getTime();
  t.mock.method(globalThis, 'Date', class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [stamp])); }
    static now() { return stamp; }
  });
  const contacts = Array.from({ length: 24 }, (_, i) => store.createContact({ name: `时机测试${i}`, birthday: '每年-09-22' }));
  const [c] = contacts;
  const archived = store.createContact({ name: '时机已归档', birthday: '每年-09-22' });
  store.updateContact(archived.id, { archived: true });
  const pending = store.createContact({ name: '时机待确认', birthday: '每年-09-22', status: 'pending' });
  for (const hidden of [archived, pending]) {
    store.createPlan({ contactId: hidden.id, idea: '不应显示', occasion: 'visit', occasionDate: '2026-09-23' });
  }
  store.createPlan({ contactId: c.id, idea: '手作茶点', occasion: '中秋', occasionDate: '2026-09-25' });
  store.createPlan({ contactId: c.id, idea: '护嗓茶', occasion: '中秋节', occasionDate: '2026-09-25' });
  store.createPlan({ contactId: c.id, idea: '灯笼', occasion: 'mid_autumn', occasionDate: '2026-09-28' });
  store.createPlan({ contactId: c.id, idea: '生日礼物', occasion: '生日', occasionDate: '2026-09-22' });
  for (let i = 0; i < 8; i++) {
    store.createPlan({ contactId: c.id, idea: `拜访礼物${i}`, occasion: 'visit', occasionDate: `2026-09-${21 + i}` });
  }
  const sent = store.createPlan({ contactId: c.id, idea: '已送', occasion: 'thank_you', occasionDate: '2026-09-23', status: 'sent' });
  const done = store.createPlan({ contactId: c.id, idea: '已完成散步', occasion: 'walk', occasionDate: '2026-09-23', status: 'done' });
  const outside = store.createPlan({ contactId: c.id, idea: '超窗', occasion: 'visit', occasionDate: '2026-10-22' });

  const occasions = store.giftOccasions(30);
  const ids = new Set(contacts.map((x) => x.id));
  const birthdays = occasions.filter((o) => ids.has(o.contactId) && o.source === 'birthday');
  assert.equal(birthdays.length, 24);
  assert.ok(birthdays.every((o) => o.date === '2026-09-22' && o.inDays === 1));
  assert.ok(!occasions.some((o) => o.contactId === archived.id || o.contactId === pending.id));
  const mine = occasions.filter((o) => o.contactId === c.id);
  assert.deepEqual(mine.filter((o) => o.occasion === 'mid_autumn').map((o) => [o.date, o.source]), [
    ['2026-09-25', 'holiday'], ['2026-09-28', 'plan'],
  ]);
  assert.equal(mine.filter((o) => o.occasion === 'birthday').length, 1);
  assert.equal(mine.filter((o) => o.occasion === 'visit').length, 8);
  assert.ok(!mine.some((o) => o.planId === sent.id || o.planId === done.id || o.planId === outside.id));
});

(hasBinary ? test : test.skip)('rust 链路 upcomingHolidays：两周内全员节日时间轴（facade 可达，与 JSON 同源）', () => {
  assert.equal(typeof store.upcomingHolidays, 'function', 'facade 暴露 upcomingHolidays');
  const hs = store.upcomingHolidays(14);
  assert.ok(Array.isArray(hs), '返回数组');
  assert.ok(hs.every((h) => h.inDays >= 0 && h.inDays <= 14), '两周窗口');
  assert.ok(hs.every((h) => !['teacher_day', 'mother_day', 'father_day'].includes(h.occasion)), '角色节日不进时间轴');
  assert.ok(hs.every((h) => h.label && /^\d{4}-\d{2}-\d{2}$/.test(h.date)), '带中文标签与完整日期');
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i].inDays >= hs[i - 1].inDays, '按临近排序');
});
