# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前阶段: Task 11/12 自动化整合验证已完成；剩余工作是 Task 10 Step 5 人工 demo 调试和真实 MCP/模型输出验收。
- 已完成: Task 1-9、Gate 1-4、Task 10 Step 1-4、Task 11 Step 1-7、Task 12 Step 1-6。
- 未完成: Task 10 Step 5 手动 demo 验收。
- 主会话职责: control-plane 复核、计划/ledger 更新、子代理委派和验证调度；主会话不得接管业务代码实现。

## 2026-05-26 MCP package 调研事实

### 调研过程

- 委派对象: `019e5ff6-0c8f-7840-87c8-72f1e6b1b590` / Archivist，角色为只读 `docs_researcher`；本轮只委派 1 个子代理。
- 生命周期: 主会话通过 `wait_agent` 收到 `completed`，随后收到同一 payload 的 subagent notification；主会话已读取最终报告并调用 `close_agent`，关闭返回的 previous status 为 `completed`。
- 本地证据范围: ledger/spec/plan、当前 demo MCP adapter 三文件、`task-dispatcher.ts`、`env.ts`、MCP config、`rpc.md`、`sdk.md`、`extensions.md`、`packages.md`、`usage.md`、`sdk.ts`、`agent-session.ts`、`index.ts`。
- Web 证据范围: `pi-mcp-adapter` GitHub README/package、npm registry、Pi package 页面。

### 当前实现事实

- 当前 demo MCP adapter 文件:
  - `packages/coding-agent/examples/rpc-task-console/mcp-config.ts`
  - `packages/coding-agent/examples/rpc-task-console/mcp-streamable-http-client.ts`
  - `packages/coding-agent/examples/rpc-task-console/extensions/mcp-tools.ts`
- 当前 demo MCP adapter 职责: 自定义 MCP 配置解析、MCP SDK/HTTP client 封装、把 remote MCP tools 注册成 Pi tools。
- 当前 runtime 的 child 启动和 task allowlist 主链路在 `task-dispatcher.ts`，会把 task `tools` 转成 child `--tools` / `--no-tools`，并把同一 allowlist 写入 `PI_DEMO_TASK_ALLOWED_TOOLS` 供 adapter 二次过滤。
- 当前 demo 已经使用官方 MCP SDK、`tools/list` 自动发现 schema、`callTool()` 执行真实 MCP；`mcp-streamable-http-client.ts` 只包装底层错误消息。

### `pi-mcp-adapter` package 事实

- `pi-mcp-adapter` 是 Pi package/extension，不是 Task Console runtime。
- `pi-mcp-adapter` package 元数据声明 Pi extension，依赖 `@modelcontextprotocol/sdk`。
- `pi-mcp-adapter` README 说明它读取标准 MCP 配置，默认提供单一 `mcp` 代理工具，可选 `directTools` 把指定 MCP tools 注册为一等 Pi tools。
- `pi-mcp-adapter` 也依赖官方 MCP SDK，并支持 HTTP endpoint 的 StreamableHTTP / SSE fallback。
- `pi-mcp-adapter directTools` 依赖 metadata cache；README 说明首次启用某 server 的 direct tools 时，如果 cache 不存在，会先退回 proxy-only 并在后台填充 cache。
- `pi.dev/packages/pi-mcp-adapter` 显示 `2.6.1`；npm registry latest 为 `2.8.0`，发布时间 `2026-05-25T06:32:22Z`。

### 已确认的 MCP package 迁移决策

- 版本: 使用 npm latest 对应的固定版本 `pi-mcp-adapter@2.8.0`，不在运行时使用 floating `@latest`。
- 范围: `pi-mcp-adapter` 用于替换当前 demo MCP 接入层；不替换 Task Console runtime、dispatcher、TaskStore、SSE、cards、stop/replace、retry、持久化和结果校验职责。
- 运行形态: 第一版继续保留 subprocess RPC runtime，不把 `AgentSession/SDK` 迁移作为本轮已批准架构。
- 加载方式: 优先使用本地 package 路径或 repo 依赖加载 `pi-mcp-adapter`；不让每个 child attempt 通过 `--extension npm:pi-mcp-adapter` 临时安装。
- 配置迁移: 当前 `mcp.config.json` 的 `servers.*` 迁到标准 `.mcp.json` 的 `mcpServers.*`；Pi 专属设置放到 `.pi/mcp.json` 或 child `PI_CODING_AGENT_DIR` 下的 `mcp.json`。

### Tool 暴露和 allowlist 决策

- `directTools` 必须使用；远端 MCP tool 需要暴露为一等 Pi tool，供 task `tools` allowlist 精确限制。
- 默认单一 `mcp` proxy 工具禁用；第一版 Task Console 不把万能 MCP proxy 工具暴露给 child agent，也不把它加入 task allowlist。
- Pi CLI/AgentSession 的 `tools` allowlist 作为主防线；adapter/package 层仍需要第二道限制，避免 proxy fallback 或额外 direct tools 绕过 task allowlist。
- 当前 POC 可以暂用无前缀 tool name 以兼容现有公安 workflow。
- 长期 tool identity 必须支持 MCP server name/id 前缀，建议格式为 `$mcp_server_name:tool_name`；后续 task `tools` 字段也应按该格式设计，以支持多个 MCP server 来源并避免 tool name 冲突。

### Metadata cache 决策

- 允许使用 `pi-mcp-adapter` metadata cache。
- demo server 启动阶段必须执行 MCP tool discovery / cache prewarm。
- cache prewarm 失败时，server 启动必须失败；不得等到 child agent 执行过程中才发现 direct tools 未注册。

### 待进入 spec/plan 的文件范围

- `packages/coding-agent/examples/rpc-task-console/env.ts`
- `packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- child settings/package loading 相关代码
- 示例 MCP 配置文件
- `packages/coding-agent/test/rpc-task-console.test.ts`
- 当前 3 个 demo adapter 文件应退出 active path；删除或保留为历史代码需在 plan/spec 调整后决定。

### Spec / Plan 更新状态

- 已更新 `docs/superpowers/specs/spec-rpc-task-console.md`：第一版 MCP 接入改为 `pi-mcp-adapter@2.8.0` package 方向，并记录 `directTools`、proxy 禁用、metadata cache prewarm、长期 tool identity 前缀和 package 迁移不承诺修复 `terminated`。
- 已更新 `docs/superpowers/plans/plan-rpc-task-console.md`：新增 Task 13，执行顺序为先迁移 MCP 接入层到 `pi-mcp-adapter`，再继续 Task 10 Step 5 完整人工 demo 验收。

### 验证命令

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`
- `npm run check`
- `cd packages/coding-agent && npm run example:rpc-task-console`
- `node docs/superpowers/plans/run-police-workflow.mjs`
- 真实 demo 日志需复核 direct tool 名称、allowlist 拒绝路径、`jcj-get-case-detail` 调用结果。

## 2026-05-26 独立问题记录

### 真实 MCP tool `terminated`

- 历史现象: 真实 demo 中观察到 `MCP tool "jcj-get-case-detail" failed: terminated`。
- 当前事实: 当前 demo 已经使用官方 MCP SDK、`tools/list` 和 `callTool()`；迁移到 `pi-mcp-adapter` 不能被记录为 `terminated` 的已确认修复。
- 当前状态: `terminated` 根因未锁定，可能仍需通过真实 run 日志、远端 server 状态、参数、鉴权、会话或服务端执行路径单独排查。

### 真实模型输出结构不稳定

- 历史现象: 已观察到真实模型输出不满足 `data_structure`，例如 `task_lookup_address_by_coordinate` 缺少 `data.coordinate`。
- 当前状态: 该问题独立于 MCP package 迁移，需要在真实 demo 验收中继续记录。

### 浏览器人工视觉验收

- 当前状态: 侧栏拖拽吸附、375px 移动端横向滚动、真实 DOM node identity、卡片最大化不覆盖侧栏仍需人工确认。

## 当前事实摘要

- UI 已拆分为真实 `index.html`、`styles.css`、`app.js`，server 不再从 `index.html` 正则拆分内联资源。
- `/runs/start`、`/runs/replace`、`/runs/reset` 使用 selected `steps + userInstruction` 契约。
- `/runs/reset` 空 body 回到当前 workflow steps 的 idle snapshot。
- reset 与 replace/stop 并发时，旧 run 迟到事件不会污染 reset 后 idle snapshot。
- TaskStore snapshot 包含 cards、logs、receipts、conversationMessages。
- task complete 后首个 SSE snapshot 包含 task result、conversation message、receipt 和 card。
- 前端只消费 backend snapshot；不解析 agent 自然语言生成 UI 状态或 card。
- 初始 UI 无业务 card，只显示非 card 空态。
- UI 静态合同覆盖 conversationMessages、流程指引、selected task、状态语义、aria-live、alert、focus ring、reduced-motion、侧栏左右吸附、3/2/1 卡片布局、卡片收起/最大化。
- 默认人工验收输出目录已迁移到项目根 `logs/`；历史 `.rpc-task-console/` 目录不再作为默认输出位置。
- runtime 自生成 ID 和持久化文件名使用标准 UUID；`stepId`、`taskId`、原始 Pi agent run id 只保留在 JSON 字段中。
- 默认日志过滤 streaming event 结构，保留完整消息、工具开始/结束、状态变化和错误诊断。
- `docs/superpowers/plans/run-police-workflow.mjs` 是公安 workflow 命令行验收入口。
- 前端右上角“测试”按钮读取当前指令输入框内容，使用公安 workflow JSON 触发 `/runs/start`。

## MCP 当前事实

- Pi 当前没有原生 MCP 配置入口；通过 Pi extension/package 把 MCP tools 注册为 Pi tools 的方向成立。
- 当前实现已完成 Task 12: 使用官方 `@modelcontextprotocol/sdk`、`tools/list` 自动发现 remote `inputSchema`、SDK `callTool()` 执行真实 MCP 调用。
- 当前 `mcp.config.json` 不再手写 `parameters`；它配置 server transport/url/headers 和允许暴露的 remote tool 名称。
- 当前 demo adapter 仍保留在:
  - `packages/coding-agent/examples/rpc-task-console/mcp-config.ts`
  - `packages/coding-agent/examples/rpc-task-console/mcp-streamable-http-client.ts`
  - `packages/coding-agent/examples/rpc-task-console/extensions/mcp-tools.ts`
- task tools allowlist 继续多层强制: Pi CLI/AgentSession 是主防线，adapter/MCP wrapper 也拒绝未发现或未允许的工具。
- 真实 MCP endpoint `http://192.168.20.21:30080/pacc-mcp-server/mcp?toolset=shijiazhuang&clientid=zyhxx` 可建立 SSE 连接。
- 默认 demo workflow 的 task tools 为空，不覆盖 MCP；验 MCP 必须使用公安 workflow JSON 或前端“测试”按钮。

## 自动化验证

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 92 tests passed。
- `npm run check`: 通过；`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。

## 人工 Demo 已验证

- demo server 可启动:
  ```bash
  cd packages/coding-agent
  npm run example:rpc-task-console
  ```
- `http://localhost:4175/` 返回真实 HTML，包含“公安指挥任务控制台”、`styles.css`、`app.js`，无初始业务 card 文案。
- `GET /api/snapshot` 初始返回 idle snapshot，默认 workflow 为 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 为空。
- LLM endpoint `http://192.168.20.20:9111/v1/models` 返回 200。
- MCP endpoint 可建立 SSE 连接，返回 `text/event-stream`。
- 使用公安 workflow 触发真实 run 后，child Pi process 启动，MCP tool call 链路进入真实执行。
- 第一阶段 task 后续输出 fallback JSON content，runtime 写入 conversation message。
- 第二阶段按并发上限启动 2 个 task。

## 调试入口

启动 demo:

```bash
cd packages/coding-agent
npm run example:rpc-task-console
```

打开 UI:

```text
http://localhost:4175
```

查看当前 snapshot:

```bash
curl -sS http://localhost:4175/api/snapshot | jq
```

用公安 workflow 触发真实 run:

```bash
node docs/superpowers/plans/run-police-workflow.mjs
```

检查输出目录:

```bash
find logs -maxdepth 3 -type f | sort
```

关键日志路径:

```text
logs/snapshots/<run-uuid>.json
logs/logs/<run-uuid>.jsonl
logs/rpc-events/<run-uuid>/<agent-uuid>.jsonl
logs/conversation/<run-uuid>.jsonl
logs/stderr/<run-uuid>/<agent-uuid>.log
logs/pi-agent/settings.json
```

定位 MCP tool 结果:

```bash
rg -n "tool_execution_start|tool_execution_end|failed: terminated|jcj-get-case-detail" logs/rpc-events
```

查看 runtime 失败原因:

```bash
tail -n 80 logs/logs/<run-uuid>.jsonl
```
