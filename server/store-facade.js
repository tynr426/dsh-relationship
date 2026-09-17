// 存储实现选择器：决定工作台数据落在 SQLite（store-rust.js + relstore CLI）还是 JSON 文件（store.js）。
// 顶层 await 动态 import，消费方统一 `import store from './store-facade.js'` 后照常 store.xxx() 调用。
//
// 选择规则（按优先级）：
// 1. 显式环境变量 REL_STORE=rust / json —— 最高优先，测试与排障用
// 2. 数据目录存在完整建库的 rel.db（>4KB，schema 就位，允许暂无数据）→ 自动用 rust（迁移/清空重录都算）
// 3. 其余情况 → json（默认，行为与历史版本完全一致）
//
// 注意：检测只在进程启动时做一次；回滚 json 的办法是 REL_STORE=json 重启（rel.db 原样保留）。
import { existsSync, statSync } from 'node:fs';
import { relstoreAvailable, relstoreDbPath, run as cli } from './relstore-bridge.js';

let mode = process.env.REL_STORE;
if (mode !== 'rust' && mode !== 'json') {
  mode = 'json';
  try {
    const dbPath = relstoreDbPath();
    // 判据：rel.db 存在且是完整建的库（schema 就位后 >40KB；0 字节视为误触残留）。
    // 清空重来的库（schema 在、数据为空）也算 rust——用户清库是为了在 SQLite 里重新录入，
    // 若判回 json，第一批数据会写进 JSON 文件，永远回不到 SQLite。
    const size = existsSync(dbPath) ? statSync(dbPath).size : 0;
    if (size > 4096 && relstoreAvailable()) {
      mode = 'rust';
    }
  } catch {
    // rel.db 存在但不可用：宁可响亮失败也不悄悄回 json（json 模式会重建空文件，掩盖问题）
    throw new Error('检测到 rel.db 存在但 relstore CLI 读取失败；请检查 relstore 二进制或显式指定 REL_STORE=json');
  }
}

export const STORE_MODE = mode;
const impl = await import(mode === 'rust' ? './store-rust.js' : './store.js');
export default impl;
