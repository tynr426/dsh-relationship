// 审计测试：闸门拦新账，审计查旧账。用 store 直写（绕过工具层闸门）制造
// 各类历史脏数据，断言 runAudit 精确识别问题形态、不误伤干净条目，
// 且驳回条目不参与查重（与闸门占用语义一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-audit-'));
process.env.REL_DATA_DIR = dataDir;
const { runAudit } = await import('../../server/audit.js');
const store = (await import('../../server/store-facade.js')).default;

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

const CHAT = [
  '2026年09月10日 20:03 妈妈：方老师说周五想给孩子们办个小庆祝',
  '2026年09月10日 20:11 我：感觉孩子特别喜欢方老师',
  '2026年09月10日 21:53 妈妈：方老师可能对芒果过敏，我没细问',
  '2026年09月10日 22:00 我：那教师节礼物避开芒果吧',
].join('\n');

let report;

test.before(async () => {
  assert.equal(store.listMaterials({}).length, 0);
  const c = store.createContact({ name: '方老师', relation: 'colleague' });
  const mt = store.saveMaterial({ text: CHAT, contactId: c.id, occasion: 'teacher_day' });

  const mk = (args) => store.createMemory({ contactId: c.id, ...args });
  // ① 干净条目
  mk({ type: 'event', content: '方老师说周五想给孩子们办个小庆祝', direction: 'contact_to_user', sourceId: mt.id, sourceQuote: '方老师说周五想给孩子们办个小庆祝', saidAt: '2026-09-10 20:03' });
  // ② 历史无摘录
  mk({ type: 'taboo', content: '方老师可能对芒果过敏', importance: 3, sourceId: mt.id, sourceQuote: '', saidAt: '2026-09-10 21:53' });
  // ③ 摘录非逐字（多个「课」字）
  mk({ type: 'preference', content: '孩子喜欢方老师', sourceId: mt.id, sourceQuote: '孩子特别喜欢方老师课', saidAt: '2026-09-10 20:11' });
  // ④ 时间戳挪用（原话在 22:00 消息，saidAt 写 20:03）
  mk({ type: 'event', content: '提议礼物避开芒果', direction: 'user_to_contact', sourceId: mt.id, sourceQuote: '那教师节礼物避开芒果吧', saidAt: '2026-09-10 20:03' });
  // ⑤ 多事实打包（两个分句），摘录本身合规
  mk({ type: 'event', content: '方老师说周五想给孩子们办个小庆祝；我提议教师节礼物避开芒果；妈妈说方老师可能对芒果过敏', direction: 'both', sourceId: mt.id, sourceQuote: '感觉孩子特别喜欢方老师', saidAt: '2026-09-10 20:11' });
  // ⑥⑦ 同联系人同内容重复（不同摘录，不触发摘录查重）
  mk({ type: 'attribute', content: '妈妈没细问过敏的事', sourceId: mt.id, sourceQuote: '方老师可能对芒果过敏，我没细问', saidAt: '2026-09-10 21:53' });
  mk({ type: 'attribute', content: '妈妈没细问过敏的事', sourceId: mt.id, sourceQuote: '我没细问', saidAt: '2026-09-10 21:53' });
  // ⑧ 跨消息打包摘录（含完整时间戳）
  mk({ type: 'event', content: '打包摘录的庆祝计划', sourceId: mt.id, sourceQuote: '2026年09月10日 20:03 妈妈：方老师说周五想给孩子们办个小庆祝', saidAt: '2026-09-10 20:03' });
  // ⑨ 悬空引用：素材不存在
  mk({ type: 'event', content: '幽灵素材里的事', sourceId: 'mt_ghost', sourceQuote: '任意' });
  // ⑩ 已驳回条目：不占摘录、不计问题
  const rej = mk({ type: 'promise', content: '说好周五一起庆祝', direction: 'contact_to_user', sourceId: mt.id, sourceQuote: '想给孩子们办个小庆祝', saidAt: '2026-09-10 20:03' });
  store.rejectMemory(rej.id, '不要这条');
  // ⑪ 会话直录缺方向 / ⑫ 会话直录干净
  mk({ type: 'interaction', content: '约了下周三吃饭' });
  mk({ type: 'interaction', content: '约了下周三吃火锅', direction: 'both', lifespan: 'short', saidAt: '2026-09-17 10:00' });

  report = runAudit();
});

test('审计：总量与后端', () => {
  assert.equal(report.storeMode, 'json');
  assert.equal(report.totals.materials, 1);
  assert.equal(report.totals.active, 11);
  assert.equal(report.totals.rejected, 1);
});

test('审计：逐条问题形态全部命中', () => {
  const codes = new Map();
  for (const row of [...report.materials[0].memories, ...report.sessionMemories, ...report.danglingReferences]) {
    for (const it of row.issues) codes.set(it.code, (codes.get(it.code) || 0) + 1);
  }
  assert.equal(codes.get('MISSING_QUOTE'), 1);
  assert.equal(codes.get('QUOTE_MISMATCH'), 1);
  assert.equal(codes.get('SAIDAT_MISPLACED'), 1);
  assert.equal(codes.get('SUSPECTED_PACKING'), 1);
  assert.equal(codes.get('DUPLICATE_CONTENT'), 2);
  assert.equal(codes.get('QUOTE_SPANS_STAMP'), 1);
  assert.equal(codes.get('MATERIAL_NOT_FOUND'), 1);
  assert.equal(codes.get('MISSING_DIRECTION'), 1);
  // 不应出现：干净条目与合规 saidAt 不触发
  assert.equal(codes.get('SAIDAT_NOT_IN_MATERIAL') || 0, 0);
  assert.equal(codes.get('DUPLICATE_QUOTE') || 0, 0, '不同摘录不复用，驳回条目不占摘录');
});

test('审计：干净条目零问题、被驳回条目不出现', () => {
  const all = [...report.materials[0].memories, ...report.sessionMemories, ...report.danglingReferences];
  const clean = all.filter((m) => m.issues.length === 0);
  assert.equal(clean.length, 2);
  assert.equal(all.some((m) => m.content.includes('说好周五一起庆祝')), false, '已驳回条目不在审计范围');
});

test('审计：汇总数字与分桶', () => {
  assert.equal(report.summary.clean, 2);
  assert.equal(report.summary.flagged, 9);
  assert.equal(report.summary.errors, 8);
  assert.equal(report.summary.warns, 1);
  assert.equal(report.danglingReferences.length, 1);
  assert.equal(report.sessionMemories.length, 2);
  assert.equal(report.materials[0].activeCount, 8);
});
