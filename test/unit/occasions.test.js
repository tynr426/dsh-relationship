import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveOccasions, occasionKey, occasionLabel, OCCASION_CN } from '../../server/occasions.js';

function mockToday(t, value = '2026-09-21T15:30:00') {
  const NativeDate = Date;
  const stamp = new NativeDate(value).getTime();
  t.mock.method(globalThis, 'Date', class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [stamp])); }
    static now() { return stamp; }
  });
}

const contact = (id = 'c_1', fields = {}) => ({ id, name: id, ...fields });
const plan = (id, occasion, occasionDate, fields = {}) => ({
  id, contactId: 'c_1', occasion, occasionDate, idea: id, status: 'idea', ...fields,
});

test('24 位联系人的生日和全员节日完整保留，不受全局截断影响', (t) => {
  mockToday(t);
  const contacts = Array.from({ length: 24 }, (_, i) => contact(`c_${i}`, { birthday: '每年-09-22' }));
  const items = deriveOccasions(contacts, []);
  const birthdays = items.filter((o) => o.source === 'birthday');
  assert.equal(birthdays.length, 24);
  assert.deepEqual(birthdays.map((o) => o.contactId), contacts.map((c) => c.id));
  assert.ok(birthdays.every((o) => o.date === '2026-09-22' && o.inDays === 1));
  assert.equal(items.filter((o) => o.occasion === 'mid_autumn').length, 24);
  assert.ok(items.every((o, i) => i === 0 || items[i - 1].inDays <= o.inDays));
});

test('同联系人、归一场合、具体日期才合并，生日与节日优先于计划', (t) => {
  mockToday(t);
  const contacts = [contact('c_1', { birthday: '09-25' }), contact('c_2')];
  const plans = [
    plan('mid_1', '中秋', '2026-09-25'),
    plan('mid_2', '中秋节', '2026-09-25'),
    plan('mid_3', 'mid_autumn', '2026-09-28'),
    plan('birthday', '生日', '2026-09-25'),
    plan('thanks_1', '答谢', '2026-09-25', { status: 'decided' }),
    plan('thanks_2', 'Thank You', '2026-09-25'),
    plan('thanks_3', 'thank_you', '2026-09-28'),
    plan('other_contact', '答谢', '2026-09-25', { contactId: 'c_2' }),
  ];
  const items = deriveOccasions(contacts, plans);
  const mine = items.filter((o) => o.contactId === 'c_1');
  assert.deepEqual(mine.filter((o) => o.occasion === 'mid_autumn').map((o) => [o.date, o.source]), [
    ['2026-09-25', 'holiday'], ['2026-09-28', 'plan'],
  ]);
  assert.deepEqual(mine.filter((o) => o.date === '2026-09-25').map((o) => o.occasion), ['birthday', 'mid_autumn', 'thank_you']);
  assert.equal(mine.find((o) => o.occasion === 'birthday').source, 'birthday');
  assert.deepEqual(mine.filter((o) => o.occasion === 'thank_you').map((o) => o.planId), ['thanks_1', 'thanks_3']);
  assert.deepEqual(mine.find((o) => o.planId === 'thanks_1'), {
    contactId: 'c_1', name: 'c_1', occasion: 'thank_you', label: '答谢',
    date: '2026-09-25', inDays: 4, source: 'plan', planId: 'thanks_1', idea: 'thanks_1', status: 'decided',
  });
  assert.ok(items.some((o) => o.planId === 'other_contact'));
});

test('每人超过五条计划仍完整保留，输入不被修改', (t) => {
  mockToday(t);
  const contacts = Object.freeze([Object.freeze(contact())]);
  const plans = Object.freeze(Array.from({ length: 8 }, (_, i) => Object.freeze(plan(`p_${i}`, 'visit', `2026-09-${21 + i}`))));
  const items = deriveOccasions(contacts, plans);
  assert.equal(items.filter((o) => o.source === 'plan').length, 8);
  assert.equal(items.filter((o) => o.source === 'holiday').length, 2);
});

test('跨年相同场合保留各次具体日期，生日只生成最近一次锚点', (t) => {
  mockToday(t, '2026-12-20T23:30:00');
  const contacts = [contact('c_1', { birthday: '1990-01-02' })];
  const plans = [
    plan('year_1', '元旦', '2027-01-01'),
    plan('year_2', 'new_year', '2028-01-01'),
    plan('birthday_1', '生日', '2027-01-02'),
    plan('birthday_2', 'birthday', '2028-01-02'),
    plan('visit_1', 'visit', '2026-12-31'),
    plan('visit_2', '拜访', '2027-01-03'),
  ];
  const items = deriveOccasions(contacts, plans, 380);
  assert.deepEqual(items.filter((o) => o.occasion === 'new_year').map((o) => [o.date, o.source]), [
    ['2027-01-01', 'holiday'], ['2028-01-01', 'holiday'],
  ]);
  assert.deepEqual(items.filter((o) => o.occasion === 'birthday').map((o) => [o.date, o.source, o.inDays]), [
    ['2027-01-02', 'birthday', 13], ['2028-01-02', 'plan', 378],
  ]);
  assert.deepEqual(items.filter((o) => o.occasion === 'visit').map((o) => o.date), ['2026-12-31', '2027-01-03']);
});

test('生日支持每年、完整年份和月日，使用本地当天而非 UTC 日期', (t) => {
  mockToday(t, '2026-09-21T00:30:00');
  const contacts = [
    contact('annual', { birthday: '每年-09-21' }),
    contact('full', { birthday: '1986-09-22' }),
    contact('month_day', { birthday: '09-23' }),
    contact('past', { birthday: '09-20' }),
    contact('month_only', { birthday: '2026-09' }),
    contact('empty'),
  ];
  assert.deepEqual(deriveOccasions(contacts, [], 2).map((o) => [o.contactId, o.date, o.inDays]), [
    ['annual', '2026-09-21', 0], ['full', '2026-09-22', 1], ['month_day', '2026-09-23', 2],
  ]);
  assert.equal(deriveOccasions(contacts, [], 365).find((o) => o.contactId === 'past' && o.source === 'birthday').date, '2027-09-20');
});

test('窗口含当天与末日，排除超窗、已送、无效日期及无联系人的计划', (t) => {
  mockToday(t);
  const contacts = [contact('c_1', { birthday: '10-22' })];
  const plans = [
    plan('past', 'visit', '2026-09-20'),
    plan('today', 'visit', '2026-09-21'),
    plan('edge', 'visit', '2026-10-21'),
    plan('future', 'visit', '2026-10-22'),
    plan('sent', 'thank_you', '2026-09-22', { status: 'sent' }),
    plan('done', 'visit', '2026-09-23', { status: 'done' }),
    plan('missing', 'visit', '2026-09-22', { contactId: 'missing' }),
    plan('empty', 'visit', ''),
    plan('invalid', 'visit', '2026-09-31'),
    plan('fuzzy', 'visit', '每年-09-22'),
  ];
  const items = deriveOccasions(contacts, plans);
  assert.deepEqual(items.filter((o) => o.source === 'plan').map((o) => o.planId), ['today', 'edge']);
  assert.ok(items.every((o) => o.inDays >= 0 && o.inDays <= 30));
  assert.ok(!items.some((o) => o.source === 'birthday'));
  assert.deepEqual(deriveOccasions(contacts, plans, 0).map((o) => o.planId), ['today']);
});

test('角色节日沿用共享匹配规则', (t) => {
  mockToday(t, '2026-09-01T12:00:00');
  const contacts = [contact('normal'), contact('teacher', { tags: ['老师'] })];
  assert.deepEqual(deriveOccasions(contacts, [], 10).filter((o) => o.occasion === 'teacher_day').map((o) => [o.contactId, o.date]), [
    ['teacher', '2026-09-10'],
  ]);
});

test('枚举显示中文，未知场合保留原标签，空场合为自定义', (t) => {
  mockToday(t);
  for (const [key, label] of Object.entries(OCCASION_CN)) assert.equal(occasionLabel(key), label);
  assert.equal(occasionLabel('Teacher Day'), '教师节');
  assert.equal(occasionKey('中秋节'), 'mid_autumn');
  const labels = ['Team Launch Party', '乔迁宴', '__proto__', 'constructor', ''];
  const items = deriveOccasions([contact()], labels.map((label, i) => plan(`p_${i}`, label, '2026-09-22')));
  assert.deepEqual(items.filter((o) => o.source === 'plan').map((o) => [o.occasion, o.label]), [
    ['team_launch_party', 'Team Launch Party'], ['乔迁宴', '乔迁宴'], ['__proto__', '__proto__'],
    ['constructor', 'constructor'], ['custom', '自定义'],
  ]);
});

test('场合别名查找不读取对象原型属性', () => {
  for (const value of ['__proto__', 'constructor', '__proto__节', 'constructor节', 'toString', 'hasOwnProperty']) {
    assert.equal(occasionKey(value), value.toLowerCase());
    assert.equal(occasionLabel(value), value);
    assert.equal(typeof occasionKey(value), 'string');
  }
});

test('JSON store 在派生前排除归档和 pending 联系人及其计划', async (t) => {
  mockToday(t);
  const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
  const existsSync = fs.existsSync;
  t.mock.method(fs, 'existsSync', (file) => String(file) !== envFile && existsSync(file));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-occasions-'));
  const previousDataDir = process.env.REL_DATA_DIR;
  process.env.REL_DATA_DIR = dataDir;
  let store;
  t.after(() => {
    store?.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.REL_DATA_DIR;
    else process.env.REL_DATA_DIR = previousDataDir;
  });
  store = await import('../../server/store.js');
  const active = store.createContact({ name: '时机确认联系人', birthday: '每年-09-22' });
  const archived = store.createContact({ name: '时机归档联系人', birthday: '每年-09-22' });
  store.updateContact(archived.id, { archived: true });
  const pending = store.createContact({ name: '时机待确认联系人', status: 'pending', birthday: '每年-09-22' });
  for (const c of [active, archived, pending]) {
    store.createPlan({ contactId: c.id, idea: '测试礼物', occasion: 'visit', occasionDate: '2026-09-23' });
  }
  const sent = store.createPlan({ contactId: active.id, idea: '已送礼物', occasion: 'thank_you', occasionDate: '2026-09-23', status: 'sent' });
  const done = store.createPlan({ contactId: active.id, idea: '已散步', occasion: 'walk', occasionDate: '2026-09-23', status: 'done' });
  const items = store.giftOccasions();
  assert.ok(items.length >= 4);
  assert.ok(items.every((o) => o.contactId === active.id));
  assert.equal(items.find((o) => o.source === 'birthday').date, '2026-09-22');
  assert.ok(!items.some((o) => o.planId === sent.id || o.planId === done.id));
  assert.deepEqual(items, deriveOccasions(store.listContacts({ includeArchived: false }), store.listPlans()));
});
