import test from 'node:test';
import assert from 'node:assert/strict';

import { cosine, textVector, vectorSearchMemories } from '../../server/vector-search.js';

const mem = (id, content, extra = {}) => ({ id, content, createdAt: '2026-09-20T10:00:00Z', ...extra });

test('空查询不检索', () => {
  const memories = [mem('a', '她只喝武夷岩茶')];
  assert.deepEqual(vectorSearchMemories(memories, ''), []);
  assert.deepEqual(vectorSearchMemories(memories, '   '), []);
  assert.deepEqual(vectorSearchMemories([], '岩茶'), []);
});

test('命中按相关度排序，包含原词的加分', () => {
  const memories = [
    mem('partial', '他老家在武夷山，也懂一点岩茶的门道'),
    mem('exact', '喜欢武夷岩茶'),
  ];
  const hits = vectorSearchMemories(memories, '岩茶');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'exact');
  assert.ok(hits[0].score > hits[1].score + 0.1, '文本更贴近查询应排前');
  assert.ok(hits[1].score >= 0.15, '字面重叠命中应过默认阈值');
});

test('稀疏向量边界：无字面重叠即无结果（生日 ≠ 寿星）', () => {
  const memories = [mem('a', '他是四月的寿星，属猪')];
  assert.deepEqual(vectorSearchMemories(memories, '生日'), []);
});

test('检索面覆盖 occasion/type/sourceQuote 字段', () => {
  const memories = [
    mem('occasion', '全家一起吃了顿饭', { occasion: '生日' }),
    mem('type', '他爱喝手冲', { type: 'preference' }),
    mem('quote', '他戒酒了', { sourceQuote: '原话：最近完全不碰酒精了' }),
  ];
  assert.equal(vectorSearchMemories(memories, '生日')[0].id, 'occasion');
  assert.equal(vectorSearchMemories(memories, 'preference')[0].id, 'type');
  assert.equal(vectorSearchMemories(memories, '酒精')[0].id, 'quote');
});

test('噪声过滤：长文本单字重叠低于默认阈值，minScore 可调', () => {
  const memories = [mem('long', '茶水间聊了两句项目进度')];
  assert.deepEqual(vectorSearchMemories(memories, '茶叶'), []);
  const relaxed = vectorSearchMemories(memories, '茶叶', { minScore: 0 });
  assert.equal(relaxed.length, 1);
  assert.ok(relaxed[0].score > 0 && relaxed[0].score < 0.15);
});

test('limit 截断且按分数降序', () => {
  const memories = [
    mem('mid', '岩茶之乡在武夷'),
    mem('top', '武夷岩茶'),
    mem('third', '他带过一盒岩茶给我'),
  ];
  const hits = vectorSearchMemories(memories, '岩茶', { limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'top');
  assert.ok(hits[0].score >= hits[1].score);
});

test('大小写与全角归一（NFKC）', () => {
  const memories = [mem('a', '他用ｉＰｈｏｎｅ拍照片')];
  assert.equal(vectorSearchMemories(memories, 'IPHONE')[0].id, 'a');
});

test('textVector/cosine：正交文本为 0，自身为 1', () => {
  const a = textVector('武夷岩茶');
  assert.equal(cosine(a, a), 1);
  assert.equal(cosine(a, textVector('羽毛球拍')), 0);
});
