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
  assert.ok(mine.some((x) => x.kind === 'occasion' && x.label === '生日' && x.days <= 90), '时机行（生日在窗口内）');
  assert.ok(mine.some((x) => x.kind === 'promise' && x.text.includes('老家特产') && x.days >= 100), '承诺行带逾期天数');
  assert.ok(mine.some((x) => x.kind === 'reciprocity' && x.text.includes('茶叶')), '回礼行');
  const fadingRow = items.find((x) => x.contactId === b.id && x.kind === 'fading');
  assert.ok(fadingRow && fadingRow.days >= 120 && fadingRow.text.includes('没有有记录的互动'), '疏远行');
  for (let i = 1; i < items.length; i++) {
    assert.ok((items[i].days ?? Infinity) >= (items[i - 1].days ?? Infinity), 'feed 按天数升序');
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

  const items = (await json(await fetch(`${base}/api/attention`))).items;
  const occasionRow = items.find((x) => x.contactId === c.id && x.kind === 'occasion');
  assert.ok(occasionRow, '有生日时机行');
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

test('时机行按天去重：同人同日多张不同场合标签的计划只出一条提醒', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const c = (await post('/api/contacts', { name: '去重老沈', relation: 'friend' })).contact;
  // 两张卡同一天、场合标签不一致（模拟 AI 建卡标签漂移：中秋 vs 中秋节）
  await post('/api/plans', { contactId: c.id, idea: '手作茶点礼盒', occasion: '中秋', occasionDate: '2026-09-21' });
  await post('/api/plans', { contactId: c.id, idea: '护嗓润喉礼盒', occasion: '中秋节', occasionDate: '2026-09-21' });
  const occasions = (await json(await fetch(`${base}/api/gifts/occasions?days=90`))).occasions;
  const mine = occasions.filter((o) => o.contactId === c.id && o.date === '2026-09-21');
  assert.equal(mine.length, 1, '同人同日只有一条时机行（计划上下文并入该行）');
});

test('POST /api/first-run：空库首价值——建联系人返回先问后给 prompt，同名复用，400 校验', async () => {
  const json = (res) => res.json();
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const raw = (body) => fetch(`${base}/api/first-run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const r = await post('/api/first-run', { name: '班主任老李', scenario: 'say', note: '教师节想发消息，五年没联系' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.ok(r.prompt.includes('班主任老李'), 'prompt 含联系人名');
  assert.ok(r.prompt.includes('先别急着给成品'), '先问后给');
  assert.ok(r.prompt.includes('五年没联系'), '用户补充进 prompt');
  assert.ok(r.prompt.includes('1-2 个最关键的问题'), '要求先提问');
  assert.ok(r.prompt.includes('待确认'), '事实落待确认');

  // 同名复用既有联系人，不建重
  const r2 = await post('/api/first-run', { name: '班主任老李', scenario: 'gift' });
  assert.equal(r2.created, false);
  assert.equal(r2.contactId, r.contactId);

  // 400：空名 / 未知场景
  assert.equal((await raw({ name: '', scenario: 'say' })).status, 400);
  assert.equal((await raw({ name: '某人', scenario: 'nope' })).status, 400);
});
