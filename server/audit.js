// 记忆质量审计（只读）：闸门拦新账，审计查旧账。
// 对已落库数据重跑与写入闸门同源的逐条检查（摘录逐字/时间戳锚点/方向），
// 加跨记忆查重（内容/摘录占用）与打包启发式（警告级）。双后端通用（经 store-facade）。
// runAudit() 返回结构化报告，供 scripts/audit.js（CLI）与单元测试复用。
import store, { STORE_MODE } from './store-facade.js';
import { DATA_DIR } from './config.js';
import { extractStamps, normalizeSaidAtStamp, STAMP_RE, DIRECTION_REQUIRED_TYPES, pad2 } from './tools.js';

const stripWs = (s) => String(s ?? '').replace(/\s+/g, '');

/** 单条活跃记忆的逐项检查（gateError 的落库后版本，含打包启发式） */
function memoryIssues(m, mt) {
  const issues = [];
  const type = String(m.type ?? '');
  if (DIRECTION_REQUIRED_TYPES.includes(type) && !String(m.direction ?? '').trim()) {
    issues.push({ code: 'MISSING_DIRECTION', level: 'error', detail: `${type} 类记忆缺 direction` });
  }
  if (!m.sourceId) return issues; // 会话直录：只查方向
  if (!mt) {
    issues.push({ code: 'MATERIAL_NOT_FOUND', level: 'error', detail: `素材 ${m.sourceId} 不存在（悬空引用）` });
    return issues;
  }
  const quote = String(m.sourceQuote ?? '').trim();
  const text = String(mt.text ?? '');
  const content = String(m.content ?? '').trim();
  if (!quote) {
    issues.push({ code: 'MISSING_QUOTE', level: 'error', detail: '无 sourceQuote 摘录，无法溯源（闸门上线前的历史数据）' });
  } else {
    if (quote.length > 200) issues.push({ code: 'QUOTE_TOO_LONG', level: 'error', detail: `摘录 ${quote.length} 字超过 200 上限` });
    const exactAt = text.indexOf(quote);
    const looseOk = exactAt < 0 && stripWs(quote) && stripWs(text).includes(stripWs(quote));
    if (exactAt < 0 && !looseOk) issues.push({ code: 'QUOTE_MISMATCH', level: 'error', detail: '摘录非逐字出自素材原文' });
    if ([...quote.matchAll(STAMP_RE)].length > 0) issues.push({ code: 'QUOTE_SPANS_STAMP', level: 'error', detail: '摘录内含完整时间戳（跨消息摘录）' });
    const { full, bareTimes } = extractStamps(text);
    const saidAt = String(m.saidAt ?? '').trim();
    const saidNorm = normalizeSaidAtStamp(saidAt);
    if (full.length) {
      if (!saidNorm) issues.push({ code: 'SAIDAT_REQUIRED', level: 'error', detail: '素材含时间戳但 saidAt 为空' });
      else {
        const anchor = [...full].reverse().find((s) => exactAt >= 0 && s.end <= exactAt + quote.length);
        if (anchor && saidNorm !== anchor.stamp) issues.push({ code: 'SAIDAT_MISPLACED', level: 'error', detail: `saidAt=${saidAt} 与原话位置不符，就近时间戳 ${anchor.stamp}` });
        if (!full.some((s) => s.stamp === saidNorm)) issues.push({ code: 'SAIDAT_NOT_IN_MATERIAL', level: 'error', detail: `saidAt=${saidAt} 不在素材时间戳里` });
      }
    } else if (bareTimes.length) {
      const tm = /(\d{1,2})[：:](\d{2})\s*$/.exec(saidAt);
      if (!tm || !bareTimes.includes(`${pad2(tm[1])}:${tm[2]}`)) {
        issues.push({ code: 'SAIDAT_NOT_IN_MATERIAL', level: 'error', detail: `素材只有时分时间（${bareTimes.join('、')}），saidAt 时间部分不命中` });
      }
    } else if (saidAt) {
      issues.push({ code: 'SAIDAT_NOT_IN_MATERIAL', level: 'error', detail: '素材无时间戳但 saidAt 非空' });
    }
  }
  // 打包启发式（警告级）：语义问题闸门管不住，标记出来供拍板时留意
  if (content.length > 55 || (content.match(/[；;。]/g) || []).length >= 2) {
    issues.push({ code: 'SUSPECTED_PACKING', level: 'warn', detail: `疑似多事实打包（${content.length} 字），拆条粒度供拍板时留意` });
  }
  return issues;
}

/** 跨记忆查重：同联系人同内容、同素材同摘录同联系人（与闸门占用语义一致：驳回/被取代不占） */
function crossMemoryIssues(active, issues) {
  const groups = [
    { code: 'DUPLICATE_CONTENT', level: 'error', key: (m) => `${m.contactId}｜${String(m.content ?? '').trim()}`, skip: (m) => false },
    { code: 'DUPLICATE_QUOTE', level: 'error', key: (m) => (m.sourceId && stripWs(m.sourceQuote) ? `${m.sourceId}｜${stripWs(m.sourceQuote)}｜${m.contactId}` : ''), skip: (m) => !m.sourceId || !stripWs(m.sourceQuote) },
  ];
  for (const { code, level, key, skip } of groups) {
    const byKey = new Map();
    for (const m of active) {
      if (skip(m)) continue;
      const k = key(m);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(m);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const m of group) {
        issues.get(m.id).push({ code, level, detail: `与 ${group.filter((x) => x !== m).map((x) => x.id).join('、')} ${code === 'DUPLICATE_CONTENT' ? '内容重复' : '复用同一摘录'}` });
      }
    }
  }
}

/** 全量审计（只读）。返回结构化报告；issues 按 level 分 error/warn。 */
export function runAudit() {
  const contacts = store.listContacts({ includeArchived: true, includePending: true });
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  const materials = store.listMaterials({});
  const reports = store.allMaterialReports();
  const all = store.listMemories({});
  const active = all.filter((m) => !m.supersededBy && (m.status === 'pending' || m.status === 'confirmed'));

  const bySource = new Map();
  const sessionMems = [];
  for (const m of active) {
    if (m.sourceId) {
      if (!bySource.has(m.sourceId)) bySource.set(m.sourceId, []);
      bySource.get(m.sourceId).push(m);
    } else {
      sessionMems.push(m);
    }
  }
  const issues = new Map(active.map((m) => [m.id, []]));
  for (const [sourceId, mems] of bySource) {
    const mt = store.getMaterial(sourceId) || null;
    for (const m of mems) issues.set(m.id, memoryIssues(m, mt));
  }
  for (const m of sessionMems) issues.set(m.id, memoryIssues(m, null));
  crossMemoryIssues(active, issues);

  const row = (m) => ({ id: m.id, contactName: names.get(m.contactId) || '', type: m.type, status: m.status, content: String(m.content ?? '').slice(0, 60), issues: issues.get(m.id) || [] });
  const materialRows = materials.map((mt) => ({
    id: mt.id,
    excerpt: mt.excerpt,
    occasion: mt.occasion || '',
    status: store.materialStatus(mt),
    activeCount: (bySource.get(mt.id) || []).length,
    hasReport: Boolean(reports[mt.id]),
    memories: (bySource.get(mt.id) || []).map(row),
  }));
  const danglingReferences = [...bySource.entries()]
    .filter(([sourceId]) => !store.getMaterial(sourceId))
    .flatMap(([, mems]) => mems.map(row));

  let clean = 0;
  let errors = 0;
  let warns = 0;
  const byCode = {};
  for (const m of active) {
    const list = issues.get(m.id) || [];
    if (!list.length) { clean++; continue; }
    for (const it of list) {
      if (it.level === 'error') errors++; else warns++;
      byCode[it.code] = (byCode[it.code] || 0) + 1;
    }
  }
  return {
    storeMode: STORE_MODE,
    dataDir: DATA_DIR,
    totals: {
      contacts: contacts.length,
      materials: materials.length,
      active: active.length,
      rejected: all.filter((m) => m.status === 'rejected').length,
      superseded: all.filter((m) => m.supersededBy).length,
    },
    materials: materialRows,
    sessionMemories: sessionMems.map(row),
    danglingReferences,
    summary: { clean, flagged: active.length - clean, errors, warns, byCode },
  };
}
