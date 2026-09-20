#!/usr/bin/env node
// 记忆质量审计 CLI：npm run audit
// 审计插件真实数据：REL_DATA_DIR=~/.dsh/dsh-relationship npm run audit
import { runAudit } from '../server/audit.js';

const r = runAudit();
const MARK = { error: 'x', warn: '!' };

function printIssues(rows) {
  for (const m of rows) {
    if (!m.issues.length) continue;
    for (const it of m.issues) console.log(`  [${MARK[it.level]}] ${m.id} ${m.contactName} ${m.type} | ${it.code}: ${it.detail}`);
    console.log(`      「${m.content}」`);
  }
}

console.log(`记忆质量审计（只读）| 后端 ${r.storeMode} | ${r.dataDir}`);
console.log(`联系人 ${r.totals.contacts} | 素材 ${r.totals.materials} | 活跃记忆 ${r.totals.active}（已驳回 ${r.totals.rejected}、被取代 ${r.totals.superseded} 不计问题）`);

if (r.danglingReferences.length) {
  console.log(`\n悬空引用（素材已删除，记忆失源）：`);
  printIssues(r.danglingReferences);
}
for (const mt of r.materials) {
  console.log(`\n素材 ${mt.id}「${mt.excerpt}」${mt.occasion ? ` | ${mt.occasion}` : ''} | ${mt.status} | 已拆 ${mt.activeCount} 条${mt.hasReport ? '' : ' | 无整理报告'}`);
  printIssues(mt.memories);
}
if (r.sessionMemories.length) {
  console.log(`\n会话直录（无素材溯源，只查方向）：`);
  printIssues(r.sessionMemories);
}

console.log(`\n汇总：干净 ${r.summary.clean} | 有问题 ${r.summary.flagged}（错误 ${r.summary.errors}、警告 ${r.summary.warns}）`);
const codes = Object.entries(r.summary.byCode);
if (codes.length) {
  console.log(`按类型：${codes.map(([c, n]) => `${c} x${n}`).join('、')}`);
  if (r.summary.byCode.MISSING_QUOTE) console.log('提示：MISSING_QUOTE 是闸门上线前的历史数据——重整理对应素材即可补上溯源');
  if (r.summary.byCode.SUSPECTED_PACKING) console.log('提示：SUSPECTED_PACKING 是启发式警告（非错误），拍板确认时可留意是否该拆成多条');
} else {
  console.log('审计完成，未发现问题。');
}
