// 独立运行入口：node server/cli.js
process.env.REL_DATA_DIR ??= new URL('../data', import.meta.url).pathname;
// 端口可配（默认 8901）。注意：插件安装到 DSH 后，8901 由 DSH 进程内的工作台
// 服务持有——独立模式/E2E 一律用 REL_PORT 换端口，绝不与宿主争抢。
const PORT = Number(process.env.REL_PORT) || 8901;

const { startRelBench } = await import('./index.js');

console.log('  关系记忆工作台 · dsh-relationship（独立模式）');
console.log('  AI 对话录入请在 DeepSeek Harness 中使用本插件与「关系记忆」preset\n');

const { server } = await startRelBench({ port: PORT, openBrowser: process.env.REL_NO_OPEN !== '1' });

function shutdown() {
  import('./index.js').then(({ closeRelBench }) => {
    closeRelBench(server).then(() => process.exit(0));
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
