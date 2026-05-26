# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前执行焦点: Task 10 Step 10 浏览器人工验收；runtime 和持久化证据已记录。
- 当前执行顺序: 完成浏览器人工验收确认 -> Task 10 Step 11 Gate 5。
- 当前子代理: 无。
- 已完成: Task 1-9、Task 10 Step 1-9；Task 10 Step 10 的自动化、真实 runtime 和持久化证据已完成记录。
- 未完成: Task 10 Step 10 浏览器人工视觉/交互确认、Task 10 Step 11、Gate 5。
- Gate 状态: Gate 1-2 已完成；Gate 3 的 Task 5-7 自动化验证已通过，最新真实 MCP/tool run 已记录为 clean；Gate 4 的 UI/API 自动化结论未被当前 MCP 变更直接否定，但浏览器人工项未确认，Gate 5 尚不能收口。
- 主会话职责: control-plane 复核、计划/ledger 更新、子代理委派和验证调度；主会话不得接管业务代码实现。

## 子代理委派记录

- 2026-05-26: 委派 Singer 执行 Task 7。写入范围限定为 RPC Task Console MCP package 接入、配置、child settings、dispatcher、package lock 和对应测试文件；不得提交 commit；若 `pi-mcp-adapter@2.8.0` 无法满足 second-layer allowlist 或禁用 proxy `mcp`，必须报告证据和建议，不得放宽语义。
- 2026-05-26: Singer 返回 `DONE`。报告变更范围：`env.ts`、`child-settings.ts`、`task-dispatcher.ts`、`.mcp.json`、`.pi/mcp.json`、`mcp.config.example.json`、`mcp.config.json`、`.env.example`、`packages/coding-agent/package.json`、`package-lock.json`、`rpc-task-console.test.ts`。报告行为：固定 `npm:pi-mcp-adapter@2.8.0` 写入 child settings packages；标准 `.mcp.json` / `mcpServers`；`.pi/mcp.json` 同步到 child agent dir；`directTools` 启用、`disableProxyTool` 启用；dispatcher 拒绝 task allowlist 中的 `mcp`，并按 task 设置 `MCP_DIRECT_TOOLS`；启动阶段执行 MCP metadata prewarm；旧 demo adapter 退出正常 runtime/test path。
- 2026-05-26: Singer 报告验证：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，87 tests；`npm run check` 通过。主会话尚未独立复核输出和 diff。
- 2026-05-26: 两个只读复核子代理因认证刷新失败退出，均已关闭；未产生有效代码结论。
- 2026-05-26: 主会话只读复核和验证：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，87 tests；`npm run check` 通过。`npm view pi-mcp-adapter@2.8.0` 使用 `/tmp/npm-cache` 确认该 package 通过 `pi.extensions` 暴露 `./index.ts`，并注册 `mcp-config` flag 与 `MCP_DIRECT_TOOLS`。
- 2026-05-26: 主会话复核发现 Task 7 阻断缺口：当前 `prewarmMcpMetadataCache()` 在 `TaskDispatcher.run()` 开始时执行，而非 demo server 启动阶段；`/runs/start` 可能先返回 202，prewarm 失败随后在后台 run promise 中发生，不满足“prewarm 失败时 server 启动失败”的要求。需重新委派修正。
- 2026-05-26: 委派 Laplace (`019e6249-e446-75b0-8513-2c7de208ece9`) 窄范围修正 Task 7 prewarm 启动边界。写入范围限定为 server/run-manager/dispatcher/child-settings 及对应测试，必要时只允许 factual 更新 plan checkbox；不得修改 spec、ledger、package manifests、lockfile、UI 或 unrelated runtime。
- 2026-05-26: Laplace 返回 `DONE` 并已关闭。报告变更：新增 `startRpcTaskConsoleServer()` async startup API，CLI 入口先 prewarm 再 listen；dispatcher 不再每个 run 远程 prewarm，只校验 prewarmed cache；补充 startup prewarm 成功、失败、以及 `/runs/start` 不重复 discovery 的回归测试。
- 2026-05-26: 主会话独立验证 Laplace 修正：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，89 tests；`npm run check` 通过，`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。Task 7 Step 1-8 和 Task 10 Step 5 已按验证结果更新为完成。
- 2026-05-26: 用户确认 runtime `localhost` 问题主要是启动日志 `http://localhost:${port}`，并要求修复后继续执行 Task 10。委派 Plato (`019e625c-66b4-7b72-b0ec-9e312ecf7b33`) 作为 implementation_worker 处理日志修复、Task 10 Step 6-8 可执行验收和 ledger/plan 事实记录；真正需要浏览器人工确认的视觉/拖拽/移动端项目不得伪造结论。
- 2026-05-26: Plato 修复启动日志公共地址语义：新增 `PI_DEMO_PUBLIC_URL` 可选配置；未配置时启动日志只打印 `port 4175`，不再硬编码 `http://localhost:${port}`。验证真实 demo server 启动日志为 `RPC task console listening on port 4175`。
- 2026-05-26: 委派 Huygens (`019e6267-8e4a-7d30-b3bd-43549c670da6`) 作为 implementation_worker 修复 Task 10 真实验收暴露的运行态收敛缺口：同一步并发任务中一个 task 最终失败后，terminal run snapshot 不得残留其他 task/attempt 为 `running`；写入范围限定为 dispatcher/store/types/test 以及 plan/ledger 事实记录，不得提交 commit。
- 2026-05-26: Huygens 返回 `DONE` 并已关闭。报告变更：同一步某个 task 最终失败后，dispatcher 停止已启动 sibling，并把当前 step 未启动队列标记为 `task_stopped`；新增 `step_failed` stopped reason；store 保持旧 run/终态 task 迟到状态保护，同时允许同 run 的 `step_failed` 停止事件收敛非终态 task。
- 2026-05-26: 控制面复核 Huygens 方案后判定该方向违背 `spec-rpc-task-console.md` 第一版执行语义：当前 step 内 tasks 独立并行；`stopped` 表示用户停止或新指令替换，不表示 sibling task 最终失败。下一步必须移除 `step_failed` stopped 方向，改为当前 step 内 sibling tasks 按自身 attempt/retry 独立收敛，后续 step 不启动，最终 snapshot 不残留 `running` task/attempt。
- 2026-05-26: 委派 Chandrasekhar (`019e6302-d1f8-7d61-8937-c07948862d8f`) 执行 Task 10 Step 6；会话恢复后收到额度失败通知，未产生可复核实现产出，关闭时工具层返回 agent not found。
- 2026-05-26: 重新委派 Fermat (`019e630a-744d-7a60-b7af-1f7378279535`) 执行 Task 10 Step 6。写入范围限定为 `task-dispatcher.ts`、`task-store.ts`、`types.ts`、`rpc-task-console.test.ts`；要求移除 `step_failed` stopped 方案，保持当前 step sibling task 独立收敛，后续 step 不启动，最终 snapshot 无 `running` task/attempt；不得提交 commit。
- 2026-05-26: Fermat 返回 `DONE` 并已关闭。报告变更：移除 `step_failed` StopReason 和 stopped/steer 分支；dispatcher 不再因当前 step task final fail 主动停止 active/queued sibling；当前 step 队列继续按 concurrency limit 启动并自然收敛；store 保护旧 run 和已终态 task，同时允许同一 run/current step 的非终态 sibling 在 run/step 已呈现 fail 后写入自身终态；回归测试覆盖 sibling complete/fail、后续 step 不启动、最终无 `running` task/attempt。
- 2026-05-26: 主会话执行 Task 10 Step 7 真实 workflow 验收。demo server 成功启动并打印 `RPC task console listening on port 4175`；HTTP shell、`styles.css`、`app.js` 返回成功；初始 snapshot 为 idle，默认 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 均为空；LLM `/v1/models` 返回 `Qwen3-30B-A3B-Instruct-2507-Int4-W4A16`；启动阶段 MCP prewarm 生成 `logs/pi-agent/mcp-cache.json`。
- 2026-05-26: Task 10 Step 7 真实公安 workflow run `7653e8b0-5444-4fab-a7f5-254ea81cc9d9` 可触发真实 child Pi process。最终 run 为 `fail`，但当前 step sibling 已全部收敛，无 `running` task/attempt；后续 step 保持未启动。当前 run 的 RPC events 中 `jcj-get-case-detail` start/end 各 1 次，`panel-operate` start/end 各 4 次，未出现 `failed: terminated` 或 tool error。`jcj-get-case-detail` 成功返回警情详情、`sendoutDevices` 和 `sendoutPolices`。失败原因集中在模型最终 JSON shape 不满足 `data_structure`：地址/坐标 task 返回 schema descriptor array，资源面板 task 一次返回 schema array、一次缺少 `content`。
- 2026-05-26: 委派 Halley (`019e6317-610c-73a0-bf44-7a3641514f4d`) 执行 Task 10 Step 8。写入范围限定为 `prompt-builder.ts`、必要时 `task-dispatcher.ts`、以及 `rpc-task-console.test.ts`；要求强化 card task prompt 的 `data` object contract，不得放宽 `result-validation.ts`，并尽力重跑真实公安 workflow。
- 2026-05-26: Halley 返回 `DONE` 并已关闭。报告变更：强化 card task prompt，明确 `data` 必须是以 `data_structure[].field` 为 key 的 JSON object，禁止 schema descriptor array、`data_structure` 数组、`field/type/required/description/value` 包装对象和完整 card object；为实际字段生成紧凑示例；未修改 validator；未实现 retry validation feedback，原因是 prompt contract 已足以修复当前缺口且避免扩大 dispatcher/retry prompt 传递范围。
- 2026-05-26: Halley 重跑真实公安 workflow run `15003123-51a2-4836-8a62-7b62b6391639`。报告最终 snapshot 为 run `complete`，failed tasks 为空，cards 9；所有配置 `card_type` 的 task 都返回 `{ content, data }`，且 `data` 为字段名 object，未再出现 schema descriptor array 或缺 `content` 的 validation error。
- 2026-05-26: 委派 Heisenberg (`019e6320-2341-7b50-a884-1eeb2dcbf6fb`) 执行 Task 10 Step 9。写入范围限定为 `task-dispatcher.ts` 和 `rpc-task-console.test.ts`；要求 assistant tool-call only `message_end` 只保留 child event log，不写 validation_error，不设置 validationError；`agent_end` 前仍无合法最终 JSON 时继续按 validation_error 失败。
- 2026-05-26: Heisenberg 返回 `DONE` 并已关闭。报告变更：`message_end` 仍记录原始 child event log；只有 assistant message 含非空 text part 时才解析最终 task result；tool-call-only assistant `message_end` 不再设置 `validationError`、不写 `validation_error`、不清空已有 `validResult`；`agent_end` 无合法最终结果时仍按兜底 `validation_error` 失败；新增两条回归测试。

## 文档整理记录

- 2026-05-26: 重新对齐 spec / plan / ledger 职责。
- Plan 调整: Task 7 改为当前 MCP package 实现任务；历史 demo adapter 方向不再作为主计划任务；后续最终验收并入 Task 10。
- Ledger 调整: 删除重复 plan 任务清单和调试命令，只保留当前状态、必要历史事实、验证证据、风险和未决问题。
- 本次只更新 plan/ledger 控制面文件，未修改业务代码、测试代码或配置代码。
- 2026-05-26: 根据新宪法边界清理 Task 10 plan：移除 plan 中的子代理验证记录和主会话验证记录，将 Task 10 Step 6 改为结构性修复任务；历史证据和风险保留在本 ledger。

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
- 最新真实公安 workflow run 未复现真实 MCP tool `terminated`；该历史风险仍需在 Gate 5 以最新证据确认不作为未决阻塞。

## 验证证据

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 89 tests passed。
- `npm run check`: 通过；`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。
- `npm_config_cache=/tmp/npm-cache npm view pi-mcp-adapter@2.8.0 name version pi --json`: 确认固定 package 版本为 2.8.0，且 `pi.extensions` 暴露 `./index.ts`。
- 2026-05-26 Plato: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，90 tests。
- 2026-05-26 Plato: `npm run check` 通过；Biome fixed 1 file，`tsgo --noEmit` 和 `npm run check:browser-smoke` 退出码为 0。
- 2026-05-26 Plato: `GET /` 返回 200，真实 shell 包含“公安指挥任务控制台”、`styles.css`、`app.js`；`GET /api/snapshot` 初始 idle，默认 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 均为空。
- 2026-05-26 Plato: LLM `/v1/models` 返回 200，包含 `Qwen3-30B-A3B-Instruct-2507-Int4-W4A16`；MCP initialize 返回 200 `text/event-stream`；`logs/pi-agent/mcp-cache.json` 含 `caseTools` metadata 和 `jcj-get-case-detail`。
- 2026-05-26 Plato: 首次真实 workflow run `201ec994-0fd3-4ba9-afe0-d55a7fd2a6f2` 因 npm 默认 cache 指向只读 `/home/liangpn/.npm` 导致 `npm install pi-mcp-adapter@2.8.0 --prefix logs/pi-agent/npm` 失败；用 `npm_config_cache=/tmp/npm-cache` 重启 server 后继续验收。
- 2026-05-26 Plato: 第二次真实 workflow run `89532862-9cb3-4d00-b7d6-31b899cf895a` 触发真实 child Pi process，RPC events 记录 `tool_execution_start` / `tool_execution_end`；`jcj-get-case-detail` 第二次调用成功返回警情详情、`sendoutDevices` 和 `sendoutPolices`。第一阶段无 `card_type` task 完成且未创建 card。
- 2026-05-26 Huygens: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，91 tests；新增回归覆盖并发 task 最终失败后 active/queued sibling 收敛为 `step_failed` stopped，且 terminal fail snapshot 中没有 `running` task/attempt。该验证仅证明 Huygens 方案下测试通过；后续控制面复核已判定该方案违背 spec，需要重修。
- 2026-05-26 Huygens: `npm run check` 通过。该结果随 Huygens 方案一起标记为 superseded，不能作为 Gate 5 收口依据。
- 2026-05-26 主会话独立验证 Huygens 后状态：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，91 tests；`npm run check` 通过，`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。该验证随 Huygens 方案一起标记为 superseded，不能作为 Gate 5 收口依据。
- 2026-05-26 Fermat: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，91 tests。
- 2026-05-26 Fermat: `npm run check` 通过；Biome no fixes applied，`tsgo --noEmit` 和 `npm run check:browser-smoke` 退出码为 0。
- 2026-05-26 主会话独立验证 Fermat 后状态：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，91 tests；`npm run check` 通过，`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 和 `npm run check:browser-smoke` 通过。
- 2026-05-26 主会话 Task 10 Step 7: `GET /` 返回真实 HTML，包含“公安指挥任务控制台”、`styles.css`、`app.js`；`GET /styles.css` 和 `GET /app.js` 均返回 200；`GET /api/snapshot` 初始 idle，2 steps / 5 tasks，cards/logs/receipts/conversationMessages 均为 0。
- 2026-05-26 主会话 Task 10 Step 7: LLM `/v1/models` 返回 200，模型列表包含 `Qwen3-30B-A3B-Instruct-2507-Int4-W4A16`；`logs/pi-agent/mcp-cache.json` 包含 `caseTools` metadata 和 `jcj-get-case-detail` 等真实 tools。
- 2026-05-26 主会话 Task 10 Step 7: `node docs/superpowers/plans/run-police-workflow.mjs` 返回 run `7653e8b0-5444-4fab-a7f5-254ea81cc9d9`；最终 snapshot 为 run `fail`，step `step_incident_facts` complete、`step_basic_assessment` fail、后续 steps loading；task counts 为 4 loading / 0 running / 3 complete / 3 fail / 0 stopped；cards 2，conversationMessages 3，receipts 7。
- 2026-05-26 主会话 Task 10 Step 7: 当前 run RPC event 统计为 `jcj-get-case-detail` start/end 1/1，`panel-operate` start/end 4/4，tool_errors 0；输出目录包含 snapshots、logs、rpc-events、conversation 和 pi-agent cache/settings/auth/models。
- 2026-05-26 Halley: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，91 tests。
- 2026-05-26 Halley: `npm run check` 通过；Biome no fixes applied，`tsgo --noEmit` 和 `npm run check:browser-smoke` 退出码为 0。
- 2026-05-26 Halley: 真实公安 workflow run `15003123-51a2-4836-8a62-7b62b6391639` 最终 complete，cards 9，failed tasks 为空。
- 2026-05-26 主会话独立验证 Halley 后状态：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，91 tests；`npm run check` 通过，`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 和 `npm run check:browser-smoke` 通过。
- 2026-05-26 主会话抽查真实 run `15003123-51a2-4836-8a62-7b62b6391639` snapshot：run complete；4 个 steps 全部 complete；10 个 tasks 全部 complete；0 running / 0 fail / 0 stopped；cards 9；conversationMessages 10。
- 2026-05-26 主会话 Step 10 预检发现真实 run `15003123-51a2-4836-8a62-7b62b6391639` 虽最终 complete，但 logs 中存在多条中间 `validation_error`，原因是 assistant tool-call `message_end` 被当成最终 JSON 文本解析失败；这会污染 runtime 证据。已补充 Task 10 Step 9 修复要求：tool-call 中间消息不记 validation_error，`agent_end` 前仍无合法结果时继续按 validation_error 失败。
- 2026-05-26 Heisenberg: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，93 tests。
- 2026-05-26 Heisenberg: `npm run check` 通过；Biome no fixes applied，后续 check exit 0。
- 2026-05-26 主会话独立验证 Heisenberg 后状态：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，93 tests；`npm run check` 通过，`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 和 `npm run check:browser-smoke` 通过。
- 2026-05-26 主会话重跑真实公安 workflow run `db017d1d-9786-41f3-823f-a7f790dd5f5b`：run complete；10 tasks complete；0 running / 0 fail / 0 stopped；cards 9；conversationMessages 10；logs 234；receipts 11；tool start/end 统计为 `jcj-get-case-detail` 3/3、`device-operate` 8/8、`panel-operate` 4/4；`rg "validation_error|failed: terminated|tool_limit_exceeded|task_failed"` 无命中。
- 2026-05-26 Task 10 Step 10 自动化覆盖复核：`rpc-task-console.test.ts` 已覆盖 retry、tool call limit、stop、replace、reset、SSE reconnect、persistence、canonical runtime payload、frontend static DOM/CSS contracts、375px 横向滚动防护、card collapse/maximize handler、aria-live/icon labels/focus/reduced-motion 等静态契约。
- 2026-05-26 Task 10 Step 10 持久化复核：最新真实 run `db017d1d-9786-41f3-823f-a7f790dd5f5b` 输出包含 `logs/snapshots/db017d1d-9786-41f3-823f-a7f790dd5f5b.json`、`logs/logs/db017d1d-9786-41f3-823f-a7f790dd5f5b.jsonl`、`logs/conversation/db017d1d-9786-41f3-823f-a7f790dd5f5b.jsonl`、`logs/rpc-events/db017d1d-9786-41f3-823f-a7f790dd5f5b/*` 和 `logs/pi-agent/*`；该成功 run 未产生 child stderr 文件，stderr 写入路径由单元测试和历史 stderr 输出覆盖。
- 2026-05-26 Task 10 Step 10 浏览器能力边界复核：`npm run check:browser-smoke` 只对 `scripts/browser-smoke-entry.ts` 做 browser bundle，不是真实浏览器渲染或交互测试；当前仓库未发现 Playwright/Puppeteer 等可直接执行的浏览器验收 runner。因此侧栏拖拽吸附、卡片最大化视觉边界、375px 实机/真实 viewport 横向滚动和真实 DOM node identity 仍需人工浏览器确认。

## 人工 Demo 已验证

- demo server 可启动。
- `http://localhost:4175/` 返回真实 HTML，包含“公安指挥任务控制台”、`styles.css`、`app.js`，无初始业务 card 文案。
- `GET /api/snapshot` 初始返回 idle snapshot，默认 workflow 为 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 为空。
- LLM endpoint `http://192.168.20.20:9111/v1/models` 返回 200。
- MCP endpoint 可建立 SSE 连接，返回 `text/event-stream`。
- 使用公安 workflow 触发真实 run 后，child Pi process 启动，MCP tool call 链路进入真实执行。
- 第一阶段 task 后续输出 fallback JSON content，runtime 写入 conversation message。
- 第二阶段按并发上限启动 2 个 task。
- 最新真实公安 workflow run `db017d1d-9786-41f3-823f-a7f790dd5f5b` 已完整完成：4 个 steps 全部 complete，10 个 tasks 全部 complete，cards 9，conversationMessages 10，未命中 `validation_error`、`failed: terminated`、`tool_limit_exceeded`、`task_failed`。

## 未决问题

- 浏览器人工视觉验收未完成：侧栏拖拽吸附、375px 移动端真实 viewport 横向滚动、真实 DOM node identity、卡片最大化不覆盖侧栏仍需确认。
- Task 10 Step 10 不能仅凭静态源码测试和 bundle smoke 勾选完成；需要用户人工确认浏览器交互，或后续另行批准引入真实浏览器自动化验收。
- 历史风险已在最新 run 中未复现但需 Gate 5 复核归档：真实 MCP tool `failed: terminated`、模型输出 schema descriptor array、terminal fail snapshot 残留 running task/attempt、card task 未创建 card。
