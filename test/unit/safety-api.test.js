import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-safety-api-'));
process.env.REL_DATA_DIR = dataDir;
process.env.REL_STORE = 'json';
const { startRelBench, closeRelBench } = await import('../../server/index.js');
const { server } = await startRelBench({ port: 0, log() {} });
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (route, method = 'GET', body, headers = {}) => {
  const response = await fetch(base + route, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
};

test.after(async () => {
  await closeRelBench(server);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('backup endpoints reject cross-site access and non-JSON writes', async () => {
  assert.equal((await request('/api/data/status', 'GET', undefined, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await request('/api/data/status', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/data/backups', 'POST', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request('/api/data/status', 'GET', undefined, { origin: base })).status, 200);
});

test('backup preview is read-only, expires on changes, and confirmation is single-use', async () => {
  const { data: { contact } } = await request('/api/contacts', 'POST', { name: '恢复 API 联系人' });
  const { data: { backup } } = await request('/api/data/backups', 'POST', {});
  assert.ok(backup.id);
  const exported = await request(`/api/data/backups/${encodeURIComponent(backup.id)}/download`);
  assert.equal(exported.status, 200);
  assert.equal((await request('/api/data/restore/confirm', 'POST', { token: 'not-a-preview' })).status, 409);
  const preview = await request('/api/data/restore/preview', 'POST', { backupId: backup.id });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.token);
  const { data: { contact: later } } = await request('/api/contacts', 'POST', { name: '预览后新增' });
  assert.equal((await request('/api/data/restore/confirm', 'POST', { token: preview.data.token })).status, 409);
  assert.equal((await request(`/api/contacts/${later.id}`)).status, 200);
  const second = await request('/api/data/restore/preview', 'POST', { backup: exported.data });
  assert.equal(second.status, 200);
  assert.equal((await request(`/api/contacts/${later.id}`)).status, 200);
  const restored = await request('/api/data/restore/confirm', 'POST', { token: second.data.token });
  assert.equal(restored.status, 200);
  assert.equal((await request(`/api/contacts/${later.id}`)).status, 404);
  assert.equal((await request(`/api/contacts/${contact.id}`)).status, 200);
  assert.equal((await request('/api/data/restore/confirm', 'POST', { token: second.data.token })).status, 409);
  assert.equal((await request('/api/data/restore/preview', 'POST', { backup: { format: 'invalid' } })).status, 400);
  assert.equal((await request(`/api/contacts/${contact.id}`)).status, 200);
});

test('backup creation refuses an in-flight mutation', async () => {
  const pending = http.request(base + '/api/contacts', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 1000 },
  });
  pending.on('error', () => {});
  pending.write('{');
  try {
    await new Promise((resolve, reject) => {
      const barrier = () => { server.off('request', barrier); resolve(); };
      server.once('request', barrier);
      pending.once('error', reject);
    });
    assert.equal((await request('/api/data/backups', 'POST', {})).status, 409);
  } finally { pending.destroy(); }
});

test('AI revision endpoints keep the original until confirmation and expose history', async () => {
  const { data: { contact } } = await request('/api/contacts', 'POST', { name: '修改 API 联系人' });
  const { data: { memory } } = await request('/api/memories', 'POST', { contactId: contact.id, type: 'preference', content: '喜欢红茶' });
  const result = await request('/api/tools', 'POST', { name: 'memory_update', args: { id: memory.id, content: '喜欢绿茶' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const overview = (await request('/api/overview')).data;
  const proposal = overview.pendingRevisions.find((p) => p.memoryId === memory.id);
  assert.ok(proposal);
  assert.equal((await request(`/api/contacts/${contact.id}/timeline`)).data.memories.find((m) => m.id === memory.id).content, '喜欢红茶');
  const denied = await request(`/api/memory-revisions/${proposal.id}/confirm`, 'POST', {}, { origin: 'https://untrusted.invalid' });
  assert.equal(denied.status, 403);
  assert.equal((await request(`/api/memory-revisions/${proposal.id}/confirm`, 'POST', {})).status, 200);
  const history = (await request(`/api/memories/${memory.id}/history`)).data.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].before.content, '喜欢红茶');
  assert.equal(history[0].after.content, '喜欢绿茶');
  assert.equal((await request(`/api/memories/${memory.id}/history/${history[0].id}/restore`, 'POST', {})).status, 200);
  assert.equal((await request(`/api/contacts/${contact.id}/timeline`)).data.memories.find((m) => m.id === memory.id).content, '喜欢红茶');
  assert.equal((await request(`/api/memories/${memory.id}/history`)).data.history.length, 2);
});

test('unresolved restore failure blocks all business APIs but keeps existing backups downloadable', async (t) => {
  const { data: { backup } } = await request('/api/data/backups', 'POST', {});
  const { data: { token } } = await request('/api/data/restore/preview', 'POST', { backupId: backup.id });
  const journal = path.join(dataDir, '.restore-journal.json');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(dataDir, 'contacts.json') && fs.existsSync(journal)) throw new Error('disk unavailable');
    return rename(from, to);
  });
  try {
    assert.equal((await request('/api/data/restore/confirm', 'POST', { token })).status, 503);
    assert.equal(fs.existsSync(journal), true);
    const contacts = fs.readFileSync(path.join(dataDir, 'contacts.json'));
    for (const [route, method, body] of [
      ['/api/contacts', 'POST', { name: 'must not be written' }],
      ['/api/tools', 'POST', { name: 'contact_add', args: { name: 'must not be written' } }],
      ['/api/memory-revisions/any/confirm', 'POST', {}],
      ['/api/memories/any/history', 'GET'],
      ['/api/overview', 'GET'],
    ]) assert.equal((await request(route, method, body)).status, 503, route);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'contacts.json')), contacts);
    assert.equal((await request('/api/data/status')).data.recoveryRequired, true);
    assert.equal((await request(`/api/data/backups/${backup.id}/download`)).status, 200);
    assert.equal((await request('/api/data/backups', 'POST', {})).status, 503);
    assert.equal((await request('/api/data/restore/preview', 'POST', { backupId: backup.id })).status, 503);
  } finally {
    t.mock.restoreAll();
    (await import('../../server/data-safety.js')).initializeDataSafety();
    (await import('../../server/store-facade.js')).default.loadStore();
  }
  assert.equal((await request('/api/overview')).status, 200);
  assert.equal((await request('/api/data/status')).data.recoveryRequired, false);
});
