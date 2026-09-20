import fs from 'node:fs';
import crypto from 'node:crypto';
import { MEMORY_VECTORS_PATH, ensureDirs } from './config.js';
import { cosine, memorySearchText, textVector, vectorEntries, vectorFromEntries } from './vector-search.js';

const VERSION = 1;

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(MEMORY_VECTORS_PATH, 'utf8'));
    return v && v.version === VERSION && v.items && typeof v.items === 'object' && !Array.isArray(v.items)
      ? v
      : { version: VERSION, items: {} };
  } catch { return { version: VERSION, items: {} }; }
}

function writeAll(cache) {
  ensureDirs();
  const tmp = MEMORY_VECTORS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
  fs.renameSync(tmp, MEMORY_VECTORS_PATH);
}

function fingerprint(memory) {
  return crypto.createHash('sha256').update(memorySearchText(memory)).digest('hex');
}

function cachedVector(cache, memory) {
  const id = String(memory.id || '');
  const fp = fingerprint(memory);
  const hit = id ? cache.items[id] : null;
  if (hit && hit.fingerprint === fp && Array.isArray(hit.vector)) return vectorFromEntries(hit.vector);
  const vector = textVector(memorySearchText(memory));
  if (id) {
    cache.items[id] = { fingerprint: fp, vector: vectorEntries(vector), updatedAt: new Date().toISOString() };
    cache.changed = true;
  }
  return vector;
}

export function searchCachedMemoryVectors(memories, query, { limit = 20, minScore = 0.15 } = {}) {
  const q = String(query ?? '').toLowerCase().normalize('NFKC').trim();
  if (!q) return [];
  const qv = textVector(q);
  const cache = readAll();
  const results = memories
    .map((memory) => {
      const text = memorySearchText(memory).toLowerCase().normalize('NFKC');
      const exactBoost = text.includes(q) ? 0.35 : 0;
      return { memory, score: cosine(qv, cachedVector(cache, memory)) + exactBoost };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.memory.createdAt || '').localeCompare(a.memory.createdAt || ''))
    .slice(0, limit)
    .map((x) => ({ ...x.memory, score: Number(x.score.toFixed(4)) }));
  if (cache.changed) {
    delete cache.changed;
    writeAll(cache);
  }
  return results;
}

export function removeMemoryVectors(ids) {
  const cache = readAll();
  let changed = false;
  for (const id of ids) {
    if (cache.items[String(id)]) { delete cache.items[String(id)]; changed = true; }
  }
  if (changed) writeAll(cache);
}

export function allMemoryVectors() {
  return readAll();
}
