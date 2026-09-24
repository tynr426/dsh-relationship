import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = process.env.RELSTORE_BIN || fileURLToPath(new URL('../../rust/relstore/target/debug/relstore', import.meta.url));
const available = fs.existsSync(binary);
const python = spawnSync('python3', ['-c', 'import sqlite3'], { encoding: 'utf8' }).status === 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-safety-sqlite-test-'));
const dir = path.join(root, 'data');
const db = path.join(root, 'custom.sqlite');
fs.mkdirSync(dir, { mode: 0o700 });
process.env.REL_DATA_DIR = dir;
process.env.REL_STORE = 'rust';
process.env.RELSTORE_BIN = binary;
process.env.RELSTORE_DB = db;
let store;
let safety;
const file = (name) => path.join(dir, name);
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function py(code, args = []) {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8', env: process.env, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
function cli(args, target = db) {
  return spawnSync(binary, [...args, '--json', '--db', target], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
}
function modified(envelope, sql) {
  const target = path.join(root, 'untrusted.sqlite');
  fs.writeFileSync(target, Buffer.from(envelope.files['rel.db'].data, 'base64'));
  py('import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.close()', [target, sql]);
  const b = fs.readFileSync(target);
  const copy = structuredClone(envelope);
  copy.files['rel.db'] = { encoding: 'base64', size: b.length, sha256: digest(b), data: b.toString('base64') };
  fs.unlinkSync(target);
  return copy;
}
test.before(async () => {
  if (!available) return;
  store = (await import('../../server/store-facade.js')).default;
  safety = await import('../../server/data-safety.js');
  assert.equal(safety.initializeDataSafety().backup, null, 'startup must not initialize missing SQLite');
  assert.equal(fs.existsSync(db), false);
  store.loadStore();
  assert.equal(safety.maybeAutomaticBackup().reason, 'startup');
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('custom SQLite database snapshot exports and restores alongside all sidecars', { skip: !available }, () => {
  const c = store.createContact({ name: 'sqlite backup' });
  store.saveMaterialReport(store.saveMaterial({ text: 'test material', contactId: c.id }).id, 'report');
  fs.writeFileSync(file('memory-vectors.json'), JSON.stringify({ version: 1, items: {} }));
  fs.writeFileSync(file('memory-revisions.json'), JSON.stringify({ version: 1, proposals: [], history: [] }));
  const backup = safety.createBackup();
  const envelope = safety.exportBackup(backup.id);
  assert.equal(envelope.backend, 'rust');
  assert.equal(envelope.version, 2);
  assert.equal(Object.keys(envelope.files).length, 15);
  assert.ok(envelope.files['rel.db']);
  assert.equal('custom.sqlite' in envelope.files, false);
  const bytes = fs.readFileSync(db);
  const before = safety.previewBackup(envelope);
  assert.deepEqual(fs.readFileSync(db), bytes, 'preview must not initialize or alter active SQLite');
  assert.equal(before.counts.contacts, 1);
  assert.equal(before.counts.materialReports, 1);
  store.updateContact(c.id, { name: 'changed after backup' });
  const result = safety.restoreBackup(envelope);
  assert.equal(result.backup.reason, 'pre-restore');
  assert.equal(store.getContact(c.id).name, 'sqlite backup');
  assert.equal(fs.statSync(db).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(file('rel.db')), false, 'custom RELSTORE_DB is the only DB destination');
});

test('WAL-only committed rows are present in VACUUM snapshot while writer connection stays open', { skip: !available || !python }, () => {
  const output = path.join(root, 'wal-snapshot.sqlite');
  py(`import sqlite3, subprocess, sys, os
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute("INSERT INTO contacts(id,name) VALUES('c_wal','committed only in WAL')")
c.commit()
assert os.path.getsize(sys.argv[1]+'-wal') > 0
r=subprocess.run([sys.argv[2],'snapshot','create','--db',sys.argv[1],'--output',sys.argv[3],'--json'],capture_output=True,text=True)
assert r.returncode == 0, r.stderr
s=sqlite3.connect(sys.argv[3])
assert s.execute("SELECT name FROM contacts WHERE id='c_wal'").fetchone()[0] == 'committed only in WAL'
s.close()
c.close()
`, [db, binary, output]);
  assert.equal(cli(['snapshot', 'validate'], output).status, 0);
  const backup = safety.createBackup();
  assert.equal(backup.counts.contacts, 2);
});

test('malicious SQLite schema, triggers, altered built-in views, future version and wrong row types are rejected in isolation', { skip: !available || !python }, () => {
  const envelope = safety.exportBackup(safety.createBackup().id);
  for (const sql of [
    'CREATE TRIGGER injected AFTER INSERT ON contacts BEGIN DELETE FROM memories; END;',
    'CREATE VIEW injected AS SELECT * FROM contacts;',
    "DROP VIEW v_material_status; CREATE VIEW v_material_status AS SELECT 'injected' AS status;",
    'CREATE TABLE secrets (token TEXT);',
    'PRAGMA user_version=999;',
    "UPDATE contacts SET name=x'000102';",
  ]) {
    const bad = modified(envelope, sql);
    const original = fs.readFileSync(db);
    assert.throws(() => safety.previewBackup(bad), /SQLITE_SNAPSHOT_REJECTED/);
    assert.throws(() => safety.restoreBackup(bad), /SQLITE_SNAPSHOT_REJECTED/);
    assert.deepEqual(fs.readFileSync(db), original);
  }
  const missing = path.join(root, 'never-created.sqlite');
  assert.notEqual(cli(['snapshot', 'validate'], missing).status, 0);
  assert.equal(fs.existsSync(missing), false);
  const corrupt = path.join(root, 'corrupt.sqlite');
  fs.writeFileSync(corrupt, 'private broken bytes');
  assert.notEqual(cli(['snapshot', 'validate'], corrupt).status, 0);
  assert.equal(fs.readFileSync(corrupt, 'utf8'), 'private broken bytes');
});

test('SQLite sidecar failure rolls back the database transaction and JSON sidecars', { skip: !available }, (t) => {
  const c = store.listContacts({ includeArchived: true })[0];
  const envelope = safety.exportBackup(safety.createBackup().id);
  store.updateContact(c.id, { name: 'current SQLite' });
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && to === file('material-reports.json') && fs.existsSync(file('.restore-journal.json'))) {
      failed = true;
      throw new Error('disk failure');
    }
    return rename(from, to);
  });
  assert.throws(() => safety.restoreBackup(envelope), /RESTORE_FAILED_ROLLED_BACK/);
  assert.equal(failed, true);
  assert.equal(store.getContact(c.id).name, 'current SQLite');
  assert.equal(fs.existsSync(file('.restore-journal.json')), false);
});

test('unchanged SQLite snapshots do not create another automatic backup after the interval', { skip: !available }, (t) => {
  safety.createBackup();
  let now = Date.now() + safety.AUTOMATIC_BACKUP_INTERVAL_MS + 1;
  t.mock.method(Date, 'now', () => now);
  assert.equal(safety.maybeAutomaticBackup(), null);
  store.createContact({ name: 'changed SQLite data' });
  now += safety.AUTOMATIC_BACKUP_INTERVAL_MS + 1;
  assert.equal(safety.maybeAutomaticBackup().reason, 'automatic');
});

test('SQLite startup recovery rolls back an interrupted database and sidecar restore without loading it first', { skip: !available }, () => {
  const envelope = safety.exportBackup(safety.createBackup().id);
  const c = store.listContacts({ includeArchived: true })[0];
  store.updateContact(c.id, { name: 'before SQLite crash' });
  const input = path.join(root, 'restore-input.json');
  fs.writeFileSync(input, JSON.stringify(envelope));
  const safetyURL = new URL('../../server/data-safety.js', import.meta.url).href;
  const storeURL = new URL('../../server/store-facade.js', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const s = await import(${JSON.stringify(safetyURL)});
    s.initializeDataSafety();
    (await import(${JSON.stringify(storeURL)})).default.loadStore();
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (to === ${JSON.stringify(file('material-reports.json'))} && fs.existsSync(${JSON.stringify(file('.restore-journal.json'))})) process.exit(74);
      return result;
    };
    s.restoreBackup(JSON.parse(fs.readFileSync(${JSON.stringify(input)}, 'utf8')));
  `], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 74, r.stderr);
  assert.equal(fs.existsSync(file('.restore-journal.json')), true);
  assert.equal(safety.initializeDataSafety().recovered, true);
  store.loadStore();
  assert.equal(store.getContact(c.id).name, 'before SQLite crash');
});

test('transactional SQLite restore preserves live WAL readers and rejects stale versions or active writers', { skip: !available || !python }, () => {
  const envelope = safety.exportBackup(safety.createBackup().id);
  const c = store.listContacts({ includeArchived: true })[0];
  const active = path.join(root, 'live-connection.sqlite');
  const expected = path.join(root, 'expected.sqlite');
  const input = path.join(root, 'incoming.sqlite');
  const changed = modified(envelope, `UPDATE contacts SET name='restored transaction' WHERE id='${c.id}'`);
  for (const target of [active, expected]) fs.writeFileSync(target, Buffer.from(envelope.files['rel.db'].data, 'base64'));
  fs.writeFileSync(input, Buffer.from(changed.files['rel.db'].data, 'base64'));
  py(`import sqlite3, subprocess, sys, os
active,binary,expected,incoming,id=sys.argv[1:]
c=sqlite3.connect(active)
c.execute('PRAGMA journal_mode=WAL')
c.execute('BEGIN')
old=c.execute('SELECT name FROM contacts WHERE id=?',(id,)).fetchone()[0]
inode=os.stat(active).st_ino
args=[binary,'snapshot','restore','--db',active,'--input',incoming,'--expected',expected,'--json']
r=subprocess.run(args,capture_output=True,text=True,timeout=15)
assert r.returncode == 0, r.stderr
assert os.stat(active).st_ino == inode
assert c.execute('SELECT name FROM contacts WHERE id=?',(id,)).fetchone()[0] == old
c.commit()
assert c.execute('SELECT name FROM contacts WHERE id=?',(id,)).fetchone()[0] == 'restored transaction'
c.execute("UPDATE contacts SET name='external after restore' WHERE id=?",(id,))
c.commit()
r=subprocess.run(args,capture_output=True,text=True,timeout=15)
assert r.returncode != 0
assert c.execute('SELECT name FROM contacts WHERE id=?',(id,)).fetchone()[0] == 'external after restore'
c.execute("UPDATE contacts SET name='restored transaction' WHERE id=?",(id,))
c.commit()
c.execute('BEGIN IMMEDIATE')
c.execute("UPDATE contacts SET name='held writer' WHERE id=?",(id,))
r=subprocess.run(args,capture_output=True,text=True,timeout=15)
assert r.returncode != 0
c.rollback()
r=subprocess.run(args,capture_output=True,text=True,timeout=15)
assert r.returncode == 0, r.stderr
c.close()
`, [active, binary, expected, input, c.id]);
});

test('SQLite recovery refuses to overwrite external edits made after an interrupted restore', { skip: !available || !python }, (t) => {
  const envelope = safety.exportBackup(safety.createBackup().id);
  const c = store.listContacts({ includeArchived: true })[0];
  store.updateContact(c.id, { name: 'before guarded restore' });
  const rename = fs.renameSync;
  let injected = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!injected && to === file('material-reports.json') && fs.existsSync(file('.restore-journal.json'))) {
      injected = true;
      py('import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.execute("UPDATE contacts SET name=? WHERE id=?", ("external during restore",sys.argv[2])); c.commit(); c.close()', [db, c.id]);
      throw new Error('sidecar disk failure');
    }
    return rename(from, to);
  });
  try {
    assert.throws(() => safety.restoreBackup(envelope), /ROLLBACK_REQUIRES_RECOVERY/);
    assert.equal(injected, true);
    assert.equal(safety.requiresDataRecovery(), true);
    assert.throws(() => safety.initializeDataSafety(), /SQLITE_SNAPSHOT_REJECTED/);
    assert.equal(fs.existsSync(file('.restore-journal.json')), true);
    assert.equal(store.getContact(c.id).name, 'external during restore');
  } finally {
    t.mock.restoreAll();
    py('import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.execute("UPDATE contacts SET name=? WHERE id=?", (sys.argv[3],sys.argv[2])); c.commit(); c.close()', [db, c.id, c.name]);
    safety.initializeDataSafety();
    store.loadStore();
  }
  assert.equal(store.getContact(c.id).name, 'before guarded restore');
});
