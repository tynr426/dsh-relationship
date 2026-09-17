// relstore 契约测试：对真实 relstore 二进制跑一遍完整业务流（联系人→记忆→素材→计划→台账）。
// 用独立临时库（RELSTORE_DB / REL_DATA_DIR），不碰用户数据；无二进制时整文件跳过（家法同款）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

(hasBinary ? test : test.skip)('记忆全生命周期（含场景继承/确认/驳回/恢复/取代）', () => {
  const c = store.createContact({ name: '曦曦' });
  const mt = store.saveMaterial({ text: '聊天：曦曦想要一套绘本', contactId: c.id, occasion: 'birthday' });
  const m = store.createMemory({ contactId: c.id, type: 'gift', content: '想要绘本', author: 'ai', sourceId: mt.id });
  assert.equal(m.status, 'pending');
  assert.equal(m.occasion, 'birthday', '未显式给 occasion 时继承素材场景');
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

(hasBinary ? test : test.skip)('overview/counts/timeline 形状', () => {
  const o = store.overview();
  assert.ok(['contacts', 'memories', 'confirmed', 'pending', 'rejected'].every((k) => k in o.counts));
  assert.ok(Array.isArray(o.upcoming));
  const t = store.timeline(store.listContacts()[0].id);
  assert.ok(Array.isArray(t.memories) && Array.isArray(t.shortItems));
});
