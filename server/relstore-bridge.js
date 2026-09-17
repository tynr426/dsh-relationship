// relstore 桥接层：关系记忆的唯一真源在 relstore 的 SQLite 库（rel.db，0600），
// 由 Rust CLI 独占读写。本模块只通过 spawn relstore 子进程交互，
// Node 侧不开任何数据库连接。写法对齐 dsh-qa 的 customers-bridge.js（家法）。
//
// 与 dbvault 桥的差异：本桥为同步（spawnSync）——工作台 routes/tools 全是同步
// store.* 调用，同步桥让存储实现可整体切换（REL_STORE=rust）而无需改造路由层。
// 单用户本地应用，CLI 单次调用 ~20ms，同步可接受。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/** 返回 relstore CLI 二进制路径（可通过 RELSTORE_BIN 覆盖；构建产物约定在 ~/.openclaw-shared/bin） */
export function relstoreBin() {
  return process.env.RELSTORE_BIN || join(homedir(), '.openclaw-shared', 'bin', 'relstore');
}

/** 开发态：仓库内刚构建好的二进制（npm run build:relstore 输出） */
function devBin() {
  return join(process.cwd(), 'rust', 'relstore', 'target', 'release', 'relstore');
}

/** 检查 relstore 是否可用（部署路径或仓库开发路径任一存在） */
export function relstoreAvailable() {
  return existsSync(relstoreBin()) || existsSync(devBin());
}

function bin() {
  const deployed = relstoreBin();
  if (existsSync(deployed)) return deployed;
  const dev = devBin();
  if (existsSync(dev)) return dev;
  throw new Error('relstore 未安装（~/.openclaw-shared/bin/relstore）；请先 npm run build:relstore 构建部署 Rust CLI');
}

/** 库路径：RELSTORE_DB 显式指定 > 数据目录下 rel.db（与 JSON 文件同目录，迁移后同源） */
export function relstoreDbPath() {
  return process.env.RELSTORE_DB || join(DATA_DIR, 'rel.db');
}

/**
 * 执行 relstore CLI 命令并解析 JSON 输出（自动追加 --json，取 stdout 最后一行）。
 * CLI 失败（stderr ✗ ...）抛出同文案错误；超时 10 秒。
 * @param {string[]} args CLI 参数数组（不含 --json）
 */
export function run(args, { timeout = 10_000 } = {}) {
  const result = spawnSync(bin(), [...args, '--json', '--db', relstoreDbPath()], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`relstore 调用失败: ${result.error.message}`);
  if (result.status !== 0) {
    const msg = String(result.stderr || '').trim() || String(result.stdout || '').trim() || `exit ${result.status}`;
    throw new Error(msg.replace(/^✗\s*/, ''));
  }
  const out = String(result.stdout || '').trim();
  try {
    return JSON.parse(out.split('\n').pop());
  } catch {
    throw new Error(`relstore 输出解析失败: ${out.slice(0, 120)}`);
  }
}
