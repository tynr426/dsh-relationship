// relstore 桥接层：关系记忆的唯一真源在 relstore 的 SQLite 库（rel.db，0600），
// 由 Rust CLI 独占读写。本模块只通过 spawn relstore 子进程交互，
// Node 侧不开任何数据库连接。写法对齐 dsh-qa 的 customers-bridge.js（家法）。
//
// 与 dbvault 桥的差异：本桥为同步（spawnSync）——工作台 routes/tools 全是同步
// store.* 调用，同步桥让存储实现可整体切换（REL_STORE=rust）而无需改造路由层。
// 单用户本地应用，CLI 单次调用 ~20ms，同步可接受。
import { execFile, spawnSync } from 'node:child_process';
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
    if (msg.includes('MEMORY_CONFLICT')) {
      throw Object.assign(new Error('原记忆已被其他操作修改，旧提案不能覆盖，请刷新后重新核对'), { status: 409, code: 'MEMORY_CONFLICT' });
    }
    if (args.includes('--expected') && msg.includes('unexpected argument')) {
      throw Object.assign(new Error('relstore 版本过旧，请重新构建后再修改记忆'), { status: 503 });
    }
    throw new Error(msg.replace(/^✗\s*/, ''));
  }
  const out = String(result.stdout || '').trim();
  try {
    return JSON.parse(out.split('\n').pop());
  } catch {
    throw new Error(`relstore 输出解析失败: ${out.slice(0, 120)}`);
  }
}

const JD_FAILURE = '京东服务暂不可用，请检查本机 relstore 安装与配置后重试';
const JD_ENV_NAMES = ['JD_APP_KEY', 'JD_APP_SECRET', 'JD_SITE_ID', 'JD_POSITION_ID'];
const jdError = (status = 502, message = JD_FAILURE) => Object.assign(new Error(message), { status });
const boundedText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);

function jdResult(command, data) {
  if (data?.ok !== true) throw jdError();
  if (command === 'status') {
    if (typeof data.configured !== 'boolean' || !Array.isArray(data.missing)
      || data.missing.some((name) => !JD_ENV_NAMES.includes(name))) throw jdError();
    return { ok: true, configured: data.configured, missing: data.missing };
  }
  if (command === 'search') {
    if (!Array.isArray(data.items) || data.items.length > 20) throw jdError();
    const items = data.items.map((item) => {
      if (!item || !boundedText(item.itemId, 256) || !/^[A-Za-z0-9_+=-]+$/.test(item.itemId) || !boundedText(item.name, 1000)
        || !item.name || typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0
        || !boundedText(item.imageUrl, 4096)) throw jdError();
      return { itemId: item.itemId, name: item.name, price: item.price, imageUrl: item.imageUrl };
    });
    return { ok: true, items };
  }
  const product = data.product;
  if (!product || !boundedText(product.productName, 1000) || !product.productName
    || !boundedText(product.productPrice, 40) || !product.productPrice
    || !boundedText(product.productUrl, 4096)) throw jdError();
  let url;
  try { url = new URL(product.productUrl); } catch { throw jdError(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw jdError();
  return { ok: true, product: { productName: product.productName, productPrice: product.productPrice, productUrl: product.productUrl } };
}

export async function runAsync(args) {
  if (!Array.isArray(args) || args[0] !== 'jd' || !['status', 'search', 'promote'].includes(args[1])
    || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw jdError(400, '无效的京东请求');
  const command = args[1];
  const flags = command === 'search' ? ['--keyword', '--min-price', '--max-price']
    : command === 'promote' ? ['--item-id', '--name', '--price'] : [];
  const seen = new Set();
  for (let i = 2; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || seen.has(args[i]) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw jdError(400, '无效的京东请求');
    // 降级资料（goods.query 无权限时替代售前复核的名称/价格）单独校验取值
    if (args[i] === '--name' && !boundedText(args[i + 1], 200)) throw jdError(400, '无效的京东请求');
    if (args[i] === '--price') {
      const price = Number(args[i + 1]);
      if (!boundedText(args[i + 1], 32) || !Number.isFinite(price) || price <= 0 || price > 1000000) throw jdError(400, '无效的京东请求');
    }
    seen.add(args[i]);
  }
  if ((command === 'search' && !seen.has('--keyword')) || (command === 'promote' && !seen.has('--item-id'))) throw jdError(400, '无效的京东请求');
  let executable;
  try { executable = bin(); } catch { throw jdError(503); }
  return new Promise((resolve, reject) => {
    execFile(executable, [...args, '--json', '--db', relstoreDbPath()], {
      timeout: 30_000, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error && (error.killed || error.signal || typeof error.code !== 'number')) {
        reject(jdError(error.killed ? 504 : 502));
        return;
      }
      try {
        const data = JSON.parse(stdout.trim());
        if (data?.ok === false && [400, 404, 502, 503, 504].includes(data.status)
          && boundedText(data.error, 200) && data.error) throw jdError(data.status, data.error);
        if (error) throw jdError();
        resolve(jdResult(command, data));
      } catch (e) {
        reject(e?.status ? e : jdError());
      }
    });
  }).catch((error) => { throw error?.status ? error : jdError(); });
}
