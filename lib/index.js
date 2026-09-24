/**
 * dsh-relationship 宿主半：在 DeepSeek Harness 进程内拉起「关系记忆工作台」，
 * 注册 /api/dsh-relationship 路由族（loopback 护栏 + 同源镜像），并向 agent
 * 系统提示播报工作台入口与工具端点。零 npm 依赖（仅 node 内建模块）。
 *
 * 路由：
 *   GET  /api/dsh-relationship/info            工作台状态（URL/端口/数据目录）
 *   GET  /api/dsh-relationship/workbench       302 → workbench/（同源 iframe 用）
 *   ANY  /api/dsh-relationship/workbench/*     反向代理到本机工作台服务（含 SSE 流式）
 *
 * 数据目录：~/.dsh/dsh-relationship（每个用户独立）。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-relationship';
export const inject = ['webServer', 'systemPrompt'];

const BASE = '/api/dsh-relationship';
const PLUGIN_DATA_DIR = path.join(os.homedir(), '.dsh', 'dsh-relationship');

/** Loopback 护栏：本插件读写用户本机关系数据，仅放行本机浏览器请求。 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

function writeJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 提示词唯一出处：播报段由注册表生成，纪律改动只改 server/prompts.js
import { announcementBody } from '../server/prompts.js';

function announcement(port) {
  const url = `http://127.0.0.1:${port}`;
  return `【关系记忆工作台（dsh-relationship 插件）】
本机安装了「关系记忆」本地工作台，入口在 GUI 侧边栏「关系记忆」（也可工具栏「在标签页打开」）。
功能：首页待确认队列（AI 提取的记忆逐条确认/编辑/驳回后进入长期记忆，可一键全部确认）、待整理素材区（用户粘贴的长文本/聊天记录先存档，AI 拆条后回填）、联系人管理（关系/标签/生日）、联系人时间线（按类型筛选）、近期生日提醒、手动记一笔。数据全部存本机，不上传。
${announcementBody().replaceAll('{TOOLS_URL}', `${url}/api/tools`)}`;
}

export function apply(ctx, config = {}) {
  const log = (msg) => {
    try { ctx.logger?.info(msg); } catch { console.log(`[dsh-relationship] ${msg}`); }
  };

  ctx.effect(async () => {
    const routeDisposers = [];

    // 数据目录经环境变量注入，必须在动态 import 服务端前设置。
    process.env.REL_DATA_DIR ??= config.dataDir || PLUGIN_DATA_DIR;

    let state = { port: null, config: null, close: null, error: null };
    try {
      const { startRelBench, closeRelBench } = await import('../server/index.js');
      const boot = await startRelBench({ port: Number(config.port) || 8901, openBrowser: false, log });
      state = { port: boot.port, config: boot.config, close: () => closeRelBench(boot.server), error: null };
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      log(`[dsh-relationship] 工作台启动失败（路由降级为 503）：${state.error}`);
    }

    // 启动成功后再播报，注入真实端口与工具清单。
    const disposeSection = state.error || config.announceToAgent === false
      ? undefined
      : ctx.systemPrompt.section({ name: 'plugin:dsh-relationship', order: 216, text: announcement(state.port) });

    routeDisposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/info`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        if (state.error) return writeJson(res, 503, { ok: false, error: state.error });
        writeJson(res, 200, { ok: true, url: `http://127.0.0.1:${state.port}/`, port: state.port, dataDir: state.config?.dataDir || PLUGIN_DATA_DIR });
      },
    }));

    routeDisposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/workbench`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        res.writeHead(302, { Location: `${BASE}/workbench/` });
        res.end();
      },
    }));

    routeDisposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: `${BASE}/workbench`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        if (state.error) return writeJson(res, 503, { ok: false, error: state.error });
        const url = new URL(req.url, 'http://x');
        const targetPath = url.pathname.slice(`${BASE}/workbench`.length) || '/';
        const headers = { ...req.headers, host: `127.0.0.1:${state.port}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${state.port}`;
        const upstream = http.request({ host: '127.0.0.1', port: state.port, path: targetPath + url.search, method: req.method, headers }, (uRes) => {
          res.writeHead(uRes.statusCode ?? 502, uRes.headers);
          uRes.pipe(res);
        });
        upstream.on('error', (e) => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (!res.writableEnded) res.end(`relationship workbench proxy error: ${e?.message || e}`);
        });
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        req.pipe(upstream);
      },
    }));

    log(`[dsh-relationship] 插件就绪${state.error ? `（降级：${state.error}）` : `：http://127.0.0.1:${state.port}`}`);

    return () => {
      disposeSection?.();
      for (const dispose of routeDisposers.splice(0)) dispose();
      if (state.close) void state.close();
    };
  }, 'dsh-relationship: workbench server + routes');
}
