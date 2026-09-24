# dsh-relationship 关系记忆工作台

一个 DeepSeek Harness（DSH）本地插件：帮你以最低成本沉淀、整理和取用人际关系记忆。

核心体验：

1. **录入即说话**——在 DSH 会话里随口说「记一下，小李女儿十月办婚礼」，AI 拆成结构化的待确认记忆实时上板。
2. **确认式入库**——AI 只提取和建议，所有 AI 写入都是 `待确认` 状态；你逐条确认后才是长期记忆。
3. **整理归 AI**——归类、去重、冲突标记由 AI 完成，你只做确认和删改。
4. **本地存储**——数据保存在本机，不上传任何服务。

## 功能

- 联系人管理：关系类型、标签、生日（支持只记月日）。
- 待确认队列：AI 提取的候选记忆逐条确认 / 编辑 / 驳回，支持一键全部确认。
- 智能整理：记一笔弹窗切到「智能整理」可粘贴长文本/聊天记录，存档为素材后在 DSH 会话说「整理素材」，AI 拆成多条待确认记忆（保留原文溯源）。
- 联系人时间线：已确认记忆按人聚合，按类型筛选。
- 京东找同款（礼赠计划）：关键词/热销榜搜京东商品，选中即生成官方 CPS 推广链接关联计划——不购买、不标已送；桌面端可复制链接或展示二维码，手机扫码直达京东下单（佣金归本链接），计划卡与首页时机提醒卡常驻「扫码买」入口。
- 手动记一笔：不经过 AI 的直接录入（即录即确认）。
- relationship preset：绑定 DSH 原生会话的「关系记忆」AI 行为。
- 双存储后端：默认零依赖 JSON 文件存储；可选 rust 实现的 SQLite 后端（`npm run build:relstore` 编译，无二进制时自动回退 JSON）。

## 使用方式

### 作为 DSH 插件

安装 dsh-relationship 插件包后，GUI 侧边栏出现「关系记忆」入口；数据存于 `~/.dsh/dsh-relationship`。DSH 会话中选择「关系记忆」preset（或经安装脚本安装）即可对话录入：

```sh
dsh plugin --profile web add tynr426/dsh-relationship   # 从 GitHub 安装插件
scripts/install-relationship-preset.sh                   # 安装 preset 到 ~/.dsh/.agent-presets/relationship
scripts/backup-dsh.sh                                    # dsh 升级前备份 ~/.dsh 整树（Session 日志/preset/数据库）
```

### 独立运行

```sh
npm start        # http://127.0.0.1:8901（数据存于 ./data）
```

独立模式下可浏览和手动录入；AI 对话录入请在 DSH 内使用。

## AI 接入（面向 agent）

工作台所有业务操作都是 REST API；DSH 会话内推荐统一走工具入口：

```sh
curl -X POST http://127.0.0.1:8901/api/tools -H 'content-type: application/json' \
  -d '{"name":"memory_add","args":{"contactId":"c_xxxx","type":"event","content":"女儿十月办婚礼"}}'
```

可用工具：`contact_search` / `contact_add` / `contact_update` / `memory_add` / `memory_batch_add` / `memory_reject` / `memory_update` / `memory_search` / `timeline_get`（确认入库没有 AI 工具，只能在工作台待确认队列点击确认）。

纪律：AI 写入只产生待确认记忆；录入前先 `contact_search` 防止建重；生成祝福/礼物建议前先 `memory_search`。

## 开发

```sh
npm install          # 安装测试依赖（@playwright/test）
npm run test:unit    # 单元 + API 测试
npm run test:e2e     # 需先 npx playwright install chromium
npm test
```

详见 `AGENTS.md`。

## License

[Apache-2.0](LICENSE)
