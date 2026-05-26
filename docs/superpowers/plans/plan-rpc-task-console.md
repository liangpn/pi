# RPC 任务控制台实施计划

> **给 agentic workers：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行本计划。所有步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 将 `packages/coding-agent/examples/rpc-task-console/` 的当前 POC 对齐 `docs/superpowers/specs/spec-rpc-task-console.md` 第一版规范。

**架构：** 第一版实现固定 SOP `steps -> tasks` 执行链路，不实现主 agent 路由。后端 runtime 负责状态、attempt、重试、停止、结果校验、卡片组装、SSE snapshot 和本地持久化；前端只消费后端 snapshot，不解析 agent 自然语言或 raw RPC events。

**技术栈：** Node 22 ESM、TypeScript erasable syntax、`node:http`、`node:child_process`、Pi RPC JSONL helper、Vitest、原生 HTML/CSS/JS。

---

## 计划依据

- 规范文档：`docs/superpowers/specs/spec-rpc-task-console.md`
- Pi 机制参考：`docs/superpowers/specs/references/pi-rpc-mechanisms.md`
- Workflow 参考：`docs/superpowers/specs/references/police-command-workflow.json`
- UI 参考：`docs/superpowers/specs/references/task-console-ui-reference.md`
- 当前代码：`packages/coding-agent/examples/rpc-task-console/*`
- 当前测试：`packages/coding-agent/test/rpc-task-console.test.ts`

本计划只覆盖第一版 POC。第二版主 agent 入口、用户自然语言路由、上下文交接、memory、workflow 匹配不在本轮实现。

## 任务拆解矩阵

| Spec 范围 | 基线状态 | 差距 | 计划任务 |
|---|---|---|---|
| Workflow 输入契约 | 有 `PlanStep`、`PlanTask`、`RuntimeStep`、`RuntimeTask`，但仍使用 `mcp` 和旧 2 step/5 task fixture | 缺 `tools`、`retry`、`integer`；未验证公安 workflow 参考结构 | Task 1 |
| 运行态数据 | 有 `TaskStore`、snapshot、logs、receipts、cards | 缺 attempts、conversationMessages；终态 guard 不完整 | Task 2 |
| 任务结果和卡片契约 | task complete 后可创建 card | 仍使用 `card_data`；没有 `{ content, data? }` 校验；没有 task conversation message | Task 2、Task 4 |
| Runtime 配置和持久化 | 有 `.env`、LLM config、MCP config | 缺 `runtime.config.json`、输出目录、child session 开关、本地文件持久化 | Task 3 |
| Child Pi RPC | 有 JSONL wrapper、prompt/steer/abort/kill、stderr tail、事件 normalize | 未归一化 `auto_retry_*`；最终结果未从 assistant `message_end` 解析 | Task 4 |
| Pi 事件处理 | `agent_end.willRetry` 已保留在 normalize 层 | dispatcher 对任意 `agent_end` 直接结算；未等待 provider retry | Task 4 |
| 调度器 | step 基本串行，step 内 task 并行 | step 内并行无上限；无 attempt retry；无 tool call 上限 | Task 5 |
| 停止和替换 | 有 stop 和 replace 雏形 | stop 直接 abort + SIGTERM；replace 不等旧 run cleanup | Task 6 |
| MCP 和工具权限 | MCP 接入方向已改为 `pi-mcp-adapter@2.8.0` package | 需要按当前 spec 重新实现 Task 7：固定 package 版本、启用 `directTools`、禁用 proxy、prewarm cache、保留多层 allowlist，并让 demo adapter 退出 active path | Task 7 |
| HTTP/SSE API | 有 `GET /events` 和 snapshot SSE | action routes 是 `/api/*`，缺 `/runs/start|stop|replace|reset`；无 replace route | Task 8 |
| UI | 能从 snapshot 动态渲染部分内容 | 内联 CSS/JS；初始硬编码业务卡片；无 conversationMessages；智能协同侧栏固定右侧；卡片网格未按可用空间优先 3 列；状态局部更新和可访问性不足 | Task 9 |
| 验证 | 有单文件 Vitest 覆盖基础路径 | 缺 Task 7 最新 MCP 实现后的最终集成和人工验收 | Task 10 |

## 文件边界

修改：

- `packages/coding-agent/examples/rpc-task-console/types.ts`
- `packages/coding-agent/examples/rpc-task-console/tasks.ts`
- `packages/coding-agent/examples/rpc-task-console/task-store.ts`
- `packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- `packages/coding-agent/examples/rpc-task-console/run-manager.ts`
- `packages/coding-agent/examples/rpc-task-console/child-agent-process.ts`
- `packages/coding-agent/examples/rpc-task-console/env.ts`
- `packages/coding-agent/examples/rpc-task-console/server.ts`
- `packages/coding-agent/examples/rpc-task-console/index.html`
- `packages/coding-agent/examples/rpc-task-console/mcp-config.ts`
- `packages/coding-agent/examples/rpc-task-console/mcp-streamable-http-client.ts`
- `packages/coding-agent/examples/rpc-task-console/extensions/mcp-tools.ts`
- `packages/coding-agent/examples/rpc-task-console/.mcp.json`（如采用项目内示例配置）
- `packages/coding-agent/examples/rpc-task-console/.pi/mcp.json`（如采用项目内示例配置）
- `packages/coding-agent/package.json`（如引入或固定 package 依赖）
- `package-lock.json`（如依赖变更）
- `packages/coding-agent/test/rpc-task-console.test.ts`

新增：

- `docs/superpowers/plans/run-police-workflow.mjs`
- `packages/coding-agent/examples/rpc-task-console/runtime-config.ts`
- `packages/coding-agent/examples/rpc-task-console/plan-validation.ts`
- `packages/coding-agent/examples/rpc-task-console/child-settings.ts`
- `packages/coding-agent/examples/rpc-task-console/prompt-builder.ts`
- `packages/coding-agent/examples/rpc-task-console/result-validation.ts`
- `packages/coding-agent/examples/rpc-task-console/persistence.ts`
- `packages/coding-agent/examples/rpc-task-console/styles.css`
- `packages/coding-agent/examples/rpc-task-console/app.js`
- `packages/coding-agent/examples/rpc-task-console/runtime.config.json`
- `packages/coding-agent/examples/rpc-task-console/runtime.config.example.json`

保持不改：

- `packages/*/CHANGELOG.md`
- `packages/ai/src/models.generated.ts`

## 执行规则

- 每次修改 `packages/coding-agent/test/rpc-task-console.test.ts` 后，从 `packages/coding-agent` 运行：

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

- 完成代码修改后，从 repo 根目录运行：

```bash
npm run check
```

- 不运行 `npm test`。
- 不运行 `npm run build`。
- 不提交 commit，除非用户明确要求。

---

## 复核安排

不采用每个 task 后跟一个独立 gate。每个 task 的结果会影响后续 runtime、UI 和测试行为，只复核当前 task 容易漏掉跨阶段问题。

本计划采用阶段性累计 gate。每个 gate 必须复核从 Task 1 到当前阶段所有已完成内容，并确认前一阶段结论没有被新改动破坏。

| Gate | 执行时机 | 累计复核范围 | 必须确认 |
|---|---|---|---|
| Gate 1 | Task 1、Task 2 完成后 | Workflow 契约、TaskStore、attempts、conversationMessages、终态 guard | `PlanTask` 不再有 `mcp`；`DataFieldType` 包含 `integer`；公安 workflow 参考结构可通过输入校验并被 runtime 克隆；非法 workflow 会被拒绝；store snapshot 包含 `conversationMessages`；TaskStore 包含 task agent 元数据、stopped 详情和 child process 诊断；card 从 `result.data` 创建；无 `card_type` 但 result 带 `data` 时不创建 card、不 fail attempt；失败 task 不写入 `cards`；迟到事件不能覆盖终态 task；一次 `task_completed` mutation 后的 store snapshot 已包含 task result、conversation message、receipt 和 card |
| Gate 2 | Task 3、Task 4 完成后 | Gate 1 全部内容、runtime config、本地持久化、child RPC event、prompt 构造、最终结果解析和校验 | runtime config 可读可校验；`runtime.config.json` 与默认 env 契约一致；输出目录可配置且相对 example 目录解析；child Pi session 默认关闭；child settings 可写入或传递给 Pi RPC process；持久化不替代 `TaskStore`；prompt 包含 task 执行和 JSON 输出约束；`child_spawned` 触发 running；`prompt_response_failure` 触发 attempt fail；`prompt` success 不完成 task；`auto_retry_*` 只写日志不结算 attempt；tool error 只写日志不直接 fail attempt；unknown JSON event 进入 task logs 和 RPC event persistence；`agent_end.willRetry === true` 不结算 attempt；assistant `message_end` 是正常路径唯一 result 解析输入 |
| Gate 3 | Task 5、Task 6、Task 7 完成后 | Gate 2 全部内容、调度、retry、tool call limit、stop/replace、MCP package 接入和 allowlist | step 严格串行；step 内并发受配置限制；queued/unstarted task 在 stop/replace 后可标记 stopped 且不启动 child；attempts 用尽后 task 才最终 fail；attempt 终态释放 child process；tool call 超限可触发 retry 或最终 fail；kill 只发生在 steer 和 abort 等待之后；replace 不并发启动新旧 run；replace 后旧 run 迟到事件被忽略并记录诊断；`pi-mcp-adapter@2.8.0` 固定加载；`directTools` 生效；proxy `mcp` 不暴露；metadata cache prewarm 成功；task allowlist 多层强制生效；MCP/package 错误转 tool error 或明确启动错误 |
| Gate 4 | Task 8、Task 9 完成后 | Gate 3 全部内容、HTTP/SSE API、前端 snapshot 渲染和 UI 行为 | canonical routes 可用；`/runs/start` 和 `/runs/replace` 接收已选定 `steps + userInstruction`；SSE 重连拿最新 snapshot；一次 `task_completed` 后首个 SSE snapshot 已包含 task result、conversation message、receipt 和 card；前端不解析 agent 自然语言；顶部标题栏展示产品名称；无提前业务 card；失败 task 不伪造成功 card；流程指引展示全部 steps/tasks、progress counts 和 selected task；智能协同侧栏支持左右吸附和对应方向展开；卡片工作区按可用空间优先 3 列；`aria-live`、icon-only `aria-label`、focus ring、reduced-motion 和非纯颜色状态表达均已实现；375px 移动端无横向滚动 |
| Gate 5 | Task 10 完成后 | 第一版 spec 全量要求、全部测试、最终人工验收、文件清理 | spec 每条第一版验收要求都有测试或人工验证；Task 7 最新 MCP package 实现已纳入最终检查；第二版内容没有被误实现为第一版承诺；`npm run check` 无 errors、warnings、infos；没有新增 changelog；没有提交 `.env`、密钥或运行输出目录 |

Task 内仍要执行对应的测试步骤。Gate 只决定阶段性质量复核，不替代 task 内的测试命令。

## Task 1: Workflow 输入契约和公安 workflow 参考结构

**目标：** 将模型层改为 spec 的输入契约，并验证公安指挥 workflow 参考结构可作为 runtime 输入。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/types.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/tasks.ts`
- 新增：`packages/coding-agent/examples/rpc-task-console/plan-validation.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 更新 task 输入类型**

`PlanTask` 使用：

```ts
export interface PlanTask {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly tools?: readonly string[];
	readonly skills?: readonly string[];
	readonly retry?: TaskRetryPolicy;
	readonly card_type?: CardType;
	readonly data_structure?: readonly DataField[];
	readonly demoOutcome?: "normal" | "force_fail_after_run";
}
```

`RuntimeTask` 保留同名 plan 字段，并新增 attempts 运行态字段：

```ts
readonly tools: readonly string[];
readonly skills: readonly string[];
readonly attempts: readonly TaskAttempt[];
```

- [x] **Step 2: 增加 retry 和 integer 类型**

```ts
export type DataFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface TaskRetryPolicy {
	readonly max_attempts?: number;
	readonly base_delay_ms?: number;
	readonly max_tool_calls?: number;
	readonly retry_on?: readonly TaskRetryReason[];
}
```

- [x] **Step 3: 将 `mcp` 迁移为 `tools`**

代码和测试中 `PlanTask.mcp`、`RuntimeTask.mcp` 全部替换为 `tools`。

允许保留的 `mcp` 命名只限于 MCP adapter/config 相关文件。

- [x] **Step 4: 增加公安 workflow 参考结构验证**

`docs/superpowers/specs/references/police-command-workflow.json` 必须能通过 `validatePlanSteps()`，并可被克隆为 runtime steps。测试至少覆盖以下 step id：

- `step_incident_facts`
- `step_basic_assessment`
- `step_scene_situation`
- `step_dispatch_resource_visualization`

后端 POC 仍允许使用更小的 demo workflow 做快速验证；公安 workflow 是业务场景参考，不要求成为唯一默认 fixture。

- [x] **Step 5: 实现 workflow 输入校验**

新增：

```ts
export function validatePlanSteps(steps: readonly PlanStep[]): readonly PlanStep[];
```

校验规则：

- step id 在同一个 plan 内必须唯一。
- task id 在同一个 plan 内必须唯一。
- `card_type` 只能缺省或取 `CardType` 联合类型中的值，空字符串非法。
- `card_type` 有值时，`data_structure` 必填且不能为空数组。
- `card_type` 缺省时，`data_structure` 必须缺省或为空数组。
- `retry.max_attempts` 必须是大于等于 1 的整数。
- `retry.max_tool_calls` 必须是大于等于 1 的整数。
- `retry.base_delay_ms` 必须是大于等于 0 的整数。
- `retry.retry_on` 只能包含 `TaskRetryReason`。
- `tools` 缺省时规范化为空数组。
- `skills` 缺省时规范化为空数组。

- [x] **Step 6: 增加 workflow 校验测试**

测试至少覆盖：

- duplicate step id 被拒绝。
- duplicate task id 被拒绝。
- `card_type: ""` 被拒绝。
- `card_type` 有值但 `data_structure` 缺省或为空数组被拒绝。
- `card_type` 缺省但 `data_structure` 非空被拒绝。
- 非法 retry 数值或非法 `retry_on` 被拒绝。
- `tools` 缺省时规范化为空数组。
- `skills` 缺省时规范化为空数组。

- [x] **Step 7: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

---

## Task 2: TaskStore、attempts、conversationMessages 和终态 guard

**目标：** 让 `TaskStore` 成为 UI/runtime 的完整事实源。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/types.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-store.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 增加运行态类型**

新增：

```ts
export interface TaskAttempt {
	readonly id: string;
	readonly taskId: string;
	readonly attempt: number;
	readonly agentRunId: string;
	readonly status: "running" | "complete" | "fail" | "stopped";
	readonly toolCallCount: number;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly errorCode?: string;
	readonly errorMessage?: string;
}

export interface TaskConversationMessage {
	readonly id: string;
	readonly runId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly content: string;
	readonly time: number;
}
```

`TaskSnapshot` 包含：

```ts
readonly conversationMessages: readonly TaskConversationMessage[];
```

`RuntimeTask` / `TaskAttempt` 必须保存结构化诊断：

```ts
readonly agent?: {
	readonly processId?: number;
	readonly sessionDir?: string;
	readonly command: readonly string[];
};
readonly stopped?: {
	readonly reason: StopReason;
	readonly detail?: string;
};
readonly process?: {
	readonly closeCode?: number;
	readonly signal?: string;
	readonly stderrTail?: string;
};
```

这些字段进入 `TaskStore` snapshot 或 task logs 诊断，不只写入本地文件。

- [x] **Step 2: 将 result 契约改为 `data`**

```ts
export interface AgentTaskResult<TData = unknown> {
	readonly content: string;
	readonly data?: TData;
}

export interface TaskResult<TData = unknown> {
	readonly status: "complete";
	readonly content: string;
	readonly data?: TData;
}
```

`task-dispatcher.ts` 中生产 `TaskResult` 的 demo result 路径也必须从 `card_data` 迁移为 `data`，避免 store 消费侧和 producer 侧契约不一致。

- [x] **Step 3: task complete 同步写入三类输出**

处理 `task_completed` 的同一次 store mutation 必须：

- 更新 task result。
- 生成 `TaskConversationMessage`，`content` 来自 `TaskResult.content`。
- 生成系统回执。
- `card_type` 有值时用 `TaskResult.data` 创建 card。
- `card_type` 缺省但 result 带 `data` 时记录诊断，不创建 card。
- mutation 完成后生成的 store snapshot 必须包含本次状态变化。
- 一次 `task_completed` mutation 后的 store snapshot 必须已包含 task result、conversation message、receipt，以及应创建的 card。

- [x] **Step 4: 增加终态 guard**

进入 `complete`、`fail`、`stopped` 的 task、step、run 不得再被状态事件改写。迟到状态事件只记录诊断日志。

- [x] **Step 5: 增加 child 运行诊断测试**

测试至少覆盖：

- child process id 被记录到 task agent 元数据。
- child close code 和 signal 被记录到 task/attempt 诊断。
- stderr tail 可进入 task 诊断。
- stop/replacement 产生 stopped 详情。
- child session 启用时 session directory 可追踪。

- [x] **Step 6: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

---

## Task 3: Runtime 配置和本地持久化

**目标：** 支持 spec 要求的 runtime config、输出目录、child session 开关和本地文件持久化。

**文件：**

- 新增：`packages/coding-agent/examples/rpc-task-console/runtime-config.ts`
- 新增：`packages/coding-agent/examples/rpc-task-console/child-settings.ts`
- 新增：`packages/coding-agent/examples/rpc-task-console/persistence.ts`
- 新增：`packages/coding-agent/examples/rpc-task-console/runtime.config.json`
- 新增：`packages/coding-agent/examples/rpc-task-console/runtime.config.example.json`
- 修改：`packages/coding-agent/examples/rpc-task-console/env.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/child-agent-process.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/run-manager.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 实现 runtime config loader**

默认值：

```json
{
  "concurrency_limit": 2,
  "stop_steer_timeout_ms": 5000,
  "stop_abort_timeout_ms": 3000,
  "retry": {
    "max_attempts": 2,
    "base_delay_ms": 1000,
    "max_tool_calls": 8,
    "retry_on": [
      "process_error",
      "process_closed_before_agent_end",
      "provider_error",
      "timeout",
      "tool_limit_exceeded",
      "validation_error"
    ]
  },
  "minimal_system_tools": []
}
```

校验规则按 spec 的 `runtime.config.json` 校验规则实现。

`runtime.config.json` 和 `runtime.config.example.json` 都写入同一组默认值。`PI_DEMO_RUNTIME_CONFIG` 未配置时使用 `runtime.config.json`。配置文件不存在或校验失败时 server 启动失败并输出配置错误，不静默回退到 source constants。

- [x] **Step 2: 扩展 `.env`**

支持：

- `PI_DEMO_OUTPUT_DIR`
- `PI_DEMO_SNAPSHOT_DIR`
- `PI_DEMO_LOG_DIR`
- `PI_DEMO_RPC_EVENT_DIR`
- `PI_DEMO_CHILD_STDERR_DIR`
- `PI_DEMO_CONVERSATION_DIR`
- `PI_DEMO_CHILD_AGENT_DIR`
- `PI_DEMO_CHILD_SESSION_DIR`
- `PI_DEMO_ENABLE_CHILD_SESSION`
- `PI_DEMO_RUNTIME_CONFIG`

`PI_DEMO_ENABLE_CHILD_SESSION=true` 且 `PI_DEMO_CHILD_SESSION_DIR` 为空时，server 启动必须失败。

- [x] **Step 3: 实现 env 路径解析规则**

规则：

- 既有实现曾按 example 目录解析相对路径；当前要求把默认输出根迁移到项目根目录 `logs/`。
- `PI_DEMO_OUTPUT_DIR` 是默认输出根目录；当前默认值为项目根目录 `logs/`。
- 未单独配置的输出目录从 `PI_DEMO_OUTPUT_DIR` 派生。
- snapshot、logs、RPC events、stderr、conversation messages 可分别配置到不同目录。
- 路径解析测试必须覆盖相对路径、绝对路径和未单独配置时的派生目录。

- [x] **Step 4: 实现 child Pi settings 写入或传递**

新增：

```ts
export interface ChildSettingsPaths {
	readonly agentDir: string;
	readonly settingsPath: string;
	readonly sessionDir?: string;
}

export function prepareChildSettings(env: RpcTaskConsoleEnv): Promise<ChildSettingsPaths>;
```

行为：

- `PI_DEMO_CHILD_AGENT_DIR` 用作 child Pi RPC process 的 `PI_CODING_AGENT_DIR`。
- settings 写入 `PI_DEMO_CHILD_AGENT_DIR/settings.json`。
- settings 内容包含 Pi provider retry、provider timeout 和 transport 配置。
- child process 环境变量必须包含 `PI_CODING_AGENT_DIR`。
- `PI_DEMO_ENABLE_CHILD_SESSION=false` 时 child 启动参数包含 `--no-session`。
- `PI_DEMO_ENABLE_CHILD_SESSION=true` 时 child 启动参数不得包含 `--no-session`，并使用 `PI_DEMO_CHILD_SESSION_DIR`。

- [x] **Step 5: 实现 persistence writer**

写入：

- snapshot
- task logs
- normalized RPC events
- child stderr tail
- conversation messages

目录不存在时创建。

- [x] **Step 6: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

- [x] **Gate 2 修复补充: 接入真实 run 链路持久化**

Gate 2 复核发现 `persistence.ts` writer 已实现，且 child RPC events / stderr tail 已接入 child process wrapper，但 snapshot、task logs、conversation messages 尚未接入真实 run 链路。

修复要求：

- 在 `RunManager` 或等价运行边界接入 `createPersistenceWriter()`。
- `TaskStore` 仍是事实源；本地持久化只写出事实副本，不反向驱动状态。
- 每次 snapshot 更新后写入最新 snapshot。
- 增量写入新 task logs，避免重复写入同一 log entry。
- 增量写入新 conversation messages，避免重复写入同一 message。
- 使用 `demoEnv.snapshotDir`、`demoEnv.logDir`、`demoEnv.conversationDir`。
- 增加真实 run 链路测试，启动 run 后断言 snapshot、task log、conversation message 会落到配置目录。
- 继续保留 child RPC events / stderr tail 的现有持久化路径。

- [x] **Gate 2 hardening: 示例配置和 prompt ack 回归**

Gate 2 已通过，但 reviewer 记录了两个非阻断风险。作为进入 Task 5 前的轻量收口项处理。

文件：

- 修改：`packages/coding-agent/examples/rpc-task-console/.env.example`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

要求：

- `.env.example` 补齐 runtime 输出目录、child agent/session、runtime config 相关变量示例。
- 增加 dispatcher 回归测试：child 只发 `rpc_response` 且 `command: "prompt"`、`success: true` 时，task 仍保持 running，不写 result/card/conversation message。
- 测试随后发送合法 `message_end` 和 `agent_end.willRetry !== true`，确认 task 才进入 complete。
- 运行 `packages/coding-agent/test/rpc-task-console.test.ts`。
- 运行 `npm run check`。

---

## Task 4: Child RPC 事件和最终结果校验

**目标：** 使用 assistant `message_end` 解析最终 `{ content, data? }`，`agent_end` 只作为 run 完成信号。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/child-agent-process.ts`
- 新增：`packages/coding-agent/examples/rpc-task-console/prompt-builder.ts`
- 新增：`packages/coding-agent/examples/rpc-task-console/result-validation.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 补齐事件归一化**

`NormalizedChildEvent` 覆盖：

- `child_spawned`
- `prompt_response_failure`
- `message_start`
- `message_update`
- `message_end`
- `turn_start`
- `turn_end`
- `agent_start`
- `agent_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `auto_retry_start`
- `auto_retry_end`
- `unknown_json_event`
- `process_close`
- `process_error`

- [x] **Step 2: 实现 task prompt builder**

新增：

```ts
export interface TaskPromptInput {
	readonly userInstruction: string;
	readonly step: RuntimeStep;
	readonly task: RuntimeTask;
}

export function buildTaskPrompt(input: TaskPromptInput): string;
```

prompt 必须包含：

- 子 agent 只负责当前 task 的说明。
- `userInstruction`。
- step title。
- task title。
- task description。
- 实际启用的工具名。
- 实际启用的技能名。
- `card_type` 有值时，要求最终只输出 JSON `{ "content": string, "data": ... }`，且 `data` 必须符合 `data_structure`。
- `card_type` 缺省时，要求最终只输出 JSON `{ "content": string }`。
- 禁止输出 card title、card type 或完整 card object。

- [x] **Step 3: 实现 result parser 和 validator**

```ts
export function parseTaskResultFromAssistantMessage(message: unknown): AgentTaskResult;
export function validateTaskResult(task: RuntimeTask, result: AgentTaskResult): TaskResult;
```

规则：

- `card_type` 缺省时，结果必须包含 `content`；如果额外返回 `data`，记录诊断但不失败，不创建 card。
- `card_type` 有值时，结果必须是 `{ content, data }`。
- `data` 必须满足 `data_structure`。
- 校验失败以 `validation_error` 失败。

- [x] **Step 4: 修改 dispatcher 完成路径**

行为：

- `child_spawned` 将 attempt task 置为 `running` 并写入 task log。
- `prompt_response_failure` 将当前 attempt 置为 `fail`。
- dispatcher 使用 `buildTaskPrompt()` 创建 child prompt。
- `message_update` 不驱动状态；默认人工验收日志不保留该类流式事件。
- `unknown_json_event` 写入 task logs 和 RPC event persistence，不驱动 task 状态。
- assistant `message_end` 解析并暂存 valid result。
- `auto_retry_start` 和 `auto_retry_end` 写入 task logs，不结算 attempt。
- `agent_end.willRetry === true` 时不结算 attempt。
- `agent_end.willRetry !== true` 且已有 valid result 时 complete attempt。
- `tool_execution_end` 表示 tool error 时写入 task logs，但不直接使 attempt fail。
- valid result 前 process close 时，attempt 以 `process_closed_before_agent_end` 失败。

- [x] **Step 5: 增加 prompt builder 测试**

测试至少覆盖：

- prompt 包含 user instruction、step title、task title 和 task description。
- 有工具或技能时列出工具名和技能名。
- 无 `card_type` 时要求 `{ content }`。
- 有 `card_type` 时要求 `{ content, data }` 并包含 `data_structure`。
- prompt 不要求 agent 输出完整 card object。
- 无 `card_type` 但 agent 返回额外 `data` 时不创建 card、不 fail attempt，并记录诊断。
- `child_spawned` 触发 running 状态和 task log。
- `prompt_response_failure` 触发 attempt fail。
- `auto_retry_start` / `auto_retry_end` 只写日志，不结算 attempt。
- tool error 只写日志，不直接 fail attempt。
- unknown JSON event 写入 task logs 和 RPC event persistence。

- [x] **Step 6: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

---

## Task 5: 调度器并发、attempt retry 和 tool call 上限

**目标：** 调度器实现 spec 的 step 串行、step 内并发上限、task attempt retry、tool call 上限。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-store.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/types.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/run-manager.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 实现 step 内并发队列**

替换 `Promise.all(step.tasks.map(...))`。

规则：

- 每次只启动 active step。
- active step 内最多启动 `runtimeConfig.concurrency_limit` 个 task。
- `RunManager` 负责将 `demoEnv.runtimeConfig` 传入 dispatcher，dispatcher 不应使用与 env loader 脱节的硬编码 runtime defaults。
- running task 结束后启动队列中的下一个 task。
- queued task 必须保留可取消运行态。
- stop/replace 发生后，queued/unstarted task 必须可被标记为 `stopped`，且不得再启动 child process。
- 任一 task 最终 fail 后，后续 step 不启动。

- [x] **Step 2: 实现 queued task cancel 和 attempt lifecycle**

每次 attempt 创建独立 child Pi RPC process，并写入 `RuntimeTask.attempts`。

queued/unstarted task 被 stop/replace 取消时，不创建 attempt，task 状态进入 `stopped` 并写入诊断日志。

attempt 失败后，根据 retry policy 决定是否重启整个 task。

- [x] **Step 3: 实现 attempt 终态清理**

要求：

- attempt `complete` 后释放对应 child Pi RPC process。
- attempt `fail` 后释放对应 child Pi RPC process。
- attempt `stopped` 后释放对应 child Pi RPC process。
- task retry 启动新 attempt 时不得复用旧 child process。
- child session 启用时，attempt 记录必须保留 session directory 或可追踪标识。
- 清理动作失败时记录 task log 诊断。

- [x] **Step 4: 实现 retry policy**

合并 runtime 默认值和 task override：

- `max_attempts`
- `base_delay_ms`
- `max_tool_calls`
- `retry_on`

`retry_on` 为空数组表示不对失败 attempt 做 task retry。

- [x] **Step 5: 实现 tool call 上限**

监听 `tool_execution_start`：

- attempt `toolCallCount += 1`
- 超过 `max_tool_calls` 时发送 `abort`
- 等待 `stop_abort_timeout_ms`
- child 未退出时 kill
- attempt 以 `tool_limit_exceeded` 失败

- [x] **Step 6: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

---

## Task 6: stop 和 replace 梯度清理

**目标：** 停止和替换严格实现 steer -> abort -> kill；replace 等待旧 run 清理完成后再启动新 run。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/run-manager.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-store.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 实现 stop flow**

```text
run.status = stopping
run.stopReason = user_stopped
TaskStore 负责将 stopping/stopReason/replacementInstruction 写入 run snapshot，作为 UI 和 persistence 的事实源。
stop launching queued/unstarted tasks
mark unstarted tasks stopped
send steer to running children
wait stop_steer_timeout_ms
send abort to unfinished children
wait stop_abort_timeout_ms
kill unfinished children
run.status = stopped
```

- [x] **Step 2: 实现 replace flow**

```text
old run -> stopping
old run.stopReason = replaced_by_new_instruction
old run.replacementInstruction = new instruction
old children cleanup settle
new run start
```

新 run 启动前，旧 child 事件必须被视为 stale event。

- [x] **Step 3: 记录 stop timeout 诊断**

要求：

- steer 等待超时后记录 task log。
- abort 等待超时后记录 task log。
- kill 后 child 仍未退出时记录 `timeout_after_stop` 诊断。
- `stopped` 不算业务失败，不触发 task retry。

- [x] **Step 4: 增加 replace 后 stale event 诊断测试**

测试至少覆盖：

- replace cleanup 完成后，旧 run 的 `agent_end` 被忽略。
- replace cleanup 完成后，旧 run 的 `process_close` 被忽略。
- replace cleanup 完成后，旧 run 的迟到 log 事件不改变新 run snapshot。
- 被忽略的迟到事件写入诊断日志。

- [x] **Step 5: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

---

## Task 7: MCP package 接入和工具权限

**目标：** 按当前 spec 将 MCP 接入层迁移到 `pi-mcp-adapter@2.8.0` package，同时保留 Task Console subprocess RPC runtime 和 task `tools` allowlist 语义。

**状态：** 已完成。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/env.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/child-settings.ts`（如需要同步 Pi MCP adapter 配置到 child agent dir）
- 修改：`packages/coding-agent/examples/rpc-task-console/mcp.config.example.json`（如保留兼容提示或迁移说明）
- 修改：`packages/coding-agent/examples/rpc-task-console/mcp.config.json`（如必须）
- 新增/修改：`packages/coding-agent/examples/rpc-task-console/.mcp.json`（如采用项目内示例配置）
- 新增/修改：`packages/coding-agent/examples/rpc-task-console/.pi/mcp.json`（如采用项目内示例配置）
- 修改：`packages/coding-agent/package.json`
- 修改：`package-lock.json`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`
- 退出 active path：`packages/coding-agent/examples/rpc-task-console/mcp-config.ts`
- 退出 active path：`packages/coding-agent/examples/rpc-task-console/mcp-streamable-http-client.ts`
- 退出 active path：`packages/coding-agent/examples/rpc-task-console/extensions/mcp-tools.ts`

- [x] **Step 1: 固定 package 版本和加载方式**

要求：

- 使用固定版本 `pi-mcp-adapter@2.8.0`，不得使用 floating `@latest`。
- 优先通过本地 package 路径或 repo 依赖加载 adapter。
- 不得让每个 task attempt 通过 `--extension npm:pi-mcp-adapter` 临时安装。
- 保留第一版 subprocess RPC runtime；不得把本任务扩大为 `AgentSession` / SDK 嵌入式迁移。

- [x] **Step 2: 迁移配置入口**

要求：

- 将当前 demo `mcp.config.json` 中的 MCP server 连接信息迁到标准 `.mcp.json` / `mcpServers` 配置。
- 将 Pi adapter 专属配置迁到 `.pi/mcp.json` 或 child `PI_CODING_AGENT_DIR` 下的 `mcp.json`。
- `PI_DEMO_MCP_CONFIG` 指向标准 MCP server 配置。
- `PI_DEMO_PI_MCP_CONFIG` 指向 Pi adapter 专属配置，或启动时同步到 child agent dir。
- 配置中必须表达允许暴露的 remote MCP tools；不得依赖手写 tool schema 作为默认 schema 来源。

- [x] **Step 3: 强制 directTools 并禁用 proxy mcp**

要求：

- 必须使用 `directTools` 把允许暴露的 remote MCP tools 注册为一等 Pi tools。
- 默认单一 `mcp` proxy 工具必须禁用。
- task `tools` allowlist 不得允许万能 `mcp` proxy。
- 当前 POC 可以暂用无前缀 tool name 以兼容现有公安 workflow。
- 长期 tool identity 必须保留 MCP server name/id 前缀方案，建议格式为 `$mcp_server_name:tool_name`；后续 task `tools` 字段应按该格式设计。

- [x] **Step 4: 保留多层 allowlist**

要求：

- dispatcher 继续通过 `--tools` / `--no-tools` 限制 child agent 工具集合。
- Pi CLI / AgentSession `tools` allowlist 仍是主防线。
- Adapter/package 层必须保留第二道限制，避免 proxy fallback 或额外 direct tools 绕过 task allowlist。
- 若 adapter/package 无法表达第二道限制，必须记录阻塞并回到 spec/plan 重新决策，不得放宽 task allowlist 语义。

- [x] **Step 5: 实现 metadata cache prewarm**

要求：

- demo server 启动阶段必须执行 MCP tool discovery / metadata cache prewarm。
- prewarm 成功后，child agent 再启动 task attempt。
- prewarm 失败时，server 启动必须失败并输出明确配置/连接错误。
- 不得等到 child agent 执行过程中才发现 direct tools 未注册。

- [x] **Step 6: 让 demo adapter 退出 active path**

要求：

- `mcp-config.ts`、`mcp-streamable-http-client.ts`、`extensions/mcp-tools.ts` 不再参与正常 demo MCP 接入链路。
- 是否删除这些文件由实现风险决定；若保留，必须确保测试和 runtime 不再依赖其 active path。
- 不得删除与 Task Console runtime、dispatcher、TaskStore、SSE、cards、stop/replace、retry、持久化和结果校验相关的功能。

- [x] **Step 7: 更新测试**

测试至少覆盖：

- 使用固定 `pi-mcp-adapter@2.8.0` 或对应本地 package 入口。
- 标准 `.mcp.json` / Pi adapter config 被加载或同步到 child agent dir。
- `directTools` 被启用。
- 默认 proxy `mcp` 工具不暴露给 child agent，且不允许出现在 task allowlist 中。
- task `tools` allowlist 仍通过 `--tools` / `--no-tools` 生效。
- adapter/package 层拒绝未允许工具或未发现工具。
- metadata cache prewarm 成功路径。
- metadata cache prewarm 失败导致 server 启动失败。
- 当前 POC 裸 tool name 兼容公安 workflow。
- 长期 `$mcp_server_name:tool_name` tool identity 策略有配置或校验占位，不被当前 POC 实现反向阻断。

- [x] **Step 8: 运行验证**

运行：

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

代码修改完成后：

```bash
npm run check
```

---

## Task 8: HTTP/SSE API 对齐

**目标：** HTTP routes 对齐 spec，SSE snapshot 保持 UI 主数据源。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/server.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/run-manager.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-store.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 实现 spec routes**

Routes：

- `GET /`
- `GET /styles.css`
- `GET /app.js`
- `GET /events`
- `POST /runs/start`
- `POST /runs/stop`
- `POST /runs/replace`
- `POST /runs/reset`

旧 `/api/*` action routes 不是第一版要求。第一版 UI 和测试只使用 canonical routes；是否删除旧 routes 不作为 spec 对齐任务。

Route 语义：

- `POST /runs/start` 接收已选定的 `steps` 和 `userInstruction`；缺少 `steps` 或 `userInstruction` 时返回 400。
- `POST /runs/replace` 接收已选定的新 `steps` 和新的 `userInstruction`；缺少 `steps` 或 `userInstruction` 时返回 400；先完成旧 run cleanup，再启动新 run。
- `RunManager` / `TaskStore` 需要支持 route 传入的 selected steps 作为当前 run/reset snapshot 的事实源；不得继续只使用构造时固定 steps。
- `POST /runs/reset` 清空内存中的当前 run、cards、logs、receipts 和 conversation messages，回到初始 idle snapshot；不删除本地持久化目录中的历史文件。

- [x] **Step 2: SSE 行为**

要求：

- 连接后立即发送最新 snapshot。
- Store 变化后发送 snapshot。
- Store mutation 完成后才能发送对应 SSE snapshot。
- 一次 `task_completed` 后首个 SSE snapshot 必须已包含 task result、conversation message、receipt，以及应创建的 card。
- 浏览器断开时移除 listener。
- 浏览器重连后拿到后端最新状态。
- 不把 raw RPC event stream 暴露为主 UI API。

- [x] **Step 3: 运行测试**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

---

## Task 9: UI 拆分和 snapshot 渲染

**目标：** UI 对齐 reference：卡片只来自 task result，智能协同消息来自 runtime receipts 和 task conversation messages。

第一版不实现独立的 workflow 选择/编辑模型。`/runs/start` 和 `/runs/replace` 直接使用当前 workflow steps 作为 selected steps；`/runs/reset` 若未显式携带 `steps`，也回到当前 workflow steps 的 idle snapshot。

**文件：**

- 修改：`packages/coding-agent/examples/rpc-task-console/index.html`
- 新增：`packages/coding-agent/examples/rpc-task-console/styles.css`
- 新增：`packages/coding-agent/examples/rpc-task-console/app.js`
- 修改：`packages/coding-agent/examples/rpc-task-console/server.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`

- [x] **Step 1: 拆分静态资源**

`index.html` 只保留结构和引用：

```html
<link rel="stylesheet" href="/styles.css" />
<script type="module" src="/app.js"></script>
```

页面结构必须包含顶部标题栏，并展示产品名称“公安指挥任务控制台”。

`server.ts` 必须改为服务真实 `index.html`、`styles.css` 和 `app.js` 文件，不再从 `index.html` 正则拆分内联资源。
`/runs/reset` 空 body 时必须保持当前 workflow steps，不得回退到别的默认 workflow。

- [x] **Step 2: 移除硬编码业务卡片**

初始 DOM 不得出现业务 card。`cards.length === 0` 时可以显示非 card 的空态，不能创建等待态业务卡片。

- [x] **Step 3: 渲染 conversation messages**

智能协同消息区渲染：

- backend receipts
- `snapshot.conversationMessages`

第一版不渲染主 agent 自由对话。

- [x] **Step 4: 渲染流程指引**

流程指引必须渲染：

- 全部 steps。
- 每个 step 的全部 tasks。
- step progress counts。
- selected task。
- task 状态文本或语义符号。

状态变化必须局部更新，不得重排整个列表。

- [x] **Step 5: card renderer**

按 `card.type` 渲染：

- `text`
- `table`
- `map`
- `media`
- `json`

Media card 使用 `gbids` 等引用数据，不请求后端视频 bytes。

- [x] **Step 6: 可访问性、stopping 和局部更新**

要求：

- task 状态有可见文本或语义符号。
- 状态符号或 task row 有 `aria-label` / `title`。
- 系统回执区域使用 `aria-live="polite"`。
- icon-only buttons 必须有 `aria-label`。
- error receipt 有 alert 语义。
- 保留清晰 focus ring。
- UI 明确展示 `stopping`。
- 异步 stop/replace 处理中，提交和停止按钮必须 disabled。
- 状态不能只依赖颜色。
- 支持 `prefers-reduced-motion`。
- 状态变化不重排整个列表。

- [x] **Step 7: 实现智能协同侧栏左右吸附**

要求：

- 侧栏可收起为“智能协同” rail。
- rail 可沿当前吸附边缘上下拖动。
- rail 可拖拽到左侧或右侧边缘并吸附。
- 侧栏吸附左侧时从左侧展开，吸附右侧时从右侧展开。
- 吸附方向只保存在前端 UI 状态，不写入 runtime snapshot。

- [x] **Step 8: 实现卡片工作区自适应 3 列优先布局**

要求：

- 卡片网格根据卡片工作区当前可用宽度计算列数。
- 桌面宽度优先保持 3 列。
- 可用宽度不足时降为 2 列或 1 列。
- 卡片不得横向溢出，不得与智能协同侧栏重叠。
- 375px 左右移动端宽度不得横向滚动。

- [x] **Step 9: 实现固定视口、独立滚动、卡片收起和最大化**

要求：

- Browser body 固定为视口高度。
- 卡片工作区独立滚动。
- 消息区独立滚动。
- 流程列表独立滚动。
- 卡片支持收起和展开。
- 卡片支持最大化和恢复。
- 最大化只覆盖卡片工作区，不覆盖智能协同侧栏。
- 按钮和交互元素保留清晰 focus ring。

---

## Task 10: 测试、调试入口和最终验收

**目标：** 完成第一版 spec 的自动化覆盖、调试入口、真实 demo 验收和 Gate 5 收口。最终验收必须在 Task 7 按当前 MCP spec 完成后执行。

**文件：**

- 新增：`docs/superpowers/plans/run-police-workflow.mjs`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-store.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/child-agent-process.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/persistence.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/types.ts`
- 修改：`packages/coding-agent/examples/rpc-task-console/index.html`
- 修改：`packages/coding-agent/examples/rpc-task-console/app.js`
- 修改：`packages/coding-agent/examples/rpc-task-console/styles.css`
- 修改：`packages/coding-agent/examples/rpc-task-console/server.ts`
- 修改：`packages/coding-agent/test/rpc-task-console.test.ts`
- 复核：`logs/`
- 状态记录：`docs/superpowers/ledgers/ledger-rpc-task-console.md`

- [x] **Step 1: 后端自动化覆盖**

测试至少覆盖：

- 公安 workflow 参考结构可通过输入校验并被 runtime 克隆。
- workflow 输入校验。
- `tools` / `skills` 缺省规范化为空数组。
- step 状态聚合。
- run 状态聚合。
- step 严格串行，下一 step 不得在当前 step complete 前启动。
- 当前 step 内 task 可并行启动，并受并发上限控制。
- 任一 task 最终 fail 后，后续 step 不启动。
- `tools` allowlist。
- `DataFieldType.integer`。
- `data_structure` 成功和失败。
- 无 `card_type` 但 result 带 `data` 时不创建 card、不 fail attempt，并记录诊断。
- `conversationMessages`。
- `task_completed` mutation 后的 store snapshot 已包含 task result、conversation message、receipt 和 card。
- 后端生成系统回执。
- task agent 元数据、stopped 详情、process id、close code、signal 和 stderr tail 诊断。
- terminal task stale event guard。
- `child_spawned` 触发 task running。
- `prompt_response_failure` 触发 attempt fail。
- `agent_end.willRetry`。
- `auto_retry_start` / `auto_retry_end` 写入 task logs。
- tool error 写入 task logs 且不直接 fail attempt。
- unknown JSON event 写入 task logs 和 RPC event persistence。
- prompt builder。
- JSONL command 序列化。
- stderr tail 捕获。
- attempt retry 最大次数。
- attempt 终态释放 child process。
- child session 启用时 attempt 诊断保留 session 可追踪信息。
- tool call 上限。
- concurrency limit。
- queued/unstarted task 在 stop/replace 后进入 `stopped` 且不启动 child process。
- stop steer/abort timeout。
- reset 与 stop/replace 同时发生时，内存 snapshot 回到当前 workflow steps 的 idle 状态，且旧 run/pending replacement 的迟到事件不改变 reset 后 snapshot。
- replace cleanup。
- replace 后旧 run 迟到事件被忽略并记录诊断。
- `runtime.config.json` 存在并与默认 env 契约一致。
- runtime config 文件不存在或校验失败时 server 启动失败。
- runtime config/env/session/output dirs。
- persistence writer。
- spec HTTP routes。
- UI 和测试只使用 canonical routes；旧 `/api/*` 不作为测试依赖。
- `/runs/start` 接收已选定 `steps` 和 `userInstruction`，缺失任一字段返回 400。
- `/runs/replace` 接收已选定 `steps` 和 `userInstruction`，缺失任一字段返回 400。
- `/runs/reset` 清空内存 snapshot，不删除本地持久化目录。
- `/runs/reset` 空 body 时回到当前 workflow steps 的 idle snapshot。
- `task_completed` 后首个 SSE snapshot 已包含 task result、conversation message、receipt 和 card。
- SSE reconnect 和 disconnect cleanup。
- static file allowlist。

- [x] **Step 2: UI/静态自动化覆盖**

测试至少覆盖：

- `index.html` 引用 `styles.css` 和 `app.js`。
- 顶部标题栏展示产品名称“公安指挥任务控制台”。
- 空 cards 不创建等待态业务 card。
- 五类 card renderer。
- media GBID 渲染。
- messages 使用 `conversationMessages`。
- 流程指引展示全部 steps/tasks、step progress counts 和 selected task。
- `stopping` 可见，stop/replace 处理中按钮 disabled。
- 无主 agent/free-chat 初始消息。
- 智能协同 rail 左右吸附。
- 左侧吸附时侧栏从左侧展开，右侧吸附时侧栏从右侧展开。
- 卡片工作区按自身可用宽度优先 3 列，空间不足时降为 2 列或 1 列。
- 375px 左右移动端宽度无横向滚动。
- body 固定视口高度，卡片区、消息区和流程列表独立滚动。
- 卡片收起、展开、最大化、恢复。
- 最大化卡片不覆盖智能协同侧栏。
- focus ring 可见。
- aria-label、aria-live、alert、reduced-motion。

- [x] **Step 3: 补齐人工验收调试入口**

要求：

- runtime 自生成 ID 和持久化文件名使用 UUID，不拼接 task id、step id 或长 agent run id。
- 默认输出路径位于项目根目录 `logs/`。
- 默认 task logs 和默认 RPC event 持久化不写入 streaming delta 结构。
- `docs/superpowers/plans/run-police-workflow.mjs` 读取公安 workflow JSON，并向 `/runs/start` 发送 `steps + userInstruction`。
- 前端“测试”按钮读取当前指令输入框内容，用公安 workflow JSON 触发 `/runs/start`。
- 指令输入框默认文本与 `run-police-workflow.mjs` 默认 `userInstruction` 一致。

- [x] **Step 4: 运行已完成自动化验证**

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

```bash
npm run check
```

- [x] **Step 5: Task 7 后 MCP 集成前置检查**

必须确认：

- `pi-mcp-adapter@2.8.0` 固定版本或对应本地 package 入口已使用。
- 标准 `.mcp.json` / Pi adapter 配置已加载或同步到 child agent dir。
- `directTools` 已启用。
- 默认 proxy `mcp` 工具未暴露给 child agent，且不允许出现在 task allowlist 中。
- metadata cache prewarm 已在 demo server 启动阶段执行。
- 当前 demo adapter 文件 `mcp-config.ts`、`mcp-streamable-http-client.ts`、`extensions/mcp-tools.ts` 已退出 active path。
- task `tools` allowlist 仍通过 Pi CLI / AgentSession 主防线和 adapter/package 第二道限制生效。

- [x] **Step 6: 修正当前 step 内失败收敛语义**

要求：

- 当前 step 内 tasks 必须保持独立并行语义。
- 任一 task attempts 用尽最终 fail 后，后续 step 不启动。
- 不得因为 sibling task 最终 fail，就把当前 step 内已启动或排队的其他 task 标记为 `stopped`。
- `stopped` 仍只表示用户停止或新指令替换导致的停止，不新增 `step_failed` stop reason。
- 当前 step 内已启动或排队的 sibling task 应继续按自身 attempt/retry 语义收敛到 `complete` 或 `fail`。
- 最终 snapshot 不得残留 `running` task 或 `running` attempt。
- 保留旧 run、旧子进程、已终态 task 的迟到事件保护和诊断日志。
- 补充回归测试覆盖：同一 step 并发启动多个 task，其中一个 task 最终 fail，其他 sibling 继续独立完成或失败；后续 step 不启动；最终 run/step 为 `fail` 且无 `running` task/attempt。
- 移除 Huygens 方向引入的 `step_failed` stop reason、主动停止 sibling、以及允许 terminal run 后用 `step_failed` stopped 改写非终态 task 的逻辑。

- [x] **Step 7: demo server 和真实公安 workflow 验收**

启动 demo server：

```bash
cd packages/coding-agent
npm run example:rpc-task-console
```

打开 UI：

```text
http://localhost:4175
```

检查初始 snapshot：

```bash
curl -sS http://localhost:4175/api/snapshot | jq
```

触发公安 workflow：

```bash
node docs/superpowers/plans/run-police-workflow.mjs
```

必须确认或记录：

- demo server 可启动。
- 初始 HTTP shell 可返回真实 `index.html` / `styles.css` / `app.js`。
- 初始 snapshot 为 idle，包含当前 workflow 的 steps/tasks，cards/logs/receipts/conversationMessages 为空。
- LLM `/v1/models` endpoint 可达。
- MCP endpoint 可建立连接，且 server 启动阶段 prewarm 成功。
- 公安 workflow 可触发真实 child Pi process。
- 公安 workflow 通过 `pi-mcp-adapter` direct tool 链路触发 MCP tool call。
- `jcj-get-case-detail` 等真实 MCP tool 的结果：成功返回业务数据，或仍出现 `terminated` 并记录独立排查证据。
- 模型最终输出是否稳定满足 `{ content, data? }` 和 task `data_structure`。
- 配置 `card_type` 的 task 成功创建 card。
- 未配置 `card_type` 的 task 不创建 card。

- [x] **Step 8: 修复真实 workflow 结构化输出稳定性缺口**

要求：

- 子 agent prompt 必须明确说明 `data` 是以 `data_structure[].field` 为 key 的 JSON object，不是 `data_structure` 数组、schema 描述数组或完整 card object。
- 对配置了 `card_type` 的 task，prompt 必须给出紧凑输出示例，例如 `{ "content": "...", "data": { "<field>": <value> } }`。
- 保持 result validation 严格；不得为了通过 demo 接受 schema 描述数组、缺少 `content` 的对象或不满足 `data_structure` 的输出。
- 如需让 retry attempt 带上前一次 validation error，必须保持每次 attempt 独立 child session 的 spec 语义。
- 补充回归测试覆盖 prompt 的 `data` object contract，至少覆盖 required field、array/integer 字段和禁止输出 schema descriptor 的说明。
- 修复后重新执行真实公安 workflow，记录模型最终输出是否满足 `{ content, data? }` 和 task `data_structure`，以及配置 `card_type` 的 task 是否创建 card。

- [x] **Step 9: 修复 tool-call 中间消息误记 validation_error**

要求：

- assistant `message_end` 中如果只有 tool call、没有最终 JSON 文本，不得立即记录 `validation_error`。
- tool-call `message_end` 仍要保留原始 child event log 和 RPC event persistence。
- 如果 `agent_end` 前仍没有合法最终 task result，attempt 仍必须按现有 `validation_error` 语义失败。
- 如果 assistant 最终文本存在但不是合法 `{ content, data? }`，仍必须记录 validation error，并按 retry/final fail 语义处理。
- 补充回归测试覆盖：工具调用中间 `message_end` 不产生 validation_error log，后续最终文本可正常完成；只有 tool call 且 agent_end 时仍失败。

- [ ] **Step 10: runtime 控制、持久化和浏览器人工验收**

必须确认：

- task retry 行为符合 spec。
- tool call 上限行为符合 spec。
- stop 行为符合 spec。
- replace 行为符合 spec。
- 浏览器重连后拿到最新 snapshot。
- 输出目录包含 snapshot、logs、RPC events、stderr、conversation messages。
- 卡片收起、展开、最大化、恢复符合 spec。
- 最大化卡片不覆盖智能协同侧栏。
- 智能协同侧栏左右吸附、对应方向展开和 rail 拖拽符合 spec。
- 卡片工作区按可用空间优先 3 列，空间不足时降为 2 列或 1 列。
- 375px 左右移动端宽度无横向滚动。
- 状态文本、aria-live、alert、focus ring、reduced-motion 等可访问性要求仍符合 spec。

检查输出目录：

```bash
find logs -maxdepth 3 -type f | sort
```

定位 MCP tool 结果：

```bash
rg -n "tool_execution_start|tool_execution_end|failed: terminated|jcj-get-case-detail" logs/rpc-events
```

查看 runtime 失败原因：

```bash
tail -n 80 logs/logs/<run-uuid>.jsonl
```

- [ ] **Step 11: Gate 5 最终收口**

运行：

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts
```

代码修改完成后：

```bash
npm run check
```

最终确认：

- spec 每条第一版验收要求都有测试或人工验证记录。
- Task 7 最新 MCP package 实现已纳入最终检查。
- 第二版内容没有被误实现为第一版承诺。
- `npm run check` 无 errors、warnings、infos。
- 没有新增 changelog。
- 没有提交 `.env`、密钥或运行输出目录。
- ledger 已记录最终验证命令、真实 MCP/模型输出结果、浏览器人工验收结果、风险和未决问题。
