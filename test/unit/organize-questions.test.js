// 整理反问测试：登记/校验/送达状态机/清除四条路径——AI 登记（工具层校验 options）、
// 工作台送达标记（sent/copied，标记不清除）、AI done 或报告提交权威清除、
// 用户手动放弃清除、素材删除级联清除。
// 场景动机：反问只落在对话里会让工作台用户无感知（一直没反应）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-question-'));
process.env.REL_DATA_DIR = dataDir;
const store = (await import('../../server/store-facade.js')).default;
const { executeTool } = await import('../../server/tools.js');

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

let mt;

test.before(async () => {
  const c = store.createContact({ name: '方老师', relation: 'colleague' });
  mt = store.saveMaterial({ text: '2026年09月10日 20:03 妈妈：方老师说周五想给孩子们办个小庆祝', contactId: c.id, occasion: 'teacher_day' });
});

test('登记：工具校验 + 落库可读', async () => {
  // options 少于 2 个拒绝
  const bad = await executeTool('organize_question', { materialId: mt.id, question: '要重新登记吗？', options: [{ label: '照常整理', command: `素材 ${mt.id} 照常整理` }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('2-4 个'));
  // 素材不存在 404
  const ghost = await executeTool('organize_question', { materialId: 'mt_ghost', question: '？', options: [] });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.status, 404);
  // 正常登记
  const r = await executeTool('organize_question', {
    materialId: mt.id,
    question: '素材与刚删除的内容相同，要重新登记吗？',
    options: [
      { label: '照常整理', command: `素材 ${mt.id} 照常整理：库里没有这些记忆，直接全部登记` },
      { label: '跳过不登记', command: `素材 ${mt.id} 跳过不登记，提交报告说明即可` },
    ],
  });
  assert.equal(r.ok, true);
  const q = store.organizeQuestion(mt.id);
  assert.equal(q.question, '素材与刚删除的内容相同，要重新登记吗？');
  assert.equal(q.options.length, 2);
  assert.ok(q.options.every((o) => o.label && o.command && o.command.includes(mt.id)), '作答指令须自足（含素材 ID）');
  assert.ok(store.allOrganizeQuestions()[mt.id], '全量映射含该素材');
  assert.equal(q.status, 'pending', '新登记的待答反问');
  assert.equal(q.sentAt, '');
  assert.equal(q.copiedAt, '');
});

test('状态机：发送标记送达、复制只记时间（复制不算送达）、标记一律不清除', async () => {
  await executeTool('organize_question', {
    materialId: mt.id,
    question: '这条记忆要不要登记？',
    options: [
      { label: '照常登记', command: `素材 ${mt.id} 照常登记` },
      { label: '跳过', command: `素材 ${mt.id} 跳过` },
    ],
  });
  // 独立模式作答=复制：只记 copiedAt，不算送达
  store.markOrganizeQuestionCopied(mt.id);
  let q = store.organizeQuestion(mt.id);
  assert.equal(q.status, 'pending', '复制不算送达');
  assert.ok(q.copiedAt, '记录复制时间');
  assert.equal(q.sentAt, '');
  assert.ok(q, '复制后反问保留，等粘贴到 DSH / AI done / 手动放弃');
  // 嵌入模式作答=发送成功：标 sent
  store.markOrganizeQuestionSent(mt.id);
  q = store.organizeQuestion(mt.id);
  assert.equal(q.status, 'sent');
  assert.ok(q.sentAt, '记录送达时间');
  assert.ok(q, '送达标记不清除反问——清除是 AI done / 报告 / 手动放弃的事');
  // 素材不存在 404（与登记同款校验）
  assert.throws(() => store.markOrganizeQuestionSent('mt_ghost'), /素材不存在/);
  assert.throws(() => store.markOrganizeQuestionCopied('mt_ghost'), /素材不存在/);
  store.clearOrganizeQuestion(mt.id);
  assert.equal(store.organizeQuestion(mt.id), null);
});

test('清除①：用户手动放弃（REST 同款 facade 调用）', () => {
  store.clearOrganizeQuestion(mt.id);
  assert.equal(store.organizeQuestion(mt.id), null);
});

test('清除②：AI 收到作答后 done=true', async () => {
  await executeTool('organize_question', { materialId: mt.id, question: '再问一次？', options: [{ label: '照常', command: `素材 ${mt.id} 照常` }, { label: '跳过', command: `素材 ${mt.id} 跳过` }] });
  assert.ok(store.organizeQuestion(mt.id));
  const r = await executeTool('organize_question', { materialId: mt.id, done: true });
  assert.equal(r.ok, true);
  assert.equal(store.organizeQuestion(mt.id), null);
});

test('清除③：整理报告提交即整理完成，反问不再悬置', async () => {
  await executeTool('organize_question', { materialId: mt.id, question: '待答状态登记报告？', options: [{ label: '照常', command: `素材 ${mt.id} 照常` }, { label: '跳过', command: `素材 ${mt.id} 跳过` }] });
  assert.ok(store.organizeQuestion(mt.id));
  const r = await executeTool('material_report', { id: mt.id, report: '拆出 1 条：小庆祝计划' });
  assert.equal(r.ok, true);
  assert.equal(store.organizeQuestion(mt.id), null, '报告提交应清除反问');
});

test('清除④：素材删除级联清理', async () => {
  await executeTool('organize_question', { materialId: mt.id, question: '还挂着吗？', options: [{ label: '照常', command: `素材 ${mt.id} 照常` }, { label: '跳过', command: `素材 ${mt.id} 跳过` }] });
  assert.ok(store.organizeQuestion(mt.id));
  store.deleteMaterial(mt.id);
  assert.equal(store.organizeQuestion(mt.id), null);
  assert.equal(Object.keys(store.allOrganizeQuestions()).length, 0);
});
