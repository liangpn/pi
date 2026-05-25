# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前阶段: Task 11/12 自动化整合验证已完成；剩余工作是 Task 10 Step 5 人工 demo 调试和真实 MCP/模型输出验收。
- 已完成: Task 1-9、Gate 1-4、Task 10 Step 1-4、Task 11 Step 1-7、Task 12 Step 1-6。
- 未完成: Task 10 Step 5 手动 demo 验收。
- 主会话职责: control-plane 复核、计划/ledger 更新、子代理委派和验证调度；主会话不得接管业务代码实现。

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

## Package Hub 调研结论

- `pi-mcp-adapter` 可以替代当前 demo MCP adapter 的大部分 MCP 接入层，但不能替代 Task Console 的 runtime、dispatcher、TaskStore、SSE、cards、stop/replace 机制。
- 若迁移到 `pi-mcp-adapter`，最小路径是只替换 MCP 接入层，保留当前 RPC Task Runtime；配置从当前自定义 `mcp.config.json` 迁到标准 `.mcp.json` / `.pi/mcp.json`，并处理 task 级 allowlist 和 tool name 前缀策略。
- `pi-mcp-adapter` 的 package 路线更标准、更少自维护代码，但不能保证直接解决真实 tool `terminated`，因为当前实现已经使用官方 SDK 和 `tools/list`。
- `pi-subagents` 适合作为第二版主 agent 编排层的参考，不适合替代第一版 deterministic task runtime。当前第一版需要 dispatcher 控制每个 task attempt、重试、stop/replace、TaskStore、SSE 和持久化。
- 后续大改时，比 package hub 更大的架构问题是 child 是否继续用 subprocess RPC，还是迁到 Node 内嵌 `AgentSession`。

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
- 已观察到真实 MCP tool: `jcj-get-case-detail`。
- 已观察到历史失败结果: `MCP tool "jcj-get-case-detail" failed: terminated`。
- 第一阶段 task 后续输出 fallback JSON content，runtime 写入 conversation message。
- 第二阶段按并发上限启动 2 个 task。
- 已观察到真实模型输出不满足 `data_structure` 导致 validation fail，例如 `task_lookup_address_by_coordinate` 缺少 `data.coordinate`。

## 当前风险点

- 真实远端 MCP tool 调用仍需重新验证。历史记录中的 `terminated` 可能来自远端 server、参数、鉴权、会话或服务端执行失败；当前代码已改成 SDK + `tools/list` + remote schema，但尚未确认最新代码下是否仍复现。
- package hub 的 `pi-mcp-adapter` 可作为降维护成本方案，但迁移会改变配置入口和可能的 tool name 策略；这需要先改 spec/plan，不能直接在实现里替换。
- 真实模型输出结构仍不稳定，已观察到缺少 `data.text`、`data.gbids`、`data.coordinate` 或返回非契约形状导致 validation fail。
- 未完成人工浏览器视觉验收: 侧栏拖拽吸附、375px 移动端横向滚动、真实 DOM node identity、卡片最大化不覆盖侧栏。
- 默认 demo workflow 的 task tools 为空，不覆盖 MCP；验 MCP 必须使用公安 workflow JSON 或前端“测试”按钮。

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
