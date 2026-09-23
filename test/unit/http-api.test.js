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

test('POST plan done：仅广播计划变化，无记忆；终态限制、活跃筛选与清建议', { timeout: 20000 }, async () => {
  const request = async (route, method = 'GET', body) => {
    const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  const { data: { contact } } = await request('/api/contacts', 'POST', { name: '普通完成 HTTP' });
  const today = new Date().toISOString().slice(0, 10);
  const { data: { plan } } = await request('/api/plans', 'POST', { contactId: contact.id, idea: '一起散步', occasion: 'walk', occasionDate: today });
  const beforeMemories = (await request('/api/memories')).data;
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  let done;
  try {
    await reader.read(); // hello
    const result = await request(`/api/plans/${plan.id}/done`, 'POST');
    assert.equal(result.status, 200);
    assert.equal('memory' in result.data, false);
    done = result.data.plan;
    assert.equal(done.status, 'done');
    assert.equal(done.memoryId, '');
    assert.equal(done.sentAt, '');
    assert.equal('doneAt' in done, false);
    const { broadcast } = await import('../../server/sse.js');
    broadcast('test.barrier', {});
    let events = '';
    const decoder = new TextDecoder();
    while (!events.includes('event: test.barrier')) events += decoder.decode((await reader.read()).value, { stream: true });
    assert.deepEqual([...events.matchAll(/event: ([^\n]+)/g)].map((m) => m[1]), ['plan.changed', 'test.barrier']);
    assert.ok(events.includes(`"action":"done","planId":"${plan.id}"`));
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  assert.deepEqual((await request(`/api/plans/${plan.id}/done`, 'POST')).data.plan, done);
  assert.deepEqual((await request('/api/memories')).data, beforeMemories);
  assert.equal((await request('/api/plans/missing/done', 'POST')).status, 404);
  assert.equal((await request(`/api/plans/${plan.id}/sent`, 'POST')).status, 400);
  for (const status of ['idea', 'decided', 'sent']) {
    assert.equal((await request(`/api/plans/${plan.id}`, 'PATCH', { status, idea: '不应写入' })).status, 400);
  }
  const listed = (await request('/api/plans?status=done')).data.plans.find((p) => p.id === plan.id);
  assert.equal(listed.idea, '一起散步');
  assert.ok(!(await request('/api/gifts/occasions')).data.occasions.some((o) => o.planId === plan.id));
  const feed = (await request('/api/attention')).data;
  assert.ok(!feed.occasionGroups.flatMap((g) => g.people).flatMap((p) => [...p.plans, ...p.aiIdeas]).some((p) => p.id === plan.id));
  assert.ok(!feed.occasionGroups.some((g) => g.occasion === 'walk'));
  for (const name of ['gift_plan_add', 'gift_plan_update']) {
    for (const status of ['sent', 'done']) {
      assert.equal((await request('/api/tools', 'POST', { name, args: { id: plan.id, contactId: contact.id, idea: 'AI 伪造完成', status } })).status, 400);
    }
  }
  // 这批建议只删除活跃卡；完成及已送的卡和侧车关联保留。
  const ids = {};
  for (const status of ['idea', 'done', 'sent']) {
    const { data } = await request('/api/tools', 'POST', { name: 'gift_plan_add', args: { contactId: contact.id, idea: `建议 ${status}`, basedOnPlanId: plan.id } });
    ids[status] = data.plan.id;
    if (status !== 'idea') assert.equal((await request(`/api/plans/${data.plan.id}/${status}`, 'POST')).status, 200);
  }
  assert.equal((await request(`/api/plans/${ids.sent}/done`, 'POST')).status, 400);
  assert.equal((await request(`/api/plans/${ids.sent}`, 'PATCH', { status: 'idea' })).status, 400);
  assert.equal((await request(`/api/plans/${plan.id}/suggestions`, 'DELETE')).data.deleted, 1);
  const remaining = (await request('/api/plans')).data.plans;
  assert.ok(!remaining.some((p) => p.id === ids.idea));
  for (const status of ['done', 'sent']) assert.equal(remaining.find((p) => p.id === ids[status]).basedOnPlanId, plan.id);
  for (const p of remaining.filter((p) => p.contactId === contact.id)) await request(`/api/plans/${p.id}`, 'DELETE');
  await request(`/api/contacts/${contact.id}`, 'DELETE');
});

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

test('联系人记忆向量搜索只返回相关的已确认未取代记忆', async () => {
  const created = await (await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '向量搜索API' }) })).json();
  const contactId = created.contact.id;
  const coffee = await (await fetch(`${base}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, type: 'preference', content: '喜欢手冲咖啡和浅烘豆' }) })).json();
  const hiking = await (await fetch(`${base}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, type: 'preference', content: '喜欢周末徒步' }) })).json();
  await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_add', args: { contactId, type: 'preference', content: '待确认的咖啡偏好' } }) });
  await fetch(`${base}/api/memories/supersede`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: hiking.memory.id, keepId: coffee.memory.id }) });

  const result = await (await fetch(`${base}/api/contacts/${contactId}/memory-search?q=${encodeURIComponent('咖啡')}`)).json();
  assert.equal(result.ok, true);
  assert.equal(result.contact.id, contactId);
  assert.equal(result.memories[0].id, coffee.memory.id);
  assert.equal(result.memories.some((m) => m.content.includes('待确认')), false);
  assert.equal(result.memories.some((m) => m.id === hiking.memory.id), false);
  assert.ok(result.memories[0].score > 0);
  const vectorCache = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-vectors.json'), 'utf8'));
  assert.ok(vectorCache.items[coffee.memory.id]);

  const empty = await (await fetch(`${base}/api/contacts/${contactId}/memory-search?q=${encodeURIComponent('滑雪')}`)).json();
  assert.deepEqual(empty.memories, []);
  const missing = await fetch(`${base}/api/contacts/c_none/memory-search?q=咖啡`);
  assert.equal(missing.status, 404);
});

test('AI 新建联系人走待确认队列：列表隐藏、手动建档强制已收录、拍板端点与记忆确认联动转正', async () => {
  // AI 通道（tools）新建 → pending
  const viaTool = await (await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'contact_add', args: { name: '熊猫API', relation: 'friend', tags: ['朋友'] } }) })).json();
  assert.equal(viaTool.ok, true);
  assert.equal(viaTool.contact.status, 'pending');
  const pendingId = viaTool.contact.id;

  // pending 不出现在联系人列表（用户可见面）
  const list = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  assert.equal(list.some((c) => c.id === pendingId), false);

  // 但 pending 记忆能挂上，且 memories 列表带出联系人名（AI 新建的人不能显示成未知）
  const mem = await (await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_add', args: { contactId: pendingId, type: 'attribute', content: '经营 GPT 中转站' } }) })).json();
  assert.equal(mem.ok, true);
  const pendingMemories = (await (await fetch(`${base}/api/memories?status=pending`)).json()).memories;
  assert.equal(pendingMemories.find((m) => m.id === mem.memory.id).contactName, '熊猫API');

  // 手动建档即使伪造 status 也强制 confirmed（拍板只能发生在 GUI）
  const forged = await (await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '伪造状态', status: 'pending' }) })).json();
  assert.equal(forged.contact.status, 'confirmed');

  // 确认该记忆 → 涉及的 pending 联系人自动转正（同一拍板动作的连带结果）
  const confirm = await (await fetch(`${base}/api/memories/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [mem.memory.id] }) })).json();
  assert.equal(confirm.confirmed.length, 1);
  assert.equal(confirm.confirmedContacts.length, 1);
  assert.equal(confirm.confirmedContacts[0].id, pendingId);
  assert.equal(confirm.confirmedContacts[0].status, 'confirmed');
  const listAfter = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  assert.ok(listAfter.some((c) => c.id === pendingId), '确认记忆后联系人应出现在列表');

  // 拍板端点：已收录的再确认 → 400
  const reconfirm = await fetch(`${base}/api/contacts/${pendingId}/confirm`, { method: 'POST' });
  assert.equal(reconfirm.status, 400);

  // 拍板端点：pending → confirmed 正常路径 + 404
  const viaTool2 = await (await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'contact_add', args: { name: '熊猫朋友', relation: 'friend' } }) })).json();
  const confirmed = await (await fetch(`${base}/api/contacts/${viaTool2.contact.id}/confirm`, { method: 'POST' })).json();
  assert.equal(confirmed.contact.status, 'confirmed');
  const missing = await fetch(`${base}/api/contacts/c_none/confirm`, { method: 'POST' });
  assert.equal(missing.status, 404);

  // 拒绝 = DELETE 级联：pending 联系人连同其记忆一并删除
  await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_add', args: { contactId: viaTool2.contact.id, type: 'attribute', content: '会被连带删除' } }) });
  const removed = await (await fetch(`${base}/api/contacts/${viaTool2.contact.id}`, { method: 'DELETE' })).json();
  assert.equal(removed.removedMemories, 1);

  // overview 汇报待确认联系人计数
  const overview = (await (await fetch(`${base}/api/overview`)).json());
  assert.ok('pendingContacts' in overview.counts);
  assert.ok(Array.isArray(overview.pendingContacts));
});

test('reject and restore roundtrip via REST', async () => {
  const contacts = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  const contactId = contacts.find((c) => c.name === 'API 小李').id;
  const toolRes = await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_add', args: { contactId, type: 'gift', content: '想收周边', direction: 'contact_to_user' } }) });
  const { memory } = await toolRes.json();

  const rejected = await (await fetch(`${base}/api/memories/${memory.id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '暂不记' }) })).json();
  assert.equal(rejected.memory.status, 'rejected');
  const again = await fetch(`${base}/api/memories/${memory.id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(again.status, 400);
  const restored = await (await fetch(`${base}/api/memories/${memory.id}/restore`, { method: 'POST' })).json();
  assert.equal(restored.memory.status, 'pending');
});

test('materials 多人素材：contactIds 数组保存，列表返回顿号名与 id 数组；非法 id 拒绝', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const c1 = (await post('/api/contacts', { name: '多人素材甲' })).contact;
  const c2 = (await post('/api/contacts', { name: '多人素材乙' })).contact;
  const saved = await post('/api/materials', { text: '中秋给甲送了茶叶，给乙送了月饼', contactIds: [c1.id, c2.id] });
  assert.ok(saved.material.id);
  const list = (await (await fetch(`${base}/api/materials?status=raw`)).json()).materials;
  const mt = list.find((x) => x.id === saved.material.id);
  assert.deepEqual(mt.contactIds, [c1.id, c2.id]);
  assert.equal(mt.contactName, '多人素材甲、多人素材乙');
  const bad = await fetch(`${base}/api/materials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '坏素材', contactIds: [c1.id, 'c_none'] }) });
  assert.equal(bad.status, 404);
});

test('materials API: paste → list → extract via tool → batch confirm', async () => {
  const contacts = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
  const contactId = contacts.find((c) => c.name === 'API 小李').id;

  const invalid = await fetch(`${base}/api/materials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ' ' }) });
  assert.equal(invalid.status, 400);

  const saved = await (await fetch(`${base}/api/materials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '2026-09-11 20:03 小李提到十月婚礼，说自己在学潜水', contactId }) })).json();
  assert.ok(saved.material.id);
  const materialId = saved.material.id;
  assert.equal(saved.material.contactId, contactId);

  const rawList = (await (await fetch(`${base}/api/materials?status=raw`)).json()).materials;
  assert.equal(rawList.some((mt) => mt.id === materialId), true);
  assert.equal(rawList.find((mt) => mt.id === materialId).contactName, 'API 小李');

  const extract = await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memory_batch_add', args: { entries: [
    { contactId, type: 'event', content: '十月办婚礼', sourceId: materialId, sourceQuote: '十月婚礼', saidAt: '2026-09-11 20:03', direction: 'user_to_contact', occasion: 'Wedding' },
    { contactId, type: 'preference', content: '在学潜水', sourceId: materialId, sourceQuote: '在学潜水', saidAt: '2026-09-11 20:03' },
  ] } }) });
  assert.equal(extract.status, 200);
  const created = (await extract.json()).created;
  assert.equal(created.length, 2);
  assert.equal(created[0].saidAt, '2026-09-11 20:03');
  assert.equal(created[0].direction, 'user_to_contact');
  assert.equal(created[0].occasion, 'wedding');
  assert.equal(created[0].sourceQuote, '十月婚礼');
  assert.equal(created[1].saidAt, '2026-09-11 20:03');

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

test('material_report via tools lands on REST payloads; pending_summary counts the queue', async () => {
  const created = await (await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '报告API小李' }) })).json();
  const contactId = created.contact.id;
  const saved = await (await fetch(`${base}/api/materials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '2026-09-11 20:03 聊到孩子快开学了', contactId }) })).json();
  const materialId = saved.material.id;

  const emptyReport = await (await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'material_report', args: { id: materialId, report: '' } }) })).json();
  assert.equal(emptyReport.ok, false);

  const reported = await (await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'material_report', args: { id: materialId, report: '拆出 1 条：孩子快开学了；无冲突' } }) })).json();
  assert.equal(reported.ok, true);
  assert.ok(reported.report.reportedAt);

  // 列表与详情都要能看到报告（工作台素材卡据此渲染）
  const list = (await (await fetch(`${base}/api/materials`)).json()).materials;
  assert.equal(list.find((mt) => mt.id === materialId).report, '拆出 1 条：孩子快开学了；无冲突');
  const detail = (await (await fetch(`${base}/api/materials/${materialId}`)).json()).material;
  assert.equal(detail.report, '拆出 1 条：孩子快开学了；无冲突');
  assert.ok(detail.reportedAt);

  const pendingBefore = (await (await fetch(`${base}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pending_summary', args: {} }) })).json());
  assert.equal(pendingBefore.ok, true);
  assert.ok(Number.isInteger(pendingBefore.pendingCount));

  // 素材删除 → 报告随素材清理
  const deleted = await fetch(`${base}/api/materials/${materialId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
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

test('relations API: CRUD + builtin protection + in-use 409', async () => {
  const json = (res) => res.json();

  // GET 列表：内置 6 类
  const list = await json(await fetch(`${base}/api/relations`));
  assert.equal(list.ok, true);
  const builtinKeys = list.relationTypes.filter((t) => t.builtin).map((t) => t.key);
  assert.deepEqual([...builtinKeys].sort(), ['client', 'colleague', 'family', 'friend', 'other', 'partner']);

  // POST 新增
  const created = await json(await fetch(`${base}/api/relations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'classmate', label: '同学' }) }));
  assert.equal(created.relationType.key, 'classmate');
  assert.equal(created.relationType.label, '同学');

  // 重复 key → 409
  const dup = await fetch(`${base}/api/relations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'classmate', label: '同学2' }) });
  assert.equal(dup.status, 409);

  // 非法 key → 400
  const badKey = await fetch(`${base}/api/relations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'Bad', label: 'x' }) });
  assert.equal(badKey.status, 400);

  // PATCH 改名
  const renamed = await json(await fetch(`${base}/api/relations/classmate`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '老同学' }) }));
  assert.equal(renamed.relationType.label, '老同学');

  // PATCH 404
  const notFound = await fetch(`${base}/api/relations/nope`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) });
  assert.equal(notFound.status, 404);

  // 用自定义类型建联系人
  const contact = await json(await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '关系类型API测试', relation: 'classmate' }) }));
  assert.equal(contact.contact.relation, 'classmate');

  // 无效 relation → 400
  const badRel = await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '坏关系', relation: 'boss' }) });
  assert.equal(badRel.status, 400);

  // DELETE 内置 → 403
  const builtinDel = await fetch(`${base}/api/relations/family`, { method: 'DELETE' });
  assert.equal(builtinDel.status, 403);

  // DELETE 占用中 → 409
  const inUse = await fetch(`${base}/api/relations/classmate`, { method: 'DELETE' });
  assert.equal(inUse.status, 409);
  assert.match((await inUse.json()).error, /正被 1 个联系人使用/);

  // 改掉联系人关系后删除 → 200
  await fetch(`${base}/api/contacts/${contact.contact.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relation: 'friend' }) });
  const deleted = await json(await fetch(`${base}/api/relations/classmate`, { method: 'DELETE' }));
  assert.equal(deleted.key, 'classmate');

  // 确认已删
  const after = await json(await fetch(`${base}/api/relations`));
  assert.equal(after.relationTypes.some((t) => t.key === 'classmate'), false);
});

test('contact memory-search: 排序与噪声过滤、q 截断 100、已取代退出、404', async () => {
  const json = (res) => res.json();
  const created = await json(await fetch(`${base}/api/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '检索老王' }) }));
  const id = created.contact.id;
  const mk = (content) => fetch(`${base}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId: id, type: 'preference', content }) }).then(json);
  const tea = await mk('她只喝武夷岩茶，别的茶碰都不碰');
  const noise = await mk('每周三固定打羽毛球两小时');
  const outdated = await mk('以前只喝速溶咖啡');
  await fetch(`${base}/api/memories/supersede`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: outdated.memory.id, keepId: tea.memory.id }) });

  const hit = await json(await fetch(`${base}/api/contacts/${id}/memory-search?q=${encodeURIComponent('岩茶')}`));
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.memories.map((m) => m.id), [tea.memory.id]);
  assert.ok(hit.memories[0].score >= 0.15);

  const capped = await json(await fetch(`${base}/api/contacts/${id}/memory-search?q=${encodeURIComponent('岩茶'.repeat(60))}`));
  assert.equal(capped.query.length, 100);
  assert.ok(capped.memories.length >= 1);

  const missing = await fetch(`${base}/api/contacts/c_none/memory-search?q=${encodeURIComponent('茶')}`);
  assert.equal(missing.status, 404);

  assert.equal(noise.memory.status, 'confirmed');
});

test('GET /api/fading：疏远预警端点（默认阈值、tier 分档、参数钳制、归档退出）', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const c1 = (await post('/api/contacts', { name: '预警老钱', relation: 'friend' })).contact;
  await post('/api/memories', { contactId: c1.id, type: 'event', content: '很久没见', date: daysAgo(220) });
  const c2 = (await post('/api/contacts', { name: '预警老孔', relation: 'friend' })).contact;
  await post('/api/memories', { contactId: c2.id, type: 'event', content: '上次聊天', date: daysAgo(100) });

  const r = await json(await fetch(`${base}/api/fading`));
  assert.equal(r.ok, true);
  assert.equal(r.thresholdDays, 90);
  const f1 = r.fading.find((f) => f.contactId === c1.id);
  const f2 = r.fading.find((f) => f.contactId === c2.id);
  assert.ok(f1 && f1.tier === 'stale' && f1.days >= 215, '220 天档为 stale');
  assert.ok(f2 && f2.tier === 'attention' && f2.days >= 95, '100 天档为 attention');
  assert.ok(r.fading.every((f, i) => i === 0 || r.fading[i - 1].days >= f.days), '降序');

  const strict = await json(await fetch(`${base}/api/fading?days=200`));
  assert.ok(strict.fading.some((f) => f.contactId === c1.id));
  assert.ok(!strict.fading.some((f) => f.contactId === c2.id));

  const clamped = await json(await fetch(`${base}/api/fading?days=9999&limit=0`));
  assert.equal(clamped.thresholdDays, 365);

  await fetch(`${base}/api/contacts/${c1.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) });
  const after = await json(await fetch(`${base}/api/fading`));
  assert.ok(!after.fading.some((f) => f.contactId === c1.id), '归档后不再预警');
});

test('POST /api/briefing：见面简报 prompt 组装（证据/承诺/禁忌/回礼/间隔），404', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 20 * 86_400_000);
  const bd = `每年-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  const c = (await post('/api/contacts', { name: '简报老贺', relation: 'friend', tags: ['球友'], birthday: bd })).contact;
  await post('/api/memories', { contactId: c.id, type: 'taboo', content: '对花生过敏', date: daysAgo(10) });
  await post('/api/memories', { contactId: c.id, type: 'promise', content: '答应带老家特产', date: daysAgo(120) });
  await post('/api/memories', { contactId: c.id, type: 'preference', content: '只喝武夷岩茶', date: daysAgo(60) });
  await post('/api/memories', { contactId: c.id, type: 'gift', content: 'TA 送了茶叶', direction: 'contact_to_user', date: daysAgo(30) });

  const r = await json(await fetch(`${base}/api/briefing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId: c.id }) }));
  assert.equal(r.ok, true);
  assert.ok(r.evidenceCount >= 4);
  for (const frag of ['简报老贺', '球友', '对花生过敏', '答应带老家特产', '只喝武夷岩茶', 'TA 送了茶叶', '不调用任何写入工具', '待跟进承诺', '相处注意', '尚未回礼', '还有']) {
    assert.ok(r.prompt.includes(frag), `简报 prompt 缺：${frag}`);
  }
  assert.ok(/距上次有记录的互动已 \d+ 天/.test(r.prompt), '含互动间隔');

  // 事实卡搭 timeline 响应：结构化派生（间隔/时机/回礼/承诺/注意），供详情页原生渲染
  const t = await json(await fetch(`${base}/api/contacts/${c.id}/timeline`));
  assert.equal(t.ok, true);
  const card = t.briefing;
  assert.ok(card, 'timeline 须带 briefing 事实卡');
  assert.ok(card.lastSeen && card.lastSeen.days >= 10, '间隔取最近一条有日期记忆（10 天前的禁忌）');
  assert.ok(card.occasions.some((o) => o.inDays >= 0 && o.inDays <= 90), '近期时间点窗口内');
  assert.ok(card.promises.some((p) => p.content === '答应带老家特产'), '承诺进卡');
  assert.ok(card.cautions.some((x) => x.content === '对花生过敏' && x.type === 'taboo'), '禁忌进卡');
  assert.ok(card.reciprocity.some((x) => x.content === 'TA 送了茶叶' && x.hasActivePlan === false), '回礼待回应进卡');

  const missing = await fetch(`${base}/api/briefing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId: 'c_none' }) });
  assert.equal(missing.status, 404);
});

test('GET /api/attention：值得关注 feed 四类派生合流（时机/疏远/待跟进/回礼），按天数升序', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 20 * 86_400_000);
  const bd = `每年-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  // 老贺：生日将到 + 欠承诺 + 欠回礼（近期有收礼记录，不会同时进疏远）
  const c = (await post('/api/contacts', { name: '关注老贺', relation: 'friend', birthday: bd })).contact;
  await post('/api/memories', { contactId: c.id, type: 'promise', content: '答应带老家特产', date: daysAgo(100) });
  await post('/api/memories', { contactId: c.id, type: 'gift', content: 'TA 送了茶叶', direction: 'contact_to_user', date: daysAgo(30) });
  // 老王：唯一一条记忆在 120 天前 → 疏远行
  const b = (await post('/api/contacts', { name: '疏远老王', relation: 'friend' })).contact;
  await post('/api/memories', { contactId: b.id, type: 'interaction', content: '上次一起吃饭', date: daysAgo(120) });

  const r = await json(await fetch(`${base}/api/attention`));
  assert.equal(r.ok, true);
  const items = r.items;
  const mine = items.filter((x) => x.contactId === c.id);
  const birthdayGroup = r.occasionGroups.find((g) => g.occasion === 'birthday' && g.people.some((x) => x.contactId === c.id));
  assert.ok(birthdayGroup && birthdayGroup.days <= 90, '生日独立分组，不被节日挤掉');
  assert.ok(mine.some((x) => x.kind === 'promise' && x.text.includes('老家特产') && x.days >= 100), '承诺行带逾期天数');
  assert.ok(mine.some((x) => x.kind === 'reciprocity' && x.text.includes('茶叶')), '回礼行');
  const fadingRow = items.find((x) => x.contactId === b.id && x.kind === 'fading');
  assert.ok(fadingRow && fadingRow.days >= 120 && fadingRow.text.includes('没有有记录的互动'), '疏远行');
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].days <= items[i - 1].days, '非节日跟进按记录间隔降序');
  }
  for (const x of mine) assert.ok(x.action === 'gift' || x.action === 'briefing', '每行带 AI 行动类型');
});

test('GET /api/attention 行内上下文：上次互动/相处注意/送礼历史/已有计划纯派生 enrich', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 20 * 86_400_000);
  const bd = `每年-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  const c = (await post('/api/contacts', { name: '上下文老蔡', relation: 'friend', birthday: bd })).contact;
  await post('/api/memories', { contactId: c.id, type: 'interaction', content: '上次一起爬山', date: daysAgo(40) });
  await post('/api/memories', { contactId: c.id, type: 'taboo', content: '对花生过敏', date: daysAgo(35) });
  await post('/api/memories', { contactId: c.id, type: 'gift', content: '送过茶叶礼盒', direction: 'user_to_contact', date: daysAgo(30) });
  await post('/api/plans', { contactId: c.id, idea: '备一盒岩茶', occasion: 'birthday' });

  const { items, occasionGroups } = await json(await fetch(`${base}/api/attention`));
  const occasionRow = occasionGroups.filter((g) => g.occasion === 'birthday').flatMap((g) => g.people).find((x) => x.contactId === c.id);
  assert.ok(occasionRow, '生日分组有该联系人的时机行');
  assert.ok(occasionRow.lastSeen && occasionRow.lastSeen.days >= 30, '带上次互动天数');
  assert.ok(occasionRow.evidence.some((e) => e.kind === 'caution' && e.text.includes('花生')), '相处注意进证据');
  assert.ok(occasionRow.evidence.some((e) => e.kind === 'gift' && e.text.includes('茶叶礼盒')), '送礼历史进证据');
  assert.equal(occasionRow.plansTotal, 1);
  assert.ok(occasionRow.plans[0].idea.includes('岩茶'), '进行中计划进上下文');
  const fadingRow = items.find((x) => x.contactId === c.id && x.kind === 'fading');
  if (fadingRow) assert.ok(fadingRow.evidence.some((e) => e.text.includes('爬山')), '疏远行带上次互动内容');
});

test('GET /api/memories/recent：已确认按确认时间倒序，pending 不出现', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const c = (await post('/api/contacts', { name: '最近记住了老唐', relation: 'friend' })).contact;
  await post('/api/memories', { contactId: c.id, type: 'preference', content: '喜欢普洱' });
  await post('/api/memories', { contactId: c.id, type: 'event', content: '女儿考上大学', importance: 3 });

  const items = (await json(await fetch(`${base}/api/memories/recent`))).items;
  assert.ok(items.length >= 1, '至少一条');
  const mine = items.filter((x) => x.contactId === c.id);
  assert.ok(mine.length >= 1, '确认过的记忆出现');
  assert.ok(mine.every((x) => x.contactName === '最近记住了老唐' && x.content), '带联系人名与内容');
  const stamps = items.map((x) => x.confirmedAt || '');
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] <= stamps[i - 1], '按确认时间倒序');
  const limit = (await json(await fetch(`${base}/api/memories/recent?limit=1`))).items;
  assert.equal(limit.length, 1, 'limit 生效');
});

test('POST /api/gift-suggest auto：无预选证据时自动取最近已确认记忆，不带 auto 保持旧行为', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const c = (await post('/api/contacts', { name: '回礼老周', relation: 'friend' })).contact;
  await post('/api/memories', { contactId: c.id, type: 'preference', content: '只喝武夷岩茶', date: daysAgo(5) });

  const r = await post('/api/gift-suggest', { contactId: c.id, occasion: '回礼', auto: true });
  assert.equal(r.ok, true);
  assert.ok(r.evidenceCount >= 1, '自动取到证据');
  assert.ok(r.prompt.includes('武夷岩茶'), '自动证据进 prompt');
  assert.ok(r.prompt.includes('场合：回礼'), '场合传入');

  const r2 = await post('/api/gift-suggest', { contactId: c.id });
  assert.ok(r2.prompt.includes('还没有可用记忆依据'), '无 auto 且无 ids 维持通用保守建议');
});

test('gift-suggest 标签必进 prompt：零记忆只有标签的联系人也能让 AI 据此收敛', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const c = (await post('/api/contacts', { name: '标签陈医生', relation: 'client', tags: ['医生', '科室主任'] })).contact;

  const r = await post('/api/gift-suggest', { contactId: c.id, occasion: '中秋', occasionDate: '2026-09-25', auto: true });
  assert.equal(r.ok, true);
  assert.equal(r.evidenceCount, 0, '零记忆');
  assert.ok(r.prompt.includes('标签：医生 / 科室主任'), '标签进 prompt');
  assert.ok(r.prompt.includes('还没有可用记忆依据'), '明说无记忆，不伪装有依据');
  assert.ok(r.prompt.includes('收敛方向'), '引导 AI 用标签收敛而非泛泛而谈');
});

test('gift-suggest occasionDate 锚定：触发日期进 prompt，防 AI 编日期繁殖提醒行', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const c = (await post('/api/contacts', { name: '日期锚定老秦', relation: 'friend' })).contact;
  const r = await post('/api/gift-suggest', { contactId: c.id, occasion: '中秋', occasionDate: '2026-09-21', auto: true });
  assert.equal(r.ok, true);
  assert.ok(r.prompt.includes('2026-09-21'), '触发日期锚定进建卡纪律');
  assert.ok(r.prompt.includes('绝不自行推断'), '明确禁止编日期');
  const r2 = await post('/api/gift-suggest', { contactId: c.id });
  assert.ok(r2.prompt.includes('不确定就留空'), '无日期时要求留空而非推断');
});

test('时机行只合并同人同场合同日，不吞掉另一天的安排', async () => {
  const post = async (url, body) => (await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const date = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const c = (await post('/api/contacts', { name: '去重老沈', relation: 'friend' })).contact;
  await post('/api/plans', { contactId: c.id, idea: '第一次拜访带茶点', occasion: '拜访', occasionDate: date(7) });
  await post('/api/plans', { contactId: c.id, idea: '第一次拜访带鲜花', occasion: 'visit', occasionDate: date(7) });
  await post('/api/plans', { contactId: c.id, idea: '第二次拜访', occasion: '拜访', occasionDate: date(14) });
  const { occasions } = await (await fetch(`${base}/api/gifts/occasions?days=90`)).json();
  const mine = occasions.filter((o) => o.contactId === c.id && o.occasion === 'visit');
  assert.deepEqual(mine.map((o) => o.date), [date(7), date(14)]);
});

test('POST /api/first-run：按明确联系人先检索，有依据直接建议，必要时才追问', async (t) => {
  const raw = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const post = async (url, body) => {
    const res = await raw(url, body);
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.ok, true);
    return result;
  };
  const get = async (url) => {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const checkPrompt = (result, scenario) => {
    const { prompt, contactId } = result;
    assert.ok(contactId);
    assert.ok(prompt.includes(`contactId=${contactId}`), '明确联系人编号');
    assert.ok(prompt.includes(`（${scenario}）`), '保留场景');
    const firstStep = prompt.match(/^1\. 先调用 memory_search，参数 (\{[^\n]+\})，检索该联系人的已确认记忆/m);
    assert.ok(firstStep, '第一步按明确 ID 检索已确认记忆');
    const args = JSON.parse(firstStep[1]);
    assert.deepEqual(args, { contactId });
    assert.ok(prompt.indexOf('memory_search') < prompt.indexOf('直接给一项具体可执行建议'));
    assert.ok(prompt.indexOf('memory_search') < prompt.indexOf('最多问 1-2 个必要问题'));
    assert.match(prompt, /只有检索结果为空时才说明暂无已确认记忆/);
    assert.match(prompt, /用户原话仍可作为本次建议的依据/);
    assert.match(prompt, /依据足够时直接给一项具体可执行建议/);
    assert.match(prompt, /自然的表达或行动示例/);
    assert.match(prompt, /仅关键上下文缺失且影响下一步时，最多问 1-2 个必要问题/);
    assert.match(prompt, /分开标注用户原话与已确认记忆/);
    assert.match(prompt, /推断与事实分开/);
    assert.match(prompt, /不把 AI 生成的建议、示例或计划当作已发生事实，也不得将其登记为记忆/);
    assert.ok(prompt.includes(`memory_add（contactId=${contactId}）`));
    assert.match(prompt, /AI 写入记忆一律为待确认（pending）状态/);
    assert.match(prompt, /确认入库是用户的拍板动作/);
    assert.match(prompt, /回工作台待确认队列操作/);
    assert.doesNotMatch(prompt, /用户刚把|工作台里还没有这个人的长期记忆|先别急着给成品|拿到回答后，再给/);
    if (scenario === 'gift') {
      assert.match(prompt, /本次为明确的 gift（送礼）场景，可以讨论送礼，但不默认需要采购/);
    } else {
      assert.match(prompt, /本次不是 gift 场景，不建议送礼或采购/);
      assert.doesNotMatch(prompt, /可以讨论送礼/);
    }
    return args;
  };

  await t.test('新建联系人：充分原话可以直接作为依据，不自动存成记忆', async () => {
    const note = '教师节想给班主任发消息，感谢他去年帮我修改志愿；希望简短自然，不送礼。';
    const r = await post('/api/first-run', { name: '  首次班主任老李  ', scenario: 'say', note: ` ${note} ` });
    assert.equal(r.created, true);
    assert.ok(r.prompt.includes('「首次班主任老李」'));
    assert.ok(r.prompt.includes(`用户原话（本次补充，尚非已确认记忆）：${JSON.stringify(note)}`));
    const args = checkPrompt(r, 'say');
    const contacts = (await get('/api/contacts')).contacts.filter((c) => c.name === '首次班主任老李');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].id, r.contactId);
    assert.equal(contacts[0].status, 'confirmed');
    assert.deepEqual((await post('/api/tools', { name: 'memory_search', args })).memories, []);
    assert.deepEqual((await get(`/api/memories?contact_id=${r.contactId}`)).memories, []);
  });

  await t.test('复用已有记忆的人：三种场景均先检索，只取该人已确认记忆', async () => {
    const c = (await post('/api/contacts', { name: '首价值老周' })).contact;
    const known = (await post('/api/memories', { contactId: c.id, type: 'interaction', direction: 'both', content: '上次一起散步时约好下次再去公园' })).memory;
    assert.equal(known.status, 'confirmed');
    await post('/api/tools', { name: 'memory_add', args: { contactId: c.id, type: 'preference', content: '可能喜欢咖啡' } });
    const other = (await post('/api/contacts', { name: '首价值另一位' })).contact;
    await post('/api/memories', { contactId: other.id, type: 'preference', content: '喜欢红茶' });
    const before = (await get(`/api/memories?contact_id=${c.id}`)).memories;
    for (const scenario of ['say', 'gift', 'reconnect']) {
      const r = await post('/api/first-run', { name: '首价值老周', scenario });
      assert.equal(r.created, false);
      assert.equal(r.contactId, c.id);
      assert.doesNotMatch(r.prompt, /用户原话（本次补充/);
      const args = checkPrompt(r, scenario);
      const found = await post('/api/tools', { name: 'memory_search', args });
      assert.deepEqual(found.memories.map((m) => m.id), [known.id]);
      assert.equal(found.memories[0].content, known.content);
    }
    assert.equal((await get('/api/contacts')).contacts.filter((item) => item.name === c.name).length, 1);
    assert.deepEqual((await get(`/api/memories?contact_id=${c.id}`)).memories, before, '生成 prompt 不写入或确认记忆');
  });

  await t.test('400 校验：空名、缺失或未知场景不能创建联系人', async () => {
    const before = (await get('/api/contacts')).contacts;
    for (const name of [undefined, null, '', '   ']) {
      const res = await raw('/api/first-run', { name, scenario: 'say' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /名字不能为空/);
    }
    for (const scenario of [undefined, null, '', 'nope', 'toString', 'constructor', '__proto__']) {
      const res = await raw('/api/first-run', { name: '无效场景不能建档', scenario });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /未知场景/);
    }
    assert.deepEqual((await get('/api/contacts')).contacts, before);
  });
});

test('节日锚点表：全员节日/角色节日/计算型/农历查表生成时机行', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const anyone = (await post('/api/contacts', { name: '锚点老白', relation: 'friend' })).contact;
  const teacher = (await post('/api/contacts', { name: '锚点孔老师', relation: 'other', tags: ['班主任'] })).contact;
  const mom = (await post('/api/contacts', { name: '锚点妈妈', relation: 'family' })).contact;
  const occasions = (await json(await fetch(`${base}/api/gifts/occasions?days=365`))).occasions;
  const mine = (id) => occasions.filter((o) => o.contactId === id);
  assert.ok(mine(anyone.id).some((o) => o.occasion === 'new_year' && o.date.endsWith('-01-01')), '元旦（固定公历）全员行');
  assert.ok(mine(teacher.id).some((o) => o.occasion === 'teacher_day'), '老师有教师节行');
  assert.ok(!mine(anyone.id).some((o) => o.occasion === 'teacher_day'), '非老师无教师节行');
  assert.ok(mine(mom.id).some((o) => o.occasion === 'mother_day' && /-05-\d\d$/.test(o.date)), '母亲节（计算型周日）匹配"妈"称谓');
  assert.ok(!mine(anyone.id).some((o) => o.occasion === 'mother_day'), '非母亲无母亲节行');
  // 农历查表只预置 2026/2027；之后年份跑此测试跳过中秋断言
  if (new Date().getFullYear() <= 2027) {
    assert.ok(mine(anyone.id).some((o) => o.occasion === 'mid_autumn'), '中秋（农历查表）全员行');
  }
});

test('attention 计划分层：你的计划与 AI 主意分开呈现', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const soon = new Date(Date.now() + 20 * 86_400_000);
  const bd = `每年-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  const c = (await post('/api/contacts', { name: '分层老齐', relation: 'friend', birthday: bd })).contact;
  const { plan } = await post('/api/plans', { contactId: c.id, idea: '我的手作礼盒', occasion: '生日' });
  await post('/api/tools', { name: 'gift_plan_add', args: { contactId: c.id, idea: 'AI 的护嗓茶建议', basedOnPlanId: plan.id } });
  const { occasionGroups } = await json(await fetch(`${base}/api/attention`));
  const row = occasionGroups.filter((g) => g.occasion === 'birthday').flatMap((g) => g.people).find((x) => x.contactId === c.id);
  assert.ok(row, '有生日时机行');
  assert.equal(row.plansTotal, 1, '你的计划单独计数');
  assert.ok(row.plans[0].idea.includes('手作礼盒'), '用户建卡进你的计划');
  assert.equal(row.aiIdeaCount, 1, 'AI 主意单独计数');
  assert.ok(row.aiIdeas[0].idea.includes('护嗓茶'), 'AI 建卡进主意见区');
  assert.equal(row.aiIdeas[0].basedOnPlanId, plan.id, '保留原计划关联');
});

test('节日行与计划行同场合同日归并，保留其他年份的节日', async () => {
  const post = async (url, body) => (await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const c = (await post('/api/contacts', { name: '归并老纪', relation: 'friend' })).contact;
  const before = (await (await fetch(`${base}/api/gifts/occasions?days=365`)).json()).occasions;
  const holiday = before.find((o) => o.contactId === c.id && o.source === 'holiday');
  assert.ok(holiday, '一年内至少有一个节日');
  await post('/api/plans', { contactId: c.id, idea: '茶点礼盒', occasion: holiday.label, occasionDate: holiday.date });
  const after = (await (await fetch(`${base}/api/gifts/occasions?days=365`)).json()).occasions;
  const rows = after.filter((o) => o.contactId === c.id && o.occasion === holiday.occasion);
  assert.deepEqual(rows.map((o) => o.date), before.filter((o) => o.contactId === c.id && o.occasion === holiday.occasion).map((o) => o.date));
  assert.equal(rows.filter((o) => o.date === holiday.date).length, 1);
  assert.ok(rows.every((o) => o.source === 'holiday'), '同日计划不替代真实节日锚点');
});

test('attention 时机行：个人锚点优先，occasion 存归一枚举，同场合历史证据跨语言命中', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const c = (await post('/api/contacts', { name: '归一老卫', relation: 'friend' })).contact;
  // 计划场合写大写英文枚举、非老师联系人：计划行 occasion 归一、label 翻译为中文
  await post('/api/plans', { contactId: c.id, idea: '手工灯笼', occasion: 'TEACHER_DAY', occasionDate: '2026-11-01' });
  // 记忆场合写中文「教师节」：与计划行归一键（teacher_day）同键，历史证据应跨语言命中
  await post('/api/memories', { contactId: c.id, type: 'gift', content: '去年教师节送过钢笔', direction: 'user_to_contact', occasion: '教师节', date: daysAgo(370) });
  const { occasionGroups } = await json(await fetch(`${base}/api/attention`));
  const row = occasionGroups.flatMap((g) => g.people).find((x) => x.contactId === c.id && x.occasion === 'teacher_day');
  assert.ok(row, '计划是个人锚点，出时机行');
  assert.equal(row.source, 'plan', '个人锚点（计划）优先于全员节日');
  assert.equal(row.occasion, 'teacher_day', 'occasion 归一为枚举');
  assert.equal(row.label, '教师节', 'label 翻译为中文');
  assert.ok(row.evidence.some((e) => e.kind === 'history' && e.text.includes('钢笔')), '同场合历史证据跨语言命中');
  for (const group of occasionGroups) {
    const ids = group.people.map((p) => p.contactId);
    assert.equal(ids.length, new Set(ids).size, '同一场合同一天，每个联系人只有一行');
  }
});

test('upcomingHolidays：两周内全员节日时间轴，角色节日不进，按临近排序', async () => {
  const json = (res) => res.json();
  const r = await json(await fetch(`${base}/api/attention?days=90&limit=5`));
  assert.ok(Array.isArray(r.holidays), '返回时间轴节日');
  assert.ok(r.holidays.every((h) => h.inDays >= 0 && h.inDays <= 14), '两周窗口');
  assert.ok(r.holidays.every((h) => !['teacher_day', 'mother_day', 'father_day'].includes(h.occasion)), '角色节日不进时间轴');
  for (let i = 1; i < r.holidays.length; i++) assert.ok(r.holidays[i].inDays >= r.holidays[i - 1].inDays, '按临近排序');
});

test('attention opportunities：节日提示与分组互斥，遵守请求时间窗', async () => {
  for (const days of [1, 90]) {
    const data = await (await fetch(`${base}/api/attention?days=${days}`)).json();
    const covered = new Set(data.occasionGroups.map((g) => g.id));
    assert.ok(data.opportunities.every((h) => !covered.has(`${h.occasion}|${h.date}`)));
    assert.ok(data.holidays.every((h) => h.inDays <= Math.min(days, 14)));
  }
});

test('首页按联系人、场合和日期关联计划，未定/已送/旧年不串本次，AI 建议跟随原计划', async () => {
  const post = async (url, body) => {
    const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const date = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const c = (await post('/api/contacts', { name: '场合隔离联系人', birthday: date(9).slice(5) })).contact;
  const birthday = (await post('/api/plans', { contactId: c.id, idea: '生日手作蛋糕', occasion: '生日', occasionDate: date(9) })).plan;
  const visit = (await post('/api/plans', { contactId: c.id, idea: '拜访带书', occasion: 'visit', occasionDate: date(9) })).plan;
  const nextVisit = (await post('/api/plans', { contactId: c.id, idea: '下次拜访带花', occasion: '拜访', occasionDate: date(19) })).plan;
  await post('/api/plans', { contactId: c.id, idea: '旧年生日计划', occasion: 'birthday', occasionDate: date(-350) });
  await post('/api/plans', { contactId: c.id, idea: '没有场合的想法' });
  const sent = (await post('/api/plans', { contactId: c.id, idea: '已经送出的礼物', occasion: 'birthday', occasionDate: date(9) })).plan;
  await post(`/api/plans/${sent.id}/sent`, {});
  const ai = (await post('/api/tools', { name: 'gift_plan_add', args: { contactId: c.id, idea: '给蛋糕配茶', basedOnPlanId: birthday.id } })).plan;
  await post('/api/tools', { name: 'gift_plan_add', args: { contactId: c.id, idea: '未关联的 AI 主意' } });
  const r = await (await fetch(`${base}/api/attention`)).json();
  const person = (occasion, day) => r.occasionGroups.find((g) => g.occasion === occasion && g.date === day)?.people.find((p) => p.contactId === c.id);
  const b = person('birthday', date(9));
  assert.deepEqual(b.plans.map((p) => p.id), [birthday.id]);
  assert.deepEqual(b.aiIdeas.map((p) => p.id), [ai.id]);
  assert.equal(b.aiIdeas[0].basedOnPlanId, birthday.id);
  assert.equal(b.aiIdeas[0].occasionDate, date(9));
  assert.deepEqual(person('visit', date(9)).plans.map((p) => p.id), [visit.id]);
  assert.deepEqual(person('visit', date(19)).plans.map((p) => p.id), [nextVisit.id]);
  const undated = person('custom', '');
  assert.equal(undated.plans[0].idea, '没有场合的想法');
  assert.equal(undated.aiIdeas[0].idea, '未关联的 AI 主意');
  assert.equal(r.occasionGroups.some((g) => g.people.some((p) => p.plans.some((plan) => plan.idea === '旧年生日计划'))), false);
  for (const group of r.occasionGroups.filter((g) => !['birthday', 'visit', 'custom'].includes(g.occasion))) {
    const row = group.people.find((p) => p.contactId === c.id);
    if (row) assert.equal(row.plansTotal + row.aiIdeaCount, 0, '生日和拜访计划不串节日');
  }
});

test('同一时机保留超过二十人，并把有计划的人排在前面', async () => {
  const post = async (url, body) => (await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const d = new Date(); d.setDate(d.getDate() + 8);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push((await post('/api/contacts', { name: `分组人数-${i}`, birthday: date.slice(5) })).contact.id);
  await post('/api/plans', { contactId: ids[23], idea: '最后一人的已定安排', occasion: '生日', occasionDate: date, status: 'decided' });
  const { occasionGroups } = await (await fetch(`${base}/api/attention`)).json();
  const group = occasionGroups.find((g) => g.occasion === 'birthday' && g.date === date);
  assert.ok(ids.every((id) => group.people.some((p) => p.contactId === id)));
  assert.equal(group.people[0].contactId, ids[23]);
  assert.equal(group.people.filter((p) => ids.includes(p.contactId)).length, 24);
});

test('继续计划的 AI 指令锚定原计划，拒绝跨联系人关联与读取', async () => {
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const c = (await (await post('/api/contacts', { name: '指令计划主人' })).json()).contact;
  const other = (await (await post('/api/contacts', { name: '不能串人的对象' })).json()).contact;
  const plan = (await (await post('/api/plans', { contactId: c.id, idea: '原计划不可另起', occasion: 'birthday', occasionDate: '2027-05-10' })).json()).plan;
  const r = await (await post('/api/gift-suggest', { contactId: c.id, planId: plan.id, occasion: '中秋', occasionDate: '2027-09-15' })).json();
  assert.ok(r.prompt.includes('原计划不可另起'));
  assert.ok(r.prompt.includes('2027-05-10'));
  assert.ok(r.prompt.includes('场合：生日'));
  assert.ok(r.prompt.includes(plan.id));
  assert.equal((await post('/api/gift-suggest', { contactId: other.id, planId: plan.id })).status, 404);
  assert.equal((await post('/api/tools', { name: 'gift_plan_add', args: { contactId: other.id, idea: '跨人错误关联', basedOnPlanId: plan.id } })).status, 400);
  const greeting = await (await post('/api/briefing', { contactId: c.id, occasion: '中秋' })).json();
  assert.ok(greeting.prompt.includes('围绕「中秋」联系'));
  assert.ok(greeting.prompt.includes('不默认需要送礼'));
});

test('素材超过三十份仍返回早期反问，不因列表截断隐藏重要状态', async () => {
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const material = (await post('/api/materials', { text: '较早保存，仍需补充的素材' })).material;
  await post('/api/tools', { name: 'organize_question', args: {
    materialId: material.id, question: '这条内容是否还需整理？', options: [
      { label: '继续', command: `继续整理素材 ${material.id}` },
      { label: '跳过', command: `跳过素材 ${material.id}` },
    ],
  } });
  for (let i = 0; i < 31; i++) await post('/api/materials', { text: `后来保存的普通素材 ${i}` });
  const { materials } = await (await fetch(`${base}/api/materials`)).json();
  assert.ok(materials.length > 30);
  assert.equal(materials.find((mt) => mt.id === material.id)?.question?.question, '这条内容是否还需整理？');
});
