import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = path.join(root, 'rust/relstore/target/release/relstore');
const serverURL = new URL('../../server/index.js', import.meta.url).href;
const localDate = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const ids = (items) => items.map((item) => item.id).sort();
const withoutDelivery = ({ delivery, ...record }) => record;

// 子进程在导入服务前绑定临时库，防止后端切换复用模块缓存。
async function startServer(backend, dataDir) {
  const env = { ...process.env, REL_STORE: backend, REL_DATA_DIR: dataDir,
    RELSTORE_DB: path.join(dataDir, 'rel.db'), RELSTORE_BIN: binary };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { startRelBench, closeRelBench } = await import(${JSON.stringify(serverURL)});
    const { server } = await startRelBench({ port: 0, openBrowser: false, log() {} });
    process.on('message', async (message) => {
      if (message !== 'close') return;
      server.closeIdleConnections?.();
      await closeRelBench(server);
      process.disconnect();
    });
    process.send({ port: server.address().port });
  `], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let timer;
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`server exited before ready (${code}): ${output}`)));
    timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 20_000);
  });
  let port;
  try { ({ port } = await ready); }
  catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
  assert.ok(Number.isInteger(port) && port > 0);
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      if (child.connected) child.send('close');
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const result = await exited;
        assert.equal(result.code, 0, `server shutdown (${result.signal}): ${output}`);
      } finally { clearTimeout(timeout); }
    },
  };
}

for (const backend of ['json', 'rust']) {
  test(`followup and material delivery HTTP API: ${backend}`, { timeout: 180_000 }, async (t) => {
    if (backend === 'rust') fs.accessSync(binary, fs.constants.X_OK);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rel-followup-api-${backend}-`));
    let server;
    t.after(async () => {
      try { await server?.close(); }
      finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
    });
    server = await startServer(backend, dataDir);
    const restart = async () => {
      await server.close();
      server = await startServer(backend, dataDir);
    };
    const request = async (route, method = 'GET', body, expectedStatus = 200) => {
      const response = await fetch(server.base + route, {
        method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      assert.equal(response.status, expectedStatus, `${method} ${route}: ${text}`);
      const data = JSON.parse(text);
      assert.equal(data.ok, expectedStatus === 200, `${method} ${route}: ${text}`);
      if (expectedStatus !== 200) assert.equal(typeof data.error, 'string');
      return data;
    };
    assert.equal((await request('/api/info')).dataDir, dataDir);
    const contact = async (name) => (await request('/api/contacts', 'POST', { name, relation: 'friend' })).contact;
    const memory = async (contactId, fields = {}) => (await request('/api/memories', 'POST', {
      contactId, type: 'promise', content: 'HTTP promise', date: localDate(-30), ...fields,
    })).memory;
    const followups = async (contactId, includeHandled = false) =>
      (await request(`/api/followups${includeHandled ? '?include_handled=true' : ''}`)).items.filter((item) => item.contactId === contactId);
    const patch = async (item, status, extra = {}) => {
      const result = await request(`/api/followups/${encodeURIComponent(item.id)}`, 'PATCH', {
        status, sourceVersion: item.sourceVersion, ...extra,
      });
      assert.equal(result.item.id, item.id);
      assert.equal(result.item.sourceVersion, item.sourceVersion);
      assert.equal(result.item.status, status);
      return result.item;
    };
    const facts = async (contactId) => (await request(`/api/memories?contact_id=${contactId}`)).memories;
    const materialDetail = async (id) => (await request(`/api/materials/${encodeURIComponent(id)}`)).material;
    const materialListItem = async (id) => (await request('/api/materials')).materials.find((item) => item.id === id);

    await t.test('organize prompts reference the reachable listener, never an untrusted Host', async () => {
      const { material } = await request('/api/materials', 'POST', { text: 'prompt endpoint roundtrip' });
      const response = await fetch(`${server.base}/api/materials/${material.id}/organize-prompt`, { headers: { Host: 'untrusted.invalid:1234' } });
      assert.equal(response.status, 200);
      const { prompt } = await response.json();
      const toolsUrl = prompt.match(/工具入口 POST ([^\s，]+)/)?.[1];
      assert.equal(toolsUrl, `${server.base}/api/tools`);
      const toolResponse = await fetch(toolsUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'material_get', args: { id: material.id } }) });
      assert.equal(toolResponse.status, 200);
      const result = await toolResponse.json();
      assert.equal(result.ok, true);
      assert.equal(result.material.text, 'prompt endpoint roundtrip');
    });

    await t.test('two promises and reciprocity stay independent across all read surfaces and a fresh server', async () => {
      const c = await contact('HTTP independent reminders');
      const first = await memory(c.id, { content: '承诺甲：整理相册' });
      const second = await memory(c.id, { content: '承诺乙：预约球场', date: localDate(-20) });
      const gift = await memory(c.id, { type: 'gift', content: '收礼丙：手工茶杯', direction: 'contact_to_user', date: localDate(-10) });
      const plan = (await request('/api/plans', 'POST', { contactId: c.id, idea: '考虑回赠点心' })).plan;
      const fading = await contact('HTTP fading remains independent');
      await memory(fading.id, { type: 'interaction', content: '很久以前一起散步', date: localDate(-200) });
      const originalFacts = await facts(c.id);
      const originalLedger = await request('/api/gifts/ledger');
      const originalPlans = await request('/api/plans');
      const initial = await followups(c.id);
      assert.deepEqual(ids(initial), [`promise:${first.id}`, `promise:${second.id}`, `reciprocity:${gift.id}`].sort());
      const states = new Map(initial.map((item) => [item.id, 'active']));
      const versions = new Map(initial.map((item) => [item.id, item.sourceVersion]));
      for (const item of initial) {
        assert.equal(item.status, 'active');
        assert.equal(typeof item.sourceVersion, 'string');
        assert.ok(item.sourceVersion.length > 0);
      }
      const checkSurfaces = async () => {
        const all = await followups(c.id, true);
        assert.deepEqual(ids(all), ids(initial));
        for (const item of all) {
          assert.equal(item.status, states.get(item.id));
          assert.equal(item.sourceVersion, versions.get(item.id));
        }
        const active = all.filter((item) => states.get(item.id) === 'active');
        assert.deepEqual(ids(await followups(c.id)), ids(active));
        const explicit = (await request('/api/followups?include_handled=false')).items.filter((item) => item.contactId === c.id);
        assert.deepEqual(ids(explicit), ids(active));
        const attention = (await request('/api/attention')).items;
        const reminders = attention.filter((item) => item.contactId === c.id && ['promise', 'reciprocity'].includes(item.kind));
        assert.deepEqual(ids(reminders), ids(active), 'attention must neither collapse two promises nor show handled reminders');
        for (const item of reminders) assert.equal(item.sourceVersion, versions.get(item.id));
        assert.ok(attention.some((item) => item.contactId === fading.id && item.kind === 'fading'));
        const reciprocity = (await request('/api/gifts/reciprocity')).items.filter((item) => item.contactId === c.id);
        const giftActive = states.get(`reciprocity:${gift.id}`) === 'active';
        assert.equal(reciprocity.length, giftActive ? 1 : 0);
        if (giftActive) {
          for (const [key, value] of Object.entries({ name: c.name, date: gift.date, content: gift.content, memoryId: gift.id, hasActivePlan: true })) {
            assert.equal(reciprocity[0][key], value, `legacy reciprocity field ${key}`);
          }
        }
        const timeline = await request(`/api/contacts/${c.id}/timeline`);
        assert.deepEqual(timeline.briefing.promises.map((item) => item.content).sort(), active.filter((item) => item.kind === 'promise').map((item) => item.content).sort());
        assert.deepEqual(timeline.briefing.reciprocity.map((item) => item.content), giftActive ? [gift.content] : []);
        assert.deepEqual(ids(timeline.memories), ids(originalFacts));
        const { prompt } = await request('/api/briefing', 'POST', { contactId: c.id });
        for (const m of [first, second]) assert.equal(prompt.includes(m.content), states.get(`promise:${m.id}`) === 'active');
        // A handled gift may still be cited as a historical fact, never as an outstanding obligation.
        const reciprocityLine = prompt.split('\n').find((line) => line.startsWith('回礼待回应：')) || '';
        assert.equal(reciprocityLine.includes(gift.content), giftActive);
        assert.deepEqual(await facts(c.id), originalFacts, 'handling and generating prompts never rewrite source memories');
        assert.deepEqual(await request('/api/gifts/ledger'), originalLedger);
        assert.deepEqual(await request('/api/plans'), originalPlans, `handling does not complete plan ${plan.id}`);
      };
      await checkSurfaces();
      for (const [id, status, extra] of [
        [`promise:${first.id}`, 'done', {}],
        [`promise:${second.id}`, 'dismissed', {}],
        [`reciprocity:${gift.id}`, 'snoozed', { until: localDate(7) }],
      ]) {
        const changed = await patch(initial.find((item) => item.id === id), status, extra);
        if (status === 'snoozed') assert.equal(changed.until, extra.until);
        states.set(id, status);
        await checkSurfaces();
      }
      await restart();
      await checkSurfaces();
      assert.equal((await followups(c.id, true)).find((item) => item.kind === 'reciprocity').until, localDate(7));
      for (const item of initial) {
        assert.equal((await patch(item, 'active')).until, '');
        states.set(item.id, 'active');
        await checkSurfaces();
      }
    });

    await t.test('source edits return 409 for stale versions; missing and no-longer-eligible sources return 404', async () => {
      const c = await contact('HTTP source version');
      const source = await memory(c.id, { content: '修改前的承诺' });
      const old = (await followups(c.id))[0];
      await patch(old, 'done');
      await request(`/api/memories/${source.id}`, 'PATCH', { content: '修改后的承诺' });
      const current = (await followups(c.id))[0];
      assert.equal(current.id, old.id);
      assert.equal(current.content, '修改后的承诺');
      assert.equal(current.status, 'active');
      assert.notEqual(current.sourceVersion, old.sourceVersion);
      await request(`/api/followups/${encodeURIComponent(old.id)}`, 'PATCH', { status: 'done', sourceVersion: old.sourceVersion }, 409);
      assert.deepEqual(await followups(c.id), [current]);
      await patch(current, 'done');
      await request(`/api/memories/${source.id}`, 'DELETE');
      assert.deepEqual(await followups(c.id, true), []);
      await request(`/api/followups/${encodeURIComponent(current.id)}`, 'PATCH', { status: 'active', sourceVersion: current.sourceVersion }, 404);
      const firstGift = await memory(c.id, { type: 'gift', direction: 'contact_to_user', content: '较早收到的礼物', date: localDate(-5) });
      const oldGift = (await followups(c.id))[0];
      await patch(oldGift, 'dismissed');
      const latestGift = await memory(c.id, { type: 'gift', direction: 'contact_to_user', content: '新收到的礼物', date: localDate(-1) });
      assert.equal(oldGift.memoryId, firstGift.id);
      assert.deepEqual((await followups(c.id, true)).map((item) => item.memoryId), [latestGift.id]);
      await request(`/api/followups/${encodeURIComponent(oldGift.id)}`, 'PATCH', { status: 'active', sourceVersion: oldGift.sourceVersion }, 404);
      assert.ok((await facts(c.id)).some((item) => item.id === firstGift.id), 'ineligible historical gifts are not deleted');
    });

    await t.test('invalid followup bodies, fields, dates and versions are rejected without mutation', async () => {
      const c = await contact('HTTP invalid reminder writes');
      await memory(c.id);
      const item = (await followups(c.id))[0];
      const route = `/api/followups/${encodeURIComponent(item.id)}`;
      const valid = { status: 'done', sourceVersion: item.sourceVersion };
      const before = await followups(c.id, true);
      const invalid = [null, [], {}, { sourceVersion: item.sourceVersion }, { status: 'done' },
        ...['', 'sent', 'organized', 'unknown'].map((status) => ({ ...valid, status })),
        ...[null, 3, {}, '', 'not-a-version'].map((sourceVersion) => ({ ...valid, sourceVersion })),
        { ...valid, unexpected: true }, { ...valid, memoryId: item.memoryId },
        { ...valid, until: localDate(7) }, { status: 'snoozed', sourceVersion: item.sourceVersion },
        ...[null, '', 123, localDate(), localDate(-1), '2999-02-29', '2999-04-31', '2999-13-01', '2999-1-01', '2999-01-01T00:00:00Z'].map((until) => ({ ...valid, status: 'snoozed', until })),
      ];
      for (const body of invalid) await request(route, 'PATCH', body, 400);
      const otherVersion = `${item.sourceVersion[0] === 'a' ? 'b' : 'a'}${item.sourceVersion.slice(1)}`;
      await request(route, 'PATCH', { ...valid, sourceVersion: otherVersion }, 409);
      for (const id of ['promise:missing', 'reciprocity:missing', '__proto__', 'constructor']) {
        await request(`/api/followups/${encodeURIComponent(id)}`, 'PATCH', valid, 404);
      }
      assert.deepEqual(await followups(c.id, true), before);
    });

    await t.test('material delivery roundtrips and survives restart without organizing or confirming', async () => {
      const c = await contact('HTTP material dispatch');
      const material = (await request('/api/materials', 'POST', { contactId: c.id, text: '待整理素材：喜欢喝红茶' })).material;
      const route = `/api/materials/${encodeURIComponent(material.id)}/delivery`;
      const original = await materialDetail(material.id);
      const originalList = await materialListItem(material.id);
      assert.equal(original.delivery, null);
      assert.equal(originalList.delivery, null);
      assert.equal(original.status, 'raw');
      const originalFacts = await facts(c.id);
      const copied = (await request(route, 'POST', { status: 'copied' })).delivery;
      assert.ok(Number.isFinite(Date.parse(copied.copiedAt)));
      assert.equal(copied.sentAt, '');
      assert.deepEqual((await materialDetail(material.id)).delivery, copied);
      assert.deepEqual((await materialListItem(material.id)).delivery, copied);
      const sent = (await request(route, 'POST', { status: 'sent' })).delivery;
      assert.ok(Number.isFinite(Date.parse(sent.sentAt)));
      assert.equal(sent.copiedAt, copied.copiedAt);
      const laterCopy = (await request(route, 'POST', { status: 'copied' })).delivery;
      assert.equal(laterCopy.sentAt, sent.sentAt, 'copying later must not downgrade sent');
      assert.ok(Number.isFinite(Date.parse(laterCopy.copiedAt)));
      assert.deepEqual(withoutDelivery(await materialDetail(material.id)), withoutDelivery(original));
      assert.deepEqual(withoutDelivery(await materialListItem(material.id)), withoutDelivery(originalList));
      assert.deepEqual(await facts(c.id), originalFacts);
      await restart();
      assert.deepEqual((await materialDetail(material.id)).delivery, laterCopy);
      assert.deepEqual((await materialListItem(material.id)).delivery, laterCopy);
      assert.equal((await materialDetail(material.id)).status, 'raw');
      const pending = (await request('/api/tools', 'POST', { name: 'memory_add', args: {
        contactId: c.id, type: 'preference', content: '喜欢喝红茶', sourceId: material.id, sourceQuote: '喜欢喝红茶',
      } })).memory;
      assert.equal(pending.status, 'pending');
      const pendingBefore = await facts(c.id);
      const extractedBefore = await materialListItem(material.id);
      for (const status of ['sent', 'copied']) await request(route, 'POST', { status });
      assert.deepEqual(await facts(c.id), pendingBefore, 'dispatch cannot confirm extracted memories');
      assert.deepEqual(withoutDelivery(await materialListItem(material.id)), withoutDelivery(extractedBefore));
      assert.equal((await materialListItem(material.id)).report, '');
      assert.equal((await materialListItem(material.id)).reportedAt, '');
      const direct = (await request('/api/materials', 'POST', { text: '直接发送，不经过复制' })).material;
      const directSent = (await request(`/api/materials/${direct.id}/delivery`, 'POST', { status: 'sent' })).delivery;
      assert.equal(directSent.copiedAt, '');
      assert.ok(Number.isFinite(Date.parse(directSent.sentAt)));
    });

    await t.test('material delivery rejects invalid or missing records without changing the material', async () => {
      const material = (await request('/api/materials', 'POST', { text: 'HTTP delivery validation' })).material;
      const route = `/api/materials/${encodeURIComponent(material.id)}/delivery`;
      const before = await materialDetail(material.id);
      for (const body of [null, [], {}, { status: null }, { status: '' }, { status: 'done' }, { status: 'organized' },
        { status: 'copied', unknown: true }, { status: 'sent', sentAt: '2999-01-01' }]) {
        await request(route, 'POST', body, 400);
      }
      assert.deepEqual(await materialDetail(material.id), before);
      assert.equal((await materialListItem(material.id)).delivery, null);
      for (const status of ['copied', 'sent']) await request('/api/materials/mt_missing/delivery', 'POST', { status }, 404);
      await request(route, 'POST', { status: 'sent' });
      await request(`/api/materials/${material.id}`, 'DELETE');
      await request(route, 'POST', { status: 'copied' }, 404);
      await request(`/api/materials/${material.id}`, 'GET', undefined, 404);
      assert.equal(await materialListItem(material.id), undefined);
    });

    await t.test('successful handling broadcasts followup.changed over real SSE', async () => {
      const c = await contact('HTTP followup SSE');
      await memory(c.id);
      const item = (await followups(c.id))[0];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let reader;
      try {
        const response = await fetch(server.base + '/api/events', { signal: controller.signal });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        reader = response.body.getReader();
        await patch(item, 'done');
        const decoder = new TextDecoder();
        let events = '';
        let found;
        while (!found) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, 'SSE must remain open until followup.changed');
          events += decoder.decode(chunk.value, { stream: true });
          found = events.match(/event: followup\.changed\ndata: ([^\n]+)\n\n/);
        }
        const changed = JSON.parse(found[1]);
        assert.equal(changed.id, item.id);
        assert.equal(changed.contactId, c.id);
        assert.equal(changed.status, 'done');
      } finally {
        clearTimeout(timer);
        controller.abort();
        await reader?.cancel().catch(() => {});
      }
    });
  });
}
