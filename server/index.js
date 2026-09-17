// 关系记忆工作台服务端：可嵌入（dsh-relationship 插件）或独立运行（server/cli.js）
import http from 'node:http';
import { DATA_DIR } from './config.js';
import * as store from './store.js';
import { handleRequest } from './routes.js';

/**
 * 启动工作台服务。
 * @param {object} opts
 * @param {string} [opts.dataDir]   数据目录（必须在动态 import 本模块前经 REL_DATA_DIR 注入）
 * @param {number} [opts.port]      首选端口，占用时自动 +1（最多 +10）
 * @param {boolean} [opts.openBrowser] 启动成功后用系统浏览器打开（macOS）
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{port:number, server:import('node:http').Server, config:object}>}
 */
export function startRelBench(opts = {}) {
  const { port: wantPort = 8901, openBrowser = false, log = console.log } = opts;
  store.loadStore();

  const server = http.createServer((req, res) => {
    try { handleRequest(req, res); }
    catch (e) { res.writeHead(500); res.end(String(e?.message || e)); }
  });

  return new Promise((resolve, reject) => {
    const listen = (port) => {
      const onListening = () => {
        server.off('error', onError);
        log(`[dsh-relationship] 关系记忆工作台已启动：http://127.0.0.1:${port}（数据 ${DATA_DIR}）`);
        if (openBrowser && process.platform === 'darwin') {
          try { import('node:child_process').then(({ execFile }) => execFile('open', [`http://127.0.0.1:${port}`])); } catch { /* ignore */ }
        }
        resolve({ port, server, config: { dataDir: DATA_DIR } });
      };
      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && port < wantPort + 10) {
          log(`[dsh-relationship] 端口 ${port} 被占用，尝试 ${port + 1}…`);
          listen(port + 1);
        } else {
          reject(e);
        }
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    listen(wantPort);
  });
}

export function closeRelBench(server) {
  return new Promise((resolve) => {
    store.flush();
    if (!server?.listening) return resolve();
    server.close(() => resolve());
  });
}
