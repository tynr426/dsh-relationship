import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-data-safety-test-'));
process.env.REL_DATA_DIR = dir;
process.env.REL_STORE = 'json';
const store = (await import('../../server/store-facade.js')).default;
const rawStore = await import('../../server/store.js');
const { readJsonFile } = await import('../../server/json-file.js');
const reports = await import('../../server/material-reports.js');
const contacts = await import('../../server/material-contacts.js');
const questions = await import('../../server/organize-questions.js');
const suggestions = await import('../../server/plan-suggestions.js');
let safety;
let run = 0;
const file = (name) => path.join(dir, name);
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function replace(envelope, name, value) {
  const b = Buffer.from(JSON.stringify(value));
  envelope.files[name] = { encoding: 'base64', size: b.length, sha256: digest(b), data: b.toString('base64') };
  return envelope;
}
function disk() {
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => [name, fs.readFileSync(file(name), 'utf8')]));
}
test.beforeEach(async () => {
  rawStore.suspendPersistence();
  for (const name of fs.readdirSync(dir)) fs.rmSync(file(name), { recursive: true, force: true });
  safety = await import(`../../server/data-safety.js?case=${++run}`);
  safety.initializeDataSafety();
  store.loadStore();
});
test.after(() => { rawStore.suspendPersistence(); fs.rmSync(dir, { recursive: true, force: true }); });

test('readJsonFile only falls back for ENOENT, with fresh values and private errors', (t) => {
  const fallback = { items: [] };
  readJsonFile(file('missing'), fallback).items.push(1);
  assert.deepEqual(readJsonFile(file('missing'), fallback), fallback);
  fs.writeFileSync(file('invalid'), '{TOP_SECRET');
  assert.throws(() => readJsonFile(file('invalid'), {}), (e) => e.name === 'JsonFileError' && !e.message.includes('TOP_SECRET'));
  fs.writeFileSync(file('invalid-utf8'), Buffer.from([0x22, 0xff, 0x22]));
  assert.throws(() => readJsonFile(file('invalid-utf8'), ''), { name: 'JsonFileError' });
  write('array', {});
  assert.throws(() => readJsonFile(file('array'), [], Array.isArray), { name: 'JsonFileError' });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...args) => {
    if (p === file('denied')) throw Object.assign(new Error('private data'), { code: 'EACCES' });
    return read(p, ...args);
  });
  assert.throws(() => readJsonFile(file('denied'), {}), (e) => e.code === 'READ_FAILED' && !e.message.includes('private data'));
});

test('first boot, missing files and valid legacy JSON remain loadable', () => {
  assert.equal(store.listContacts().length, 0);
  assert.equal(safety.listBackups().length, 1);
  assert.equal(safety.initializeDataSafety().backup, null);
  write('meta.json', { schemaVersion: 0 });
  write('contacts.json', [{ id: 'c_old', name: 'legacy' }]);
  fs.unlinkSync(file('plans.json'));
  store.loadStore();
  assert.equal(store.getContact('c_old').status, 'confirmed');
  assert.deepEqual(JSON.parse(fs.readFileSync(file('plans.json'))), []);
  assert.equal(fs.statSync(file('contacts.json')).mode & 0o777, 0o600);
});

test('every damaged main file/meta blocks writes and cancels an older timer', async () => {
  const c = store.createContact({ name: 'original' });
  store.flush();
  for (const [name, value] of [['contacts.json', '{secret'], ['memories.json', '{}'], ['materials.json', '[null]'],
    ['plans.json', '[{}]'], ['relation_types.json', '[{"key":12}]'], ['meta.json', '{"schemaVersion":999}'],
    ['meta.json', '{}'], ['meta.json', 'null']]) {
    const good = fs.readFileSync(file(name));
    store.updateContact(c.id, { notes: 'pending timer' });
    fs.writeFileSync(file(name), value);
    const before = disk();
    assert.throws(() => rawStore.loadStore(), { name: 'JsonFileError' });
    assert.equal(store.getContact(c.id).name, 'original');
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual(disk(), before);
    assert.throws(() => store.flush(), /LOAD_FAILED/);
    fs.writeFileSync(file(name), good);
    store.loadStore();
  }
});

test('sidecar read-modify-write never replaces damaged or wrongly shaped content', () => {
  for (const [name, action] of [
    ['material-reports.json', () => reports.setMaterialReport('mt', 'report')],
    ['material-contacts.json', () => contacts.setMaterialContacts('mt', ['c'])],
    ['organize-questions.json', () => questions.setOrganizeQuestion('mt', 'question', [])],
    ['plan-suggestions.json', () => suggestions.linkPlan('gp', 'base')],
  ]) {
    for (const value of ['{secret', '[]', '{"mt":null}']) {
      fs.writeFileSync(file(name), value);
      assert.throws(action, { name: 'JsonFileError' });
      assert.equal(fs.readFileSync(file(name), 'utf8'), value);
    }
  }
});

test('export/preview/restore includes all sidecars and preserves pre-restore snapshot', () => {
  const c = store.createContact({ name: 'backup contact' });
  store.createMemory({ contactId: c.id, type: 'event', content: 'backup memory' });
  reports.setMaterialReport('mt', 'report');
  contacts.setMaterialContacts('mt', [c.id]);
  questions.setOrganizeQuestion('mt', 'question', [{ label: 'yes', command: 'answer' }]);
  suggestions.linkPlan('gp', 'base');
  write('memory-vectors.json', { version: 1, items: { m: { fingerprint: 'fp', vector: [['term', 1]], updatedAt: '' } } });
  write('memory-revisions.json', { version: 1, proposals: [], history: [] });
  fs.writeFileSync(file('.env'), 'TOKEN=NEVER_BACK_UP');
  fs.writeFileSync(file('credentials.json'), 'NEVER_BACK_UP');
  const saved = safety.createBackup();
  const envelope = safety.exportBackup(saved.id);
  assert.equal(envelope.version, 2);
  assert.equal(Object.keys(envelope.files).length, 14);
  assert.equal(JSON.stringify(envelope).includes('NEVER_BACK_UP'), false);
  const before = disk();
  const preview = safety.previewBackup(envelope);
  assert.equal(preview.counts.contacts, 1);
  assert.equal(preview.counts.memories, 1);
  assert.equal(preview.counts.organizeQuestions, 1);
  assert.deepEqual(disk(), before, 'preview is read only');
  store.updateContact(c.id, { name: 'changed' });
  reports.setMaterialReport('mt', 'changed report');
  const restored = safety.restoreBackup(envelope);
  assert.equal(restored.backup.reason, 'pre-restore');
  assert.equal(store.getContact(c.id).name, 'backup contact');
  assert.equal(reports.getMaterialReport('mt').report, 'report');
  assert.deepEqual(contacts.getMaterialContacts('mt'), [c.id]);
  assert.equal(questions.getOrganizeQuestion('mt').question, 'question');
  assert.equal(suggestions.planBase('gp'), 'base');
  assert.equal(fs.statSync(file('backups')).mode & 0o777, 0o700);
  for (const b of safety.listBackups()) assert.equal(fs.statSync(file(`backups/${b.id}.json`)).mode & 0o777, 0o600);
  safety.restoreBackup(safety.exportBackup(restored.backup.id));
  assert.equal(store.getContact(c.id).name, 'changed');
});

test('confirmed memory history and pending revision proposals round-trip without becoming confirmed', () => {
  const c = store.createContact({ name: 'revision contact' });
  const m = store.createMemory({ contactId: c.id, type: 'event', content: 'original', author: 'user' });
  store.updateMemory(m.id, { content: 'user edit' });
  const proposal = store.proposeMemoryUpdate(m.id, { content: 'pending AI edit' });
  const envelope = safety.exportBackup(safety.createBackup().id);
  const preview = safety.previewBackup(envelope);
  assert.equal(preview.counts.memoryRevisionHistory, 1);
  assert.equal(preview.counts.memoryRevisionProposals, 1);
  store.rejectMemoryRevision(proposal.id);
  store.updateMemory(m.id, { content: 'later user edit' });
  safety.restoreBackup(envelope);
  assert.equal(store.getMemory(m.id).content, 'user edit');
  assert.equal(store.listMemoryRevisions({ status: 'pending' })[0].id, proposal.id);
  assert.equal(store.memoryHistory(m.id).length, 1);
});

test('bad envelopes, paths, future versions, checksums and structures fail before active writes', () => {
  const original = safety.exportBackup(safety.createBackup().id);
  const invalid = [
    { ...original, version: 3 }, { ...original, backend: 'rust' }, { ...original, id: '../private' },
    { ...original, files: { ...original.files, '../.env': null } },
    replace(structuredClone(original), 'followups.json', { 'promise:m': { status: 'done' } }),
    replace(structuredClone(original), 'material-delivery.json', { mt: { copiedAt: '', sentAt: 'invalid' } }),
    replace(structuredClone(original), 'contacts.json', [null]),
    replace(structuredClone(original), 'memory-revisions.json', { version: 2, proposals: [], history: [] }),
    replace(structuredClone(original), 'memory-revisions.json', { version: 1, proposals: [{}], history: [] }),
    replace(structuredClone(original), 'meta.json', { schemaVersion: 999 }),
  ];
  const tampered = structuredClone(original);
  tampered.files['contacts.json'].data = Buffer.from('[{}]').toString('base64');
  invalid.push(tampered);
  const before = disk();
  const backups = safety.listBackups().length;
  for (const envelope of invalid) {
    assert.throws(() => safety.previewBackup(envelope));
    assert.throws(() => safety.restoreBackup(envelope));
    assert.deepEqual(disk(), before);
  }
  assert.throws(() => safety.previewBackup(' '.repeat(safety.MAX_BACKUP_BYTES + 1)), /TOO_LARGE/);
  assert.equal(safety.listBackups().length, backups);
  assert.throws(() => safety.exportBackup('../.env'), /INVALID_ID/);
});

test('mid-replacement IO failure rolls back both memory and all sidecars', (t) => {
  const c = store.createContact({ name: 'before' });
  const envelope = safety.exportBackup(safety.createBackup().id);
  store.updateContact(c.id, { name: 'current' });
  reports.setMaterialReport('mt', 'current');
  store.flush();
  const before = disk();
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && to === file('memories.json') && fs.existsSync(file('.restore-journal.json'))) {
      failed = true;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  assert.throws(() => safety.restoreBackup(envelope), /RESTORE_FAILED_ROLLED_BACK/);
  assert.equal(failed, true);
  assert.deepEqual(disk(), before);
  assert.equal(store.getContact(c.id).name, 'current');
  assert.equal(fs.existsSync(file('.restore-journal.json')), false);
});

test('process interruption leaves durable journal; startup restores old complete dataset before load', () => {
  const c = store.createContact({ name: 'snapshot' });
  const id = safety.createBackup().id;
  store.updateContact(c.id, { name: 'before crash' });
  reports.setMaterialReport('mt', 'before crash');
  store.flush();
  const before = disk();
  const moduleURL = pathToFileURL(path.resolve('server/data-safety.js')).href;
  const storeURL = pathToFileURL(path.resolve('server/store-facade.js')).href;
  const code = `import fs from 'node:fs';
    const s = await import(${JSON.stringify(moduleURL)});
    const store = (await import(${JSON.stringify(storeURL)})).default;
    s.initializeDataSafety(); store.loadStore();
    const envelope = s.exportBackup(${JSON.stringify(id)});
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === ${JSON.stringify(file('memories.json'))} && fs.existsSync(${JSON.stringify(file('.restore-journal.json'))})) process.exit(73);
      return rename(from, to);
    };
    s.restoreBackup(envelope);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 73, result.stderr);
  assert.equal(fs.existsSync(file('.restore-journal.json')), true);
  assert.equal(safety.initializeDataSafety().recovered, true);
  assert.deepEqual(disk(), before);
  store.loadStore();
  assert.equal(store.getContact(c.id).name, 'before crash');
});

test('failed rollback blocks writes until journal recovery succeeds', (t) => {
  const c = store.createContact({ name: 'backup' });
  const envelope = safety.exportBackup(safety.createBackup().id);
  store.updateContact(c.id, { name: 'current' });
  store.flush();
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file('memories.json') && fs.existsSync(file('.restore-journal.json'))) throw new Error('disk unavailable');
    return rename(from, to);
  });
  assert.throws(() => safety.restoreBackup(envelope), (e) => e.recoveryRequired === true);
  assert.throws(() => store.flush(), /WRITES_BLOCKED/);
  mock.mock.restore();
  assert.equal(safety.initializeDataSafety().recovered, true);
  store.loadStore();
  assert.equal(store.getContact(c.id).name, 'current');
});

for (const stage of ['prepare', 'commit']) test(`journal ${stage} IO failure freezes writes until startup recovery`, (t) => {
  const c = store.createContact({ name: 'backup' });
  const envelope = safety.exportBackup(safety.createBackup().id);
  store.updateContact(c.id, { name: 'before restore' });
  store.flush();
  let mock;
  if (stage === 'prepare') {
    const sync = fs.fsyncSync;
    mock = t.mock.method(fs, 'fsyncSync', (fd) => {
      if (fs.fstatSync(fd).isDirectory() && fs.existsSync(file('.restore-journal.json'))) throw new Error('journal sync failed');
      return sync(fd);
    });
  } else {
    const unlink = fs.unlinkSync;
    mock = t.mock.method(fs, 'unlinkSync', (target) => {
      if (target === file('.restore-journal.json')) throw new Error('journal unlink failed');
      return unlink(target);
    });
  }
  assert.throws(() => safety.restoreBackup(envelope), (e) => e.recoveryRequired === true);
  assert.throws(() => store.flush(), /WRITES_BLOCKED/);
  mock.mock.restore();
  assert.equal(safety.initializeDataSafety().recovered, true);
  store.loadStore();
  assert.equal(store.getContact(c.id).name, 'before restore');
});

test('automatic snapshots require changes and interval; only seven automatic files retained', (t) => {
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  const manual = safety.createBackup();
  assert.equal(safety.maybeAutomaticBackup(), null);
  for (let i = 0; i < 10; i++) {
    store.createContact({ name: `c${i}` });
    assert.equal(safety.maybeAutomaticBackup(), null);
    time += safety.AUTOMATIC_BACKUP_INTERVAL_MS + 1;
    assert.equal(safety.maybeAutomaticBackup().reason, 'automatic');
  }
  time += safety.AUTOMATIC_BACKUP_INTERVAL_MS + 1;
  assert.equal(safety.maybeAutomaticBackup(), null);
  const list = safety.listBackups();
  assert.equal(list.filter((b) => ['startup', 'automatic'].includes(b.reason)).length, 7);
  assert.ok(list.some((b) => b.id === manual.id));
});

test('startup snapshot defers until the existing memory revision journal is recovered', async () => {
  store.flush();
  write('memory-revisions.journal.json', { version: 1, kind: 'delete', memoryIds: ['m_missing'], contactId: null });
  const fresh = await import('../../server/data-safety.js?revision-startup');
  assert.equal(fresh.initializeDataSafety().backup, null);
  assert.throws(() => fresh.createBackup(), /MEMORY_REVISION_RECOVERY_REQUIRED/);
  store.loadStore();
  assert.equal(fresh.maybeAutomaticBackup().reason, 'startup');
  assert.equal(fresh.maybeAutomaticBackup(), null);
});

test('damaged startup data and invalid recovery journals do not change active bytes', () => {
  fs.writeFileSync(file('meta.json'), '{private');
  const before = disk();
  assert.throws(() => rawStore.loadStore());
  assert.throws(() => safety.createBackup());
  assert.deepEqual(disk(), before);
  fs.writeFileSync(file('.restore-journal.json'), '{"version":999}');
  const journalBefore = disk();
  assert.throws(() => safety.initializeDataSafety(), /INVALID_RECOVERY_JOURNAL/);
  assert.deepEqual(disk(), journalBefore);
});
