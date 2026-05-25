# RPC 任务控制台 Spec

## 目标

RPC 任务控制台是一个基于 Pi 的主从多 agent 架构 POC。

核心机制是 Task Execution Runtime：它接收已选定的 `steps` 流程定义，按 step 串行、task 并行的规则创建独立 Pi RPC 子 agent 会话，跟踪 task 运行态，校验 task 结果，并把进度、任务消息和业务卡片暴露给 UI。

当前可执行版本是第一版 POC。第一版从已选定的 `steps` 开始，不实现主 agent 的流程匹配、用户自然语言路由或 memory 沉淀。第二版完整 POC 会在第一版 runtime 之上增加事件通知入口、用户指令入口和主 agent 委派入口的完整关系设计。

本文档中，第一版章节是当前实现和验收依据；第二版章节只记录后续设计方向和待解决问题，不作为第一版验收依据。

## 第一版范围

第一版 POC 以事件通知触发的固定 SOP 流程为主。第一版不定义事件通知的上游协议；进入 Task Execution Runtime 的输入必须已经是 `PlanStep[]` 和一段 `userInstruction`。

入口：

```text
事件通知
  -> 已选定 steps
  -> Task Execution Runtime
  -> TaskDispatcher
  -> child Pi RPC agents
  -> TaskStore / SSE / UI / 对话区域任务消息
```

第一版必须支持：

- 执行固定 `steps -> tasks` 流程。
- step 严格串行执行。
- 当前 step 内 tasks 独立并行执行，并受调度器并发上限控制。
- 每个 task attempt 创建一个独立 Pi RPC 子 agent 会话。
- task attempt 到达终态后清理对应子会话。
- task 成功完成的同一次 completion handling 中，后端必须先写入 TaskStore，再通过 SSE 发布包含最新 task 状态和对话区域任务消息的 snapshot。
- 当 task 配置了 `card_type` 时，task 完成后必须创建 UI card；未配置 `card_type` 时不得创建 UI card。
- task attempt 级失败重试，并通过参数控制最大尝试次数。
- 用户停止和新指令替换流程。
- MCP 工具通过 Pi extension adapter 接入，不让 Pi core 直接读取 MCP config。
- demo 级本地文件持久化：snapshot、logs、RPC events、stderr、conversation task messages 和 runtime 输出目录都必须可配置。第一版不要求数据库、分布式存储、高可用或跨进程恢复。

第一版不包含：

- 主 agent 根据外部 JSON 自动匹配 workflow。
- 主 agent 处理用户自然语言指令。
- 主 agent 改写、裁剪或新增 task。
- 用户打断后把前序 run 上下文交给主 agent。
- 主 agent 基于 task 完成结果继续推理。
- 失败经验沉淀和 memory 机制。
- 生产级认证、权限或部署。
- 后端返回真实视频 bytes。
- 独立 `ui_card` tool。

第一版事实源：

- `TaskStore`
- task attempts
- task logs
- cards
- receipts
- runtime 本地文件持久化输出

第一版 child Pi RPC process 默认使用 `--no-session`。Pi 原生 child session 不作为第一版事实源。

## 第二版规划

第二版需要覆盖事件通知入口和用户指令入口。第二版是待设计方向，不是第一版实现承诺。进入第二版 plan 前，必须先把本节问题重新讨论并固化为更具体的 spec。

完整入口：

```text
事件通知入口
  -> 固定 SOP steps
  -> Task Execution Runtime

用户指令入口
  -> 如果存在 running run，先 stop/replace
  -> 主 agent 接收用户指令和可选 interrupted_run_summary
  -> 主 agent 判断：
       -> 直接回答
       -> 委派 single_task
       -> 发起 workflow
  -> Task Execution Runtime
```

确定方向：

- 事件通知入口不依赖主 agent 触发。
- 用户指令入口由主 agent 接收和判断。
- 事件通知入口和主 agent 委派入口共用同一套 Task Execution Runtime。
- single task 委派可以规范化为单 step 单 task。
- UI task 状态、UI card、对话区域任务汇报消息必须复用第一版 runtime 机制。
- 不把整个 workflow runtime 封装为一个长时间阻塞式 tool。
- 如果主 agent 通过 tool 形态发起 runtime run，tool 不能等待 workflow 完整结束；tool 的同步返回值只能表示 run 已被接收，例如 `{ "run_id": "...", "status": "accepted" }`。

第二版必须继续设计的问题；这些问题在第一版中不实现：

- **上下文交接**：事件通知 SOP 被用户打断后，是否以及如何把已完成 task、运行中 task、失败 task、cards、logs 摘要交给主 agent。
- **摘要粒度**：默认交给主 agent 的应是结构化 `interrupted_run_summary`，不是完整 child agent message/tool history。
- **触发时机**：用户指令到达时，是先 stop 完成后再调用主 agent，还是 stop 过程中先给主 agent 部分上下文。
- **主 agent 继续推理**：task 完成后是否需要注入主 agent 会话并触发下一轮推理。
- **消息归属**：对话区域中哪些消息属于 runtime 任务消息，哪些属于主 agent 消息。
- **上下文选择**：哪些 cards、task results、tool errors、attempt diagnostics 可以进入主 agent context。
- **session 策略**：是否为主 agent、runtime、child agent 分别启用 Pi session；如果启用，session 文件如何关联到 run/task/attempt。
- **权限边界**：主 agent 委派时能否修改 workflow，能否覆盖 task tools、skills、retry 和 `data_structure`。
- **并发冲突**：用户指令、事件通知、新 workflow 同时到来时的排队、丢弃、替换和优先级规则。
- **长期记忆**：task 失败经验如何沉淀到 memory，后续委派如何引用。
- **审计与回放**：如何基于持久化 snapshot、RPC JSONL、task logs 重建一次 run。

## 标准术语

- **Step**：串行流程阶段。Step 是计划定义，不直接执行，也不产生卡片。
- **Task**：最小执行单元。每个 task 对应一个独立 Pi RPC 子 agent 会话。
- **Task Attempt**：task 的一次执行尝试。每次 attempt 使用独立 child Pi RPC process。
- **RuntimeStep**：从 step 克隆出的运行态对象，带聚合状态。
- **RuntimeTask**：从 task 克隆出的运行态对象，带状态、结果、日志、attempts、子 agent 元数据和终态信息。
- **Task Execution Runtime**：可复用执行运行时，负责调度、状态、重试、停止、结果校验、卡片和事件输出。
- **TaskDispatcher**：runtime 内的确定性后端调度器。调度器不是 agent。
- **主 agent**：第二版中的上游编排 agent。第一版不实现主 agent。
- **子 agent**：为单个 task attempt 创建的 Pi RPC 子进程/会话。
- **卡片**：后端工程代码基于 task 配置和 agent 输出组装出的 UI/runtime 对象。

## Workflow 输入契约

`steps` 是被维护的流程定义，不是运行态。

```ts
interface PlanStep {
  id: string;
  title: string;
  tasks: PlanTask[];
}

interface PlanTask {
  id: string;
  title: string;
  description: string;
  tools?: string[];
  skills?: string[];
  retry?: TaskRetryPolicy;
  card_type?: CardType;
  data_structure?: DataField[];
  demoOutcome?: "normal" | "force_fail_after_run";
}

interface TaskRetryPolicy {
  max_attempts?: number;
  base_delay_ms?: number;
  max_tool_calls?: number;
  retry_on?: TaskRetryReason[];
}

type TaskRetryReason =
  | "process_error"
  | "process_closed_before_agent_end"
  | "provider_error"
  | "timeout"
  | "tool_limit_exceeded"
  | "validation_error";

type CardType = "media" | "map" | "table" | "json" | "text";

type DataFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

interface DataField {
  field?: string;
  type: DataFieldType;
  required?: boolean;
  description?: string;
  items?: DataField;
  fields?: DataField[];
}
```

规则：

- `steps` 数组顺序就是执行顺序。
- step id 在同一个 plan 内必须唯一。
- task id 在同一个 plan 内必须唯一。
- step 内 `tasks` 数组顺序只用于展示排序，不代表串行执行。
- task `description` 是给子 agent 的业务执行说明。
- 复杂的多步业务/工具调用保留在一个 task description 内，调度器不再把 task 拆成更小的结构化步骤。
- `tools` 是该 task 的工具 allowlist，不是提示词建议。
- `tools` 缺省或为空数组时，该 task 不启用业务工具/MCP 工具。
- 子 agent 只能使用 `tools` 内声明的业务工具/MCP 工具，以及 runtime 配置显式允许的最小系统工具。
- `skills` 声明该 task 需要启用的技能。
- `skills` 缺省或为空数组时，该 task 不启用额外技能。
- `card_type` 字段可缺省。
- `card_type` 只允许缺省或取 `CardType` 联合类型中的值；空字符串是非法值。
- `card_type` 有值时，`data_structure` 必填且不能为空数组。
- `card_type` 缺省时，`data_structure` 必须缺省或为空数组。
- `data_structure` 同时约束 agent 输出和 UI 卡片渲染数据。
- `retry` 是 task 级重试覆盖配置；未设置的字段使用 runtime 默认配置。
- `max_attempts` 必须是大于等于 1 的整数。
- `max_tool_calls` 必须是大于等于 1 的整数。
- `base_delay_ms` 必须是大于等于 0 的整数毫秒值。
- `retry_on` 为空数组时不对失败 attempt 做 task retry。
- `DataFieldType` 支持 `integer`，用于表达整数型结构化数据。
- `steps` 不保存 run 状态、task 状态、结果、日志、子进程 ID、错误或卡片实例。

## 执行语义

执行顺序：

```text
run start
  -> clone plan steps into runtime steps
  -> start tasks in step 1 up to dispatcher concurrency limit
  -> when active step completes successfully, start next step
  -> when any task exhausts attempts and fails, mark run failed and do not start later steps
  -> when user stops or replaces, mark unstarted tasks stopped and stop running children
```

规则：

- step 严格串行。
- `step-2` 必须等待 `step-1` 完成后才能启动。
- 当前 step 内的 tasks 独立并行。
- 调度器必须对当前 step 内的 tasks 执行可配置的并发上限。
- 如果并发上限低于 task 数量，排队 task 在 running task 完成后启动。
- task attempt 到达终态后必须释放对应子进程/会话。
- task 只有在成功 attempt 完成、attempts 用尽失败、或被 stop/replacement 中止后才进入 task 终态。
- task 成功完成的同一次 completion handling 中，runtime 必须写入 task result、对话区域任务消息，并发布最新 snapshot。
- 第一版不做 step 内 task 聚合后再通知。step 内聚合行为属于第二版或后续设计，不作为第一版验收依据。

终态定义：

- task attempt 终态只能是 `complete`、`fail` 或 `stopped`。
- task 终态只能是 `complete`、`fail` 或 `stopped`。
- step 终态只能是 `complete`、`fail` 或 `stopped`。
- run 终态只能是 `complete`、`fail` 或 `stopped`。
- 进入终态后的 task、step 和 run 不得再改变状态；旧 run 或已终态对象的迟到事件必须被忽略并记录诊断。

## 状态模型

```ts
type TaskStatus = "loading" | "running" | "complete" | "fail" | "stopped";
type RunStatus = "idle" | "running" | "stopping" | "complete" | "fail" | "stopped";
type StopReason =
  | "user_stopped"
  | "replaced_by_new_instruction"
  | "timeout_after_stop";
```

中文展示：

```ts
const STATUS_LABELS = {
  loading: "等待",
  running: "执行中",
  complete: "已完成",
  fail: "失败",
  stopped: "已停止",
} satisfies Record<TaskStatus, string>;
```

Step 状态聚合：

```text
任一 task fail -> step fail
全部 task complete -> step complete
全部 task stopped -> step stopped
没有 running 且存在 stopped -> step stopped
任一 task running 或 complete -> step running
其他情况 -> step loading
```

Run 状态聚合：

```text
任一 step fail -> run fail
全部 step complete -> run complete
stopping 完成且没有 failure -> run stopped
全部 step stopped -> run stopped
其他情况 -> run running
```

`fail` 表示业务执行失败、进程异常、最终结果解析失败、校验失败或 attempts 用尽。`stopped` 表示用户停止或新指令替换导致的停止，不算作业务失败。

## 运行态数据

`TaskStore` 是 UI/runtime 的唯一事实源。

保存内容：

- 当前 run
- runtime steps
- runtime tasks
- task attempts
- task agent 元数据
- task 结果
- task 错误
- stopped 详情
- cards
- task logs
- 后端生成的系统回执
- 对话区域任务消息

所有 UI 状态都来自后端 snapshot。前端不能从 agent 自然语言中推断 task 状态、card type 或 card data。

代表性 snapshot：

```ts
interface TaskSnapshot {
  run: TaskRun;
  cards: UICard[];
  logs: TaskLogEntry[];
  receipts: SystemReceipt[];
  conversationMessages: TaskConversationMessage[];
}

interface TaskRun {
  id: string;
  userInstruction: string;
  status: RunStatus;
  stopReason?: "user_stopped" | "replaced_by_new_instruction";
  replacementInstruction?: string;
  steps: RuntimeStep[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

interface TaskAttempt {
  id: string;
  taskId: string;
  attempt: number;
  agentRunId: string;
  status: "running" | "complete" | "fail" | "stopped";
  toolCallCount: number;
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface TaskConversationMessage {
  id: string;
  runId: string;
  stepId: string;
  taskId: string;
  content: string;
  time: number;
}
```

系统回执和对话区域任务消息由后端状态变化生成，不由 agent 自由文本生成。

运行态 ID 规则：

- runtime 自生成 ID 统一使用标准 UUID 文本格式：`8-4-4-4-12`，例如 `550e8400-e29b-41d4-a716-446655440000`。
- `run.id`、log id、message id、receipt id、card id、attempt id、agent 关联 id 都使用同一 UUID 格式。
- ID 不拼接 `stepId`、`taskId`、时间戳、事件类型或 agent run 长字符串。
- `stepId`、`taskId` 等业务定位字段继续作为独立字段保存，不进入文件名和 runtime 自生成 ID。
- RPC request id 仍遵守 Pi RPC 协议；它不是 task id，也不是 runtime log/message/card id。

## 任务结果和卡片契约

子 agent 只返回当前 task 的结果。

无卡片：

```json
{
  "content": "任务完成之后的一段总结"
}
```

有卡片数据：

```json
{
  "content": "任务完成之后的一段总结",
  "data": {
    "gbids": ["gbid_1", "gbid_2"]
  }
}
```

规则：

- `content` 是 runtime 生成对话区域任务消息的唯一文本来源。
- `data` 是按 `data_structure` 输出的结构化数据。
- `card_type` 缺省时，agent 只返回 `content`。
- `card_type` 有值时，agent 必须返回 `content` 和 `data`。
- agent 只输出 `content`，以及有卡片数据时输出 `data`。
- agent 不输出 card title、card type 或完整 card 对象。
- 后端解析 JSON、校验 `data`，再创建 runtime/UI card。

`data_structure` 校验语义：

- 校验发生在后端工程代码中，不依赖前端。
- 校验发生在 child agent final assistant result 解析之后、写入 `TaskStore` 之前。
- `data_structure` 由外部维护页面维护，POC 接收时视为已选定的 task 数据契约。
- `card_type` 有值时，`data_structure` 必填，且 `task_result.data` 必须满足该结构。
- `card_type` 缺省时，`task_result.data` 不参与卡片创建；如果返回了 `data`，后端必须记录诊断，且不得创建 card。
- 校验失败时，该 attempt 以 `validation_error` 失败，并根据 task retry 策略决定是否重试。

运行态/UI card：

```ts
interface UICard<TData = unknown> {
  id: string;
  stepId: string;
  taskId: string;
  type: CardType;
  title: string;
  status: TaskStatus;
  data: TData;
}
```

卡片组装：

```text
if task.card_type is set:
  card.title = task.title
  card.type = task.card_type
  card.data = task_result.data
```

第一版支持的卡片类型：

- `text`：文本摘要或结构化文本字段。
- `table`：表格数据。
- `map`：地址、坐标、marker 或地图操作结果。
- `media`：媒体/视频引用数据，例如 GBID。后端不返回视频 bytes。
- `json`：调试或通用结构化预览。

卡片属于 task。Step 永远不持有卡片。

失败渲染：

- task 失败时，UI 优先展示错误摘要和日志。
- UI 不能为失败任务伪造成功业务卡片。
- 失败 task 不得写入 `cards` collection；失败相关原始信息只能出现在 task logs 或错误详情中。

## 重试和执行限制

Retry 分为三层，三层语义不能混用。

### Provider 和 LLM 请求层

Pi 已有请求层 retry 配置：

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.provider.timeoutMs`
- `retry.provider.maxRetries`
- `retry.provider.maxRetryDelayMs`

配置出处：

- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/src/core/sdk.ts`

规则：

- 这一层只处理 LLM provider 请求、流中断、429、5xx、timeout 等 transient error。
- task console 不重新实现这一层。
- task console demo 必须能把这些配置写入或传递给 child Pi RPC process 使用的 settings。
- child event 中 `agent_end.willRetry === true` 时，dispatcher 不能立刻结算 task attempt。
- `auto_retry_start` 和 `auto_retry_end` 进入 task logs，用于解释为什么当前 task 还没有终态。

### 工具调用层

Pi 当前没有独立的 `maxToolCalls` 配置。

Pi agent loop 的行为：

- assistant 输出 tool call。
- Pi 执行 tool call。
- tool result 写回上下文。
- 如果模型继续输出 tool call，agent loop 继续下一轮。

可用插入点：

- `beforeToolCall`：tool 执行前可 block。
- `afterToolCall`：tool 执行后可改写 result、error flag 或 terminate。
- coding-agent extension 已桥接 `tool_call` 和 `tool_result` hook。

第一版采用 dispatcher 级工具调用次数限制：

- dispatcher 监听 child RPC `tool_execution_start`。
- 每个 task attempt 维护 tool call 计数。
- 计数超过配置上限时，dispatcher 必须对 child 发送 `abort`。
- abort 后等待 `stop_abort_timeout_ms`；超时后 child 仍未退出时，dispatcher 必须 kill child。
- 该 attempt 以 `tool_limit_exceeded` 失败。
- 是否进入下一次 task attempt 由 task retry 策略决定。

工具调用失败不等于 task 立即失败。Pi 会把 tool error 作为 tool result 放回上下文，模型仍可能在后续 turn 自我修复。只有 attempt 达到终态失败条件时，dispatcher 才结算 attempt。

### Task Attempt 层

task retry 由 dispatcher 控制。一个 attempt 对应一个独立 child Pi RPC process。

默认策略：

```ts
interface TaskConsoleRetryConfig {
  max_attempts: number; // 默认 2，表示首次执行 + 1 次重试
  base_delay_ms: number; // 默认 1000
  max_tool_calls: number; // 默认 8
  retry_on: TaskRetryReason[];
}

type TaskRetryReason =
  | "process_error"
  | "process_closed_before_agent_end"
  | "provider_error"
  | "timeout"
  | "tool_limit_exceeded"
  | "validation_error";
```

规则：

- `max_attempts = 1` 表示不做 task retry。
- task 上的 `retry` 配置覆盖 runtime 默认配置。
- runtime 默认 `max_attempts = 2`。
- runtime 默认 `base_delay_ms = 1000`。
- runtime 默认 `max_tool_calls = 8`。
- runtime 默认 `retry_on = ["process_error", "process_closed_before_agent_end", "provider_error", "timeout", "tool_limit_exceeded", "validation_error"]`。
- task retry 重启整个 task，不复用旧 child 会话。
- 每次 attempt 的 agent run id、开始时间、结束时间、错误原因和关键 logs 都要保留到 runtime task 诊断信息。
- task 最终完成时只使用成功 attempt 的结果创建 card。
- 所有 attempts 都失败时，task 进入 `fail`，并阻止后续 step 启动。
- dispatcher 不判断工具是否幂等；有副作用工具是否允许 retry 只能由 task `retry` 或 runtime config 控制。

## 调度器

`TaskDispatcher` 是确定性后端代码。

职责：

- 选择当前 active step。
- 按并发上限启动 active step 内的 tasks。
- 为每个 task attempt 创建一个 Pi RPC 子进程/会话。
- 根据用户指令、step、task title、task description、tools、skills、`card_type` 和 `data_structure` 构造 task prompt。
- 订阅子进程事件。
- 将子进程事件转换为 task store events。
- 将 runtime task 置为 complete、fail 或 stopped。
- 按 task retry 策略决定是否启动下一次 attempt。
- 只有当前 step 成功完成后才进入下一个 step。
- failure、stop 或 replacement 后不再启动后续 step。
- 忽略旧 run 或旧子进程的迟到事件。

Prompt 要求：

- 子 agent 必须知道自己只负责一个 task。
- prompt 必须包含 task title 和 description。
- 当实际启用了工具或技能时，prompt 必须列出该 task 可用的工具名和技能名。
- `card_type` 有值时，prompt 必须要求 JSON 输出 `{ content, data }`。
- `card_type` 缺省时，prompt 必须要求 JSON 输出 `{ content }`。
- 前端不直接消费 raw prompt 或 raw model text 作为 UI 状态。

## Child Pi RPC 子进程

每个 task attempt 使用一个子进程/会话：

```bash
pi --mode rpc --no-session
```

子进程 wrapper 必须：

- 使用 LF 分隔的 JSONL 作为 stdin/stdout 协议。
- 复用项目 JSONL helper，避免临时手写 line parsing。
- 将 commands 序列化为 JSON lines。
- 将 child RPC events 归一化后再进入 task 状态。
- 捕获 stderr tail 作为诊断。
- 捕获 process id、close code 和 signal。
- 支持 prompt、steer、abort 和 kill。

Commands：

```json
{"id":"request-id","type":"prompt","message":"..."}
{"id":"request-id","type":"steer","message":"..."}
{"id":"request-id","type":"abort"}
```

RPC request id 不是 task id，也不是 agent run id。`prompt` success 只表示请求已被接受，不表示 task 已完成。

## Pi 事件处理

控制台使用归一化 child events 作为诊断信息和 task 状态输入。

驱动状态的事件：

- child spawned -> task running
- prompt response failure -> current attempt fail
- process error -> current attempt fail
- 非 stopping 状态下，最终结果前 process close -> current attempt fail
- final assistant result 解析和校验成功 -> current attempt complete -> task complete
- stop flow 达到终态 -> task stopped

诊断/log 事件：

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `auto_retry_start`
- `auto_retry_end`
- unknown JSON events

重要规则：

- 不从自然语言文本驱动 task 状态。
- 不把 streaming delta 当作最终结构化 task result。
- `message_update` 只可用于显式开启的 debug 流式诊断，不进入默认人工验收日志。
- assistant `message_end` 是解析最终 `{ content, data? }` 的唯一正常输入事件。
- `agent_end` 是子 agent 会话终止信号；dispatcher 在收到该事件时必须确认 attempt 是否已经进入终态。
- `turn_end` 表示一个 assistant response 及该 response 触发的 tool results 完成。
- `agent_end` 表示整个 prompt run 完成。
- `agent_end.willRetry === true` 时，说明 Pi 会继续 provider 层 retry，dispatcher 不能结算 attempt。
- `tool_execution_update` 只用于展示运行中进度，不能作为模型已经收到最终结果的依据。
- tool error 必须进入 task logs，但不直接使 attempt fail；Pi 会把 tool error 作为 tool result 放回模型上下文，直到 attempt 命中终态失败条件。
- process error、validation error、MCP/extension fatal error 必须进入 task logs，并使当前 attempt fail。
- 旧 run 或已 settled task 的迟到事件必须被忽略。

默认日志规则：

- 默认人工验收日志只保存完整事实，不保存流式 delta 结构。
- `message_update`、`message_start`、`tool_execution_update` 不写入默认 task logs 和默认 RPC event 持久化文件。
- 完整 assistant message 只从 `message_end` 记录；日志中优先保存最终 `content`、解析结果、校验错误摘要和必要上下文字段。
- 工具日志保留 `tool_execution_start` 和 `tool_execution_end`；不保存 partial result 流式更新。
- 进程、校验、重试、stop/replace、stale event 诊断保留，但 detail 必须避免写入大段 streaming event 原始结构。
- 如果后续需要完整 raw trace，必须通过单独 debug 配置显式开启；debug trace 不作为默认人工验收输出。

Pi 事件生命周期出处：

- RPC events 是 stdout JSON lines：`packages/coding-agent/docs/rpc.md`。
- RPC event schema 包含 `agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_*`、`tool_execution_*`、`auto_retry_*`。
- `turn_end` 在 assistant response 和 tool results 完成后产生：`packages/agent/src/agent-loop.ts`。
- `agent_end` 在整个 agent run 结束后产生：`packages/agent/src/agent-loop.ts`。
- tool 执行中可以通过 `onUpdate` 产生 `tool_execution_update`：`packages/agent/src/agent-loop.ts`。
- tool 完成后才产生 tool result message，模型后续 turn 才能看到该结果：`packages/agent/src/agent-loop.ts`。

当前技术判断：RPC Mode 是第一版主通道，因为任务控制台需要运行中控制。JSON Event Stream Mode 可以作为事件 schema 参考，但不适合作为 stop/replace/multi-child 控制的主执行模式。

## 停止和替换

停止和新指令替换共用同一套清理策略。

用户停止：

```text
click stop
  -> run.status = stopping
  -> stopReason = user_stopped
  -> stop launching queued/unstarted tasks
  -> mark unstarted tasks stopped
  -> send steer to running children
  -> wait short timeout
  -> send abort to children that did not finish
  -> wait short timeout
  -> kill children that still did not exit
  -> run.status = stopped
```

新指令替换：

```text
submit new instruction while running
  -> run.status = stopping
  -> stopReason = replaced_by_new_instruction
  -> stop and clean old child processes
  -> when old run cleanup settles, start a new run
```

规则：

- 停止后不自动开始新 run。
- 替换只在旧 child 清理完成后开始新 run。
- Kill 只能在 steer 等待和 abort 等待都结束后执行。
- UI 必须明确展示 stopping。
- 异步 stop/replace 处理中，按钮必须 disabled。
- steer 后等待默认 5 秒。
- abort 后等待默认 3 秒。
- 两个超时值必须可配置。
- 超时后 kill 仍未退出的 child 需要记录 `timeout_after_stop` 诊断。

## 配置和持久化

POC 使用配置文件保存本地 provider、runtime 和 MCP 细节，避免硬编码到 source constants。

配置文件：

- `.env`：本地密钥、配置文件路径、端口、Pi command、输出目录。
- `llm.config.json`：OpenAI-compatible provider/base URL/model 信息。
- `mcp.config.json`：MCP 相关本地配置入口；最终字段、schema 来源和是否保留手写工具映射需等待 MCP 调研确认。
- `runtime.config.json`：并发上限、stop timeout、task retry、tool call limit 等调度器参数。
- child Pi RPC process 使用的 `settings.json`：Pi retry、provider timeout、provider retry、transport 等 Pi 运行配置。

`runtime.config.json` 结构：

```ts
interface RuntimeConfig {
  concurrency_limit: number;
  stop_steer_timeout_ms: number;
  stop_abort_timeout_ms: number;
  retry: TaskConsoleRetryConfig;
  minimal_system_tools: string[];
}
```

`runtime.config.json` 默认值：

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

`runtime.config.json` 校验规则：

- `concurrency_limit` 必须是大于等于 1 的整数。
- `stop_steer_timeout_ms` 必须是大于等于 0 的整数。
- `stop_abort_timeout_ms` 必须是大于等于 0 的整数。
- `retry.max_attempts` 必须是大于等于 1 的整数。
- `retry.base_delay_ms` 必须是大于等于 0 的整数。
- `retry.max_tool_calls` 必须是大于等于 1 的整数。
- `retry.retry_on` 只能包含 `TaskRetryReason`。
- `minimal_system_tools` 中的工具不受 task `tools` 限制；第一版默认值必须为空数组。

`.env` 至少需要支持：

```dotenv
PI_DEMO_PORT=4175
PI_DEMO_PI_COMMAND=../../node_modules/.bin/tsx
PI_DEMO_PI_ARGS=
PI_DEMO_OUTPUT_DIR=logs
PI_DEMO_SNAPSHOT_DIR=logs/snapshots
PI_DEMO_LOG_DIR=logs/logs
PI_DEMO_RPC_EVENT_DIR=logs/rpc-events
PI_DEMO_CHILD_STDERR_DIR=logs/stderr
PI_DEMO_CONVERSATION_DIR=logs/conversation
PI_DEMO_CHILD_AGENT_DIR=logs/pi-agent
PI_DEMO_CHILD_SESSION_DIR=
PI_DEMO_ENABLE_CHILD_SESSION=false
PI_DEMO_LLM_CONFIG=llm.config.json
PI_DEMO_MCP_CONFIG=mcp.config.json
PI_DEMO_RUNTIME_CONFIG=runtime.config.json
```

配置规则：

- 默认输出目录位于项目根目录 `logs/`，不再写入 example 目录下的 `.rpc-task-console/`。
- `PI_DEMO_OUTPUT_DIR` 是默认输出根目录；默认值按项目根目录解析为 `logs/`。
- 显式配置的相对输出路径必须按项目根目录解析，避免运行产物散落到 example 源码目录。
- 未单独配置的输出目录从 `PI_DEMO_OUTPUT_DIR` 派生。
- 日志、snapshot、RPC events、conversation messages 必须可以通过配置输出到不同目录。
- `PI_DEMO_CHILD_AGENT_DIR` 用作 child Pi RPC process 的 `PI_CODING_AGENT_DIR`。
- 第一版默认 `PI_DEMO_ENABLE_CHILD_SESSION=false`，child Pi RPC process 继续使用 `--no-session`。
- 当 `PI_DEMO_ENABLE_CHILD_SESSION=true` 时，dispatcher 必须移除 `--no-session`，并把 `PI_DEMO_CHILD_SESSION_DIR` 作为 child Pi RPC process 的 session directory。
- `PI_DEMO_ENABLE_CHILD_SESSION=true` 且 `PI_DEMO_CHILD_SESSION_DIR` 为空时，server 启动必须失败并输出配置错误。
- 无论是否启用 Pi child session，TaskStore 持久化和 runtime logs 都是第一版事实源。

默认输出文件命名：

```text
logs/
  snapshots/
    <run-uuid>.json
  logs/
    <run-uuid>.jsonl
  conversation/
    <run-uuid>.jsonl
  rpc-events/
    <run-uuid>/
      <agent-uuid>.jsonl
  stderr/
    <run-uuid>/
      <agent-uuid>.log
```

规则：

- 文件名只使用 UUID 和固定文件扩展名，不拼接 `stepId`、`taskId`、事件类型或长 agent run id。
- `rpc-events/<run-uuid>/<agent-uuid>.jsonl` 中的 `agent-uuid` 是 runtime 为 child agent/attempt 分配的稳定关联 ID。
- 每条 JSON record 内保留 `runId`、`agentId`、`stepId`、`taskId`、`attemptId` 等字段用于定位。
- `snapshot` 文件可以反复覆盖当前 run 最新状态；`logs`、`conversation`、`rpc-events` 使用 JSONL append。
- 旧的 `packages/coding-agent/examples/rpc-task-console/.rpc-task-console/` 属于历史 demo 运行产物，可安全删除；不得依赖该目录作为新默认输出位置。

## MCP 和工具权限

MCP 接入方案需要先调研 Pi 文档和仓库实现后再最终确认。当前第一版不再把手写 MCP tool schema 或手写 Streamable HTTP client 作为已确认架构。

调研必须确认：

- Pi 是否已有原生 MCP 配置入口。
- Pi 是否能通过 MCP `tools/list` 自动发现 tool schema。
- task console 是否应该删除本地手写 tool schema。
- Streamable HTTP 是否已有项目内实现、依赖库或官方接入方式，是否不应在示例中从头实现。
- 子 agent 工具 schema 应由 Pi runtime 传给模型，还是需要 task console 在 prompt 中补充。
- task `tools` allowlist 应该在 Pi CLI、extension adapter、MCP client 或多层共同约束。

工具权限规则：

- `PlanTask.tools` 是子 agent 的工具 allowlist。
- dispatcher 创建 child Pi RPC process 时，只能启用 task allowlist 中的工具，以及工程配置显式允许的最小系统工具。
- MCP 接入最终实现必须保留 task allowlist 语义。
- 在 MCP 调研结论落地前，不得继续基于现有 `mcp.config.json` 手写 schema 方案扩大实现范围。

## HTTP 和实时 API

浏览器 UI 使用 HTTP POST 处理用户动作，使用 SSE 接收后端 snapshot。

Routes：

- `GET /`
- `GET /styles.css`
- `GET /app.js`
- `GET /events`
- `POST /runs/start`
- `POST /runs/stop`
- `POST /runs/replace`
- `POST /runs/reset`

验收辅助入口：

- 顶部右上角提供“测试”按钮。
- “测试”按钮读取当前指令输入框内容，并用公安 workflow JSON 作为预置 `steps` 调用 `/runs/start`。
- 如果指令输入框为空，前端弹框提示，不启动 run。
- 指令输入框默认文本必须与 `docs/superpowers/plans/run-police-workflow.mjs` 的默认 `userInstruction` 一致。
- 对话框中的正常 start、stop、replace 交互语义不因“测试”按钮改变。

SSE 要求：

- 连接后立即发送最新 snapshot。
- Store 变化后发送 snapshot。
- 浏览器断开时移除 listener。
- 浏览器重连后拿到后端最新状态。
- SSE 对外暴露 runtime snapshots，而不是把 raw RPC event stream 作为主 UI API。

## UI 要求

UI 是公安指挥工作流的高密度操作控制台，不是营销页。

当前优先布局遵循 `docs/superpowers/specs/references/task-console-ui-reference.md`：

- 顶部标题栏展示产品名称。
- 业务卡片工作区占据智能协同侧栏之外的主区域。
- 智能协同侧栏可吸附在左侧或右侧。
- 智能协同侧栏包含系统回执、任务消息和流程指引。第二版接入主 agent 后，才能展示主 agent 消息。
- 智能协同侧栏可收起为可拖拽的“智能协同” rail。
- rail 在当前吸附边缘支持上下拖动。
- rail 支持拖拽到另一侧边缘并吸附；吸附到左侧时，侧栏从左侧展开；吸附到右侧时，侧栏从右侧展开。
- 侧栏吸附方向是前端 UI 状态，不得改变 run、step、task、card 或 message 数据。
- Browser body 固定为视口高度。
- 卡片工作区、消息区和流程列表独立滚动。

卡片工作区：

- task 有结果后才出现卡片。
- 不提前渲染等待态占位卡片。
- 卡片网格按卡片工作区当前可用宽度和高度自适应布局。
- 桌面布局优先保持 3 列卡片。
- 可用宽度不足以保持 3 列时降为 2 列或 1 列；不得横向溢出，也不得与智能协同侧栏重叠。
- 根据 `card.type` 选择 renderer。
- 卡片支持收起和最大化。
- 最大化只覆盖卡片工作区，不覆盖智能协同侧栏。
- Media 卡片基于 `gbids` 等业务引用渲染，不依赖后端视频 bytes。

流程指引：

- 展示全部 steps 和 tasks。
- 展示 step progress counts。
- 展示 selected task。
- task 状态必须通过文本或语义符号表达，不能只靠颜色。
- 状态变化必须局部更新，不得重排整个列表。

可访问性：

- 系统回执使用 `aria-live="polite"`。
- 错误消息使用合适的 alert 语义。
- icon-only buttons 必须有 `aria-label`。
- 保留清晰 focus ring。
- 状态不能只依赖颜色。
- 375px 左右移动端宽度不能横向滚动。
- 支持 `prefers-reduced-motion`。

## POC 工作流示例

当前业务化 test workflow 位于 `docs/superpowers/specs/references/police-command-workflow.json`，包含：

- `step_incident_facts`：识别警情要素和出警资源。
- `step_basic_assessment`：定位事发地址、定位坐标、查询报警人背景、查询处置预案、打开可调资源面板。
- `step_scene_situation`：打开周边监控和周边警力。
- `step_dispatch_resource_visualization`：调阅出警单兵/执法仪，跟踪出警警车。

后端 POC 允许使用更小的 demo workflow 做快速验证；业务场景以公安指挥 workflow 为准。

人工验收辅助脚本：

- `docs/superpowers/plans/run-police-workflow.mjs` 作为命令行验收入口。
- 脚本读取 `docs/superpowers/specs/references/police-command-workflow.json`。
- 脚本默认使用与前端指令输入框一致的 `userInstruction`。
- 脚本把 `steps + userInstruction` 写入 `/runs/start` 请求 JSON，不创建或修改 workflow 参考 JSON 文件。
- 脚本不包含 snapshot 轮询逻辑；运行状态通过浏览器 UI、`GET /api/snapshot` 或输出日志查看。

## 校验和测试

后端测试应覆盖：

- plan 克隆为 runtime steps。
- step 状态聚合。
- run 状态聚合。
- 旧 run 事件忽略。
- task attempt 历史记录。
- task retry 最大尝试次数。
- task retry 等待 `agent_end.willRetry`。
- tool call 上限行为。
- `tools` allowlist 强制生效。
- runtime 输出目录配置。
- snapshot 持久化输出。
- task logs 持久化输出。
- child RPC JSONL events 持久化输出。
- conversation task messages 持久化输出。
- child Pi `PI_CODING_AGENT_DIR` 配置。
- child Pi session 默认关闭。
- 只有配置 `card_type` 时才创建 card。
- 未配置 `card_type` 时不创建 card。
- `data_structure` 校验成功和失败。
- 后端生成系统回执。
- JSONL command 序列化。
- child event 归一化。
- stderr tail 捕获。
- step 串行、task 并行调度。
- 并发上限行为。
- task 失败阻止后续 step。
- stop 和 replace 清理。
- stop timeout 配置生效。
- SSE snapshot 格式。
- static file allowlist。
- 默认日志不写入 streaming `message_update`、`message_start`、`tool_execution_update` 结构。
- runtime 自生成 ID 和持久化文件名使用 UUID，不拼接 task id 或长 agent run id。
- “测试”按钮使用公安 workflow JSON 和当前指令输入框内容触发 `/runs/start`。
- `run-police-workflow.mjs` 使用同一默认 `userInstruction` 触发公安 workflow。
- MCP 接入实现必须在 Pi 文档和仓库调研结论确认后再调整测试；现有 fake MCP Streamable HTTP adapter 测试不能作为最终架构依据。

## 参考文档

- `docs/superpowers/specs/references/pi-rpc-mechanisms.md`
- `docs/superpowers/specs/references/workflow-steps-schema.md`
- `docs/superpowers/specs/references/police-command-workflow.json`
- `docs/superpowers/specs/references/task-console-ui-reference.md`
- `docs/superpowers/specs/references/task-console-ui-wireframe.html`
