// 存储实现选择器：REL_STORE=rust 走 SQLite（store-rust.js + relstore CLI），
// 默认 json 走原 JSON 文件实现（store.js）。顶层 await 动态 import，
// 消费方统一 `import store from './store-facade.js'` 后照常 store.xxx() 调用。
const impl = await import(process.env.REL_STORE === 'rust' ? './store-rust.js' : './store.js');
export default impl;
