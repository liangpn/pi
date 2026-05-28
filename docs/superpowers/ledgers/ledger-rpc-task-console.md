# RPC Task Console 执行台账

## 当前状态

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 当前执行焦点: 第一版 POC / Gate 5 已收口。
- 当前子代理: 无。
- 已完成: Task 1-9、Task 10 Step 1-14、Gate 5。
- 待复核实现: 无。
- 未完成: 无；后续工作进入第二版 spec / plan。
- 主会话职责: control-plane 复核、计划和 ledger 更新、子代理委派、验证调度；不得接管业务代码实现。

## 第一版有效边界

- 第一版继续收口固定 `steps -> runtime -> child Pi agents -> MCP tools -> cards/messages/snapshot/persistence` 链路。
- Gate 5 只证明第一版 runtime 和 `run_workflow` 底座可靠，不承诺第二版产品能力。
- 以下能力不作为第一版继续投入项: tabs 真实数据、历史、待办、main agent、spawn_agent、自然语言路由、产品级 UI 打磨。
- 如果完整真实公安 workflow 再次失败，只修影响第一版 runtime 底座的阻塞级问题。

## 已落地事实

### Runtime / MCP

- 第一版保留 subprocess RPC runtime，不把 `AgentSession` / SDK 嵌入式调用作为本轮前提。
- MCP package 使用固定版本 `pi-mcp-adapter@2.8.0`。
- MCP server 连接信息使用标准 `.mcp.json` / `mcpServers`。
- Pi adapter 专属配置使用 `.pi/mcp.json` 或 child `PI_CODING_AGENT_DIR` 下的 `mcp.json`。
- child settings 注入 `pi-mcp-adapter@2.8.0` package，启用 `directTools`。
- 默认 proxy `mcp` 工具禁用，且不得加入 task allowlist。
- demo server 启动阶段执行 MCP metadata prewarm；prewarm 失败时 server 启动失败。
- task `tools` allowlist 保持多层强制，Pi CLI / AgentSession 为主防线，adapter/package 层保留第二道限制。
- 当前 POC 可以暂用无前缀 tool name 兼容公安 workflow；长期 tool identity 需要支持 `$mcp_server_name:tool_name`。
- 未配置公开 URL 时，demo server 启动日志只打印端口，不再硬编码 `http://localhost:${port}`。

### Runtime 语义

- steps 严格串行。
- 同一 step 内 tasks 按并发上限并行执行。
- 同一 step 内 sibling tasks 相互独立；某个 task 最终 fail 后，不把已启动或排队的 sibling 标记为 `stopped`。
- 任一 task attempts 用尽最终 fail 后，后续 step 不启动。
- terminal snapshot 不得残留 `running` task 或 `running` attempt。
- `stopped` 语义保留给用户 stop 或新指令 replace，不用于 sibling task fail。
- assistant tool-call-only `message_end` 不记录 `validation_error`；`agent_end` 前仍无合法最终 JSON 时继续按 validation error 失败。
- card task 最终结果要求为 `{ "content": string, "data": object }`，且 `data` 必须按 `data_structure[].field` 返回字段对象，不允许返回 schema descriptor array。

### UI POC

- 冷启动 `PLAN_STEPS` 为空。
- 初始消息区为空白。
- 初始流程指引不显示 `0 / 0` 等伪进度。
- 右上角测试入口加载公安 workflow JSON 后启动测试 run。
- reset 是显式入口；浏览器刷新保留 snapshot 符合 SSE / persistence 语义。
- reset 后当前任务摘要和卡片区回到初始空态，用户浏览器复验已确认可接受。
- task 行首 icon 已表达状态，task 下方重复可见状态 label 已移除，保留可访问语义。
- textarea 高度随输入内容自适应。
- 智能协同侧栏桌面宽度已增加。
- rail 支持左右吸附拖拽。
- tabs / 历史 / 待办在第一版只保留有限 UI 壳，不继续投入真实数据模型。

## 最新验证证据

- 2026-05-28 用户浏览器复验: reset 后当前任务摘要和卡片区空态效果可接受，Task 10 Step 12 可作为已完成处理。
- 2026-05-28 主会话独立验证 Harvey 第三轮:
  - `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 98 tests passed。
  - `npm run check`: 通过，包含 Biome、`tsgo --noEmit` 和 `check:browser-smoke`。
- 2026-05-28 最新真实公安 workflow run `cc02f7cd-e1e0-4392-9612-3f7c229968a9`:
  - run `complete`。
  - 4 个 steps 全部 `complete`。
  - 10 个 tasks 全部 `complete`。
  - cards 9，conversationMessages 10，logs 246，receipts 11。
  - 未命中 `validation_error`、`task_failed`、`tool_limit_exceeded`、`failed: terminated`。
  - tool event 统计: `jcj-get-case-detail` start/end 3/3，`device-operate` start/end 10/10，`panel-operate` start/end 4/4。
- 2026-05-28 data_structure 抽查:
  - 9 张 card 的 `data` 均按对应 `data_structure` 字段和类型返回。
  - 未发现 schema descriptor array、缺 `content`、额外字段或类型不符。
  - `task_open_police_resources_panel` 结构符合 `{ panel_type: string, success: boolean }`，业务值为 `success: false`。
- 业务侧 caveat: `device-operate` / `panel-operate` 多次返回“调用出错: 前端离线”，但 tool result `isError=false`，runtime 按合法最终 JSON 完成。
- 2026-05-28 Gate 5 收口复核 run `54341d8d-73d8-4595-ad9f-52ea885a87ad`:
  - run `complete`。
  - 4 个 steps 全部 `complete`。
  - 10 个 tasks 全部 `complete`。
  - cards 9，conversationMessages 10，logs 246，receipts 11。
  - 未命中 `validation_error`、`task_failed`、`tool_limit_exceeded`、`failed: terminated`。
  - 持久化文件存在: `logs/snapshots/54341d8d-73d8-4595-ad9f-52ea885a87ad.json`、`logs/logs/54341d8d-73d8-4595-ad9f-52ea885a87ad.jsonl`、`logs/conversation/54341d8d-73d8-4595-ad9f-52ea885a87ad.jsonl`、`logs/rpc-events/54341d8d-73d8-4595-ad9f-52ea885a87ad/`。
- 用户浏览器复验: 多次测试均可看到状态更新、卡片生成和渲染；第一版固定 workflow POC 通过。

## Step 13 待复核变更

- 子代理报告已完成侧栏对话按钮和右上角测试按钮修正。
- 侧栏输入框提交应只提示 `暂不支持对话功能`，不得调用 `/runs/start`、`/runs/replace` 或 `/runs/stop`。
- 右上角按钮 idle / complete / fail / stopped 时显示 `开始测试`，running 时显示 `停止`。
- `开始测试` 加载公安 workflow JSON 和当前输入文本后调用 `/runs/start`。
- `停止` 调用现有 `/runs/stop`。
- 子代理报告验证:
  - `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 101 tests passed。
  - `npm run check`: 通过。
- Dalton 补齐 reset 后“预案指引”显示层空态：reset idle snapshot 渲染时把传给 `updateSelectedTask` 和 `renderFlow` 的 run steps 视为空数组，不改变 backend reset snapshot 语义。
- 主会话独立验证:
  - `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 101 tests passed。
  - `npm run check`: 通过，Biome no fixes applied，`tsgo --noEmit` 和 `check:browser-smoke` 通过。
- 用户浏览器复验: 侧栏输入框提示、右上角 `开始测试` / `停止`、reset 后卡片区和“预案指引”空态均通过。
- 待确认风险: `loading` 状态当前按非 running 映射为 `开始测试`；如果需要禁用或停止语义，需另行确认。

## 未决问题

- 第一版 POC 无阻塞未决问题。
- 业务侧 caveat: `device-operate` / `panel-operate` 仍可能返回“调用出错: 前端离线”，但该返回 `isError=false`，不影响第一版 runtime、状态更新、卡片生成和持久化链路；是否接入真实前端联动属于后续阶段问题。
