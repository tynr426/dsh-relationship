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
  // ③ 计划日期项在 occasion 命令里验证（见 CLI 契约）；Node 侧 giftOccasions 直通
  const occ = store.giftOccasions(365);
  assert.ok(Array.isArray(occ));

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
