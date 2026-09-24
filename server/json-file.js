// Shared fail-closed JSON IO. Error messages never include file contents or parser errors.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';

export class JsonFileError extends Error {
  constructor(file, code = 'INVALID_JSON') {
    super(`无法安全读取 ${path.basename(file)} (${code})`);
    this.name = 'JsonFileError';
    this.code = code;
  }
}

export function readJsonFile(file, fallback, validate = () => true) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(typeof fallback === 'function' ? fallback() : fallback);
    throw new JsonFileError(file, 'READ_FAILED');
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!validate(value)) throw new Error();
    return value;
  } catch { throw new JsonFileError(file); }
}

export function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Unique private temp + fsync + rename. Parent directory must already exist. */
export function atomicWriteFile(file, data) {
  const tmp = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const records = (v) => Array.isArray(v) && v.every(isRecord);
const optional = (v, key, check) => !(key in v) || check(v[key]);
const text = (v) => typeof v === 'string';
const fields = (v, keys) => keys.split(' ').every((key) => optional(v, key, text));
const member = (v, key, values) => optional(v, key, (value) => values.includes(value));
const mapOf = (v, check) => isRecord(v) && Object.values(v).every(check);
const exactKeys = (v, keys) => isRecord(v) && Object.keys(v).length === keys.length
  && keys.every((key) => Object.hasOwn(v, key));
const safeId = (v) => text(v) && v.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(v);
const timestamp = (v) => text(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const FOLLOWUP_STATUSES = Object.freeze(['active', 'done', 'dismissed', 'snoozed']);
export function isCalendarDate(v) {
  if (!text(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith('0000-')) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function validFollowups(v) {
  return isRecord(v) && Object.entries(v).every(([id, e]) =>
    exactKeys(e, ['contactId', 'memoryId', 'kind', 'sourceVersion', 'status', 'until', 'updatedAt'])
    && safeId(e.contactId) && safeId(e.memoryId) && ['promise', 'reciprocity'].includes(e.kind)
    && id === `${e.kind}:${e.memoryId}` && text(e.sourceVersion) && /^[a-f0-9]{64}$/.test(e.sourceVersion)
    && FOLLOWUP_STATUSES.includes(e.status) && timestamp(e.updatedAt)
    && (e.status === 'snoozed' ? isCalendarDate(e.until) : e.until === ''));
}
function validMaterialDeliveries(v) {
  return isRecord(v) && Object.entries(v).every(([id, e]) => safeId(id)
    && exactKeys(e, ['copiedAt', 'sentAt'])
    && (e.copiedAt === '' || timestamp(e.copiedAt)) && (e.sentAt === '' || timestamp(e.sentAt))
    && Boolean(e.copiedAt || e.sentAt));
}

/** Shared structural checks; optional legacy fields remain migratable. */
export function validateDataFile(name, v) {
  if (name === 'followups.json') return validFollowups(v);
  if (name === 'material-delivery.json') return validMaterialDeliveries(v);
  if (name === 'meta.json') return isRecord(v) && Number.isInteger(v.schemaVersion)
    && v.schemaVersion >= 0 && v.schemaVersion <= CURRENT_SCHEMA_VERSION;
  if (name === 'material-reports.json') return mapOf(v, (e) => isRecord(e) && text(e.report) && fields(e, 'reportedAt'));
  if (name === 'material-contacts.json') return mapOf(v, strings);
  if (name === 'organize-questions.json') return mapOf(v, (e) => isRecord(e) && text(e.question)
    && fields(e, 'askedAt sentAt copiedAt') && optional(e, 'status', (s) => ['pending', 'sent'].includes(s))
    && optional(e, 'options', (a) => records(a) && a.every((o) => text(o.label) && text(o.command))));
  if (name === 'plan-suggestions.json') return mapOf(v, (e) => isRecord(e) && text(e.basedOnPlanId) && fields(e, 'linkedAt'));
  if (name === 'memory-revisions.json') return isRecord(v) && v.version === 1 && records(v.proposals) && records(v.history);
  if (name === 'memory-vectors.json') return isRecord(v) && v.version === 1 && mapOf(v.items, (e) => isRecord(e)
    && text(e.fingerprint) && fields(e, 'updatedAt') && Array.isArray(e.vector)
    && e.vector.every((pair) => Array.isArray(pair) && pair.length === 2 && text(pair[0]) && Number.isFinite(pair[1])));
  if (!records(v)) return false;
  const key = name === 'relation_types.json' ? 'key' : 'id';
  if (!v.every((e) => text(e[key]) && e[key].length > 0) || new Set(v.map((e) => e[key])).size !== v.length) return false;
  return v.every((e) => {
    if (!fields(e, 'createdAt updatedAt')) return false;
    switch (name) {
      case 'contacts.json': return text(e.name) && fields(e, 'relation birthday notes')
        && optional(e, 'tags', strings) && optional(e, 'archived', (b) => typeof b === 'boolean')
        && optional(e, 'status', (s) => ['pending', 'confirmed'].includes(s));
      case 'memories.json': return text(e.content) && text(e.contactId)
        && fields(e, 'type date saidAt direction lifespan occasion sourceId sourceQuote author status reason')
        && member(e, 'type', ['preference', 'dislike', 'taboo', 'event', 'gift', 'promise', 'interaction', 'attribute'])
        && member(e, 'status', ['pending', 'confirmed', 'rejected']) && member(e, 'author', ['ai', 'user'])
        && member(e, 'direction', ['', 'user_to_contact', 'contact_to_user', 'both']) && member(e, 'lifespan', ['long', 'short'])
        && optional(e, 'importance', (n) => Number.isInteger(n) && n >= 1 && n <= 3)
        && optional(e, 'confirmedAt', (s) => s === null || text(s))
        && optional(e, 'supersededBy', (s) => s === null || text(s));
      case 'materials.json': return text(e.text) && fields(e, 'kind excerpt contactId occasion capturedAt')
        && member(e, 'kind', ['text', 'screenshot', 'file']) && optional(e, 'extractedMemoryIds', strings);
      case 'plans.json': return text(e.idea) && text(e.contactId)
        && fields(e, 'occasion occasionDate budget productName productPrice productUrl status sentAt memoryId source')
        && member(e, 'status', ['idea', 'decided', 'sent', 'done']) && member(e, 'source', ['ai', 'user']);
      case 'relation_types.json': return /^[a-z][a-z0-9_]{0,31}$/.test(e.key) && text(e.label)
        && optional(e, 'sort', Number.isInteger) && optional(e, 'builtin', (b) => typeof b === 'boolean');
      default: return false;
    }
  });
}
