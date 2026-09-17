// 存储实现共享的小工具（避免 store-rust.js 反向依赖 store.js 而加载 JSON 库）。
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export const now = () => new Date().toISOString();
