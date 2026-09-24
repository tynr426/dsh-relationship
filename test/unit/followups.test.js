import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '../..');
const mode = process.env.REL_FOLLOWUP_TEST_BACKEND;
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };
if (!mode) {
  const binary = process.env.RELSTORE_BIN || path.join(root, 'rust/relstore/target/release/relstore');
  for (const backend of ['json', 'rust']) test(`followup and delivery persistence: ${backend}`, () => {
    if (backend === 'rust') assert.ok(fs.existsSync(binary), 'built relstore CLI required');
    const result = spawnSync(process.execPath, ['--test', self], {
      cwd: root, encoding: 'utf8', timeout: 180_000,
      env: { ...childEnv(), REL_FOLLOWUP_TEST_BACKEND: backend, RELSTORE_BIN: binary },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /v1 migration clears sidecars/);
    process.stdout.write(result.stdout);
  });
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rel-followups-${mode}-`));
  process.env.REL_DATA_DIR = dir;
  process.env.REL_STORE = mode;
  process.env.RELSTORE_DB = path.join(dir, 'rel.db');
  const storeURL = new URL('../../server/store-facade.js', import.meta.url).href;
  const store = (await import(storeURL)).default;
  const { validateDataFile } = await import('../../server/json-file.js');
  const file = (name) => path.join(dir, name);
  const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'));
  const all = () => store.listFollowups({ includeHandled: true });
  const itemFor = (memory) => all().find((item) => item.memoryId === memory.id);
  const update = (item, status, until = '') => store.updateFollowup(item.id, { status, until, sourceVersion: item.sourceVersion });
  const error = (status, fn) => assert.throws(fn, (e) => e.status === status);
  const memory = (contactId, fields = {}) => store.createMemory({ contactId, type: 'promise', content: 'send the photos', author: 'user', ...fields });
  const gift = (contactId, date, fields = {}) => memory(contactId, { type: 'gift', direction: 'contact_to_user', content: 'received a book', date, ...fields });
  const child = (code, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const store = (await import(${JSON.stringify(storeURL)})).default;
    store.loadStore();
    ${code}
  `], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...childEnv(), ...env } });
  test.beforeEach(() => {
    store.suspendPersistence?.();
    for (const name of fs.readdirSync(dir)) fs.rmSync(file(name), { recursive: true, force: true });
    store.loadStore();
  });
  test.after(() => { store.suspendPersistence?.(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('multiple promises are independent; done/dismissed/snoozed/reopen never change facts or ledger', () => {
    const c = store.createContact({ name: 'friend', relation: 'friend' });
    const a = memory(c.id, { date: '2026-09-20', occasion: 'birthday' });
    const b = memory(c.id, { content: 'arrange dinner' });
    const received = gift(c.id, '2026-09-21');
    const plan = store.createPlan({ contactId: c.id, idea: 'a possible gift' });
    const facts = structuredClone(store.listMemories());
    const ledger = structuredClone(store.giftLedger());
    const plans = structuredClone(store.listPlans());
    const item = itemFor(a);
    assert.equal(item.id, `promise:${a.id}`);
    assert.equal(item.contactName, c.name);
    assert.equal(item.relation, c.relation);
    assert.equal(item.content, a.content);
    assert.equal(item.date, a.date);
    assert.equal(item.occasion, 'birthday');
    assert.equal(item.until, '');
    assert.equal(item.updatedAt, '');
    assert.match(item.sourceVersion, /^[a-f0-9]{64}$/);
    assert.equal(itemFor(received).hasActivePlan, true);
    update(item, 'done');
    assert.deepEqual(new Set(store.listFollowups().map((i) => i.memoryId)), new Set([b.id, received.id]));
    update(itemFor(b), 'dismissed');
    update(itemFor(received), 'done');
    assert.equal(store.listFollowups().length, 0);
    assert.equal(all().length, 3);
    assert.equal(itemFor(b).status, 'dismissed');
    assert.equal(update(itemFor(a), 'active').status, 'active');
    assert.equal(update(itemFor(a), 'snoozed', '2999-02-28').status, 'snoozed');
    assert.equal(store.listFollowups().length, 0);
    assert.equal(update(itemFor(a), 'active').until, '');
    assert.deepEqual(store.listMemories(), facts);
    assert.deepEqual(store.giftLedger(), ledger);
    assert.deepEqual(store.listPlans(), plans);
    assert.equal(store.getPlan(plan.id).status, 'idea');
    assert.deepEqual(store.memoryHistory(a.id), []);
    assert.deepEqual(store.listMemoryRevisions(), []);
    const saved = read('followups.json')[item.id];
    assert.deepEqual(Object.keys(saved).sort(), ['contactId', 'kind', 'memoryId', 'sourceVersion', 'status', 'until', 'updatedAt']);
  });

  test('strict dates, elapsed snoozes, safe IDs and invalid patches', () => {
    const c = store.createContact({ name: 'dates' });
    const item = itemFor(memory(c.id));
    for (const until of ['', null, 0, '2000-01-01', '2999-02-29', '2999-04-31', '2999-13-01',
      '2999-00-10', '2999-01-00', '2999-1-01', '2999-01-01T00:00:00Z', '2999-01-01 ', '每年-01-01']) {
      error(400, () => update(item, 'snoozed', until));
    }
    for (const patch of [null, [], {}, { status: 'sent', sourceVersion: item.sourceVersion },
      { status: 'done' }, { status: 'done', sourceVersion: 42 },
      { status: 'done', sourceVersion: item.sourceVersion, unexpected: true }]) {
      error(400, () => store.updateFollowup(item.id, patch));
    }
    error(400, () => update(item, 'done', '2999-01-01'));
    for (const id of ['__proto__', 'constructor', 'promise:__proto__', 'promise:missing', 'reciprocity:missing']) {
      error(404, () => update({ ...item, id }, 'done'));
    }
    error(400, () => store.listFollowups({ today: '2026-02-30' }));
    update(item, 'snoozed', '2996-02-29');
    const bytes = fs.readFileSync(file('followups.json'));
    assert.equal(store.listFollowups({ today: '2996-02-28' }).length, 0);
    assert.equal(store.listFollowups({ includeHandled: true, today: '2996-02-28' })[0].status, 'snoozed');
    assert.equal(store.listFollowups({ today: '2996-02-29' })[0].status, 'active');
    assert.equal(store.listFollowups({ today: '2996-03-01' })[0].until, '');
    assert.deepEqual(fs.readFileSync(file('followups.json')), bytes, 'elapsed reads never mutate dispositions');
  });

  test('local calendar day, not UTC, controls due dates and snooze validation', () => {
    const c = store.createContact({ name: 'timezone' });
    const item = itemFor(memory(c.id));
    store.flush();
    const r = child(`
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-09-22T01:00:00.000Z'])); }
      };
      assert.equal(new Date().getDate(), 21);
      const item = store.listFollowups()[0];
      assert.throws(() => store.updateFollowup(item.id, { status: 'snoozed', until: '2026-09-21', sourceVersion: item.sourceVersion }), e => e.status === 400);
      store.updateFollowup(item.id, { status: 'snoozed', until: '2026-09-22', sourceVersion: item.sourceVersion });
      assert.equal(store.listFollowups().length, 0);
      assert.equal(store.listFollowups({ today: '2026-09-22' })[0].id, ${JSON.stringify(item.id)});
    `, { TZ: 'America/Los_Angeles' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('real reload preserves handling; editing source invalidates old version with 409 and reactivates', () => {
    const c = store.createContact({ name: 'reload' });
    const a = memory(c.id);
    const b = memory(c.id, { content: 'second promise' });
    const g = gift(c.id, '2026-09-21');
    const old = itemFor(a);
    update(old, 'done');
    update(itemFor(b), 'snoozed', '2999-01-01');
    update(itemFor(g), 'dismissed');
    store.flush();
    const r = child(`
      const items = store.listFollowups({ includeHandled: true });
      assert.deepEqual(new Set(items.map(i => i.status)), new Set(['done', 'snoozed', 'dismissed']));
      assert.equal(store.listFollowups().length, 0);
      store.updateMemory(${JSON.stringify(a.id)}, { content: 'edited promise' });
    `);
    assert.equal(r.status, 0, r.stderr);
    store.loadStore();
    assert.equal(itemFor(a).status, 'active');
    assert.equal(itemFor(a).content, 'edited promise');
    assert.notEqual(itemFor(a).sourceVersion, old.sourceVersion);
    error(409, () => update(old, 'done'));
    assert.equal(update(itemFor(a), 'done').status, 'done');
    const later = gift(c.id, '2026-09-23');
    assert.equal(itemFor(g), undefined);
    assert.equal(itemFor(later).status, 'active');
    error(404, () => update({ ...old, id: `reciprocity:${g.id}` }, 'done'));
  });

  test('pending/rejected/superseded/archived/deleted sources and pending contacts are ineligible', () => {
    const c = store.createContact({ name: 'eligibility' });
    const pendingContact = store.createContact({ name: 'pending contact', status: 'pending' });
    memory(pendingContact.id);
    const pending = memory(c.id, { author: 'ai' });
    const rejected = memory(c.id, { author: 'ai', content: 'reject this' });
    store.rejectMemory(rejected.id);
    const superseded = memory(c.id);
    const valid = memory(c.id, { content: 'replacement' });
    store.supersedeMemory(superseded.id, valid.id);
    memory(c.id, { type: 'event' });
    assert.deepEqual(all().map((i) => i.memoryId), [valid.id]);
    for (const m of [pending, rejected, superseded]) error(404, () => update({ ...itemFor(valid), id: `promise:${m.id}` }, 'done'));
    const item = itemFor(valid);
    update(item, 'done');
    store.updateContact(c.id, { archived: true });
    assert.deepEqual(all(), []);
    error(404, () => update(item, 'active'));
    store.updateContact(c.id, { archived: false });
    assert.equal(itemFor(valid).status, 'done');
    store.deleteMemory(valid.id);
    assert.deepEqual(all(), []);
    error(404, () => update(item, 'active'));
  });

  test('reciprocity derives valid latest gifts, excluding superseded sent and received facts', () => {
    const c = store.createContact({ name: 'gift facts' });
    const event = memory(c.id, { type: 'event' });
    const received = gift(c.id, '2026-09-10');
    const newer = gift(c.id, '2026-09-12');
    store.supersedeMemory(newer.id, event.id);
    gift(c.id, '2026-09-30', { author: 'ai' });
    assert.equal(store.giftReciprocity()[0].memoryId, received.id);
    const sent = gift(c.id, '2026-09-11', { direction: 'user_to_contact' });
    assert.deepEqual(store.giftReciprocity(), []);
    store.supersedeMemory(sent.id, event.id);
    assert.equal(store.giftReciprocity()[0].memoryId, received.id, 'superseded sent gift cannot suppress a reminder');
    store.supersedeMemory(received.id, event.id);
    assert.deepEqual(store.giftReciprocity(), [], 'no eligible received gift must not dereference undefined');
    gift(c.id, '2026-09-20', { direction: 'both' });
    assert.deepEqual(store.giftReciprocity(), []);
    const latest = gift(c.id, '2026-09-21');
    assert.equal(itemFor(latest).hasActivePlan, false);
    const plan = store.createPlan({ contactId: c.id, idea: 'possible return gift' });
    assert.equal(itemFor(latest).hasActivePlan, true);
    store.updatePlan(plan.id, { status: 'done' });
    assert.equal(itemFor(latest).hasActivePlan, false);
    assert.equal(itemFor(latest).status, 'active', 'plan completion does not invent a sent gift');
    gift(c.id, '2026-09-21', { content: 'same day later record' });
    assert.equal(store.giftReciprocity()[0].memoryId, latest.id, 'equal dates retain JSON insertion-order choice');
  });

  test('copied is not sent; neither dispatch completes organization or confirms memories', () => {
    const c = store.createContact({ name: 'dispatch' });
    const mt = store.saveMaterial({ text: 'material to organize', contactId: c.id });
    assert.equal(store.materialDelivery(mt.id), null);
    assert.deepEqual(store.allMaterialDeliveries(), {});
    for (const status of ['', 'done', 'failed', 'organized', null]) error(400, () => store.markMaterialDelivery(mt.id, status));
    for (const id of ['missing', '__proto__', 'constructor']) error(404, () => store.markMaterialDelivery(id, 'sent'));
    assert.equal(store.materialDelivery('__proto__'), null);
    const original = structuredClone(store.getMaterial(mt.id));
    const copied = store.markMaterialDelivery(mt.id, 'copied');
    assert.ok(copied.copiedAt);
    assert.equal(copied.sentAt, '');
    const sent = store.markMaterialDelivery(mt.id, 'sent');
    assert.equal(sent.copiedAt, copied.copiedAt);
    assert.ok(sent.sentAt);
    assert.equal(store.markMaterialDelivery(mt.id, 'copied').sentAt, sent.sentAt);
    assert.deepEqual(store.getMaterial(mt.id), original);
    assert.equal(store.materialStatus(store.getMaterial(mt.id)), 'raw');
    assert.equal(store.materialReport(mt.id), null);
    const m = memory(c.id, { sourceId: mt.id, author: 'ai' });
    store.markMaterialDelivery(mt.id, 'sent');
    assert.equal(store.getMemory(m.id).status, 'pending');
    assert.equal(store.materialReport(mt.id), null);
    store.saveMaterialReport(mt.id, 'completed report');
    store.markMaterialDelivery(mt.id, 'copied');
    assert.equal(store.materialReport(mt.id).report, 'completed report');
    store.flush();
    const r = child(`assert.deepEqual(store.materialDelivery(${JSON.stringify(mt.id)}), ${JSON.stringify(store.materialDelivery(mt.id))});`);
    assert.equal(r.status, 0, r.stderr);
  });

  test('atomic publication failures never report successful handling or delivery', (t) => {
    const c = store.createContact({ name: 'write failure' });
    const m = memory(c.id);
    const item = itemFor(m);
    const mt = store.saveMaterial({ text: 'not yet delivered', contactId: c.id });
    const copied = store.markMaterialDelivery(mt.id, 'copied');
    update(item, 'dismissed');
    store.flush();
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if ([file('followups.json'), file('material-delivery.json')].includes(to)) throw new Error('injected atomic failure');
      return rename(from, to);
    });
    assert.throws(() => update(item, 'done'), /injected atomic failure/);
    assert.throws(() => store.markMaterialDelivery(mt.id, 'sent'), /injected atomic failure/);
    assert.equal(itemFor(m).status, 'dismissed');
    assert.deepEqual(store.materialDelivery(mt.id), copied);
    assert.equal(store.materialReport(mt.id), null);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  });

  test('memory/contact/material deletions clean only corresponding sidecar records', () => {
    const c = store.createContact({ name: 'delete' });
    const other = store.createContact({ name: 'keep' });
    const a = memory(c.id);
    const b = memory(c.id, { content: 'delete with contact' });
    const g = gift(c.id, '2026-09-21');
    const keep = memory(other.id);
    for (const item of all()) update(item, 'done');
    const mt = store.saveMaterial({ text: 'explicit deletion', contactId: c.id });
    const cascade = store.saveMaterial({ text: 'contact deletion', contactId: c.id });
    const retained = store.saveMaterial({ text: 'unrelated', contactId: other.id });
    for (const m of [mt, cascade, retained]) store.markMaterialDelivery(m.id, 'sent');
    store.deleteMemory(a.id);
    assert.equal(Object.hasOwn(read('followups.json'), `promise:${a.id}`), false);
    assert.equal(itemFor(b).status, 'done');
    store.deleteMaterial(mt.id);
    assert.equal(store.materialDelivery(mt.id), null);
    store.deleteContact(c.id);
    assert.deepEqual(Object.keys(read('followups.json')), [`promise:${keep.id}`]);
    assert.equal(itemFor(g), undefined);
    assert.equal(store.materialDelivery(cascade.id) === null, !store.getMaterial(cascade.id));
    assert.equal(Boolean(store.getMaterial(cascade.id)), mode === 'json');
    assert.ok(store.materialDelivery(retained.id).sentAt);
  });

  test('corrupt sidecars fail closed on read, write, deletion, startup and backup without replacing bytes', async () => {
    const c = store.createContact({ name: 'corruption' });
    const m = memory(c.id);
    const item = itemFor(m);
    update(item, 'done');
    const mt = store.saveMaterial({ text: 'preserve material', contactId: c.id });
    store.markMaterialDelivery(mt.id, 'copied');
    store.flush();
    const safety = await import('../../server/data-safety.js?followup-corrupt');
    safety.initializeDataSafety();
    store.loadStore();
    for (const name of ['followups.json', 'material-delivery.json']) {
      const good = fs.readFileSync(file(name), 'utf8');
      const map = JSON.parse(good);
      const id = Object.keys(map)[0];
      const invalidRecord = name === 'followups.json' ? { ...map[id], until: '2999-01-01' } : { copiedAt: '', sentAt: 'not-a-time' };
      for (const bad of ['{secret', '[]', 'null', '{"__proto__":{}}', JSON.stringify({ [id]: null }),
        JSON.stringify({ [id]: { ...map[id], unknown: true } }), JSON.stringify({ [id]: invalidRecord })]) {
        fs.writeFileSync(file(name), bad);
        try {
          const actions = name === 'followups.json'
            ? [() => all(), () => update(item, 'active'), () => store.deleteMemory(m.id)]
            : [() => store.allMaterialDeliveries(), () => store.materialDelivery(mt.id),
              () => store.markMaterialDelivery(mt.id, 'sent'), () => store.deleteMaterial(mt.id)];
          for (const action of [...actions, () => store.deleteContact(c.id), () => store.loadStore()]) {
            assert.throws(action, { name: 'JsonFileError' });
          }
          assert.throws(() => safety.createBackup());
          assert.equal(fs.readFileSync(file(name), 'utf8'), bad);
          assert.ok(store.getMemory(m.id));
          assert.ok(store.getMaterial(mt.id));
          assert.ok(store.getContact(c.id));
        } finally { fs.writeFileSync(file(name), good); }
      }
      assert.equal(validateDataFile(name, JSON.parse(good)), true);
    }
  });

  test('v2 sidecars roundtrip; v1 migration clears sidecars and pre-restore rollback restores them', async (t) => {
    const c = store.createContact({ name: 'backup sidecars' });
    const m = memory(c.id);
    const item = itemFor(m);
    const mt = store.saveMaterial({ text: 'backup material', contactId: c.id });
    update(item, 'snoozed', '2999-01-01');
    store.markMaterialDelivery(mt.id, 'copied');
    store.markMaterialDelivery(mt.id, 'sent');
    store.flush();
    const safety = await import('../../server/data-safety.js?followup-migration');
    safety.initializeDataSafety();
    store.loadStore();
    const envelope = safety.exportBackup(safety.createBackup().id);
    assert.equal(envelope.version, 2);
    const preview = safety.previewBackup(envelope);
    assert.equal(preview.counts.followups, 1);
    assert.equal(preview.counts.materialDeliveries, 1);
    const oldFollowups = read('followups.json');
    const oldDeliveries = store.allMaterialDeliveries();
    update(item, 'done');
    safety.restoreBackup(envelope);
    assert.deepEqual(read('followups.json'), oldFollowups);
    assert.deepEqual(store.allMaterialDeliveries(), oldDeliveries);
    assert.equal(itemFor(m).status, 'snoozed');
    const legacy = structuredClone(envelope);
    legacy.version = 1;
    delete legacy.files['followups.json'];
    delete legacy.files['material-delivery.json'];
    const before = fs.readFileSync(file('followups.json'));
    assert.equal(safety.previewBackup(legacy).version, 1);
    assert.equal(safety.previewBackup(legacy).counts.followups, 0);
    assert.deepEqual(fs.readFileSync(file('followups.json')), before, 'v1 preview is read only');
    const result = safety.restoreBackup(legacy);
    assert.equal(fs.existsSync(file('followups.json')), false);
    assert.equal(fs.existsSync(file('material-delivery.json')), false);
    assert.equal(itemFor(m).status, 'active');
    assert.equal(store.materialDelivery(mt.id), null);
    safety.restoreBackup(safety.exportBackup(result.backup.id));
    assert.deepEqual(read('followups.json'), oldFollowups);
    assert.deepEqual(store.allMaterialDeliveries(), oldDeliveries);
    // A v1 stored backup exports as v2 but its original bytes remain usable by recovery hashes.
    legacy.id = `b_${crypto.randomBytes(16).toString('hex')}`;
    const legacyBytes = JSON.stringify(legacy);
    fs.writeFileSync(file(`backups/${legacy.id}.json`), legacyBytes);
    const exported = safety.exportBackup(legacy.id);
    assert.equal(exported.version, 2);
    assert.equal(exported.files['followups.json'], null);
    assert.equal(exported.files['material-delivery.json'], null);
    assert.equal(fs.readFileSync(file(`backups/${legacy.id}.json`), 'utf8'), legacyBytes);
    for (const invalid of [{ ...legacy, files: { ...legacy.files, 'followups.json': null } },
      { ...envelope, files: legacy.files }, { ...envelope, version: 3 }]) {
      assert.throws(() => safety.previewBackup(invalid));
      assert.throws(() => safety.restoreBackup(invalid));
    }
    // Fail after one v1 reset, exercising rollback with a v1 expected envelope on SQLite too.
    const remove = fs.rmSync;
    let failed = false;
    const mock = t.mock.method(fs, 'rmSync', (target, ...args) => {
      if (!failed && target === file('material-delivery.json') && fs.existsSync(file('.restore-journal.json'))) {
        failed = true; throw new Error('injected migration IO failure');
      }
      return remove(target, ...args);
    });
    assert.throws(() => safety.restoreBackup(legacy), /RESTORE_FAILED_ROLLED_BACK/);
    mock.mock.restore();
    assert.equal(failed, true);
    assert.deepEqual(read('followups.json'), oldFollowups);
    assert.deepEqual(store.allMaterialDeliveries(), oldDeliveries);
    assert.equal(store.getMemory(m.id).content, m.content);
    const r = child(`
      import fs from 'node:fs';
      const safety = await import(${JSON.stringify(new URL('../../server/data-safety.js', import.meta.url).href)});
      safety.initializeDataSafety(); store.loadStore();
      const remove = fs.rmSync;
      fs.rmSync = (target, ...args) => {
        if (target === ${JSON.stringify(file('material-delivery.json'))} && fs.existsSync(${JSON.stringify(file('.restore-journal.json'))})) process.exit(72);
        return remove(target, ...args);
      };
      safety.restoreBackup(${JSON.stringify(legacy)});
    `);
    assert.equal(r.status, 72, r.stderr);
    if (mode === 'rust') assert.equal(read('.restore-journal.json').expected.version, 1);
    assert.equal(safety.initializeDataSafety().recovered, true);
    store.loadStore();
    assert.deepEqual(read('followups.json'), oldFollowups);
    assert.deepEqual(store.allMaterialDeliveries(), oldDeliveries);
  });
}
