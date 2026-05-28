# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前执行焦点: Task 10 Step 13 Gate 5 前的浏览器人工复验。
- 当前执行顺序: 用户复验 reset 卡片区空态 -> Task 10 Step 13 Gate 5。
- 当前子代理: 无。
- 已完成: Task 1-9、Task 10 Step 1-12；Task 10 Step 10 的自动化、真实 runtime、持久化证据和用户浏览器人工确认已完成记录。
- 待复核实现: Harvey 第三轮 reset 空态修复已由主会话独立验证自动化通过；tabs 按用户要求本轮暂停、不再继续实现。当前需要用户在浏览器确认 reset 后当前任务摘要和卡片区是否恢复初始空态。
- 未完成: Task 10 Step 13、Gate 5。
- Gate 状态: Gate 1-2 已完成；Gate 3 的 Task 5-7 自动化验证已通过，最新真实 MCP/tool run 已记录为 clean；Gate 4 的 UI/API 自动化结论已按最新人工验收反馈补充前端条款和回归测试，浏览器人工复验已确认通过；Task 10 Step 12 自动化已通过，待用户浏览器复验后进入 Gate 5。
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
- 2026-05-26: 用户人工验收发现智能协同 rail 只能在右侧上下拖动，不能拖到左右两侧吸附。委派 Descartes (`019e633d-33c4-7e82-93c6-fc6c3306b4e7`) 修复 rail 拖拽吸附；写入范围限定为 `app.js`、`styles.css`、`rpc-task-console.test.ts`。
- 2026-05-26: Descartes 返回 `DONE` 并已关闭。报告变更：rail 拖拽中同时更新纵向位置和横向位移，`pointerup` 按释放位置提交左右吸附，`pointercancel` / `lostpointercapture` 清理拖拽态，拖拽后通过 `data-dragged` 避免误触发收展；CSS 增加 `--rail-drag-x` 和 dragging 视觉反馈；测试增强横向拖拽、release 吸附和清理契约。报告验证：`rpc-task-console.test.ts` 通过，`npm run check` 通过。主会话尚未独立验证。
- 2026-05-26: 委派 Goodall (`019e636c-8bd9-73a1-817f-216fcd6d8f1f`) 作为 `implementation_worker` 执行 Task 10 Step 11 前端补缺。写入范围限定为 `tasks.ts`、`index.html`、`app.js`、`styles.css`、`rpc-task-console.test.ts`；要求冷启动空 `PLAN_STEPS`、初始消息区空白、初始流程指引无 `0 / 0` 伪进度、开始/停止单按钮、textarea 自适应高度、侧栏宽度约 1.5 倍，并保留 Descartes rail 拖拽修复；不得提交 commit，若需范围外修改或发现 spec/plan 冲突必须停止报告。
- 2026-05-26: Goodall 返回 `DONE_WITH_CONCERNS`。报告变更：`PLAN_STEPS` 改为空数组；删除初始消息区“等待后端回执。”占位；删除初始流程指引 `0 / 0` 伪进度；开始/停止合并为单一主按钮；textarea 自动高度、最大高度和内部滚动；侧栏桌面宽度约 1.5 倍；保留 rail 左右拖拽吸附及清理逻辑；更新静态/UI/运行时测试。报告验证：`rpc-task-console.test.ts` 通过，96 tests；`npm run check` 通过。报告关注点：真实浏览器人工验收未执行；冷启动未加载 workflow 时主按钮会携带空 `steps` 触发 start，Goodall 判定与显式 workflow payload 语义一致。
- 2026-05-28: 用户浏览器人工复验确认主会话列出的 Step 11 重点验收项均已到位：冷启动空态、初始消息区空白、初始无 `0 / 0`、测试按钮加载 workflow、开始/停止单按钮、textarea 自适应、侧栏宽度增加、rail 左右拖拽吸附和移动端横向滚动检查均未再反馈阻塞问题。
- 2026-05-28: 用户提出第一版 POC 新 UI 优化：需要显式重置按钮。原因是浏览器刷新会重连并保留当前任务状态；控制面判断刷新保留 snapshot 符合 SSE/持久化语义，缺口是 UI 没有调用 `/runs/reset` 的显式入口。已记录为 Task 10 Step 12。
- 2026-05-28: 用户补充侧栏 UI 优化：对话区域上半区改为“智能协同 / 历史 / 待办”tabs；待办语义是传入消息事件列表，事件串行展示，当前协同中为进行中，其余为等待；历史语义是不同协同会话记录。控制面复核：第一版可实现 tabs 结构和当前“智能协同”内容，但不得伪造待办事件队列或历史会话数据；真实待办/历史数据模型已补充到后续阶段 spec。
- 2026-05-28: 用户补充流程指引优化：task 行首已有 icon 表达状态时，task 下方重复状态 label 不需要。已纳入 Task 10 Step 12，要求移除重复可见 label 并保留可访问状态语义。
- 2026-05-28: 委派 Harvey (`019e6ca6-2d22-7bc1-b893-1fa116517df9`) 作为 `implementation_worker` 执行 Task 10 Step 12。写入范围限定为 `index.html`、`app.js`、`styles.css`、`rpc-task-console.test.ts`；要求新增 `/runs/reset` 前端重置按钮、侧栏“智能协同 / 历史 / 待办”tabs、移除流程指引 task 重复可见状态 label，并保留既有 Step 11/Descartes UI 行为；不得提交 commit，若需范围外修改或发现 spec/plan 冲突必须停止报告。
- 2026-05-28: Harvey 返回 `DONE` 并已关闭。报告变更：新增前端“重置”按钮并调用 `POST /runs/reset`；请求中、running、stopping 禁用 reset；侧栏上半区加入“智能协同 / 历史 / 待办”tabs，历史和待办只展示空态；流程指引移除 task 标题下方重复可见状态 label，保留 `aria-label` 和隐藏状态文本；更新静态/UI/HTTP 测试。报告验证：`rpc-task-console.test.ts` 通过，97 tests；`npm run check` 通过。报告风险：需要人工复验 tabs 切换、reset 禁用态、rail、移动端 composer 换行和 reset 时序。
- 2026-05-28: 用户人工复验 Harvey 后反馈三处需修正：第一，重置按钮要放在右上角并与“测试”一起；第二，重置必须把卡片区域也重置；第三，tabs 应放在现有“智能协同 / 历史 / 待办”这一栏，作为整个侧边栏的切换，不是在对话区域内部切换。控制面已据此更新 spec/plan，Task 10 Step 12 继续未完成。
- 2026-05-28: 恢复 Harvey (`019e6ca6-2d22-7bc1-b893-1fa116517df9`) 继续修正 Task 10 Step 12。写入范围仍限定为 `index.html`、`app.js`、`styles.css`、`rpc-task-console.test.ts`；要求只修正重置按钮位置、reset 卡片区清空、tabs 切换整个侧栏三点，并保留现有单主按钮、测试按钮、textarea 自适应、rail 拖拽和 task 状态 label 精简。
- 2026-05-28: Harvey 第二轮返回 `DONE`。报告变更：重置按钮已移动到顶部右上角运行操作区并与“测试”并列；侧栏 tabs 提升为整体侧栏级切换；测试覆盖 reset snapshot 清空卡片工作区、按钮位置、侧栏级 tabs、route contract 和重复状态 label 移除。报告验证：`rpc-task-console.test.ts` 通过，98 tests；`npm run check` 通过。报告风险：需人工浏览器复验 reset 位置、running 禁用态、卡片空态、侧栏 tabs 和 375px 顶栏多按钮。
- 2026-05-28: 用户人工复验第二轮后确认 tabs 仍不理想但本轮暂停、不再继续实现；当前重点阻塞为 reset 后卡片区域没有恢复初始 `暂无任务` 状态。控制面判断需最小修正前端 reset 渲染：reset 后 `data-selected-task` 必须为 `暂无任务`，卡片网格为 `暂无业务卡片`，并清除旧 task selection/card UI state；即使 reset snapshot 保留 idle workflow steps，也不得自动选中第一个 idle/loading task。
- 2026-05-28: 已重新恢复 Harvey 执行最小修正。写入范围限定为 `index.html`、`app.js`、`styles.css`、`rpc-task-console.test.ts`；要求不再继续 tabs 实现，只修 reset 后 selected task/card grid/card UI state 回到初始空态，并运行 `rpc-task-console.test.ts` 与 `npm run check`。
- 2026-05-28: Harvey 第三轮返回 `DONE` 并已关闭。报告变更：reset/idle snapshot 后不再自动选中 workflow 第一个 loading task；idle + empty cards snapshot 清空 `selectedTaskId` 并让 `data-selected-task` 回到 `暂无任务`；`renderCards([])` 清空 `cardUiState`；用户点击 task 时才显式更新当前任务摘要，新 run 进入 running/stopping 后仍可自动跟随 running/loading task；强化前端静态测试覆盖 reset snapshot 的当前任务摘要、卡片空态和 card UI state 清理。
- 2026-05-28: 主会话独立验证 Harvey 第三轮：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，98 tests；`npm run check` 通过，Biome no fixes applied，`tsgo --noEmit` 和 `check:browser-smoke` 通过。Task 10 Step 12 已更新为完成，剩余为用户浏览器复验 reset 空态和 Gate 5。

## 文档整理记录

- 2026-05-26: 重新对齐 spec / plan / ledger 职责。
- Plan 调整: Task 7 改为当前 MCP package 实现任务；历史 demo adapter 方向不再作为主计划任务；后续最终验收并入 Task 10。
- Ledger 调整: 删除重复 plan 任务清单和调试命令，只保留当前状态、必要历史事实、验证证据、风险和未决问题。
- 本次只更新 plan/ledger 控制面文件，未修改业务代码、测试代码或配置代码。
- 2026-05-26: 根据新宪法边界清理 Task 10 plan：移除 plan 中的子代理验证记录和主会话验证记录，将 Task 10 Step 6 改为结构性修复任务；历史证据和风险保留在本 ledger。
- 2026-05-26: 通读 `spec-rpc-task-console.md`、`plan-rpc-task-console.md` 和本 ledger 后，按人工验收反馈补充第一版 UI 条款和 Task 10 Step 11：冷启动 `PLAN_STEPS` 为空、初始消息区空白、流程指引初始不显示 `0 / 0` 等伪进度、开始/停止合并为单按钮、输入框高度自适应、智能协同侧栏桌面宽度增加约 1.5 倍。

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
- 2026-05-26 人工验收反馈：右上角“测试”按钮可以触发公安 workflow 做浏览器验证；命令行 `run-police-workflow.mjs` 主要用于拿 run id、查持久化日志和形成可复现证据。
- 2026-05-26 人工验收反馈：`PLAN_STEPS` 冷启动应为空；初始对话区域不应显示“等待后端回执。”；流程指引初始不应显示 `0 / 0` 等伪进度；开始和停止应合并为一个主按钮；指令输入框高度应随内容自适应；智能协同侧栏桌面宽度应增加到当前约 1.5 倍。
- 2026-05-26 Goodall: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，96 tests。
- 2026-05-26 Goodall: `npm run check` 通过。
- 2026-05-26 主会话独立验证 Goodall 后状态：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，96 tests；`npm run check` 通过，`biome check --write --error-on-warnings .` no fixes applied，`tsgo --noEmit` 和 `npm run check:browser-smoke` 通过。
- 2026-05-28 用户人工浏览器复验：确认 Goodall/Descartes 的重点 UI 补缺效果到位；新增发现为缺少显式重置按钮，刷新页面仍保留任务状态。
- 2026-05-28 Harvey: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，97 tests。
- 2026-05-28 Harvey: `npm run check` 通过。该验证仅证明 Harvey 初版实现自动化通过；后续用户人工复验已打回 UI 位置和作用域，不能作为 Step 12 收口依据。
- 2026-05-28 Harvey 第三轮 / 主会话独立验证：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` 通过，98 tests。
- 2026-05-28 Harvey 第三轮 / 主会话独立验证：`npm run check` 通过；Biome no fixes applied，`tsgo --noEmit` 和 `check:browser-smoke` 通过。

## 历史人工 Demo 已验证

- demo server 可启动。
- `http://localhost:4175/` 返回真实 HTML，包含“公安指挥任务控制台”、`styles.css`、`app.js`，无初始业务 card 文案。
- Step 11 前 `GET /api/snapshot` 初始返回 idle snapshot，默认 workflow 为 2 steps / 5 tasks，cards/logs/receipts/conversationMessages 为空；Step 11 后该冷启动语义已改为空 `steps`，用户浏览器人工复验已确认重点空态效果到位。
- LLM endpoint `http://192.168.20.20:9111/v1/models` 返回 200。
- MCP endpoint 可建立 SSE 连接，返回 `text/event-stream`。
- 使用公安 workflow 触发真实 run 后，child Pi process 启动，MCP tool call 链路进入真实执行。
- 第一阶段 task 后续输出 fallback JSON content，runtime 写入 conversation message。
- 第二阶段按并发上限启动 2 个 task。
- 最新真实公安 workflow run `db017d1d-9786-41f3-823f-a7f790dd5f5b` 已完整完成：4 个 steps 全部 complete，10 个 tasks 全部 complete，cards 9，conversationMessages 10，未命中 `validation_error`、`failed: terminated`、`tool_limit_exceeded`、`task_failed`。

## 未决问题

- 浏览器人工复验待确认：点击“重置”后，当前任务摘要应回到 `暂无任务`，卡片网格应回到 `暂无业务卡片`，再次启动 run 后任务摘要应恢复跟随 running/loading task。tabs 本轮暂停、不再继续实现；第一版不得伪造待办事件或历史会话数据。
- 历史风险已在最新 run 中未复现但需 Gate 5 复核归档：真实 MCP tool `failed: terminated`、模型输出 schema descriptor array、terminal fail snapshot 残留 running task/attempt、card task 未创建 card。
