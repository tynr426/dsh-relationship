import { defineConfig, devices } from '@playwright/test';

// E2E 专用端口 8911：与独立模式默认端口 8901、以及 DSH 插件安装后由
// 宿主进程持有的 8901 隔离——测试永不触碰运行中的真实工作台。
const PORT = 8911;

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `node -e "import('node:fs').then(({ rmSync }) => rmSync('test/.data/e2e', { recursive: true, force: true }))" && REL_NO_OPEN=1 REL_PORT=${PORT} REL_DATA_DIR=test/.data/e2e node server/cli.js`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
