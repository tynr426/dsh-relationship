import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-csearch-'));
process.env.REL_DATA_DIR = dataDir;
process.env.REL_STORE = 'json';
const tools = await import('../../server/tools.js');
const store = (await import('../../server/store-facade.js')).default;

test.after(() => { store.flush(); fs.rmSync(dataDir, { recursive: true, force: true }); });

store.createContact({ name: '星屿-iqc-周老师', tags: ['负责来料质检项目；接待客户'] });
store.createContact({ name: '星屿-iqc-老大', tags: ['星屿质量部的老大；爱垂钓'] });
store.createContact({ name: '星屿-采购-林老师', tags: ['公司采购员'] });
store.createContact({ name: '王小雨', tags: ['大学同学'] });
store.createContact({ name: '赵铁柱', tags: ['老师'] });

const search = (query) => tools.executeTool('contact_search', { query });
const names = (r) => r.matches.map((m) => m.name);

test('「机构+姓+角色」整串称呼按字序命中带分隔符的姓名，不误报同事', async () => {
  const r = await search('星屿周老师');
  assert.equal(r.ok, true);
  assert.deepEqual(names(r), ['星屿-iqc-周老师']);
  assert.ok(r.matches[0].matchedBy.some((x) => x.includes('字序')), JSON.stringify(r.matches[0].matchedBy));
});

test('整句「下周二找星屿周老师吃饭」仍命中周老师且不误报林老师', async () => {
  const r = await search('下周二找星屿周老师吃饭');
  assert.equal(names(r)[0], '星屿-iqc-周老师');
  assert.ok(!names(r).includes('星屿-采购-林老师'));
});

test('单字姓氏保持原有包含匹配', async () => {
  const r = await search('周');
  assert.deepEqual(names(r), ['星屿-iqc-周老师']);
});

test('简称「周老师」不误报同为老师的林老师', async () => {
  const r = await search('周老师');
  assert.deepEqual(names(r), ['星屿-iqc-周老师']);
});

test('标签独立入围保持原有行为，且角色标签只作加分不当入围', async () => {
  const tagHit = await search('爱垂钓');
  assert.deepEqual(names(tagHit), ['星屿-iqc-老大']);
  assert.ok(tagHit.matches[0].matchedBy.includes('标签含查询'));
  const teacher = await search('老师');
  assert.deepEqual(names(teacher).slice(0, 2), ['星屿-iqc-周老师', '星屿-采购-林老师']);
  assert.equal(names(teacher).at(-1), '赵铁柱', '纯标签命中排最后');
  const noise = await search('星屿周老师');
  assert.ok(!names(noise).includes('赵铁柱'), '无关姓名仅因查询含其标签字面不得入围');
});

test('机构词命中多人（现状行为保留）', async () => {
  const r = await search('星屿');
  assert.equal(names(r).length, 3);
});

test('查无此人返回空列表与新建提示', async () => {
  const r = await search('张三丰');
  assert.equal(r.ok, true);
  assert.deepEqual(r.matches, []);
  assert.ok(r.提示.includes('contact_add'));
});

test('空 query 报错（现状行为保留）', async () => {
  const r = await search('  ');
  assert.equal(r.ok, false);
});
