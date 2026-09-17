# dsh-relationship 协作与验证规范

## 项目定位

dsh-relationship 是一个 Node.js ESM 本地关系记忆工作台插件。服务端使用 Node 原生 HTTP、SSE 和 JSON 文件存储，前端位于 `public/`，不需要生产构建步骤。零生产依赖（仅 Node 内建模块）。

## 目录职责

- `server/`：独立服务、配置、数据存储、REST API、SSE 和业务工具。
- `public/`：原生 HTML、CSS 和浏览器端 JavaScript。
- `lib/`：DeepSeek Harness 宿主插件入口和浏览器接入层。
- `preset/relationship/`：关系记忆 DSH 用户 preset（preset id: relationship）与安装脚本。
- `scripts/`：安装与测试脚本。
- `test/unit/`：Node 内置测试运行器的业务和 API 测试。
- `test/e2e/`：Playwright 真实浏览器测试。
- `docs/`：设计文档。

## 常用命令

```sh
npm start                 # 独立启动工作台（默认端口 8901）
npm run dev               # 监听重启
npm run test:unit         # 单元与 API 测试
npm run test:e2e          # Playwright Chromium 测试
npm test                  # 单元测试 + E2E 测试
```

首次运行 E2E 测试前执行 `npx playwright install chromium`。测试不需要 DSH 登录、真实模型或 API Key。

## 数据与隐私

- 数据目录由 `REL_DATA_DIR` 指定：独立运行默认 `<repo>/data`，插件模式为 `~/.dsh/dsh-relationship`。
- `REL_DATA_DIR` 在服务模块导入时生效；涉及服务启动的测试必须串行运行，并在动态导入前设置数据目录。
- 关系数据只在本地：不提交 `data/`、测试数据目录或任何真实联系人/记忆内容。
- AI 通过 DSH 原生会话调用 `POST /api/tools` 与 REST API 写入数据；AI 写入一律为待确认（pending），用户确认后才进入长期记忆。

## 测试规则

- 单元测试使用 Node 内置 `node:test`，优先验证 `server/store.js` 和 `server/tools.js` 的行为。
- API 测试启动真实本地服务，但必须使用临时 `REL_DATA_DIR` 和随机端口。
- Playwright 测试使用真实服务和 Chromium，覆盖用户可观察的主流程，不用测试专用 DOM 分支替代真实页面。
- 不提交 Playwright report、trace 或 screenshot 产物。

## 修改与交付

保持 ESM、Node 18+ 和现有零生产依赖约束。改动应保持小范围，不顺手重构无关模块。交付前至少运行相关测试、`npm test` 和 `git diff --check`；汇报时区分静态检查、单元测试和真实浏览器验证。

### 多步骤实现任务的终止约束

对多步骤实现任务，禁止将进度说明作为 `final_answer`。只有当用户请求中的全部验收项均完成，并已运行要求的验证命令、检查 Git 状态、完成提交/推送（如要求）后，才能结束任务。若某项未完成，继续执行或明确说明阻塞原因；不得以“我会继续”结束回复。
