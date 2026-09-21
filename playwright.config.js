import { defineConfig, devices } from '@playwright/test';

// E2E 专用端口：与独立模式默认端口 8901、以及 DSH 插件安装后由宿主进程
// 持有的 8901 隔离——测试永不触碰运行中的真实工作台。
// 文件之间默认并行，但共享同一个服务；不同 spec 需要不同的初始数据
// （relbench 依赖空库做首价值引导断言），所以每个 spec 独立端口和数据目录。
const PORT = 8911;
const JD_PORT = 8912;

const webServerFor = (port, dataDir) => ({
  command: `node -e "import('node:fs').then(({ rmSync }) => rmSync('${dataDir}', { recursive: true, force: true }))" && REL_NO_OPEN=1 REL_PORT=${port} REL_DATA_DIR=${dataDir} node server/cli.js`,
  url: `http://127.0.0.1:${port}`,
  reuseExistingServer: false,
  timeout: 30_000,
  stdout: 'pipe',
  stderr: 'pipe',
});

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'relbench', testMatch: /relbench\.spec\.js/, use: { baseURL: `http://127.0.0.1:${PORT}` } },
    { name: 'jd-products', testMatch: /jd-products\.spec\.js/, use: { baseURL: `http://127.0.0.1:${JD_PORT}` } },
    // 探针自带目标地址（127.0.0.1:3080），不依赖工作台服务
    { name: 'sandbox-probe', testMatch: /sandbox-probe\.spec\.js/ },
  ],
  webServer: [webServerFor(PORT, 'test/.data/e2e'), webServerFor(JD_PORT, 'test/.data/e2e-jd')],
});
