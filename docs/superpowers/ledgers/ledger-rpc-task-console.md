# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前阶段: Task 11/12 自动化整合验证已完成；剩余工作是人工 demo 调试和真实 MCP/模型输出验收。
- 已完成: Task 1-9、Gate 1-4、Task 10 Step 1-4、Task 11 Step 1-7、Task 12 Step 1-6。
- 未完成: Task 10 Step 5 手动 demo 验收。

## 当前委派

- `019e5e45-8f8c-78f2-81de-9acd264aa249` / Goodall: implementation_worker，负责后端日志过滤、UUID、项目根 `logs/` 输出目录、`run-police-workflow.mjs`；已完成并关闭。
- `019e5e45-ebc6-77a0-9cb4-909bdbe5bc8e` / Franklin: implementation_worker，负责前端右上角“测试”按钮、默认输入和公安 workflow 触发入口；已完成并关闭，待主会话复核 diff。
- `019e5e46-2ea6-7a10-a4a8-21189c62237b` / Aquinas: MCP 只读调研，因预设模型不可用失败，已关闭。
- `019e5e46-d845-7440-9721-73194920f7fb` / Lorentz: MCP 只读调研重派；已完成并关闭，未改文件。
- `019e5e4e-d4ab-7183-b531-56b7f5f4bd0d` / Erdos: implementation_worker，负责 MCP adapter 改造为 `tools/list` schema 自动发现和 SDK `callTool()`；已完成并关闭。
- `019e5e5f-73c9-7fe0-8355-b3240ee44b42` / Ohm: implementation_worker，负责整合更新 `rpc-task-console.test.ts`，使 UUID、`logs/`、streaming 过滤、MCP/前端新行为测试通过。

## MCP 调研结论

- Pi 当前没有原生 MCP 配置入口；文档建议通过 extensions/packages 扩展工具能力。
- 通过 Pi extension 把 MCP tools 注册为 Pi tools 的方向成立。
- 当前 `mcp.config.json` 手写 `tools[].parameters` 只能作为临时 adapter schema/override，不应作为长期必需配置。
- 当前 `mcp-streamable-http-client.ts` 只实现 `initialize` 和 `tools/call`，没有 `tools/list` 自动发现；长期建议用官方 MCP TypeScript SDK 处理 Streamable HTTP、session、鉴权、分页和兼容细节。
- 推荐后续 MCP 改造范围限于 demo adapter：`mcp-config.ts`、`mcp-streamable-http-client.ts`、`extensions/mcp-tools.ts`、`mcp.config.example.json`、必要时 `mcp.config.json` 和依赖文件。
- 不建议修改 Pi core RPC 协议、CLI `--tools` 语义、settings 原生结构或 `packages/agent/src`。
- task tools allowlist 应多层强制：Pi CLI/AgentSession 是主防线，adapter 和 MCP wrapper 也要拒绝未允许工具。

## Task 11 子代理结果

- Goodall 完成后端日志/UUID/输出目录/脚本改造；修改 `.env.example`、`env.ts`、`persistence.ts`、`run-manager.ts`、`child-agent-process.ts`、`task-dispatcher.ts`、`task-store.ts`、`docs/superpowers/plans/run-police-workflow.mjs`。
- Goodall 验证结果：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 为 78 passed / 12 failed；失败来自旧测试仍期望 `.rpc-task-console`、旧拼接 ID、保留 streaming 日志和旧 RPC event 文件名。
- Goodall 验证结果：`npm run check` 通过。
- Goodall 运行验证生成未跟踪 `logs/` 产物，暂未清理。
- Franklin 完成前端“测试”按钮相关改动并关闭；待主会话复核 diff 和后续测试 worker 覆盖。
- Ohm 更新 `packages/coding-agent/test/rpc-task-console.test.ts`，将断言整合到 UUID、项目根 `logs/`、streaming 过滤、MCP `tools/list`/`callTool` 和前端测试按钮后的新行为。
- Ohm 验证结果：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，92 tests passed。
- Ohm 验证结果：`npm run check` 通过。

## Task 12 子代理结果

- Erdos 完成 MCP adapter 改造：新增官方 `@modelcontextprotocol/sdk@^1.29.0` 依赖，使用 `tools/list` 自动发现 `inputSchema`，`parameters` 改为可选 override，`callTool` 使用 SDK。
- Erdos 修改 `mcp-config.ts`、`mcp-streamable-http-client.ts`、`extensions/mcp-tools.ts`、`mcp.config.example.json`、`mcp.config.json`、`packages/coding-agent/package.json`、`package-lock.json`、`packages/coding-agent/test/rpc-task-console.test.ts`。
- Erdos 验证结果：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts -t "MCP Streamable HTTP"` 通过，7 passed。
- Erdos 验证结果：`npm run check` 通过。
- Erdos 全量单文件测试仍 12 个失败，失败集中在待整合的 UUID、`logs/` 默认路径、streaming 过滤和旧 run id 断言。
- MCP 风险：extension 初始化会访问远端 `tools/list`；远端不可用时 MCP extension 加载失败并给明确诊断。

## 当前改动范围

- UI 拆分: `packages/coding-agent/examples/rpc-task-console/index.html`
- 新增静态资源: `packages/coding-agent/examples/rpc-task-console/styles.css`
- 新增前端逻辑: `packages/coding-agent/examples/rpc-task-console/app.js`
- 静态资源服务/API: `packages/coding-agent/examples/rpc-task-console/server.ts`
- reset stale event 修复: `packages/coding-agent/examples/rpc-task-console/task-store.ts`
- 验收覆盖: `packages/coding-agent/test/rpc-task-console.test.ts`
- 用户已修正 MCP 地址: `packages/coding-agent/examples/rpc-task-console/mcp.config.json`

## 已确认补充需求

- 默认人工验收日志不记录 streaming event 结构；默认只保留完整消息、工具开始/结束、状态变化和错误诊断。
- runtime 自生成 ID 统一使用标准 UUID 文本格式 `8-4-4-4-12`；文件名和 JSON `id` 不拼接 task id、step id、时间戳或长 agent run id。
- 默认输出路径改为项目根目录 `logs/`，使用 `<run-uuid>` 和 `<agent-uuid>` 命名；`stepId`、`taskId` 只作为 JSON 字段保留。
- 历史运行产物 `packages/coding-agent/examples/rpc-task-console/.rpc-task-console/` 可以清理，不再作为默认输出位置。
- 新增 `docs/superpowers/plans/run-police-workflow.mjs` 作为公安 workflow 命令行验收入口，不包含 snapshot 轮询逻辑。
- 前端右上角新增“测试”按钮；读取当前指令输入框内容，空输入弹框提示，使用公安 workflow JSON 触发 `/runs/start`。
- 指令输入框默认文本与 `run-police-workflow.mjs` 默认 `userInstruction` 一致，默认包含接警单编号 `44010620260525085000433002`。
- MCP 接入方案必须先调研 Pi 文档和仓库实现；调研完成前不继续基于当前手写 schema 或 hand-rolled Streamable HTTP client 扩大实现。

## 自动化验证

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 92 tests passed。
- `npm run check`: 通过；`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。

## 已验证事实

- `GET /`、`GET /styles.css`、`GET /app.js` 服务真实静态文件，不再正则拆分 `index.html` 内联资源。
- `/runs/start`、`/runs/replace`、`/runs/reset` 使用 selected `steps + userInstruction` 契约。
- `/runs/reset` 空 body 回到当前 workflow steps 的 idle snapshot。
- reset 与 replace/stop 并发时，旧 run 迟到事件不会污染 reset 后 idle snapshot。
- TaskStore snapshot 包含 cards、logs、receipts、conversationMessages。
- task complete 后首个 SSE snapshot 包含 task result、conversation message、receipt 和 card。
- 前端只消费 backend snapshot；不解析 agent 自然语言生成 UI 状态或 card。
- 初始 UI 无业务 card，只显示非 card 空态。
- UI 静态合同覆盖 conversationMessages、流程指引、selected task、状态语义、aria-live、alert、focus ring、reduced-motion、侧栏左右吸附、3/2/1 卡片布局、卡片收起/最大化。

## 人工 Demo 已跑结果

- demo server 可启动:
  ```bash
  cd packages/coding-agent
  npm run example:rpc-task-console
  ```
- `http://localhost:4175/` 返回真实 HTML，包含“公安指挥任务控制台”、`styles.css`、`app.js`，无初始业务 card 文案。
- `GET /api/snapshot` 初始返回 idle snapshot，默认 workflow 为 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 为空。
- LLM endpoint `http://192.168.20.20:9111/v1/models` 返回 200。
- MCP endpoint `http://192.168.20.21:30080/pacc-mcp-server/mcp?toolset=shijiazhuang&clientid=zyhxx` 可建立 SSE 连接，返回 `text/event-stream`。
- 使用公安 workflow 触发真实 run 后，child Pi process 启动，MCP tool call 链路进入真实执行:
  - tool: `jcj-get-case-detail`
  - args: `{ "caseId": "CASE-001" }`
  - result: `MCP tool "jcj-get-case-detail" failed: terminated`
- 第一阶段 task 后续输出 fallback JSON content，runtime 写入 1 条 conversation message。
- 第二阶段按并发上限启动 2 个 task。
- 公安 workflow run 最终失败点: `task_lookup_address_by_coordinate` 的模型输出未满足 `data.coordinate` schema。

## 当前风险点

- 真实 MCP 工具调用进入链路但未成功完成，当前错误为 `MCP tool "jcj-get-case-detail" failed: terminated`。
- 当前 MCP 方案存在架构风险: `mcp.config.json` 手写 tool schema，且示例中存在手写 Streamable HTTP client；需确认 Pi 是否已有原生 MCP 接入、schema 自动发现和标准实现。
- 真实模型输出结构仍不稳定，已观察到缺少 `data.text`、`data.gbids`、`data.coordinate` 或返回非契约形状导致 validation fail。
- 未完成人工浏览器视觉验收: 侧栏拖拽吸附、375px 移动端横向滚动、真实 DOM node identity、卡片最大化不覆盖侧栏。
- 默认 demo workflow 的 task tools 为空，不覆盖 MCP；要验 MCP 必须用公安 workflow JSON。

## 人工调试入口

- 启动 demo:
  ```bash
  cd packages/coding-agent
  npm run example:rpc-task-console
  ```
- 打开 UI:
  ```text
  http://localhost:4175
  ```
- 查看当前 snapshot:
  ```bash
  curl -sS http://localhost:4175/api/snapshot | jq
  ```
- 用公安 workflow 触发真实 run:
  ```bash
  node docs/superpowers/plans/run-police-workflow.mjs
  ```
- 推荐脚本内容见 plan 的 Task 10 Step 5。
- 运行输出目录:
  ```text
  logs/
  ```
- 关键日志路径:
  ```text
  logs/snapshots/<run-uuid>.json
  logs/logs/<run-uuid>.jsonl
  logs/rpc-events/<run-uuid>/<agent-uuid>.jsonl
  logs/conversation/<run-uuid>.jsonl
  logs/stderr/<run-uuid>/<agent-uuid>.log
  logs/pi-agent/settings.json
  ```
