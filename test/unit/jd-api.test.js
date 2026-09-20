import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-jd-fake-cli-'));
const fixtureFile = path.join(dir, 'fixture.json');
const logFile = path.join(dir, 'calls.jsonl');
const binary = path.join(dir, 'fake-relstore.cjs');
const previous = Object.fromEntries(['REL_DATA_DIR', 'RELSTORE_DB', 'RELSTORE_BIN', 'REL_STORE'].map((key) => [key, process.env[key]]));
Object.assign(process.env, { REL_DATA_DIR: dir, RELSTORE_DB: path.join(dir, 'unused.db'), RELSTORE_BIN: binary, REL_STORE: 'json' });
fs.writeFileSync(logFile, '');
fs.writeFileSync(fixtureFile, '{}');
fs.writeFileSync(binary, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\n');
let reply = fixture.reply;
if (fixture.storePlan) {
  const plan = fixture.storePlan;
  if (args[0] === 'plan' && args[1] === 'list') reply = { ok: true, plans: [plan] };
  if (args[0] === 'plan' && args[1] === 'set') reply = { ok: true, plan: { ...plan, productUrl: args[args.indexOf('--product-url') + 1] } };
}
setTimeout(() => {
  process.stderr.write(fixture.stderr || 'FAKE_SECRET_MUST_NOT_LEAK');
  process.stdout.write(fixture.stdout ?? JSON.stringify(reply));
  process.exitCode = fixture.code || 0;
}, fixture.delay || 0);
`, { mode: 0o700 });
const { runAsync } = await import('../../server/relstore-bridge.js');
const { startRelBench, closeRelBench } = await import('../../server/index.js');
const store = (await import('../../server/store-facade.js')).default;
const rustStore = await import('../../server/store-rust.js');
const started = await startRelBench({ port: 0, log: () => {} });
const base = `http://127.0.0.1:${started.server.address().port}`;
const contact = store.createContact({ name: '隔离测试联系人' });
const product = { productName: '官方保温杯', productPrice: '99.50', productUrl: 'https://u.jd.com/' + 'x'.repeat(1000) };
const item = { itemId: '123456', name: '保温杯', price: 99.5, imageUrl: 'https://img.example.test/cup.png' };

function fixture(value) { fs.writeFileSync(fixtureFile, JSON.stringify(value)); }
function calls() { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
function newPlan() { return store.createPlan({ contactId: contact.id, idea: '给联系人准备礼物的私密理由', budget: '一两百左右', source: 'ai' }); }
async function request(route, body, method = 'POST') {
  const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
function nextCall() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('fake CLI 未启动')); }, 5000);
    const watcher = fs.watch(logFile, () => { clearTimeout(timer); watcher.close(); resolve(); });
  });
}

test.beforeEach(() => { fixture({ reply: { ok: true, configured: false, missing: ['JD_APP_KEY', 'JD_APP_SECRET', 'JD_SITE_ID'] } }); fs.writeFileSync(logFile, ''); });
test.after(async () => {
  await closeRelBench(started.server);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('隔离 fake CLI（非真实京东）：status 只返回配置状态和变量名', async () => {
  fixture({ reply: { ok: true, configured: false, missing: ['JD_APP_SECRET'], secret: 'FAKE_SECRET_MUST_NOT_LEAK' } });
  assert.deepEqual(await request('/api/jd/status', undefined, 'GET'), { status: 200, data: { ok: true, configured: false, missing: ['JD_APP_SECRET'] } });
  assert.deepEqual(calls(), [['jd', 'status', '--json', '--db', process.env.RELSTORE_DB]]);
  assert.equal(fs.existsSync(process.env.RELSTORE_DB), false);
});

test('search 只发送显式关键词/数字范围，无 shell、计划或关系信息', async () => {
  const plan = newPlan();
  const keyword = '保温杯; $(not-a-command)';
  fixture({ reply: { ok: true, items: [item], secret: 'FAKE_SECRET_MUST_NOT_LEAK' } });
  const result = await request(`/api/plans/${plan.id}/jd/search`, { keyword, minPrice: 0, maxPrice: 200, idea: plan.idea, contact: contact.name, command: 'contact', bin: '/not-allowed' });
  assert.deepEqual(result, { status: 200, data: { ok: true, items: [item] } });
  assert.deepEqual(calls(), [['jd', 'search', '--keyword', keyword, '--min-price', '0', '--max-price', '200', '--json', '--db', process.env.RELSTORE_DB]]);
  assert.equal(store.getPlan(plan.id).productUrl, '');
  fixture({ reply: { ok: true, items: [] } });
  assert.deepEqual((await request(`/api/plans/${plan.id}/jd/search`, { keyword: '杯', minPrice: '', maxPrice: null })).data.items, []);
});

test('80 字关键词、百万价格上限与 256 字联盟 ID 可完整往返', async () => {
  const plan = newPlan();
  const keyword = '茶'.repeat(80);
  const longItem = { ...item, itemId: 'x'.repeat(256) };
  fixture({ reply: { ok: true, items: [longItem] } });
  const result = await request(`/api/plans/${plan.id}/jd/search`, { keyword, maxPrice: 1000000 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.items, [longItem]);
  assert.deepEqual(calls()[0].slice(0, 6), ['jd', 'search', '--keyword', keyword, '--max-price', '1000000']);
  fixture({ reply: { ok: true, product } });
  assert.equal((await request(`/api/plans/${plan.id}/jd/select`, { itemId: longItem.itemId })).status, 200);
  assert.equal(calls()[1][3], longItem.itemId);
});

test('计划/输入校验在外网调用前完成，已送计划不可搜或选', async () => {
  const plan = newPlan();
  for (const body of [{}, null, [], { keyword: ' ' }, { keyword: 'x'.repeat(81) }, { keyword: 'a\u0000b' }, { keyword: 'a\u007fb' }, { keyword: '杯', minPrice: -1 }, { keyword: '杯', maxPrice: 1000001 }, { keyword: '杯', maxPrice: '100' }, { keyword: '杯', minPrice: 200, maxPrice: 100 }, { keyword: '杯', maxPrice: {} }]) {
    assert.equal((await request(`/api/plans/${plan.id}/jd/search`, body)).status, 400);
  }
  for (const body of [{}, { itemId: 123 }, { itemId: '' }, { itemId: 'a\n' }, { itemId: '--db' }, { itemId: 'x'.repeat(257) }, { itemId: 'https://u.jd.com/test' }]) {
    assert.equal((await request(`/api/plans/${plan.id}/jd/select`, body)).status, 400);
  }
  for (const action of ['search', 'select']) {
    assert.equal((await request(`/api/plans/missing/jd/${action}`, { keyword: '杯', itemId: '123' })).status, 404);
  }
  store.updatePlan(plan.id, { status: 'sent' });
  for (const action of ['search', 'select']) assert.equal((await request(`/api/plans/${plan.id}/jd/${action}`, { keyword: '杯', itemId: '123' })).status, 400);
  assert.deepEqual(calls(), []);
});

test('select 只信任 Rust 商品字段，关联原 AI 计划并广播，保留状态/依据/记忆', async () => {
  const basePlan = newPlan();
  const plan = newPlan();
  store.linkPlanSuggestion(plan.id, basePlan.id);
  const beforeCount = store.listPlans().length;
  const beforeMemories = store.listMemories().length;
  fixture({ reply: { ok: true, product: { ...product, status: 'sent', idea: '不得覆盖', contactId: 'unknown' } } });
  const controller = new AbortController();
  const events = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = events.body.getReader();
  await reader.read();
  try {
    const result = await request(`/api/plans/${plan.id}/jd/select`, { itemId: item.itemId, productName: '伪造名称', productPrice: '0.01', productUrl: 'https://attacker.invalid', status: 'sent' });
    assert.equal(result.status, 200);
    assert.deepEqual(calls(), [['jd', 'promote', '--item-id', item.itemId, '--json', '--db', process.env.RELSTORE_DB]]);
    assert.equal(result.data.plan.id, plan.id);
    assert.equal(result.data.plan.source, 'ai');
    assert.equal(result.data.plan.status, 'idea');
    assert.equal(result.data.plan.idea, plan.idea);
    assert.equal(result.data.plan.contactId, contact.id);
    for (const key of Object.keys(product)) assert.equal(result.data.plan[key], product[key]);
    assert.equal(store.planSuggestionBase(plan.id), basePlan.id);
    assert.equal(store.listPlans().length, beforeCount);
    assert.equal(store.listMemories().length, beforeMemories);
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: plan.changed/);
    assert.ok(event.includes(plan.id));
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});

test('JD 异步调用不阻塞 API，等待期间已送/删除的计划不再关联', async () => {
  for (const action of ['sent', 'delete']) {
    const plan = newPlan();
    fixture({ reply: { ok: true, product }, delay: 300 });
    const invoked = nextCall();
    let finished = false;
    const pending = request(`/api/plans/${plan.id}/jd/select`, { itemId: item.itemId }).then((res) => { finished = true; return res; });
    await invoked;
    assert.equal((await request('/api/info', undefined, 'GET')).status, 200);
    assert.equal(finished, false);
    if (action === 'sent') store.updatePlan(plan.id, { status: 'sent' }); else store.deletePlan(plan.id);
    const result = await pending;
    assert.equal(result.status, action === 'sent' ? 400 : 404);
    assert.equal(store.getPlan(plan.id)?.productUrl || '', '');
  }
});

test('JSON 安全错误可在 exit 1 时传递状态，失败不更改计划', async () => {
  const plan = newPlan();
  for (const status of [400, 404, 502, 503, 504]) {
    fixture({ reply: { ok: false, error: '京东请求失败，请重试', status }, code: 1 });
    assert.deepEqual(await request(`/api/plans/${plan.id}/jd/select`, { itemId: item.itemId }), { status, data: { ok: false, error: '京东请求失败，请重试' } });
    assert.equal(store.getPlan(plan.id).productUrl, '');
  }
});

test('桥拒绝命令/参数注入、不完整和超限响应，不泄露原始输出或 stderr', async () => {
  for (const args of [['contact', 'list'], ['jd', 'status', '--db', '/tmp/other'], ['jd', 'promote', '--item-id', '1', '--item-id', '2'], ['jd', 'search'], ['jd', 'search', '--keyword', 'a\0b']]) {
    await assert.rejects(runAsync(args), { status: 400 });
  }
  assert.deepEqual(calls(), []);
  for (const bad of [
    { stdout: 'FAKE_SECRET_MUST_NOT_LEAK', code: 1 },
    { stdout: 'FAKE_SECRET_MUST_NOT_LEAK\n{"ok":true,"configured":true,"missing":[]}' },
    { stdout: 'x'.repeat(300 * 1024) },
    { reply: { ok: true, configured: true, missing: ['FAKE_SECRET_MUST_NOT_LEAK'] } },
    { reply: { ok: false, error: 'FAKE_SECRET_MUST_NOT_LEAK', status: 500 }, code: 1 },
    { reply: { ok: true, configured: true, missing: [] }, code: 1 },
  ]) {
    fixture(bad);
    const result = await request('/api/jd/status', undefined, 'GET');
    assert.ok([502, 504].includes(result.status));
    assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET|xxx|stderr/);
  }
  fixture({ reply: { ok: true, items: Array(21).fill(item) } });
  await assert.rejects(runAsync(['jd', 'search', '--keyword', '杯']), { status: 502 });
  fixture({ reply: { ok: true, product: { ...product, productUrl: 'javascript:alert(1)' } } });
  await assert.rejects(runAsync(['jd', 'promote', '--item-id', '123']), { status: 502 });
});

test('进程无法启动时固定安全错误，不输出本机二进制内容', async () => {
  process.env.RELSTORE_BIN = dir;
  try {
    await assert.rejects(runAsync(['jd', 'status']), (err) => err.status === 502 && !err.message.includes(dir));
  } finally { process.env.RELSTORE_BIN = binary; }
});

test('JSON 与 Rust Node 校验均保留 4096 字链接，4097 字明确拒绝而非截断', async () => {
  const plan = newPlan();
  const url = 'https://u.jd.com/'.padEnd(4096, 'x');
  const result = await request(`/api/plans/${plan.id}`, { productUrl: url }, 'PATCH');
  assert.equal(result.data.plan.productUrl, url);
  const bad = await request(`/api/plans/${plan.id}`, { productUrl: url + 'x' }, 'PATCH');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /4096/);
  assert.equal(store.getPlan(plan.id).productUrl, url);
  fixture({ storePlan: { ...plan, productUrl: '' } });
  assert.equal(rustStore.updatePlan(plan.id, { productUrl: url }).productUrl, url);
  assert.throws(() => rustStore.updatePlan(plan.id, { productUrl: url + 'x' }), /4096/);
  const setters = calls().filter((args) => args[1] === 'set');
  assert.equal(setters.length, 1);
  assert.equal(setters[0][setters[0].indexOf('--product-url') + 1], url);
});

test('外网桥 30 秒超时返回固定安全 504（fake CLI，无真实网络）', { timeout: 35_000 }, async () => {
  fixture({ reply: { ok: true, configured: true, missing: [] }, delay: 60_000 });
  const start = Date.now();
  await assert.rejects(runAsync(['jd', 'status']), (err) => err.status === 504 && !err.message.includes('FAKE_SECRET'));
  assert.ok(Date.now() - start >= 29_000);
});
