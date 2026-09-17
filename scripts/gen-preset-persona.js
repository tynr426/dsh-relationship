#!/usr/bin/env node
// 从提示词注册表（server/prompts.js）生成 preset 人设段，写入 preset/relationship/agent.cordis.yml。
// 纪律唯一出处是 prompts.js：本脚本把 DISCIPLINE/presetBody() 渲染进 yml 的 persona.prefix，
// 消除「同一纪律手写多处」的漂移。用法：node scripts/gen-preset-persona.js [--check]
//   --check  只比对文件是否已是最新（CI/测试用），不同步则退出码 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetBody } from '../server/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'preset', 'relationship', 'agent.cordis.yml');

const INDENT = '      '; // yml prefix 段的固定缩进
const body = presetBody()
  .split('\n')
  .map((l) => (l.trim() ? INDENT + l : ''))
  .join('\n');

const src = fs.readFileSync(FILE, 'utf8');
// 定位 prefix: >- 与下一段（- id: agent-instructions）之间的人设正文
const PREFIX_MARK = '    prefix: >-\n';
const PREFIX_AT = src.indexOf(PREFIX_MARK);
const END = src.indexOf('- id: agent-instructions');
if (PREFIX_AT < 0 || END < 0) {
  console.error('✗ 未定位到 persona prefix 段（"prefix: >-" 到 "- id: agent-instructions"）');
  process.exit(1);
}
const START = PREFIX_AT + PREFIX_MARK.length;
const next = `${body}\n\n`;

if (process.argv.includes('--check')) {
  const current = src.slice(START, END);
  process.stdout.write(current === next ? 'preset persona 已是最新\n' : 'preset persona 落后于 prompts.js\n');
  process.exit(current === next ? 0 : 1);
}

fs.writeFileSync(FILE, src.slice(0, START) + next + src.slice(END));
console.log('✔ preset persona 已从 server/prompts.js 重新生成：preset/relationship/agent.cordis.yml');
