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

function announcement(port) {
  const url = `http://127.0.0.1:${port}`;
  return `【关系记忆工作台（dsh-relationship 插件）】
本机安装了「关系记忆」本地工作台，入口在 GUI 侧边栏「关系记忆」（也可工具栏「在标签页打开」）。
功能：首页待确认队列（AI 提取的记忆逐条确认/编辑/驳回后进入长期记忆，可一键全部确认）、待整理素材区（用户粘贴的长文本/聊天记录先存档，AI 拆条后回填）、联系人管理（关系/标签/生日）、联系人时间线（按类型筛选）、近期生日提醒、手动记一笔。数据全部存本机，不上传。
对话即录入：用户在会话里说出关系事实（如「记一下，小李女儿十月办婚礼，他对花生过敏」）时，你必须把每个事实登记为一条待确认记忆。涉及本工作台的全部操作经 REST API 完成，工具入口：POST ${url}/api/tools，body 为 {"name":"工具名","args":{...}}。可用工具：contact_search（查找联系人，任何录入前必调）、contact_add、contact_update、memory_add（登记一条待确认记忆，一条只含一个事实）、memory_batch_add（一段素材拆多条）、memory_confirm（用户明确确认后才可调用）、memory_reject、memory_update、memory_search（生成祝福/礼物建议前必调，只返回已确认记忆，检索为空要明说）、timeline_get（读取某人时间线）、gift_plan_add（把礼物方案落成计划卡，理由须引用记忆点）、gift_plan_list、gift_plan_update、gift_plan_delete、material_save（存档用户粘贴的原始素材）、material_list（列出素材，用户说"整理素材"时先调）、material_get（读素材全文后提取）。
素材智能整理流程：用户粘贴长文本/聊天记录（无论在会话里还是工作台「智能整理」框里）→ 先 material_save 存档（可带 contactId 和 occasion 场景标签）→ material_get 读全文 → 逐个 fact 用 memory_batch_add 拆条登记，每条带 sourceId=素材 ID（未显式给 occasion 时自动继承素材的）；涉及多人时先 contact_search 逐个定位，没有的联系人先与用户确认新建 → 回复里列出拆出的记忆，提示用户回工作台确认。时间分两个维度：date 记事实时间（事情何时发生），saidAt 记话语时间（这句话何时说的）；聊天带时间戳（如 2026年09月11日 20:03）时先规范化为 YYYY-MM-DD HH:mm 再填 saidAt，往来类记忆 date 用对话发生日。三层标注：interaction/gift/promise 类必填 direction（user_to_contact=用户对联系人 / contact_to_user / both）；请假、约饭等近期一次性安排 lifespan=short（不进长期画像）；能判断场景时填 occasion（teacher_day/birthday 等小写标签）。
纪律：AI 写入记忆一律为待确认（pending），不得自称"已记住"而未调用工具；礼物计划是低风险意图，用 gift_plan_add 直接落卡不进确认队列；新建联系人前先 contact_search 防止建重；事实时间与话语时间都只保留已知精度（如 2026-10-__、每年-05-20）；禁忌与健康信息只按用户原话记录，不推断；不做性格总结，不把一次行为上升为稳定偏好；生成祝福前先做表达回顾（检索同类场合 user_to_contact 历史表达并避开已说过的核心角度）；礼物建议必须基于已确认记忆（喜好/禁忌/送过记录），方案理由引用记忆点，禁忌品类明确排除。数据目录：~/.dsh/dsh-relationship。用户提到「关系记忆 / 联系人 / 记一笔 / 素材 / 送礼」时即指本插件。`;
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
