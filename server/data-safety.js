// 启动先恢复日志再加载主库；同步备份与恢复期间由 HTTP 层排除在途写请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR as CONFIG_DATA_DIR, ROOT } from './config.js';
import store, { STORE_MODE } from './store-facade.js';
import { relstoreBin, relstoreDbPath } from './relstore-bridge.js';
import { atomicWriteFile, syncDirectory, isRecord, validateDataFile } from './json-file.js';
import { createMemoryRevisions } from './memory-revisions.js';

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const AUTOMATIC_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const DATA_DIR = path.resolve(CONFIG_DATA_DIR);
const BACKUP_VERSION = 2;
const V1_JSON_FILES = Object.freeze([
  'contacts.json', 'memories.json', 'materials.json', 'plans.json', 'relation_types.json', 'meta.json',
  'material-reports.json', 'material-contacts.json', 'organize-questions.json', 'plan-suggestions.json',
  'memory-vectors.json', 'memory-revisions.json',
]);
const V2_ADDITIONS = Object.freeze(['followups.json', 'material-delivery.json']);
const JSON_FILES = Object.freeze([...V1_JSON_FILES, ...V2_ADDITIONS]);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const JOURNAL = path.join(DATA_DIR, '.restore-journal.json');
const REVISION_JOURNAL = path.join(DATA_DIR, 'memory-revisions.journal.json');
const ID = /^b_[a-f0-9]{32}$/;
const REASONS = ['manual', 'startup', 'automatic', 'pre-restore'];
let initialized = false;
let startupDone = false;
let lastFingerprint = '';
let lastBackupAt = 0;

export class DataSafetyError extends Error {
  constructor(code, status = 400) {
    super(`数据安全检查失败 (${code})`);
    this.name = 'DataSafetyError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status) => { throw new DataSafetyError(code, status); };
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
const names = (backend = STORE_MODE, version = BACKUP_VERSION) => {
  const files = version === 1 ? V1_JSON_FILES : JSON_FILES;
  return backend === 'rust' ? [...files, 'rel.db'] : [...files];
};
const destination = (name) => name === 'rel.db' ? path.resolve(relstoreDbPath()) : path.join(DATA_DIR, name);
const backupFile = (id) => {
  if (!ID.test(id)) fail('INVALID_ID');
  return path.join(BACKUP_DIR, `${id}.json`);
};
function stat(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function regular(file) {
  const s = stat(file);
  if (s && !s.isFile()) fail('NOT_REGULAR_FILE');
  return s;
}
function privateDirectory(dir) {
  const s = stat(dir);
  if (s && !s.isDirectory()) fail('NOT_PRIVATE_DIRECTORY');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
function storageDirectory() {
  const s = stat(DATA_DIR);
  if (s && !s.isDirectory()) fail('INVALID_DATA_DIRECTORY');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  privateDirectory(BACKUP_DIR);
  if (STORE_MODE === 'rust') {
    const db = destination('rel.db');
    if (JSON_FILES.some((n) => path.resolve(destination(n)) === db)
      || db.startsWith(path.resolve(BACKUP_DIR) + path.sep)
      || ['.env', '.restore-journal.json', 'memory-revisions.journal.json'].includes(path.basename(db))) fail('INVALID_DATABASE_PATH');
  }
}
function readBytes(file) {
  const s = regular(file);
  if (!s) return null;
  if (s.size > MAX_BACKUP_BYTES) fail('TOO_LARGE', 413);
  const data = fs.readFileSync(file);
  if (data.length > MAX_BACKUP_BYTES) fail('TOO_LARGE', 413);
  return data;
}
function parse(data) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { fail('INVALID_JSON'); }
}
function jsonValue(name, bytes) {
  const v = parse(bytes);
  if (!validateDataFile(name, v)) fail('INVALID_DATA_STRUCTURE');
  return v;
}
function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-safety-'));
  try { fs.chmodSync(dir, 0o700); return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function sqlite(command, db, options = {}) {
  const configured = relstoreBin();
  const binary = fs.existsSync(configured) ? configured : path.join(ROOT, 'rust/relstore/target/release/relstore');
  const args = ['snapshot', command, '--json', '--db', db];
  for (const [key, value] of Object.entries(options)) args.push(`--${key}`, value);
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) fail('SQLITE_SNAPSHOT_REJECTED');
  const value = parse(Buffer.from(result.stdout.trim().split('\n').pop()));
  if (value?.ok !== true || !isRecord(value.counts)) fail('SQLITE_SNAPSHOT_REJECTED');
  return value.counts;
}
export function requiresDataRecovery() {
  return !initialized || Boolean(stat(JOURNAL));
}
function assertIdle() {
  if (requiresDataRecovery()) fail('INITIALIZATION_REQUIRED', 503);
  if (stat(REVISION_JOURNAL)) fail('MEMORY_REVISION_RECOVERY_REQUIRED', 503);
}
function entry(bytes) {
  return bytes === null ? null : { encoding: 'base64', size: bytes.length, sha256: hash(bytes), data: bytes.toString('base64') };
}
function encode(envelope) {
  let text;
  try { text = JSON.stringify(envelope); } catch { fail('INVALID_ENVELOPE'); }
  if (!text || Buffer.byteLength(text) > MAX_BACKUP_BYTES) fail('TOO_LARGE', 413);
  return text;
}
function decode(envelope, allowOtherBackend = false) {
  if (typeof envelope === 'string' || Buffer.isBuffer(envelope)) {
    if (Buffer.byteLength(envelope) > MAX_BACKUP_BYTES) fail('TOO_LARGE', 413);
    envelope = parse(Buffer.from(envelope));
  }
  // Detach caller-owned objects, reject non-JSON and bound the complete wire format.
  envelope = parse(Buffer.from(encode(envelope)));
  if (!exactKeys(envelope, ['version', 'id', 'backend', 'createdAt', 'reason', 'files']) || ![1, BACKUP_VERSION].includes(envelope.version)
    || !ID.test(envelope.id) || !REASONS.includes(envelope.reason)
    || typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt))) fail('INVALID_ENVELOPE');
  if (!['json', 'rust'].includes(envelope.backend) || (!allowOtherBackend && envelope.backend !== STORE_MODE)) fail('BACKEND_MISMATCH');
  const sourceNames = names(envelope.backend, envelope.version);
  if (!exactKeys(envelope.files, sourceNames)) fail('INVALID_FILE_LIST');
  const buffers = new Map();
  let total = 0;
  for (const name of sourceNames) {
    const e = envelope.files[name];
    if (e === null) {
      if (name === 'rel.db') fail('MISSING_DATABASE');
      buffers.set(name, null);
      continue;
    }
    if (!exactKeys(e, ['encoding', 'size', 'sha256', 'data']) || e.encoding !== 'base64'
      || !Number.isSafeInteger(e.size) || e.size < 0 || typeof e.data !== 'string'
      || typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) fail('INVALID_FILE_ENTRY');
    const bytes = Buffer.from(e.data, 'base64');
    total += bytes.length;
    if (total > MAX_BACKUP_BYTES) fail('TOO_LARGE', 413);
    if (bytes.length !== e.size || bytes.toString('base64') !== e.data || hash(bytes) !== e.sha256) fail('CHECKSUM_MISMATCH');
    buffers.set(name, bytes);
  }
  // v1 缺少的侧车应清空；原信封须保留，以便恢复日志校验和 SQLite 回滚。
  if (envelope.version === 1) for (const name of V2_ADDITIONS) buffers.set(name, null);
  const counts = { contacts: 0, memories: 0, materials: 0, plans: 0, relationTypes: 0,
    materialReports: 0, materialContacts: 0, organizeQuestions: 0, planSuggestions: 0, memoryVectors: 0,
    memoryRevisionProposals: 0, memoryRevisionHistory: 0, followups: 0, materialDeliveries: 0 };
  const countNames = { 'contacts.json': 'contacts', 'memories.json': 'memories', 'materials.json': 'materials',
    'plans.json': 'plans', 'relation_types.json': 'relationTypes', 'material-reports.json': 'materialReports',
    'material-contacts.json': 'materialContacts', 'organize-questions.json': 'organizeQuestions', 'plan-suggestions.json': 'planSuggestions',
    'followups.json': 'followups', 'material-delivery.json': 'materialDeliveries' };
  for (const name of JSON_FILES) {
    const bytes = buffers.get(name);
    if (bytes === null) continue;
    const v = jsonValue(name, bytes);
    if (countNames[name]) counts[countNames[name]] = Object.keys(v).length;
    if (name === 'memory-vectors.json') counts.memoryVectors = Object.keys(v.items).length;
    if (name === 'memory-revisions.json') {
      counts.memoryRevisionProposals = v.proposals.length;
      counts.memoryRevisionHistory = v.history.length;
      // 仅复用修改历史的纯校验，不能在预览时触发日志恢复。
      withTemp((dir) => {
        atomicWriteFile(path.join(dir, name), bytes);
        try {
          createMemoryRevisions({ store: {}, validateMemoryFields: (fields) => store.validateMemoryFields(fields), dataDir: dir }).validate();
        } catch { fail('INVALID_MEMORY_REVISIONS'); }
      });
    }
  }
  if (envelope.backend === 'rust') withTemp((dir) => {
    const db = path.join(dir, 'snapshot.db');
    atomicWriteFile(db, buffers.get('rel.db'));
    Object.assign(counts, sqlite('validate', db));
  });
  return { envelope, buffers, counts, total };
}
function metadata({ envelope, counts }) {
  const { id, createdAt, backend, reason } = envelope;
  return { id, createdAt, backend, counts, reason };
}
function fingerprint(envelope) {
  return hash(JSON.stringify(names().map((name) => [name, envelope.files[name]?.sha256 ?? null])));
}
function capture(reason, flush) {
  // Validate existing on-disk bytes BEFORE flushing stale in-memory JSON.
  const files = {};
  let total = 0;
  const add = (name, bytes) => {
    total += bytes?.length ?? 0;
    if (total > MAX_BACKUP_BYTES) fail('TOO_LARGE', 413);
    if (name !== 'rel.db' && bytes !== null) jsonValue(name, bytes);
    files[name] = entry(bytes);
  };
  for (const name of JSON_FILES) add(name, readBytes(destination(name)));
  if (flush) {
    store.flush();
    total = 0;
    for (const name of JSON_FILES) add(name, readBytes(destination(name)));
  }
  if (STORE_MODE === 'rust') withTemp((dir) => {
    const db = destination('rel.db');
    regular(db);
    const output = path.join(dir, 'snapshot.db');
    sqlite('create', db, { output });
    add('rel.db', readBytes(output));
  });
  const envelope = { version: BACKUP_VERSION, id: `b_${crypto.randomBytes(16).toString('hex')}`, backend: STORE_MODE,
    createdAt: new Date().toISOString(), reason, files };
  return decode(envelope);
}
function save(snapshot) {
  atomicWriteFile(backupFile(snapshot.envelope.id), encode(snapshot.envelope));
  lastFingerprint = fingerprint(snapshot.envelope);
  lastBackupAt = Date.now();
  // 新备份持久化成功后才清理自动备份，手动和恢复前备份不自动删除。
  const automatic = listBackups().filter((b) => ['startup', 'automatic'].includes(b.reason));
  for (const old of automatic.slice(7)) fs.unlinkSync(backupFile(old.id));
  if (automatic.length > 7) syncDirectory(BACKUP_DIR);
  return metadata(snapshot);
}
function readBackup(id, allowOtherBackend = false) {
  const bytes = readBytes(backupFile(id));
  if (bytes === null) fail('BACKUP_NOT_FOUND', 404);
  const snapshot = decode(bytes, allowOtherBackend);
  if (snapshot.envelope.id !== id) fail('BACKUP_ID_MISMATCH');
  return snapshot;
}

export function initializeDataSafety() {
  initialized = false;
  store.suspendPersistence?.();
  storageDirectory();
  let recovered = false;
  if (stat(JOURNAL)) {
    initialized = false;
    store.suspendPersistence?.();
    const journal = parse(readBytes(JOURNAL));
    const keys = ['version', 'backend', 'backupId', 'sha256', 'target'];
    if (STORE_MODE === 'rust') keys.push('expected');
    if (!exactKeys(journal, keys) || journal.version !== 1
      || journal.backend !== STORE_MODE || journal.target !== hash(destination('rel.db'))) fail('INVALID_RECOVERY_JOURNAL', 503);
    const snapshot = readBackup(journal.backupId);
    if (hash(encode(snapshot.envelope)) !== journal.sha256) fail('INVALID_RECOVERY_JOURNAL', 503);
    apply(snapshot, STORE_MODE === 'rust' ? decode(journal.expected) : undefined);
    clearJournal();
    recovered = true;
  }
  initialized = true;
  let backup = null;
  if (!startupDone && !stat(REVISION_JOURNAL) && (STORE_MODE !== 'rust' || regular(destination('rel.db')))) {
    backup = save(capture('startup', false));
    startupDone = true;
  }
  return { recovered, backup };
}

export function createBackup(reason = 'manual') {
  assertIdle();
  if (!REASONS.includes(reason)) fail('INVALID_REASON');
  return save(capture(reason, true));
}
export function listBackups() {
  if (!stat(BACKUP_DIR)) return [];
  if (!stat(BACKUP_DIR).isDirectory()) fail('NOT_PRIVATE_DIRECTORY');
  return fs.readdirSync(BACKUP_DIR).filter((name) => /^b_[a-f0-9]{32}\.json$/.test(name))
    .map((name) => metadata(readBackup(name.slice(0, -5), true)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export function exportBackup(id) {
  const { envelope } = readBackup(id, true);
  if (envelope.version === BACKUP_VERSION) return envelope;
  // Export old stored backups in the current format without rewriting their journal-hashed originals.
  return { ...envelope, version: BACKUP_VERSION,
    files: { ...envelope.files, ...Object.fromEntries(V2_ADDITIONS.map((name) => [name, null])) } };
}
export function previewBackup(envelope) {
  const snapshot = decode(envelope);
  return { ...metadata(snapshot), version: snapshot.envelope.version, bytes: snapshot.total, files: names(), requiresConfirmation: true };
}
function clearJournal() {
  fs.unlinkSync(JOURNAL);
  syncDirectory(DATA_DIR);
}
function requireRecovery(code) {
  initialized = false;
  store.suspendPersistence?.();
  const error = new DataSafetyError(code, 503);
  error.recoveryRequired = true;
  throw error;
}
function apply(snapshot, expected) {
  for (const name of names()) regular(destination(name));
  if (STORE_MODE === 'rust') withTemp((dir) => {
    const input = path.join(dir, 'input.db');
    const previous = path.join(dir, 'expected.db');
    atomicWriteFile(input, snapshot.buffers.get('rel.db'));
    atomicWriteFile(previous, expected.buffers.get('rel.db'));
    sqlite('restore', destination('rel.db'), { input, expected: previous });
  });
  for (const name of JSON_FILES) {
    const file = destination(name);
    const bytes = snapshot.buffers.get(name);
    if (bytes === null) {
      fs.rmSync(file, { force: true });
      syncDirectory(path.dirname(file));
    } else atomicWriteFile(file, bytes);
  }
}

export function restoreBackup(envelope) {
  assertIdle();
  const incoming = decode(envelope); // Validation never writes the active DB.
  const before = capture('pre-restore', true);
  const backup = save(before);
  try {
    atomicWriteFile(JOURNAL, encode({ version: 1, backend: STORE_MODE, backupId: backup.id,
      sha256: hash(encode(before.envelope)), target: hash(destination('rel.db')),
      ...(STORE_MODE === 'rust' ? { expected: incoming.envelope } : {}) }));
  } catch (error) {
    if (stat(JOURNAL)) requireRecovery('JOURNAL_SYNC_REQUIRES_RECOVERY');
    throw error;
  }
  store.suspendPersistence?.();
  try {
    apply(incoming, before);
    store.loadStore();
  } catch {
    try {
      store.suspendPersistence?.();
      apply(before, incoming);
      store.loadStore();
      clearJournal();
    } catch {
      requireRecovery('ROLLBACK_REQUIRES_RECOVERY');
    }
    fail('RESTORE_FAILED_ROLLED_BACK', 503);
  }
  // 日志清除失败时提交点不确定，重启恢复前禁止业务读写。
  try { clearJournal(); } catch { requireRecovery('RESTORE_COMMIT_REQUIRES_RECOVERY'); }
  lastFingerprint = '';
  return { backup, restored: metadata(incoming) };
}
export function maybeAutomaticBackup() {
  assertIdle();
  if (!startupDone) {
    const backup = save(capture('startup', true));
    startupDone = true;
    return backup;
  }
  if (Date.now() - lastBackupAt < AUTOMATIC_BACKUP_INTERVAL_MS) return null;
  const snapshot = capture('automatic', true);
  if (fingerprint(snapshot.envelope) === lastFingerprint) return null;
  return save(snapshot);
}
