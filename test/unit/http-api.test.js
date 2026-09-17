import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-api-'));
process.env.REL_DATA_DIR = dataDir;
const { startRelBench, closeRelBench } = await import('../../server/index.js');
const started = await startRelBench({ port: 0, openBrowser: false, log: () => {} });
const base = `http://127.0.0.1:${started.server.address().port}`;

test.after(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); await closeRelBench(started.server); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('info and overview report status', async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.ok, true);
  assert.equal(info.name, 'dsh-relationship');
  assert.ok(Array.isArray(info.tools));
  const overview = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(overview.ok, true);
  assert.ok('pending' in overview.counts);
});

test('static frontend is served', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /关系记忆/);
  const missing = await fetch(`${base}/no-such-file.js`);
  assert.equal(missing.status, 404);
});

test('contacts API validates and CRUDs', async () => {
  const invalid = await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /姓名不能为空/);

  const badBirthday = await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '日期错', birthday: '13-99' }) });
  assert.equal(badBirthday.status, 400);

  const created = await (await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API 小李', relation: 'friend', birthday: '10-02' }) })).json();
  const id = created.contact.id;
  assert.equal(created.contact.name, 'API 小李');

  const patched = await fetch(`${base}/api/contacts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: '老同学' }) });
  assert.equal((await patched.json()).contact.notes, '老同学');

  const notFound = await fetch(`${base}/api/contacts/c_none`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'x' }) });
  assert.equal(notFound.status, 404);
});

test('manual memory POST is confirmed, tool memory_add is pending, confirm via REST', async () => {
  const contacts = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  const contactId = contacts.find((c) => c.name === 'API 小李').id;

  const manual = await (await fetch(`${base}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, type: 'preference', content: '喜欢手冲咖啡' }) })).json();
  assert.equal(manual.memory.status, 'confirmed');

  const toolRes = await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_add', args: { contactId, type: 'event', content: '十月婚礼', date: '2026-10-__' } }) });
  assert.equal(toolRes.status, 200);
  const tool = await toolRes.json();
  assert.equal(tool.memory.status, 'pending');

  const pendingList = (await (await fetch(`${base}/api/memories?status=pending`)).json()).memories;
  assert.equal(pendingList.some((m) => m.id === tool.memory.id), true);

  const badConfirm = await fetch(`${base}/api/memories/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [] }) });
  assert.equal(badConfirm.status, 400);

  const confirmed = await (await fetch(`${base}/api/memories/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [tool.memory.id], edits: { [tool.memory.id]: { importance: 3 } } }) })).json();
  assert.equal(confirmed.confirmed[0].importance, 3);

  const timeline = (await (await fetch(`${base}/api/contacts/${contactId}/timeline`)).json());
  assert.equal(timeline.memories.length, 2);
  assert.equal(timeline.memories.some((m) => m.content === '十月婚礼'), true);

  const unknownTool = await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope', args: {} }) });
  assert.equal(unknownTool.status, 400);
});

test('reject and restore roundtrip via REST', async () => {
  const contacts = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  const contactId = contacts.find((c) => c.name === 'API 小李').id;
  const toolRes = await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_add', args: { contactId, type: 'gift', content: '想收周边' } }) });
  const { memory } = await toolRes.json();

  const rejected = await (await fetch(`${base}/api/memories/${memory.id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '暂不记' }) })).json();
  assert.equal(rejected.memory.status, 'rejected');
  const again = await fetch(`${base}/api/memories/${memory.id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(again.status, 400);
  const restored = await (await fetch(`${base}/api/memories/${memory.id}/restore`, { method: 'POST' })).json();
  assert.equal(restored.memory.status, 'pending');
});

test('materials API: paste → list → extract via tool → batch confirm', async () => {
  const contacts = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  const contactId = contacts.find((c) => c.name === 'API 小李').id;

  const invalid = await fetch(`${base}/api/materials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ' ' }) });
  assert.equal(invalid.status, 400);

  const saved = await (await fetch(`${base}/api/materials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '小李提到十月婚礼和学潜水的事', contactId }) })).json();
  assert.ok(saved.material.id);
  const materialId = saved.material.id;
  assert.equal(saved.material.contactId, contactId);

  const rawList = (await (await fetch(`${base}/api/materials?status=raw`)).json()).materials;
  assert.equal(rawList.some((mt) => mt.id === materialId), true);
  assert.equal(rawList.find((mt) => mt.id === materialId).contactName, 'API 小李');

  const extract = await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_batch_add', args: { entries: [
    { contactId, type: 'event', content: '十月婚礼', sourceId: materialId, saidAt: '2026-09-11 20:03', direction: 'user_to_contact', occasion: 'Wedding' },
    { contactId, type: 'preference', content: '在学潜水', sourceId: materialId },
  ] } }) });
  assert.equal(extract.status, 200);
  const created = (await extract.json()).created;
  assert.equal(created.length, 2);
  assert.equal(created[0].saidAt, '2026-09-11 20:03');
  assert.equal(created[0].direction, 'user_to_contact');
  assert.equal(created[0].occasion, 'wedding');
  assert.equal(created[1].saidAt, '');

  // V4：memories 列表支持 direction/occasion/lifespan 过滤
  const filtered = await (await fetch(`${base}/api/memories?direction=user_to_contact&occasion=wedding`)).json();
  assert.equal(filtered.memories.some((m) => m.id === created[0].id), true);

  // V5：礼物计划 HTTP 流——创建 → 标已送自动入账 → 出主意 prompt → 删除
  const planRes = await fetch(`${base}/api/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, idea: '岩茶礼盒', occasion: 'thank_you', budget: '¥200' }) });
  assert.equal(planRes.status, 200);
  const plan = (await planRes.json()).plan;
  assert.equal(plan.source, 'user');
  const sentRes = await (await fetch(`${base}/api/plans/${plan.id}/sent`, { method: 'POST' })).json();
  assert.equal(sentRes.plan.status, 'sent');
  assert.ok(sentRes.memory.id);
  const ledger = await (await fetch(`${base}/api/gifts/ledger`)).json();
  assert.equal(ledger.given.some((m) => m.id === sentRes.memory.id), true);
  const occasions = await (await fetch(`${base}/api/gifts/occasions?days=3650`)).json();
  assert.ok(Array.isArray(occasions.occasions));
  // gift-suggest 只采用已确认记忆：手动记一笔（author=user 即确认）作为证据
  const manual = await (await fetch(`${base}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, type: 'preference', content: '非常喜欢小主持课', direction: 'user_to_contact' }) })).json();
  const suggest = await (await fetch(`${base}/api/gift-suggest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, memoryIds: [manual.memory.id], budget: '¥300' }) })).json();
  assert.equal(suggest.ok, true);
  assert.ok(suggest.prompt.includes('gift_plan_add'));
  assert.ok(suggest.prompt.includes('小主持课'));
  assert.equal(suggest.evidenceCount, 1);
  const delRes = await fetch(`${base}/api/plans/${plan.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);

  const processedList = (await (await fetch(`${base}/api/materials?status=processed`)).json()).materials;
  const material = processedList.find((mt) => mt.id === materialId);
  assert.ok(material);
  assert.equal(material.extracted.length, 2);
  assert.equal(material.extracted.every((m) => m.status === 'pending'), true);

  const confirm = await (await fetch(`${base}/api/memories/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: created.map((m) => m.id) }) })).json();
  assert.equal(confirm.confirmed.length, 2);

  const full = (await (await fetch(`${base}/api/materials/${materialId}`)).json()).material;
  assert.equal(full.status, 'processed');
  assert.match(full.text, /学潜水/);

  const deleted = await fetch(`${base}/api/materials/${materialId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const gone = await fetch(`${base}/api/materials/${materialId}`);
  assert.equal(gone.status, 404);
  assert.equal((await (await fetch(`${base}/api/memories?q=学潜水`)).json()).memories.length, 1);
});

test('contact delete cascades and unknown api 404s', async () => {
  const created = await (await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '待删除' }) })).json();
  const id = created.contact.id;
  await fetch(`${base}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId: id, type: 'event', content: '将被级联删除' }) });
  const removed = await (await fetch(`${base}/api/contacts/${id}`, { method: 'DELETE' })).json();
  assert.equal(removed.removedMemories, 1);
  const memories = (await (await fetch(`${base}/api/memories?q=级联删除`)).json()).memories;
  assert.equal(memories.length, 0);

  const unknown = await fetch(`${base}/api/nothing-here`);
  assert.equal(unknown.status, 404);
});
