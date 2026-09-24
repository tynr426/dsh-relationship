import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { apply } from '../../lib/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-plugin-safety-'));
process.env.REL_DATA_DIR = dataDir;
process.env.REL_STORE = 'json';
const routes = [];
const host = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = routes.find((r) => r.kind === 'exact' ? r.path === pathname : pathname.startsWith(r.path + '/'));
  if (route) route.handler(req, res);
  else { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${host.address().port}`;
let boot;
apply({
  logger: { info() {} },
  effect(fn) { boot = fn(); },
  systemPrompt: { section() { return () => {}; } },
  webServer: { register(route) { routes.push(route); return () => {}; } },
}, { port: host.address().port + 1, announceToAgent: false });
const dispose = await boot;

test.after(async () => {
  await new Promise((resolve) => host.close(resolve));
  dispose();
  await new Promise(setImmediate);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('plugin proxy preserves same-origin safety operations and rejects foreign origins before forwarding', async () => {
  const url = `${origin}/api/dsh-relationship/workbench/api/data`;
  const allowed = await fetch(url + '/status', { headers: { origin } });
  assert.equal(allowed.status, 200, await allowed.text());
  const backup = await fetch(url + '/backups', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(backup.status, 200);
  assert.ok((await backup.json()).backup.id);
  for (const headers of [{ origin: 'https://untrusted.invalid' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
    const denied = await fetch(url + '/backups', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 403);
    await denied.text();
  }
});
