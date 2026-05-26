# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前执行焦点: Task 7 MCP package 接入和工具权限。
- 当前执行顺序: Task 7 -> Task 10 -> Gate 5。
- 已完成: Task 1-6、Task 8-9、Task 10 Step 1-4。
- 未完成: Task 7 Step 1-8、Task 10 Step 5-8、Gate 5。
- Gate 状态: Gate 1-2 已完成；Gate 3 需按当前 Task 7 重新复核；Gate 4 的 UI/API 自动化结论未被当前 MCP 变更直接否定，但 Gate 5 仍需做最终累计复核。
- 主会话职责: control-plane 复核、计划/ledger 更新、子代理委派和验证调度；主会话不得接管业务代码实现。

## 文档整理记录

- 2026-05-26: 重新对齐 spec / plan / ledger 职责。
- Plan 调整: Task 7 改为当前 MCP package 实现任务；历史 demo adapter 方向不再作为主计划任务；后续最终验收并入 Task 10。
- Ledger 调整: 删除重复 plan 任务清单和调试命令，只保留当前状态、必要历史事实、验证证据、风险和未决问题。
- 本次只更新 plan/ledger 控制面文件，未修改业务代码、测试代码或配置代码。

## 必要历史事实

- 此前曾完成一版 demo adapter 方向实现：使用官方 `@modelcontextprotocol/sdk`、`tools/list` 自动发现 remote `inputSchema`，并用 SDK `callTool()` 执行真实 MCP 调用。
- 后续 spec 已变更为 `pi-mcp-adapter@2.8.0` package 方向。上述 demo adapter 方向现在只作为历史事实保留，不是当前目标架构。
- 当前仍需要让以下 demo adapter 文件退出 active path：
  - `packages/coding-agent/examples/rpc-task-console/mcp-config.ts`
  - `packages/coding-agent/examples/rpc-task-console/mcp-streamable-http-client.ts`
  - `packages/coding-agent/examples/rpc-task-console/extensions/mcp-tools.ts`

## 当前 MCP 决策

- 使用固定版本 `pi-mcp-adapter@2.8.0`，不使用 floating `@latest`。
- 保留第一版 subprocess RPC runtime；不把 `AgentSession` / SDK 嵌入式调用作为本轮前提。
- MCP server 连接信息迁到标准 `.mcp.json` / `mcpServers`。
- Pi adapter 专属配置使用 `.pi/mcp.json` 或 child `PI_CODING_AGENT_DIR` 下的 `mcp.json`。
- 必须使用 `directTools` 暴露 remote MCP tools。
- 默认单一 `mcp` proxy 工具必须禁用，且不得加入 task allowlist。
- demo server 启动阶段必须执行 MCP tool discovery / metadata cache prewarm；prewarm 失败时 server 启动失败。
- task `tools` allowlist 继续多层强制：Pi CLI / AgentSession 是主防线，adapter/package 层保留第二道限制。
- 当前 POC 可以暂用无前缀 tool name 兼容公安 workflow；长期 tool identity 需要支持 `$mcp_server_name:tool_name`。
- MCP package 迁移不等于已确认修复真实 MCP tool `terminated`。

## 验证证据

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 92 tests passed。
- `npm run check`: 通过；`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。
- 以上验证发生在 Task 7 当前 MCP package 实现完成前；Task 7 完成后必须重新运行。

## 人工 Demo 已验证

- demo server 可启动。
- `http://localhost:4175/` 返回真实 HTML，包含“公安指挥任务控制台”、`styles.css`、`app.js`，无初始业务 card 文案。
- `GET /api/snapshot` 初始返回 idle snapshot，默认 workflow 为 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 为空。
- LLM endpoint `http://192.168.20.20:9111/v1/models` 返回 200。
- MCP endpoint 可建立 SSE 连接，返回 `text/event-stream`。
- 使用公安 workflow 触发真实 run 后，child Pi process 启动，MCP tool call 链路进入真实执行。
- 第一阶段 task 后续输出 fallback JSON content，runtime 写入 conversation message。
- 第二阶段按并发上限启动 2 个 task。

## 未决问题

- 真实 MCP tool `jcj-get-case-detail` 曾出现 `failed: terminated`；根因未锁定，需在 Task 10 最终验收中记录最新结果。
- 真实模型输出曾不满足 `data_structure`，例如 `task_lookup_address_by_coordinate` 缺少 `data.coordinate`；需在 Task 10 最终验收中记录最新结果。
- 浏览器人工视觉验收未完成：侧栏拖拽吸附、375px 移动端横向滚动、真实 DOM node identity、卡片最大化不覆盖侧栏仍需确认。
