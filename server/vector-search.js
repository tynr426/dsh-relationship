const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_RE = /[\p{L}\p{N}]+/gu;

function normalizeText(v) {
  return String(v ?? '').toLowerCase().normalize('NFKC');
}

function addGram(map, gram, weight = 1) {
  if (!gram) return;
  map.set(gram, (map.get(gram) || 0) + weight);
}

export function textVector(text) {
  const s = normalizeText(text);
  const v = new Map();
  for (const m of s.matchAll(WORD_RE)) addGram(v, m[0], 1.2);

  const compact = [...s].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
  for (const ch of compact) {
    if (CJK_RE.test(ch)) addGram(v, ch, 0.8);
  }
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i <= compact.length - n; i++) addGram(v, compact.slice(i, i + n), n === 2 ? 1.6 : 1);
  }
  return v;
}

export function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (const av of a.values()) aa += av * av;
  for (const bv of b.values()) bb += bv * bv;
  if (!aa || !bb) return 0;
  for (const [k, av] of a) dot += av * (b.get(k) || 0);
  return dot / Math.sqrt(aa * bb);
}

export function memorySearchText(m) {
  return [m.content, m.type, m.occasion, m.direction, m.sourceQuote].filter(Boolean).join(' ');
}

export function vectorEntries(vector) {
  return [...vector.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function vectorFromEntries(entries) {
  return new Map(Array.isArray(entries) ? entries : []);
}

export function vectorSearchMemories(memories, query, { limit = 20, minScore = 0.15 } = {}) {
  const q = normalizeText(query).trim();
  if (!q) return [];
  const qv = textVector(q);
  return memories
    .map((memory) => {
      const text = normalizeText(memorySearchText(memory));
      const exactBoost = text.includes(q) ? 0.35 : 0;
      return { memory, score: cosine(qv, textVector(text)) + exactBoost };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.memory.createdAt || '').localeCompare(a.memory.createdAt || ''))
    .slice(0, limit)
    .map((x) => ({ ...x.memory, score: Number(x.score.toFixed(4)) }));
}
