// 一句话建计划解析器：纯规则、可离线，必须可单测（today 固定，不依赖运行日）
// plan-parse.js 是浏览器经典脚本（挂 globalThis.PlanParse，无 ESM 导出），这里动态 import 触发求值后取全局
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../../public/plan-parse.js');
const { parse } = globalThis.PlanParse;

const TODAY = new Date(2026, 8, 23); // 2026-09-23 周三
const CT = [
  { id: 'c1', name: '小李' },
  { id: 'c2', name: '王老师' },
  { id: 'c3', name: '老张' },
  { id: 'c4', name: 'E2E 一句话小李' },
];
const P = (text) => parse(text, { contacts: CT, today: TODAY });

test('主场景：下周三约小李吃饭 → 人+日期+约吃饭', () => {
  const r = P('下周三约小李吃饭');
  assert.equal(r.contactId, 'c1');
  assert.equal(r.contactName, '小李');
  assert.equal(r.date, '2026-09-30'); // 本周三 09-23 + 7
  assert.equal(r.idea, '约吃饭');
  assert.equal(r.occasion, '');
});

test('打算明天联系老张 → 日期+默认想法', () => {
  const r = P('打算明天联系老张');
  assert.equal(r.contactId, 'c3');
  assert.equal(r.date, '2026-09-24');
  assert.equal(r.idea, '联系一下');
});

test('模糊时间不编造：打算下周联系小李 → 日期留空，「下周」留在想法里', () => {
  const r = P('打算下周联系小李');
  assert.equal(r.date, '');
  assert.equal(r.idea, '下周联系');
});

test('场合识别并消费：教师节前看望王老师', () => {
  const r = P('教师节前看望王老师');
  assert.equal(r.occasion, 'teacher_day');
  assert.equal(r.contactId, 'c2');
  assert.equal(r.idea, '看望');
});

test('生日+具体日期：11月3日给小李过生日', () => {
  const r = P('11月3日给小李过生日');
  assert.equal(r.occasion, 'birthday');
  assert.equal(r.date, '2026-11-03');
  assert.equal(r.contactId, 'c1');
  assert.equal(r.idea, '联系一下'); // 残句只剩「过」
});

test('无年份日期已过则顺延明年：3月8日联系小李', () => {
  const r = P('3月8日联系小李');
  assert.equal(r.date, '2027-03-08');
});

test('相对日：3天后 / 大后天 / 今天', () => {
  assert.equal(P('3天后跟老张聚一下').date, '2026-09-26');
  assert.equal(P('大后天给小李送文件').date, '2026-09-26');
  assert.equal(P('今天跟老张聚一下').date, '2026-09-23');
  assert.equal(P('3天后跟老张聚一下').idea, '聚一下'); // 有信息量的残句原样保留
});

test('周末与星期：这周末 / 下周末 / 裸周六 / 已过的裸周一', () => {
  assert.equal(P('这周末约老张爬山').date, '2026-09-26'); // 本周六
  assert.equal(P('下周末约老张爬山').date, '2026-10-03');
  assert.equal(P('周六找小李对齐').date, '2026-09-26');
  assert.equal(P('周一找小李对齐').date, '2026-09-28'); // 本周一已过 → 下周一
});

test('完整年月日：2026-10-01给小李寄特产', () => {
  const r = P('2026-10-01给小李寄特产');
  assert.equal(r.date, '2026-10-01');
  assert.equal(r.idea, '寄特产'); // 「给」随人名一起消费
});

test('没匹配到联系人：名字留在想法里，不猜人', () => {
  const r = P('打算联系王五');
  assert.equal(r.contactId, '');
  assert.equal(r.idea, '联系王五');
});

test('长名字优先 + 带空格名字', () => {
  const r = P('明天约E2E 一句话小李吃饭');
  assert.equal(r.contactId, 'c4');
  assert.equal(r.date, '2026-09-24');
  assert.equal(r.idea, '约吃饭');
});

test('空输入与边界', () => {
  const empty = parse('', { contacts: CT, today: TODAY });
  assert.deepEqual(empty, { contactId: '', contactName: '', occasion: '', date: '', idea: '' });
  assert.equal(P('随便写写没有结构').idea, '随便写写没有结构');
  // 非法日期（13月）不产出错误日期，文本原样留在想法里
  const bad = P('13月5日联系小李');
  assert.equal(bad.date, '');
  // 今天有线下方框 date 输入兼容：返回 YYYY-MM-DD
  assert.match(P('明天联系小李').date, /^\d{4}-\d{2}-\d{2}$/);
});
