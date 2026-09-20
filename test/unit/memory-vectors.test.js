import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rel-vectors-'));
process.env.REL_DATA_DIR = dataDir;
const { searchCachedMemoryVectors, allMemoryVectors } = await import('../../server/memory-vectors.js');

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('searchCachedMemoryVectors caches vectors and recomputes on content change', () => {
  const memory = { id: 'm_cache', content: '喜欢手冲咖啡', type: 'preference', createdAt: '2026-01-01T00:00:00.000Z' };
  const first = searchCachedMemoryVectors([memory], '咖啡');
  assert.equal(first[0].id, memory.id);
  const fp1 = allMemoryVectors().items[memory.id].fingerprint;

  const changed = { ...memory, content: '喜欢周末徒步' };
  const miss = searchCachedMemoryVectors([changed], '咖啡');
  assert.equal(miss.length, 0);
  const fp2 = allMemoryVectors().items[memory.id].fingerprint;
  assert.notEqual(fp2, fp1);

  const hit = searchCachedMemoryVectors([changed], '徒步');
  assert.equal(hit[0].id, memory.id);
});
