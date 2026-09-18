// 提示词注册表防漂移测试：四个出口（preset 人设、播报、整理指令、礼物建议）
// 都必须包含所引用的纪律片段关键内容——纪律改动只改 server/prompts.js，
// 任何出口与注册表脱节（手写回退/漏同步）在这里立刻失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCIPLINE, FLOWS, announcementBody, presetBody, toolCatalog } from '../../server/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('纪律片段注册表：关键主题一条不缺', () => {
  const mustHave = ['onePerFact', 'pendingOnly', 'confirmHumanOnly', 'sessionPendingCheck', 'reportOnOrganize', 'searchFirst', 'sceneFirst', 'dedupe', 'behaviorOnly', 'verbatim', 'quote', 'dualTime', 'dateAnchor', 'direction', 'lifespan', 'occasion', 'conflict', 'recallFirst', 'recallAvoidRepeat', 'giftRules', 'privacy'];
  for (const key of mustHave) {
    assert.ok(DISCIPLINE[key], `DISCIPLINE.${key} 缺失`);
    assert.ok(DISCIPLINE[key].length >= 20, `DISCIPLINE.${key} 内容过短`);
  }
  // 确认下线是安全闭环，任何片段/出口不得再出现「用 memory_confirm 确认」的旧口径
  assert.ok(!DISCIPLINE.confirmHumanOnly.includes('用 memory_confirm'));
  // 联系人待确认队列纪律：查不到的人直接新建（进队列），不再打断整理问用户
  assert.ok(DISCIPLINE.searchFirst.includes('待确认队列'), 'searchFirst 应说明新建联系人进待确认队列');
  assert.ok(DISCIPLINE.multiPerson.includes('contact_add'), 'multiPerson 应允许直接新建');
  assert.ok(!DISCIPLINE.multiPerson.includes('先与用户确认再新建'), 'multiPerson 不得再要求先问再建');
});

test('出口①播报（lib/index.js）：由注册表生成且引用了完整纪律', () => {
  const body = announcementBody();
  for (const key of ['sceneFirst', 'dedupe', 'multiPerson', 'dualTime', 'direction', 'lifespan', 'occasion', 'pendingOnly', 'behaviorOnly', 'recallAvoidRepeat', 'giftRules', 'sessionPendingCheck', 'reportOnOrganize']) {
    assert.ok(body.includes(DISCIPLINE[key].slice(0, 30)), `播报缺少纪律片段 ${key} 的内容`);
  }
  assert.ok(body.includes('memory_confirm 已下线'), '播报必须声明确认无 AI 工具');
  assert.ok(body.includes('{TOOLS_URL}'), '播报保留工具入口占位符（宿主注入端口）');
});

test('出口②preset：agent.cordis.yml 与注册表生成结果一致（防手改漂移）', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'preset', 'relationship', 'agent.cordis.yml'), 'utf8');
  const body = presetBody();
  // yml 里 persona 正文每行带 6 空格缩进——比对时去掉
  const normalize = (s) => s.split('\n').map((l) => l.replace(/^ {6}/, '')).join('\n');
  const ymlPersona = normalize(yml.slice(yml.indexOf('    prefix: >-\n') + '    prefix: >-\n'.length, yml.indexOf('- id: agent-instructions'))).trim();
  assert.equal(ymlPersona, body.trim(), 'agent.cordis.yml persona 落后于 server/prompts.js——跑 node scripts/gen-preset-persona.js');
  for (const key of ['sceneFirst', 'dedupe', 'behaviorOnly', 'dateAnchor', 'confirmHumanOnly', 'sessionPendingCheck', 'reportOnOrganize', 'recallAvoidRepeat', 'giftRules']) {
    assert.ok(body.includes(DISCIPLINE[key].slice(0, 20)), `preset 缺少纪律片段 ${key}`);
  }
});

test('出口③整理指令（FLOWS.materialOrganize）：8 步流程 + 工具入口 + today 锚点', () => {
  const cmd = FLOWS.materialOrganize.build('mt_demo', 'http://127.0.0.1:8901/api/tools');
  assert.equal((cmd.match(/^\d\./gm) || []).length, 8, '整理指令应为 8 步');
  assert.ok(cmd.includes('mt_demo'), '含素材 ID');
  assert.ok(cmd.includes('today'), '含相对时间锚点说明');
  assert.ok(cmd.includes('memory_search'), '含查重步骤');
  assert.ok(cmd.includes('sourceId="mt_demo"'), '含溯源要求');
  assert.ok(cmd.includes('material_report'), '第 8 步须经 material_report 提交整理报告');
  assert.ok(cmd.includes('回工作台确认'), '含人工确认引导');
  // 第 2 步：查不到的人直接新建待确认联系人，不再「先问我」
  assert.ok(cmd.includes('contact_add'), '查不到的联系人应直接 contact_add 新建');
  assert.ok(!cmd.includes('先问我'), '不得再要求先问用户才能建联系人');
  // 流程步骤声明与片段一致
  assert.deepEqual(FLOWS.materialOrganize.steps, ['loadMaterial', 'multiPerson', 'sceneFirst', 'dedupe', 'extract', 'report']);
});

test('出口④礼物建议（FLOWS.giftSuggest）：引用 giftRules + recallFirst', () => {
  const prompt = FLOWS.giftSuggest.build({ contactName: '测试', relation: 'friend', occasion: 'birthday', budget: '', plan: null, lines: ['- [喜好] 岩茶'] });
  for (const frag of ['2-3 个具体方案', '明确排除', '不重复建议', 'gift_plan_add', 'memory_search']) {
    assert.ok(prompt.includes(frag), `礼物建议缺关键内容：${frag}`);
  }
  assert.ok(prompt.includes('岩茶'), '证据清单被拼入');
});

test('工具目录：无 memory_confirm（AI 通道禁确认）', () => {
  assert.ok(!toolCatalog().includes('memory_confirm'), 'toolCatalog 不应再出现 memory_confirm');
  assert.ok(toolCatalog().includes('material_report'), 'toolCatalog 应含 material_report');
  assert.ok(toolCatalog().includes('pending_summary'), 'toolCatalog 应含 pending_summary');
});
