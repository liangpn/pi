# Pi 任务控制台 main agent 规划 Spec

## 状态

本文档维护 Pi 任务控制台后续阶段的 main agent、`spawn_agent` 和 `run_workflow` 设计。

本文档不是第一版 POC 的验收依据。第一版当前实现和验收依据仍是 `docs/superpowers/specs/spec-pi-task-console.md`。

## 目标

后续阶段要把 Pi 任务控制台从固定 SOP runtime 扩展为面向事件和用户输入的多 agent 编排系统。

系统必须同时支持：

- 消息事件携带合法 `steps + instruct` 时，main agent 调用 `run_workflow` 执行 SOP workflow。
- 用户自然语言指令进入时，main agent 可以直接回答、调用 `spawn_agent` 委派单个 agent，或自主创建合法 `steps` 后调用 `run_workflow`。
- SOP workflow 失败、用户实时纠正或上下文发生变化时，main agent 可以基于已有上下文创建新的合法 `steps`，再调用 `run_workflow` 继续执行。
- `spawn_agent` 和 `run_workflow` 底层复用 agent 执行、状态、日志、结果校验、卡片、消息、SSE 和持久化机制。

## 标准术语

- **main agent**：面向用户和外部事件的上游编排 agent。main agent 接收输入、理解意图，并选择直接回答、调用 `spawn_agent` 或调用 `run_workflow`。
- **spawn_agent**：main agent 可用的工具，用于启动一个单独的 agent run。它适配用户自由指令、临时任务、补充调查和非固定 SOP 的单 agent 委派。
- **run_workflow**：main agent 可用的工具，用于执行一个合法 SOP workflow。它接收 `steps + instruct`，内部使用 Workflow Executor 按确定性策略执行。
- **Workflow Executor**：确定性 SOP 执行器。它按 step 串行、step 内 task 并行的策略调度 workflow，并把每个 task 编译成 agent invocation。
- **Agent Execution Core**：通用 agent 执行内核。`spawn_agent` 直接使用它；`run_workflow` 内部的每个 task 也使用它。
- **Agent Invocation**：一次待执行 agent 调用的输入描述，包括 instruction、agent_type、tools、skills、output_contract 和 context。
- **Agent Run**：一次 agent invocation 的运行态实例，包含状态、attempts、日志、诊断、结果和持久化关联。
- **Workflow Run**：一次 workflow 的运行态实例，包含 steps、tasks、关联的 agent runs、进度、卡片、消息和日志。
- **Output Contract**：agent 输出契约，约束 agent result 的结构、校验方式，以及是否生成 UI card。
- **Execution Snapshot**：UI 和外部查询消费的运行态快照。它可以包含 workflow run、agent run、messages、cards、logs 和 receipts。

术语规则：

- 文档统一使用 `main agent`，不使用其他中文别名。
- 文档统一使用 `spawn_agent` 和 `run_workflow` 表示 main agent 的两个核心工具。
- 文档统一使用 Workflow Executor 表示 SOP 确定性执行器。
- 文档统一使用 Agent Execution Core 表示单 agent run 的底层执行机制。

## 总体入口

后续阶段的入口统一进入 main agent。

```text
消息事件输入
  -> input envelope: steps + instruct + metadata
  -> main agent
  -> run_workflow
  -> Workflow Executor
  -> Agent Execution Core
  -> Execution Snapshot / SSE / UI

用户指令输入
  -> input envelope: instruct + optional context
  -> main agent
  -> direct answer | spawn_agent | run_workflow
  -> Execution Snapshot / SSE / UI
```

消息事件和用户指令的区别在于输入形态和 tool selection 规则，不在于是否绕过 main agent。

## UI 队列和历史

后续阶段的智能协同侧栏应以 tabs 组织：

- `智能协同`：展示当前正在协同的 main agent / workflow / agent run 消息和输入控件。
- `历史`：展示不同协同会话或 workflow run 的历史记录入口。
- `待办`：展示传入系统但尚未完成协同处理的消息事件列表。

待办事件列表规则：

- 事件按进入系统的顺序串行展示。
- 同一时刻只有当前正在协同处理的事件显示为进行中。
- 未开始处理的事件显示为等待。
- 进行中和等待状态必须使用不同样式表达，且不能只依赖颜色。
- 待办列表是 main agent 入口层的事件队列视图，不是 Workflow Executor 内部 task 并发状态的替代品。

历史记录规则：

- 历史 tab 存放不同协同会话或 workflow run 的记录入口。
- 历史记录应关联 Execution Snapshot、messages、cards、logs 和持久化输出，而不是只保存前端临时 DOM。
- 第一版 POC 中如果只实现 tab 外壳，不得伪造历史会话或待办事件数据。

## main agent 工具

main agent 第一批只暴露两个核心工具：

- `spawn_agent`
- `run_workflow`

不在本阶段引入用户级 agent 配置、项目级 agent 配置等 Codex CLI 概念。生产系统只依赖服务端维护的 agent 类型和运行策略。

### spawn_agent

`spawn_agent` 用于启动一个单独 agent run。

适用场景：

- 用户提出自由问题或临时调查请求。
- main agent 判断只需要一个 agent 完成任务。
- workflow 之外的补充分析、复核、摘要或单点查询。
- main agent 不需要 SOP step/task 编排语义。

输入契约草案：

```ts
interface SpawnAgentInput {
  instruction: string;
  agent_type?: string;
  tools?: string[];
  skills?: string[];
  output_contract?: OutputContract;
  context?: unknown;
  metadata?: Record<string, unknown>;
}

interface SpawnAgentOutput {
  agent_run_id: string;
  status: "accepted";
}
```

规则：

- `spawn_agent` 同步返回只表示 agent run 已被接收，不等待 agent 完整完成。
- `agent_type` 引用服务端维护的 agent 类型；缺省时使用默认 agent 类型。
- `tools` 是本次 agent run 的工具 allowlist，不是提示词建议。
- `output_contract` 有值时，Agent Execution Core 必须在写入结果前执行结构校验。
- `spawn_agent` 不包含 step 串行、task 并行、workflow progress 等 SOP 语义。

### run_workflow

`run_workflow` 用于执行合法 SOP workflow。

适用场景：

- 消息事件携带合法 `steps + instruct`。
- main agent 基于用户指令创建了合法 `steps`，需要按 SOP 方式执行。
- 原 workflow 失败后，main agent 基于失败摘要创建补救 workflow。
- 用户实时纠正后，main agent 基于上下文调整后续 SOP 并继续执行。

输入契约草案：

```ts
interface RunWorkflowInput {
  steps: PlanStep[];
  instruct: string;
  source: "event" | "user" | "main_agent";
  context?: unknown;
  metadata?: Record<string, unknown>;
}

interface RunWorkflowOutput {
  workflow_run_id: string;
  status: "accepted";
}
```

规则：

- `run_workflow` 同步返回只表示 workflow run 已被接收，不等待 workflow 完整完成。
- `steps` 必须通过同一套 `validatePlanSteps()` 校验。
- 合法 `steps` 必须按 Workflow Executor 的确定性策略执行：step 串行、step 内 task 并行。
- Workflow Executor 内部把每个 task 编译成 Agent Invocation，再交给 Agent Execution Core 执行。
- `run_workflow` 不要求输入一定来自消息事件；main agent 也可以创建新的合法 `steps` 后调用它。
- 对消息事件原始 `steps`，默认应原样传入 `run_workflow`；只有明确的用户纠正、失败补救或已授权调整场景，main agent 才应创建新的 `steps`。
- 如果输入疑似 workflow 但 `steps` 不合法，main agent 不得脑补修复并执行；必须返回结构错误或请求上游修正。

## Tool Selection 规则

main agent 的系统提示词必须明确 tool selection 规则。

核心规则：

- 输入包含合法 `steps` 且存在 SOP 执行意图时，main agent 必须调用 `run_workflow`。
- 消息事件携带合法 `steps + instruct` 时，main agent 必须调用 `run_workflow`，不得改为直接回答或拆成多个 `spawn_agent` 自行调度。
- 输入没有合法 `steps` 时，main agent 才根据用户意图选择直接回答、`spawn_agent` 或创建新 `steps` 后 `run_workflow`。
- main agent 创建新 `steps` 后，仍必须通过 `run_workflow` 执行，不得手工调用多个 `spawn_agent` 模拟 SOP。
- 对固定 SOP，main agent 不负责 step/task 调度；调度由 Workflow Executor 负责。
- main agent 不得把 `run_workflow` 当成长时间阻塞工具使用。

推荐提示词约束：

```text
If the input contains a valid PlanStep[] workflow and an instruction to execute it,
you must call run_workflow with the provided steps and instruct.
Do not split workflow steps into multiple spawn_agent calls.
Do not answer workflow events directly.
If the input does not contain valid steps, decide whether to answer directly,
call spawn_agent, or create valid steps and call run_workflow.
```

中文等价约束：

```text
如果输入包含合法 PlanStep[] 且目标是执行 SOP，必须调用 run_workflow。
不要把 SOP 拆成多个 spawn_agent 自行调度。
不要直接回答 SOP 事件。
如果输入没有合法 steps，再根据用户意图选择直接回答、spawn_agent，或创建合法 steps 后 run_workflow。
```

## Agent Execution Core

Agent Execution Core 是 `spawn_agent` 和 `run_workflow` 的共享底层。

职责：

- 接收 Agent Invocation。
- 解析 agent_type、tools、skills、output_contract 和 context。
- 启动 Pi RPC child process 或后续候选 agent execution backend。
- 跟踪 agent run 状态。
- 管理 attempts、retry、timeout、stop、abort、kill。
- 捕获 RPC events、stderr tail、process id、close code 和 signal。
- 解析 final assistant result。
- 按 Output Contract 校验结果。
- 写入 logs、diagnostics、messages、cards 和 persistence。
- 向 Execution Snapshot 发布状态变化。

Agent Execution Core 不负责：

- 判断用户意图。
- 决定是否执行 SOP。
- 决定 step 串行或 task 并行。
- 生成 workflow progress。

## Workflow Executor

Workflow Executor 是 `run_workflow` 的内部确定性执行器。

职责：

- 校验 `steps`。
- clone plan steps into runtime steps。
- 按 step 串行、step 内 task 并行执行。
- 维护 workflow task 状态和 progress。
- 把每个 task 编译成 Agent Invocation。
- 收集 task 对应的 Agent Run 结果。
- 根据 task `card_type`、`data_structure` 和 Output Contract 创建 UI card。
- 复用第一版 stop、replace、retry、stale event ignore、SSE 和持久化语义。

Workflow Executor 不负责：

- 自然语言意图理解。
- 自主修改 workflow。
- 选择是否直接回答用户。

## 共享 UI 和状态

`spawn_agent` 和 `run_workflow` 必须共享状态、进度和 UI 呈现底层机制。

共享内容：

- run status。
- agent run status。
- attempts。
- logs。
- diagnostics。
- conversation messages。
- system receipts。
- UI cards。
- SSE snapshot。
- persistence。
- stop/abort/kill 状态反馈。

差异内容：

- `run_workflow` 额外展示 steps、tasks、step progress counts、selected task 和 workflow 总进度。
- `spawn_agent` 默认只展示 agent run 状态、agent 输出消息、可选 card 和日志。

建议统一 snapshot 方向：

```ts
type ExecutionKind = "agent" | "workflow";

interface Execution {
  id: string;
  kind: ExecutionKind;
  status: "accepted" | "running" | "complete" | "fail" | "stopped";
  title?: string;
  source: "event" | "user" | "main_agent";
  messages: ExecutionMessage[];
  cards: UICard[];
  logs: ExecutionLog[];
}

interface AgentExecution extends Execution {
  kind: "agent";
  agent_type?: string;
  instruction: string;
  result?: AgentResult;
}

interface WorkflowExecution extends Execution {
  kind: "workflow";
  steps: RuntimeStep[];
}
```

上述接口是后续阶段设计方向，不约束第一版当前 snapshot schema。

## pi-web-ui 设计参考

Pi 官方历史上曾存在 `packages/web-ui` workspace，包名为 `@earendil-works/pi-web-ui`。该 workspace 已在提交 `b141e1fa2460868686ffd19c5d4ced743eee6c24` 中整体移除，提交标题为 `chore: remove web-ui workspace`。当前公开 package catalog 不应被视为 `pi-web-ui` 的延续。

后续 UI 设计只保留短参考事实：可借鉴其 chat/interface 分层、message/tool renderer registry、artifact preview panel 等展示思路；不得恢复 `packages/web-ui`，也不得把任务控制台改成依赖该历史组件库。

## Steps 创建和调整

main agent 可以创建或调整 `steps`，但必须受规则约束。

允许场景：

- 用户自然语言目标需要拆解成 SOP workflow。
- 原 workflow 失败后需要补救 workflow。
- 用户打断并明确纠正执行方向。
- main agent 基于已有 cards、task results、tool errors 或 diagnostics 生成后续 workflow。

限制：

- main agent 创建的 `steps` 必须通过 `validatePlanSteps()`。
- main agent 不得执行不合法 `steps`。
- main agent 不得在消息事件原始 SOP 无错误、无用户纠正、无补救理由时随意改写 `steps`。
- main agent 是否允许覆盖 task `tools`、`skills`、`retry` 和 `data_structure` 必须在后续 implementation spec 中继续细化。

## 上下文交接

当已有 workflow 被用户打断、失败或需要调整时，main agent 不应接收完整 child agent message/tool history。

默认交接对象应是结构化摘要：

```ts
interface InterruptedRunSummary {
  workflow_run_id: string;
  status: "running" | "stopping" | "fail" | "stopped" | "complete";
  completed_tasks: TaskSummary[];
  running_tasks: TaskSummary[];
  failed_tasks: TaskSummary[];
  stopped_tasks: TaskSummary[];
  cards: CardSummary[];
  errors: ErrorSummary[];
  diagnostics: DiagnosticSummary[];
}
```

规则：

- 摘要应优先包含 task result、card summary、error summary 和必要 diagnostics。
- 默认不注入完整 child RPC events。
- 默认不注入 streaming message deltas。
- 是否注入原始 logs 必须由 debug 或审计场景显式开启。

## 仍需细化的问题

进入后续阶段实施计划前，必须继续固化：

- main agent 的外部输入接口形态：是否使用 Pi chat 接口、HTTP endpoint，或其他 host runtime。
- 输入 envelope 的最终 schema。
- `spawn_agent` 和 `run_workflow` 的最终 tool schema。
- agent_type 的服务端注册、枚举和默认值。
- main agent 创建 `steps` 时可使用哪些 tools、skills、retry 和 `data_structure`。
- `run_workflow` 与正在运行 workflow 的 stop/replace/queue 关系。
- 多个用户指令、消息事件和 workflow 同时到来时的优先级。
- main agent 消息和 runtime task message 在 UI 中的归属和展示方式。
- Agent Execution Core 与第一版 TaskStore 的衔接边界。
- Execution Snapshot 是否替代第一版 TaskSnapshot，或先兼容并行。
- memory 是否进入本阶段；如果进入，失败经验如何沉淀和引用。
- 审计与回放如何基于 snapshot、RPC JSONL、task logs 和 agent run logs 重建一次执行。
