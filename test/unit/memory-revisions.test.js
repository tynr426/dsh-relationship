import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '../..');
const mode = process.env.REL_REVISION_TEST_BACKEND;
// node:test 的内部子进程标记不能传给再次启动的 test runner（否则可能静默跳过执行）。
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };
if (!mode) {
  const bin = [process.env.RELSTORE_BIN, path.join(os.homedir(), '.openclaw-shared/bin/relstore'),
    path.join(root, 'rust/relstore/target/release/relstore')].filter(Boolean).find((p) => fs.existsSync(p));
  for (const backend of ['json', 'rust']) {
    test(`memory revisions contract: ${backend}`, { skip: backend === 'rust' && !bin ? 'relstore binary unavailable' : false }, () => {
      const result = spawnSync(process.execPath, ['--test', self], {
        cwd: root, encoding: 'utf8', timeout: 180_000,
        env: { ...childEnv(), REL_REVISION_TEST_BACKEND: backend, ...(bin ? { RELSTORE_BIN: bin } : {}) },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /process crash recovery at published boundary/);
      process.stdout.write(result.stdout);
    });
  }
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-rel-revisions-${mode}-`));
  process.env.REL_STORE = mode;
  process.env.REL_DATA_DIR = dir;
  process.env.RELSTORE_DB = path.join(dir, 'rel.db');
  const store = (await import('../../server/store-facade.js')).default;
  const impl = await import(mode === 'rust' ? '../../server/store-rust.js' : '../../server/store.js');
  const { createMemoryRevisions } = await import('../../server/memory-revisions.js');
  const file = path.join(dir, 'memory-revisions.json');
  const journal = path.join(dir, 'memory-revisions.journal.json');
  const fields = ['type', 'content', 'date', 'importance', 'saidAt', 'direction', 'lifespan', 'occasion'];
  const semantics = (m) => Object.fromEntries(fields.map((k) => [k, m[k]]));
  const snap = (id) => structuredClone(store.getMemory(id));
  const json = (f = file) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const conflict = (fn) => assert.throws(fn, (e) => e.status === 409);
  const fixtures = [];
  const fixture = () => {
    const c = store.createContact({ name: `修订测试${fixtures.length}` });
    fixtures.push(c.id);
    const m = structuredClone(store.createMemory({ contactId: c.id, type: 'attribute', content: '原始事实', author: 'user' }));
    store.flush();
    return { c, m };
  };
  const child = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const store = (await import(${JSON.stringify(new URL('../../server/store-facade.js', import.meta.url).href)})).default;
    store.loadStore();
    ${code}
  `], { cwd: root, encoding: 'utf8', timeout: 30_000, env: childEnv() });
  const reload = () => { store.loadStore(); };
  store.loadStore();
  test.after(() => { store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  test.afterEach(() => {
    for (const id of fixtures.splice(0)) if (store.getContact(id)) store.deleteContact(id);
  });

  test('proposal preserves full original, is isolated from memory/search, and snapshots cannot alias', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '建议内容' });
    assert.deepEqual(snap(m.id), m);
    assert.equal(store.listMemories({ q: '建议内容' }).length, 0);
    assert.equal(store.listMemories({ contactId: m.contactId }).length, 1);
    assert.equal(store.memoryHistory(m.id).length, 0);
    assert.deepEqual(p.before, m);
    assert.equal(p.after.content, '建议内容');
    assert.equal(p.status, 'pending');
    const ov = store.overview();
    assert.ok(ov.pendingRevisions.some((x) => x.id === p.id));
    assert.equal(ov.counts.pendingRevisions, ov.pendingRevisions.length);
    assert.equal(store.counts().pendingRevisions, ov.counts.pendingRevisions);
    assert.equal(ov.pending.some((x) => x.id === p.id), false);
    p.before.content = '篡改引用'; p.after.content = '篡改建议';
    ov.pendingRevisions[0].before.content = '篡改概览';
    assert.equal(store.listMemoryRevisions({ memoryId: m.id })[0].before.content, m.content);
    assert.deepEqual(snap(m.id), m);
    assert.deepEqual(Object.keys(json()).sort(), ['history', 'proposals', 'version']);
  });

  test('confirmation publishes exactly one ai-confirmed history; repeat/cross operations conflict', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '已确认建议', type: 'preference' });
    const result = store.confirmMemoryRevision(p.id);
    assert.equal(result.content, '已确认建议');
    const [h] = store.memoryHistory(m.id);
    assert.equal(h.source, 'ai-confirmed');
    assert.deepEqual(h.before, m);
    assert.deepEqual(h.after, snap(m.id));
    assert.equal(store.listMemoryRevisions({ status: 'confirmed', memoryId: m.id })[0].id, p.id);
    conflict(() => store.confirmMemoryRevision(p.id));
    conflict(() => store.rejectMemoryRevision(p.id));
    assert.equal(store.memoryHistory(m.id).length, 1);
    result.content = '篡改返回值'; h.before.content = '篡改历史';
    assert.equal(snap(m.id).content, '已确认建议');
    assert.equal(store.memoryHistory(m.id)[0].before.content, '原始事实');
  });

  test('rejection leaves original and history untouched; duplicate rejection conflicts', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '不采纳' });
    assert.equal(store.rejectMemoryRevision(p.id).status, 'rejected');
    conflict(() => store.rejectMemoryRevision(p.id));
    conflict(() => store.confirmMemoryRevision(p.id));
    assert.deepEqual(snap(m.id), m);
    assert.equal(store.memoryHistory(m.id).length, 0);
  });

  test('manual edits and competing AI confirmations invalidate old proposals but allow rejection', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '旧提案' });
    store.updateMemory(m.id, { content: '人工修改' });
    conflict(() => store.confirmMemoryRevision(p.id));
    assert.equal(snap(m.id).content, '人工修改');
    assert.equal(store.rejectMemoryRevision(p.id).status, 'rejected');
    const p1 = store.proposeMemoryUpdate(m.id, { content: '一号建议' });
    const p2 = store.proposeMemoryUpdate(m.id, { content: '二号建议' });
    store.confirmMemoryRevision(p1.id);
    conflict(() => store.confirmMemoryRevision(p2.id));
    assert.equal(store.rejectMemoryRevision(p2.id).status, 'rejected');
    assert.equal(snap(m.id).content, '一号建议');
  });

  test('edit then restore (ABA), supersession, and external deletion never let a stale proposal overwrite', () => {
    const { c, m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '旧提案' });
    store.updateMemory(m.id, { content: '人工临时改动' });
    store.restoreMemoryHistory(m.id, store.memoryHistory(m.id)[0].id);
    conflict(() => store.confirmMemoryRevision(p.id));
    store.rejectMemoryRevision(p.id);
    const p2 = store.proposeMemoryUpdate(m.id, { content: '被取代前建议' });
    const keep = store.createMemory({ contactId: c.id, type: 'attribute', content: '取代依据', author: 'user' });
    store.supersedeMemory(m.id, keep.id);
    conflict(() => store.confirmMemoryRevision(p2.id));
    assert.equal(store.rejectMemoryRevision(p2.id).status, 'rejected');
    conflict(() => store.proposeMemoryUpdate(m.id, { content: '不再可编辑' }));
    const p3 = store.proposeMemoryUpdate(keep.id, { content: '删除前建议' });
    impl.deleteMemory(keep.id); impl.flush();
    conflict(() => store.confirmMemoryRevision(p3.id));
    assert.equal(store.rejectMemoryRevision(p3.id).status, 'rejected');
    assert.equal(store.getMemory(keep.id), null);
  });

  test('eight semantic fields share pure validation/normalization and cannot alter protected metadata', () => {
    const { m } = fixture();
    const invalid = [
      { type: 'wrong' }, { content: ' ' }, { content: 'x'.repeat(501) }, { date: 'not-a-date' },
      { importance: 4 }, { importance: 1.5 }, { saidAt: 'yesterday' }, { direction: 'wrong' },
      { lifespan: 'forever' }, { occasion: 'x'.repeat(41) },
    ];
    for (const patch of invalid) {
      assert.throws(() => store.proposeMemoryUpdate(m.id, patch), (e) => e.status === 400);
      assert.throws(() => store.updateMemory(m.id, patch), (e) => e.status === 400);
      assert.deepEqual(snap(m.id), m);
    }
    assert.equal(store.memoryHistory(m.id).length, 0);
    assert.equal(store.listMemoryRevisions({ memoryId: m.id }).length, 0);
    const patch = { type: 'event', content: ' 修正事实 ', date: '2026-10-__', importance: '3',
      saidAt: ' 2026-09-11 20:03 ', direction: 'both', lifespan: 'short', occasion: 'Birthday',
      id: 'forged', contactId: 'forged', sourceId: 'forged', sourceQuote: 'forged', author: 'ai', status: 'pending' };
    const p = store.proposeMemoryUpdate(m.id, patch);
    const expected = impl.validateMemoryFields({ ...semantics(m), ...patch });
    assert.deepEqual(semantics(p.after), expected);
    const result = store.confirmMemoryRevision(p.id);
    assert.deepEqual(semantics(result), expected);
    for (const key of ['id', 'contactId', 'sourceId', 'sourceQuote', 'author', 'status', 'createdAt', 'confirmedAt']) {
      assert.deepEqual(result[key], m[key], key);
    }
    const pending = store.createMemory({ contactId: m.contactId, type: 'attribute', content: '待确认' });
    assert.throws(() => store.proposeMemoryUpdate(pending.id, { content: '禁止' }), (e) => e.status === 400);
  });

  test('manual and restore histories preserve before/after and restoring only changes semantic fields', () => {
    const { m } = fixture();
    store.updateMemory(m.id, { content: '手动版本', type: 'event' }, { source: 'ai-confirmed' });
    const h1 = store.memoryHistory(m.id)[0];
    assert.equal(h1.source, 'user', 'options cannot forge the history author');
    assert.deepEqual(h1.before, m);
    store.updateMemory(m.id, { content: '再次编辑', importance: 3 });
    const latest = snap(m.id);
    const restored = store.restoreMemoryHistory(m.id, h1.id);
    assert.deepEqual(semantics(restored), semantics(m));
    const [restore, second, first] = store.memoryHistory(m.id);
    assert.equal(restore.source, 'restore');
    assert.deepEqual(restore.before, latest);
    assert.deepEqual(restore.after, snap(m.id));
    assert.equal(first.id, h1.id);
    assert.equal(second.source, 'user');
    // 即使当前内容恰好等于该 before，明确的恢复动作仍留下新的 restore 记录。
    store.restoreMemoryHistory(m.id, h1.id);
    assert.equal(store.memoryHistory(m.id).length, 4);
    assert.equal(store.memoryHistory(m.id)[0].source, 'restore');
    for (const key of ['id', 'contactId', 'sourceId', 'sourceQuote', 'author', 'status']) assert.deepEqual(restored[key], latest[key]);
    const other = fixture().m;
    assert.throws(() => store.restoreMemoryHistory(other.id, h1.id), (e) => e.status === 404);
    const keep = store.createMemory({ contactId: m.contactId, type: 'event', content: '新事实', author: 'user' });
    store.supersedeMemory(m.id, keep.id);
    conflict(() => store.restoreMemoryHistory(m.id, h1.id));
  });

  test('memory/contact deletion removes associated proposals/history and never revives deleted records', () => {
    const { c, m } = fixture();
    store.updateMemory(m.id, { content: '已有历史' });
    const h = store.memoryHistory(m.id)[0];
    const p = store.proposeMemoryUpdate(m.id, { content: '未确认' });
    store.deleteMemory(m.id);
    assert.equal(store.memoryHistory(m.id).length, 0);
    assert.equal(store.listMemoryRevisions({ memoryId: m.id }).length, 0);
    conflict(() => store.confirmMemoryRevision(p.id));
    assert.throws(() => store.restoreMemoryHistory(m.id, h.id), (e) => e.status === 404);
    assert.equal(store.getMemory(m.id), null);
    const m2 = store.createMemory({ contactId: c.id, type: 'attribute', content: '联系人删除目标', author: 'user' });
    store.updateMemory(m2.id, { content: '编辑后' });
    store.proposeMemoryUpdate(m2.id, { content: '未确认' });
    const unrelated = fixture().m;
    store.proposeMemoryUpdate(unrelated.id, { content: '无关提案应保留' });
    store.deleteContact(c.id);
    assert.equal(json().proposals.some((p) => p.contactId === c.id), false);
    assert.equal(json().history.some((h) => h.before.contactId === c.id), false);
    assert.equal(store.listMemoryRevisions({ memoryId: unrelated.id }).length, 1);
  });

  test('deletion interrupted after main commit finishes sidecar cleanup on restart', () => {
    for (const method of ['deleteMemory', 'deleteContact']) {
      const { c, m } = fixture();
      store.updateMemory(m.id, { content: '有修改历史' });
      store.proposeMemoryUpdate(m.id, { content: '删除前的提案' });
      const r = child(`
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => { if (to === ${JSON.stringify(file)}) process.exit(23); return rename(from, to); };
        store[${JSON.stringify(method)}](${JSON.stringify(method === 'deleteMemory' ? m.id : c.id)});
      `);
      assert.equal(r.status, 23, r.stderr);
      assert.ok(json().history.some((h) => h.memoryId === m.id));
      reload();
      assert.equal(store.getMemory(m.id), null);
      assert.equal(store.listMemoryRevisions({ memoryId: m.id }).length, 0);
      assert.equal(store.memoryHistory(m.id).length, 0);
      assert.equal(fs.existsSync(journal), false);
    }
  });

  test('sidecar and journal corruption fail closed without overwriting bytes or changing original', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '建议' });
    const good = fs.readFileSync(file, 'utf8');
    const badSnapshots = JSON.parse(good); badSnapshots.proposals[0].after.contactId = 'wrong';
    const badContent = JSON.parse(good); badContent.proposals[0].after.content = '';
    for (const bad of ['{truncated', '[]', '{}', 'null', '{"version":2,"proposals":[],"history":[]}',
      JSON.stringify({ version: 1, proposals: [null], history: [] }), JSON.stringify(badSnapshots), JSON.stringify(badContent)]) {
      fs.writeFileSync(file, bad);
      try {
        assert.throws(() => store.listMemoryRevisions());
        assert.throws(() => store.confirmMemoryRevision(p.id));
        assert.throws(() => store.updateMemory(m.id, { content: '不可写' }));
        assert.throws(() => store.deleteMemory(m.id));
        assert.throws(() => store.deleteContact(m.contactId));
        assert.equal(fs.readFileSync(file, 'utf8'), bad);
        assert.deepEqual(snap(m.id), m);
      } finally { fs.writeFileSync(file, good); }
    }
    fs.writeFileSync(journal, '{corrupt');
    try { assert.throws(() => store.memoryHistory(m.id)); assert.equal(fs.readFileSync(journal, 'utf8'), '{corrupt'); }
    finally { fs.unlinkSync(journal); }
  });

  test('journal write failure happens before mutation; main flush failure rolls back and never publishes success', (t) => {
    const { m } = fixture();
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === journal) throw new Error('injected journal failure');
      return rename(from, to);
    });
    assert.throws(() => store.updateMemory(m.id, { content: '禁止先改再存历史' }), /injected journal failure/);
    assert.deepEqual(snap(m.id), m);
    mock.mock.restore();
    let fail = true;
    const wrapped = { ...impl, flush() { if (fail) { fail = false; throw new Error('injected flush failure'); } impl.flush(); } };
    const revisions = createMemoryRevisions({ store: wrapped, validateMemoryFields: impl.validateMemoryFields });
    assert.throws(() => revisions.updateMemory(m.id, { content: '写失败' }), /injected flush failure/);
    assert.deepEqual(semantics(snap(m.id)), semantics(m));
    assert.equal(store.memoryHistory(m.id).length, 0);
    assert.equal(fs.existsSync(journal), false);
    reload();
    assert.deepEqual(semantics(snap(m.id)), semantics(m));
  });

  test('history publication failure retains before journal and recovers the applied operation exactly once', (t) => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '最终生效' });
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === file) throw new Error('injected sidecar publication failure');
      return rename(from, to);
    });
    assert.throws(() => store.confirmMemoryRevision(p.id), (e) => e.status === 503 && /可能已更新/.test(e.message));
    assert.equal(json().history.length, 0);
    assert.equal(json().proposals.find((x) => x.id === p.id).status, 'pending');
    assert.equal(json(journal).history.before.content, m.content);
    mock.mock.restore();
    reload();
    assert.equal(snap(m.id).content, '最终生效');
    assert.equal(store.memoryHistory(m.id).length, 1);
    assert.equal(store.listMemoryRevisions({ memoryId: m.id })[0].status, 'confirmed');
    reload();
    assert.equal(store.memoryHistory(m.id).length, 1);
  });

  test('real process restart persists pending/confirmed/rejected proposals and restoration history', () => {
    const { m } = fixture();
    const p1 = store.proposeMemoryUpdate(m.id, { content: '持久化建议' });
    const p2 = store.proposeMemoryUpdate(m.id, { content: '拒绝建议' });
    store.rejectMemoryRevision(p2.id);
    const r = child(`
      const id = ${JSON.stringify(m.id)};
      if (store.getMemory(id).content !== '原始事实') process.exit(11);
      store.confirmMemoryRevision(${JSON.stringify(p1.id)});
      const h = store.memoryHistory(id)[0];
      if (h.source !== 'ai-confirmed') process.exit(12);
      store.restoreMemoryHistory(id, h.id);
    `);
    assert.equal(r.status, 0, r.stderr);
    reload();
    assert.equal(snap(m.id).content, '原始事实');
    assert.deepEqual(store.memoryHistory(m.id).map((h) => h.source), ['restore', 'ai-confirmed']);
    assert.deepEqual(new Set(store.listMemoryRevisions({ memoryId: m.id }).map((p) => p.status)), new Set(['confirmed', 'rejected']));
  });

  for (const phase of ['prepared', 'applied', 'published']) {
    test(`process crash recovery at ${phase} boundary`, () => {
      const { m } = fixture();
      const p = store.proposeMemoryUpdate(m.id, { content: '崩溃边界建议' });
      const injection = phase === 'published' ? `
        const unlink = fs.unlinkSync;
        fs.unlinkSync = (file) => { if (file === ${JSON.stringify(journal)}) process.exit(23); return unlink(file); };
      ` : `
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          ${phase === 'applied' ? `if (to === ${JSON.stringify(file)}) process.exit(23);` : ''}
          const result = rename(from, to);
          ${phase === 'prepared' ? `if (to === ${JSON.stringify(journal)}) process.exit(23);` : ''}
          return result;
        };
      `;
      const r = child(`${injection}\nstore.confirmMemoryRevision(${JSON.stringify(p.id)});`);
      assert.equal(r.status, 23, `${r.stdout}\n${r.stderr}`);
      reload();
      const applied = phase !== 'prepared';
      assert.equal(snap(m.id).content, applied ? '崩溃边界建议' : '原始事实');
      assert.equal(store.memoryHistory(m.id).length, applied ? 1 : 0);
      assert.equal(store.listMemoryRevisions({ memoryId: m.id })[0].status, applied ? 'confirmed' : 'pending');
      assert.equal(fs.existsSync(journal), false);
      reload();
      assert.equal(store.memoryHistory(m.id).length, applied ? 1 : 0);
    });
  }

  test('persistent rollback flush failure keeps the original journal until rollback is durable', { skip: mode !== 'json' }, () => {
    const { m } = fixture();
    let failing = true;
    let firstFlush = true;
    const wrapped = { ...impl, flush() {
      if (failing) {
        if (firstFlush) { firstFlush = false; impl.flush(); }
        throw new Error('persistent disk failure');
      }
      impl.flush();
    } };
    const revisions = createMemoryRevisions({ store: wrapped, validateMemoryFields: impl.validateMemoryFields });
    try {
      assert.throws(() => revisions.updateMemory(m.id, { content: '磁盘中的未完成修改' }), (e) => e.status === 503);
      assert.equal(snap(m.id).content, m.content);
      assert.equal(json(path.join(dir, 'memories.json')).find((x) => x.id === m.id).content, '磁盘中的未完成修改');
      assert.throws(() => revisions.memoryHistory(m.id), /persistent disk failure/);
      assert.equal(json(journal).history.before.content, m.content);
    } finally { failing = false; }
    assert.deepEqual(revisions.memoryHistory(m.id), []);
    assert.equal(fs.existsSync(journal), false);
    reload();
    assert.equal(snap(m.id).content, m.content);
  });

  test('contact deletion interrupted between JSON files completes memory cleanup before history removal', { skip: mode !== 'json' }, () => {
    const { c, m } = fixture();
    store.updateMemory(m.id, { content: '删除前历史' });
    store.proposeMemoryUpdate(m.id, { content: '删除前提案' });
    const r = child(`
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        const result = rename(from, to);
        if (to === ${JSON.stringify(path.join(dir, 'contacts.json'))} && fs.existsSync(${JSON.stringify(journal)})) process.exit(23);
        return result;
      };
      store.deleteContact(${JSON.stringify(c.id)});
    `);
    assert.equal(r.status, 23, r.stderr);
    assert.ok(json(path.join(dir, 'memories.json')).some((x) => x.id === m.id));
    assert.ok(json().history.some((h) => h.memoryId === m.id));
    reload();
    assert.equal(store.getContact(c.id), null);
    assert.equal(store.getMemory(m.id), null);
    assert.deepEqual(store.memoryHistory(m.id), []);
    assert.equal(fs.existsSync(journal), false);
  });

  test('noncanonical CLI original is preserved in readable history and survives reload', { skip: mode !== 'rust' }, () => {
    const { m } = fixture();
    const r = spawnSync(process.env.RELSTORE_BIN, ['memory', 'set', m.id, '--date', '2026-09-22 ', '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    store.updateMemory(m.id, { content: '修正后的内容' });
    assert.equal(store.memoryHistory(m.id)[0].before.date, '2026-09-22 ');
    assert.equal(snap(m.id).date, '2026-09-22');
    reload();
    const p = store.proposeMemoryUpdate(m.id, { content: '新的建议' });
    store.confirmMemoryRevision(p.id);
    assert.equal(store.memoryHistory(m.id).length, 2);
    assert.equal(fs.existsSync(journal), false);
  });

  test('invalid original is rejected before writing an unreadable journal or mutating the main record', () => {
    const { m } = fixture();
    if (mode === 'json') impl.getMemory(m.id).date = 'not-a-date';
    else {
      const r = spawnSync(process.env.RELSTORE_BIN, ['memory', 'set', m.id, '--date', 'not-a-date', '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
    try {
      assert.throws(() => store.updateMemory(m.id, { content: '不能先写', date: '2026-09-22' }), /原记忆字段/);
      assert.equal(fs.existsSync(journal), false);
      assert.equal(snap(m.id).content, m.content);
    } finally { impl.updateMemory(m.id, { date: m.date }); impl.flush(); }
    reload();
  });

  test('atomic expected-version update rejects a change between proposal checking and the database write', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '过期提案' });
    let injected = false;
    const wrapped = { ...impl, updateMemory(id, patch, options) {
      if (!injected) {
        injected = true;
        if (mode === 'rust') {
          const r = spawnSync(process.env.RELSTORE_BIN, ['memory', 'set', id, '--content', '外部更新', '--importance', '3', '--json', '--db', process.env.RELSTORE_DB], { encoding: 'utf8' });
          assert.equal(r.status, 0, r.stderr);
        } else { impl.updateMemory(id, { content: '外部更新', importance: 3 }); impl.flush(); }
      }
      return impl.updateMemory(id, patch, options);
    } };
    const revisions = createMemoryRevisions({ store: wrapped, validateMemoryFields: impl.validateMemoryFields });
    conflict(() => revisions.confirmMemoryRevision(p.id));
    assert.equal(snap(m.id).content, '外部更新');
    assert.equal(snap(m.id).importance, 3);
    assert.equal(store.memoryHistory(m.id).length, 0);
    assert.equal(store.listMemoryRevisions({ memoryId: m.id })[0].status, 'pending');
    assert.equal(fs.existsSync(journal), false);
  });

  test('ambiguous recovery preserves journal and refuses to invent a successful history', () => {
    const { m } = fixture();
    const p = store.proposeMemoryUpdate(m.id, { content: '未完成建议' });
    const r = child(`
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => { const r = rename(from, to); if (to === ${JSON.stringify(journal)}) process.exit(23); return r; };
      store.confirmMemoryRevision(${JSON.stringify(p.id)});
    `);
    assert.equal(r.status, 23, r.stderr);
    impl.updateMemory(m.id, { content: '外部并发版本' }); impl.flush();
    const preserved = fs.readFileSync(journal, 'utf8');
    try {
      conflict(() => store.memoryHistory(m.id));
      assert.equal(json().history.length, 0);
      assert.equal(fs.readFileSync(journal, 'utf8'), preserved);
      assert.equal(snap(m.id).content, '外部并发版本');
      assert.equal(store.listMemoryRevisions({ memoryId: m.id })[0].status, 'pending');
      assert.equal(store.rejectMemoryRevision(p.id).status, 'rejected');
      assert.equal(fs.readFileSync(journal, 'utf8'), preserved);
    } finally { fs.unlinkSync(journal); }
  });
}
