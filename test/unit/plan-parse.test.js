// 一句话建计划解析器：纯规则、可离线，必须可单测（today 固定，不依赖运行日）
// plan-parse.js 是浏览器经典脚本（挂 globalThis.PlanParse，无 ESM 导出），这里动态 import 触发求值后取全局
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../../public/plan-parse.js');
const { parse, giftKeyword } = globalThis.PlanParse;

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

test('京东关键词：电话/见面类客套话宁空不猜', () => {
  assert.equal(giftKeyword('联系一下'), '');
  assert.equal(giftKeyword('一起到公园散步'), '');
  assert.equal(giftKeyword('约饭聊聊'), '');
  assert.equal(giftKeyword('打个电话祝生日快乐'), '');
  assert.equal(giftKeyword('先拜访他再说'), '');
  assert.equal(giftKeyword(''), '');
});

test('京东关键词：礼物/商品类想法照常派生', () => {
  assert.equal(giftKeyword('送低糖蛋糕，他喜欢低糖'), '低糖蛋糕');
  assert.equal(giftKeyword('打算送花束'), '花束'); // 两遍剥头：打算 → 送
  assert.equal(giftKeyword('AI 建议低糖蛋糕'), '低糖蛋糕');
  assert.equal(giftKeyword('帮我挑个保温杯'), '保温杯');
  assert.equal(giftKeyword('带点茶叶过去'), '茶叶过去'); // 剥「带点」后保留余文，可手改
  assert.equal(giftKeyword('保温杯'), '保温杯'); // 本身就是商品词
  assert.equal(giftKeyword('甲计划：私人喜好仅供本地参考'), '甲计划'); // jd-products e2e 夹具回归锚点
});

// —— 简称/带前缀姓名的字序匹配：库里是「星屿-iqc-周老师」，句中只说「周老师」——
const CT2 = [
  { id: 'x1', name: '星屿-iqc-周老师' },
  { id: 'x2', name: '星屿-iqc-老大' },
  { id: 'x3', name: '星屿-采购-林老师' },
];
const P2 = (text) => parse(text, { contacts: CT2, today: TODAY });

test('简称选中带前缀姓名：下周三请周老师吃饭 → 星屿-iqc-周老师', () => {
  const r = P2('下周三请周老师吃饭');
  assert.equal(r.contactId, 'x1');
  assert.equal(r.contactName, '星屿-iqc-周老师');
  assert.equal(r.date, '2026-09-30');
  assert.equal(r.idea, '请吃饭');
});

test('句中带机构词照样归对人：下周三去星屿找周老师吃饭', () => {
  const r = P2('下周三去星屿找周老师吃饭');
  assert.equal(r.contactId, 'x1');
});

test('同角色词不误报：下周一请林老师吃饭 → 林老师而非周老师', () => {
  const r = P2('下周一请林老师吃饭');
  assert.equal(r.contactId, 'x3');
});

test('得分并列视为歧义宁空不猜：请老师吃饭 / 去星屿拜访', () => {
  assert.equal(P2('下周三请老师吃饭').contactId, '');
  assert.equal(P2('下周三去星屿拜访').contactId, '');
});

// —— 两字片段门槛：恰为姓名完整分段才可信，活动词撞名不误选 ——
const CT3 = [
  { id: 'y1', name: '星屿-采购-小林' },
  { id: 'y2', name: '星屿-晨跑搭子' },
];
const P3 = (text) => parse(text, { contacts: CT3, today: TODAY });

test('两字完整分段可信：下周三请小林吃饭 → 星屿-采购-小林', () => {
  assert.equal(P3('下周三请小林吃饭').contactId, 'y1');
});

test('活动词撞人名局部不误选：找一天一起晨跑 → 宁空不猜', () => {
  const r = P3('找一天一起晨跑');
  assert.equal(r.contactId, '');
  assert.equal(r.idea, '找一天一起晨跑');
});

// —— 星期/礼拜写法与 周X 同义：下周星期天 = 下周日 ——
test('星期/礼拜写法日期识别：下周星期天聚一下 → 2026-10-04', () => {
  assert.equal(P('下周星期天聚一下').date, '2026-10-04');
  assert.equal(P('下礼拜三聚一下').date, '2026-09-30');
  assert.equal(P('这星期五聚一下').date, '2026-09-25');
  assert.equal(P('礼拜六聚一下').date, '2026-09-26');
  assert.equal(P('星期一聚一下').date, '2026-09-28'); // 本周一已过，无前缀顺延下周一
});

test('下周星期天整段消费：下周星期天约小李吃饭 → 人+日期+约吃饭', () => {
  const r = P('下周星期天约小李吃饭');
  assert.equal(r.contactId, 'c1');
  assert.equal(r.date, '2026-10-04');
  assert.equal(r.idea, '约吃饭');
});
