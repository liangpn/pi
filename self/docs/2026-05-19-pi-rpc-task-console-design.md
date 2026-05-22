# Pi RPC 任务控制台 Demo 设计

## 目标

构建一个基于 Pi 的真实任务控制台 demo，用于验证“用户指令 -> 父子任务骨架 -> 子任务独立 Pi agent 执行 -> UI 实时状态和卡片反馈”的完整链路。

第一版使用固定父子任务清单，不验证上游 LLM 自动拆任务。每个子任务启动一个真实 `pi --mode rpc --no-session` 子进程，后端消费 RPC JSONL events，转换为稳定的任务事件，再推送给浏览器 UI。

## 非目标

- 第一版不接真实上游 Pi agent 自动拆任务。
- 第一版不接真实媒体流，只用 demo URL 或占位数据验证卡片渲染。
- 第一版不做生产级认证、权限、持久化或部署。
- 第一版不做独立 `ui_card` tool。
- 第一版不让前端从 agent 自然语言文本里推断状态或卡片类型。

## 最新需求结论

- UI 初始加载时就展示完整父子任务骨架。
- 父任务只是业务阶段标题和状态聚合，不执行动作，不启动进程，不产出卡片。
- 子任务是可执行单元。每个子任务独立启动一个 Pi RPC 子进程。
- 子任务之间没有依赖关系，谁先有状态变化，UI 就先更新谁。
- 子任务内部可以包含多步业务动作，但业务系统用一段自然语言 `instruction` 表达，不拆成结构化 `steps[]`。
- 子任务可以声明输出数据类型和卡片渲染契约。
- 卡片属于子任务，不属于父任务。
- 运行中用户可以输入新指令。系统停止当前 run，清理旧子任务，再按新指令开始新 run。
- 对话区有停止按钮。点击停止与新指令替换共用停止策略，但停止后不自动开始新 run。

## 用户界面

页面采用“对话控制区 + 任务索引区 + 子任务详情区”的工作台布局，而不是只服务当前 POC 清单的简单左右布局。

这个结构的目标是支持长清单：父任务和子任务数量增加后，用户仍然能看到整体进度、定位某个子任务、查看该子任务卡片和日志，而不是依赖页面整体滚动。

可查看静态线框：

```text
docs/superpowers/specs/task-console-wireframe.html
```

文件名不能以 `pi-` 开头，因为仓库 `.gitignore` 已忽略 `pi-*.html`。

设计参考只吸收 agent 工作台类产品的信息架构，不绑定它们的产品概念：

- Symphony 类调度台：强调运行状态、并发控制、事件可观测。
- vibe-kanban 类任务板：强调任务索引、状态筛选、选中任务后的详情面板。
- Claude Code agent view 类后台会话视图：强调 agent 状态、attach / peek、失败和停止的可见反馈。

对话控制区：

- 展示用户指令。
- 展示系统任务回执。
- 输入新指令。
- 显示运行按钮。未运行时显示“开始”，运行中显示“停止”，停止中显示“停止中”并禁用。
- 支持钉住和收起。长清单或宽卡片场景下，收起后保留窄 rail 和展开按钮，把横向空间让给任务索引和卡片区。

任务索引区：

- 展示完整父子任务骨架。
- 父任务按分组展示，子任务作为分组内行项目展示。
- 支持状态筛选、关键词搜索和选中态。
- 独立滚动，不影响右侧详情区。

子任务详情区：

- 展示当前选中子任务的 instruction、agent run 元数据、卡片和事件日志。
- 卡片和日志独立于任务索引滚动。
- 失败子任务展示错误摘要和恢复信息，不盲目渲染业务卡片。

左侧系统回执由后端状态生成，不由 agent 自由生成。例如：

```text
系统：已创建 2 个父任务，5 个子任务
系统：【先期处置】已完成
系统：【资源确认】【模拟失败任务】失败：执行超时
系统：收到新指令，当前任务将在安全边界停止
系统：旧任务已停止，开始执行新指令
系统：当前任务已停止
```

## UI/UX 设计规范

界面定位是“任务执行控制台”，不是营销页。视觉应偏工作台和运维工具：信息密度高、层级清楚、状态可扫读、操作反馈明确。

### 布局

桌面端采用三栏：

- 左侧对话控制区默认 360-420px，可钉住，可收起到 56px 左右的 rail。
- 中间任务索引区默认 360-440px，承载父子任务骨架、搜索、筛选、状态统计。
- 右侧子任务详情区自适应，占据剩余空间，承载卡片、日志和 agent run 信息。
- 顶部不做大 hero，只保留紧凑标题、运行状态、环境摘要和必要操作。
- 页面主体不依赖整体滚动；对话消息、任务索引、详情内容分别独立滚动。
- 卡片区宽度不足时优先纵向堆叠，不压缩到不可读。

小屏端：

- 375px 宽度不能横向滚动。
- 三栏改为上下布局，或使用“对话 / 任务 / 详情”分段切换。
- 停止按钮和输入框必须始终可触达，不能被任务列表挤出视口。

滚动策略：

- 对话区消息列表独立滚动，输入框固定在对话区底部。
- 任务索引区独立滚动，筛选条固定在索引区顶部。
- 详情区独立滚动，选中子任务标题固定在详情区顶部。
- 当清单超过 50 个子任务时，任务索引应考虑虚拟列表；第一版 demo 可以先不实现，但布局要为它预留。

### 视觉风格

建议使用中性深色或浅色工作台风格，第一版可以优先深色控制台：

- 背景使用中性色，不使用强装饰渐变。
- 卡片半径控制在 6-8px。
- 不使用营销式大卡片、装饰性光斑或 hero 插画。
- 主要按钮和状态色要明确，但页面不能被单一高饱和颜色主导。
- 使用一致图标体系，例如 lucide 图标；不使用 emoji 作为结构性图标。

建议语义色：

```ts
const STATUS_COLORS = {
  loading: "neutral",
  running: "blue",
  complete: "green",
  fail: "red",
  stopped: "amber",
} as const;
```

状态不能只靠颜色表达，必须同时显示中文状态文本。

### 对话区

对话区承担两类内容：

- 用户指令。
- 系统任务回执。

系统回执由后端状态生成，不由 agent 自由输出。消息应该短，突出业务对象和结果：

```text
【先期处置】已完成
【资源确认】【模拟失败任务】失败：执行超时
当前任务已停止
```

输入区规则：

- idle 时主按钮显示“开始”。
- running 时主按钮显示“停止”，使用危险或警示语义，但不要误导成失败。
- stopping 时显示“停止中”，按钮 disabled，并展示进度反馈。
- complete / fail / stopped 后显示“重新开始”。
- 用户在 running 时提交新指令，输入框不禁用；提交后系统进入 stopping，并显示“收到新指令，当前任务将在安全边界停止”。

### 任务区

父任务展示：

- 父任务使用紧凑分组标题。
- 标题旁显示聚合状态和子任务统计，例如 `2/3 已完成`。
- 父任务不显示卡片。

子任务展示：

- 每个子任务至少展示 label、status、instruction 摘要、agent run 状态。
- instruction 默认折叠或截断，支持展开查看完整内容。
- 子任务状态变化应局部更新，不重排整个列表。
- 子任务完成后展示结果摘要。
- 子任务失败后展示一行错误摘要，详细错误放到日志或展开区。

日志展示：

- 默认不把所有日志展开到主视图。
- 每个子任务提供“日志”展开区。
- 关键事件可以显示在行内：启动、工具开始、工具结束、完成、失败、停止。
- 原始 RPC event 只作为调试信息，不直接作为业务 UI。

### 卡片区

卡片只挂在子任务下。

- `text` 用紧凑文本卡片。
- `table` 用可横向适配的表格卡片，移动端可变成 key/value 列表。
- `map` 第一版用点位占位图或简化坐标列表，不接真实地图也要保持布局稳定。
- `video` 第一版用监控占位画面、stream URL 和指标摘要。
- `json` 默认折叠，避免占据主视图。

卡片尺寸由 `layout` 影响：

- `compact`：适合文本摘要和小结果。
- `wide`：适合视频、地图、表格。
- `tall`：适合长表格或长日志。
- `full`：后续用于复杂工作台。

失败时不盲目渲染原业务卡片。如果子任务失败，优先显示错误摘要和日志；已有的运行中卡片可以保留为失败态外框，但不继续展示假成功数据。

### 交互和反馈

- 所有按钮点击后必须在 300ms 内有反馈。
- stopping 状态必须可见，不能让用户误以为点击无效。
- 所有异步按钮在处理中 disabled，防止重复提交。
- 状态变化动画只用于增强因果关系，控制在 150-300ms。
- 支持 `prefers-reduced-motion`，减少或关闭非必要动画。
- 不通过 hover-only 展示关键信息；日志、详情、停止等操作必须可点击或可键盘访问。

### 可访问性

- 正文和按钮文本对比度至少满足 4.5:1。
- icon-only 按钮必须有 `aria-label`。
- 任务状态不能只靠颜色表达，要有文本或图标加文本。
- 错误消息使用 `role="alert"` 或合适的 `aria-live`。
- 左侧系统回执可以使用 `aria-live="polite"`，让屏幕阅读器收到关键状态变化。
- Tab 顺序应先对话输入和运行按钮，再进入任务列表。
- focus ring 必须清晰可见，不能移除。

## 状态模型

任务状态收敛为五个：

```ts
type TaskStatus = "loading" | "running" | "complete" | "fail" | "stopped";
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

运行级状态：

```ts
type RunStatus = "idle" | "running" | "stopping" | "complete" | "fail" | "stopped";
```

`fail` 表示业务执行失败或进程异常。`stopped` 表示被用户停止或被新指令替换，不应算作业务失败。

父任务状态由子任务聚合得出：

```text
任一子任务 fail -> 父任务 fail
全部子任务 complete -> 父任务 complete
全部子任务 stopped -> 父任务 stopped
没有 running，且存在 stopped -> 父任务 stopped
任一子任务 running / complete -> 父任务 running
其余情况 -> 父任务 loading
```

第一版规则简单保守：只要有子任务失败，父任务显示失败；如果没有失败但部分子任务被停止，父任务显示已停止。后续可以扩展 `partial_failed`、`partial_stopped` 或业务自定义聚合规则。

## 执行计划结构

第一版 POC 的任务骨架来自计划配置字段 `steps`。`steps` 表达完整执行顺序：外层 step 串行执行；同一个 step 内的 tasks 并行执行。父任务在 UI 中对应 step，子任务在 UI 中对应 task。

`steps` 是计划定义，不保存运行状态、执行结果或进程信息。每次 run 启动时，后端从 `steps` 克隆出一份运行态任务树，再在 `TaskStore` 中维护状态、日志、卡片和错误。

计划结构：

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
  mcp: string[];
  skills: string[];
  card_type?: CardType;
  data_structure?: DataField[];
}

type CardType = "media" | "map" | "table" | "json" | "text";

interface DataField {
  field: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  description?: string;
  items?: DataField;
  fields?: DataField[];
}
```

规则：

- `steps[].id` 和 `steps[].tasks[].id` 是业务编排 id，应显式创建并在同一计划内保持唯一。
- `steps` 串行执行：前一个 step 完成后才启动下一个 step。
- 同一个 step 内的 `tasks` 是并行执行单元。
- `description` 是 task 给子 agent 的业务执行说明，后端会包装成实际 prompt。
- `mcp` 和 `skills` 是 task 需要的工具/技能声明；真实 MCP 工具接入通过 Pi extension 完成，后端不会把 MCP server 当成 Pi core 的内置配置。
- `card_type` 为空时，task 只需要返回文本总结，不需要 `data_structure`。
- `card_type` 非空时，`data_structure` 定义 agent 必须返回的 `card_data` 结构，同时也定义前端渲染该卡片所需的数据契约。
- `data_structure` 是业务数据结构声明，不直接表达 UI 布局。

## Demo 配置文件边界

POC 的运行配置分为三层：

- `.env`：只放本地密钥、配置文件路径、端口和 Pi 启动命令，例如 `OPENAI_API_KEY`、`PI_DEMO_LLM_CONFIG`、`PI_DEMO_MCP_CONFIG`、`PI_DEMO_PORT`。
- `llm.config.json`：放 OpenAI 兼容 LLM 的 provider、baseUrl、api、models、selectedModel 和兼容性开关。后端根据该文件生成本地 `.pi-agent/models.json`。
- `mcp.config.json`：放 MCP Streamable HTTP server 的 `url`、headers 和工具映射。Pi extension 会按 `tools[].name` 注册 Pi tool，并把调用转发为 MCP `tools/call`。

MCP 接入采用 Streamable HTTP，不采用 stdio。`mcp.config.json` 中的 server `url` 是 MCP endpoint，例如 `http://127.0.0.1:9001/mcp`。

运行态 step：

父任务：

```ts
interface ParentTask {
  id: string;
  label: string;
  status: TaskStatus;
  subTasks: SubTask[];
}
```

子任务：

```ts
interface SubTask {
  id: string;
  parentId: string;
  label: string;
  instruction: string;
  status: TaskStatus;
  cardType?: CardType;
  dataStructure?: DataField[];
  agentRun?: AgentRunState;
  result?: TaskResult;
  error?: TaskError;
  stopped?: TaskStopped;
  eventCount: number;
  startedAt?: number;
  finishedAt?: number;
  demoOutcome?: "normal" | "force_fail_after_run";
}
```

子任务 agent run 元数据：

```ts
interface AgentRunState {
  agentRunId: string;
  processId?: number;
  command: string;
  args: string[];
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string;
}
```

`instruction` 来自计划 task 的 `description`，是子任务给 agent 的业务步骤描述，可以包含工具标记。例如：

```text
1、调用 @get_jw@ 获取经纬度
2、调用 @get_address@ 获取地址
3、调用 @open_camera@ 打开监控
```

后端将 `instruction`、`card_type` 和 `data_structure` 包装成实际发给子 Pi agent 的 prompt。业务模型不使用 `prompt` 作为主字段，避免把业务描述和 agent 传输格式绑定。

成功结果：

```ts
interface AgentTaskResult<TCardData = unknown> {
  content: string;
  card_data?: TCardData;
}

interface TaskResult<TCardData = unknown> {
  status: "complete";
  content: string;
  card?: {
    title: string;
    type: CardType;
    data: TCardData;
  };
}
```

子 agent 只返回 `AgentTaskResult`。如果 task 配置了 `card_type`，后端校验 `card_data` 符合 `data_structure` 后，再补齐 `card.title = task.title` 和 `card.type = task.card_type`，形成给前端的 `TaskResult`。

失败结果：

```ts
interface TaskError {
  status: "fail";
  code?: string;
  message: string;
  detail?: string;
}
```

停止结果：

```ts
interface TaskStopped {
  status: "stopped";
  reason: "user_stopped" | "replaced_by_new_instruction" | "timeout_after_stop";
  message: string;
}
```

## 卡片和数据类型

卡片只渲染子任务输出。父任务不持有卡片数据。

失败时不强行渲染原业务卡片。失败信息优先展示在子任务行和日志中；必要时可在子任务展开区显示轻量错误块，但不把失败统一包装成业务卡片。

第一版支持这些卡片类型：

- 无 `card_type`：只显示状态和 `content`，不渲染卡片。
- `text`：文本摘要。
- `table`：表格。
- `map`：地图点位。
- `media`：媒体/监控卡片。后端只返回结构化业务数据，例如 `gbids`；前端根据 `card_type=media` 和 `card_data` 自行拉取/渲染视频画面。
- `json`：结构化调试数据。

建议前端把 `UICard` 设计成 discriminated union：

```ts
interface BaseUICard<TType extends CardType, TData> {
  id: string;
  parentTaskId: string;
  subTaskId: string;
  type: TType;
  title: string;
  status: TaskStatus;
  layout: CardLayout;
  data: TData;
}

type UICard =
  | BaseUICard<"text", TextCardData>
  | BaseUICard<"table", TableCardData>
  | BaseUICard<"map", MapCardData>
  | BaseUICard<"media", MediaCardData>
  | BaseUICard<"json", JsonCardData>;
```

前端收到的卡片数据来自 agent 的 `card_data`，并且必须符合 task 配置的 `data_structure`。例如媒体卡片可以声明：

```json
{
  "card_type": "media",
  "data_structure": [
    {
      "field": "gbids",
      "type": "array",
      "required": true,
      "description": "视频设备 GBID 列表",
      "items": { "type": "string" }
    }
  ]
}
```

对应 agent 返回：

```json
{
  "content": "已打开 3 路监控画面",
  "card_data": {
    "gbids": ["gbid_1", "gbid_2", "gbid_3"]
  }
}
```

后端给前端的卡片：

```json
{
  "title": "打开服务监控",
  "type": "media",
  "data": {
    "gbids": ["gbid_1", "gbid_2", "gbid_3"]
  }
}
```

前端通过 `CardRegistry` 渲染：

```ts
type CardRenderer = (card: UICard) => HTMLElement;
```

映射关系：

- `text` -> 文本卡片。
- `table` -> 表格卡片。
- `map` -> 地图或点位占位卡片。
- `media` -> 媒体/监控卡片。
- `json` -> JSON 预览卡片。

第一版的卡片数据可以由 `card_type` + `data_structure` + `TaskDispatcher` demo 规则生成。后续再从真实业务 tool result 或 agent 结构化 result 中提取。

如果接真实媒体流，后端结果只返回业务引用数据，不返回媒体 bytes。前端根据 `card_type` 和 `card_data` 调用自己的媒体渲染逻辑。

## 固定任务清单

第一版使用固定清单，验证成功、失败、停止、卡片渲染和父任务聚合。

```ts
const STEPS: PlanStep[] = [
  {
    id: "step-1",
    title: "先期处置",
    tasks: [
      {
        id: "task-1",
        title: "总结当前目录",
        description: "请用一句话说明当前目录是什么项目。不要修改文件。",
        mcp: [],
        skills: [],
        card_type: "text",
        data_structure: [{ field: "text", type: "string", required: true }],
        demoOutcome: "normal",
      },
      {
        id: "task-2",
        title: "打开服务监控",
        description:
          "1、调用 @get_jw@ 获取经纬度 2、调用 @get_address@ 获取地址 3、调用 @open_camera@ 打开 service-a 监控",
        mcp: [],
        skills: [],
        card_type: "media",
        data_structure: [
          {
            field: "gbids",
            type: "array",
            required: true,
            description: "监控设备 GBID 列表",
            items: { type: "string" },
          },
        ],
        demoOutcome: "normal",
      },
      {
        id: "task-3",
        title: "查询地图点位",
        description: "模拟查询目标周边点位，返回中心点和若干 marker。",
        mcp: [],
        skills: [],
        card_type: "map",
        data_structure: [
          { field: "center", type: "object", required: false },
          { field: "markers", type: "array", required: true },
        ],
        demoOutcome: "normal",
      },
    ],
  },
  {
    id: "step-2",
    title: "资源确认",
    tasks: [
      {
        id: "task-4",
        title: "拉取资源清单",
        description: "模拟拉取可用资源清单，输出表格数据。",
        mcp: [],
        skills: [],
        card_type: "table",
        data_structure: [{ field: "rows", type: "array", required: true }],
        demoOutcome: "normal",
      },
      {
        id: "task-5",
        title: "模拟失败任务",
        description: "请尝试读取一个不存在的文件 docs/definitely-missing-demo-file.txt，并报告错误。",
        mcp: [],
        skills: [],
        demoOutcome: "force_fail_after_run",
      },
    ],
  },
];
```

`demoOutcome: "force_fail_after_run"` 只用于 POC 展示失败 UI，不属于 `table_plan.steps` 的正式业务字段。失败判断后续应接真实 `stopReason`、tool error、process error 或业务 result。

## 运行管理

`RunManager` 管理一轮用户指令对应的所有父子任务。

职责：

- 创建 run。
- 初始化完整父子任务骨架。
- 管理并发。
- 派发子任务。
- 处理用户停止。
- 处理运行中新指令。
- 清理子进程。
- 生成左侧对话区系统回执。

运行对象：

```ts
interface TaskRun {
  id: string;
  userInstruction: string;
  status: RunStatus;
  stopReason?: "user_stopped" | "replaced_by_new_instruction";
  replacementInstruction?: string;
  parents: ParentTask[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
```

run 完成时的状态由子任务聚合得出：任一子任务 `fail` 则 run `fail`；全部父任务 `complete` 则 run `complete`；停止流程完成且没有失败则 run `stopped`。

## 子任务派发

`TaskDispatcher` 是确定性调度代码，不是 agent。

职责：

- 从当前 run 中取出当前 step 的所有子任务。
- 按 step 串行、step 内 task 并行的规则调度。
- 按并发限制启动同一个 step 内的子任务。
- 每个子任务创建一个 `ChildAgentProcess`。
- 订阅子进程 events。
- 将 Pi RPC events 转换成任务事件。
- 更新 `TaskStore`。
- 每次子任务状态变化后重新聚合父任务状态。
- 当前 step 内所有 task 到达终态后，若没有停止或失败阻断，再进入下一个 step。

状态流转：

```text
loading -> running -> complete
loading -> running -> fail
loading -> stopped
running -> stopped
running -> fail
```

未启动的子任务在 run 停止时直接标记 `stopped`。运行中的子任务通过统一停止策略进入 `stopped` 或 `fail`。

调度顺序：

```text
run start
  -> 初始化所有 step/task 为 loading
  -> 启动 step-1 内 tasks（并发受限）
  -> step-1 全部 complete 后启动 step-2
  -> 任一 task fail 后 run fail，后续 step 不再启动
  -> 用户停止或新指令替换时，未启动 step/task 标记 stopped
```

## ChildAgentProcess

`ChildAgentProcess` 封装一个子 Pi RPC 进程。

启动命令：

```bash
pi --mode rpc --no-session
```

发送 prompt：

```json
{"id":"task-1","type":"prompt","message":"..."}
```

prompt 由子任务 `instruction` 生成，示例：

```text
你是一个子任务执行 agent。
只完成当前子任务，不要处理父任务之外的事项。

子任务：打开服务监控
执行说明：
1、调用 @get_jw@ 获取经纬度 2、调用 @get_address@ 获取地址 3、调用 @open_camera@ 打开 service-a 监控

请在完成后用简短文字总结结果。
```

如果 task 配置了 `card_type` 和 `data_structure`，prompt 必须要求子 agent 输出结构化 JSON：

```json
{
  "content": "任务完成之后的一段总结",
  "card_data": {}
}
```

如果 task 未配置 `card_type`，prompt 只要求：

```json
{
  "content": "任务完成之后的一段总结"
}
```

后端负责解析和校验 agent 输出。前端不直接消费 agent 原始文本，也不从自然语言总结中推断卡片类型或状态。

`ChildAgentProcess` 必须：

- 以 LF 分割 stdout JSONL。
- 不使用 Node `readline` 解析 RPC 输出。
- 捕获 stderr 作为诊断信息。
- 将 RPC response 和 agent events 归一化。
- 支持发送 `steer`。
- 支持发送 `abort`。
- 支持最后兜底 kill process。

归一化事件：

- `child_started`
- `rpc_response`
- `agent_start`
- `message_update`
- `tool_execution_start`
- `tool_execution_end`
- `turn_end`
- `agent_end`
- `process_close`
- `process_error`

## 事件映射

子 Pi RPC 事件到任务状态的映射：

| 子事件 | 更新 |
|---|---|
| process spawned | 子任务 `running`，父任务重新聚合 |
| RPC prompt accepted | 追加日志 |
| `agent_start` | 子任务保持 `running` |
| `message_update` | 追加日志或 live text |
| `tool_execution_start` | 追加工具开始日志 |
| `tool_execution_end` | 追加工具结束日志 |
| `turn_end` | 后续可提取 tool result 或卡片数据 |
| `agent_end` | 候选完成状态 |
| process close code 0 | 清理进程；如果无最终状态则按 `agent_end` 判定 |
| process close non-zero | 除非 run 正在停止，否则子任务 `fail` |
| stop requested | 子任务进入停止流程 |
| stop timeout | 子任务 `stopped` 或 `fail`，取决于是否已成功 abort |

完成判定：

```text
run stopping + child exits cleanly -> stopped
demoOutcome=force_fail_after_run -> fail
agent_end stopReason=error -> fail
process close non-zero 且不是 stopping -> fail
否则 agent_end/process close clean -> complete
```

## 运行中输入新指令

Pi 单个 session 在 streaming 时支持 `steer` 和 `follow_up`：

- `steer`：当前 assistant turn 的工具调用完成后、下一次 LLM 调用前注入新消息。
- `follow_up`：agent 完全结束后再注入新消息。
- `abort`：中止当前 agent operation。

这些能力是单 session 级别。第一版 demo 会启动多个独立 Pi RPC 子进程，因此不能依赖 Pi 自动广播新指令。`RunManager` 必须维护当前 run 的子进程列表，并对每个运行中的子任务执行停止策略。

用户在运行中输入新指令：

```text
新指令提交
  -> 当前 run.status = stopping
  -> stopReason = replaced_by_new_instruction
  -> 停止派发未启动子任务，标记 stopped
  -> 对 running 子任务发送 steer：当前工具调用结束后停止，不再调用后续工具
  -> 等待短超时
  -> 未结束子任务发送 abort
  -> 再等待短超时
  -> 仍未退出则 kill process
  -> 旧 run 清理完成
  -> 使用新指令创建新 run
```

这个设计接近 Codex App Server 的 `turn/steer` / `turn/interrupt` 模型，但扩展到多个独立子 Pi RPC 进程。

## 停止按钮

对话区运行按钮在 run 启动后变为“停止”。

点击停止与“新指令替换”共用同一套停止策略：

```text
点击停止
  -> 当前 run.status = stopping
  -> stopReason = user_stopped
  -> 停止派发未启动子任务，标记 stopped
  -> 对 running 子任务发送 steer
  -> 等待短超时
  -> 未结束子任务发送 abort
  -> 再等待短超时
  -> 仍未退出则 kill process
  -> run.status = stopped
```

区别是：点击停止后不自动开始新 run；新指令替换会在旧 run 清理后自动开始新 run。

不建议点击停止时直接 kill 全部进程。直接 kill 只能作为兜底，否则容易丢失工具结束事件、错误信息和可用于 UI 的最终日志。

按钮状态：

```text
idle -> 开始
running -> 停止
stopping -> 停止中（disabled）
complete / fail / stopped -> 重新开始
```

## TaskStore

`TaskStore` 是 UI 状态唯一事实源。

保存内容：

- 当前 run。
- 父任务和子任务。
- 子任务 agent run 元数据。
- 子任务卡片。
- 事件日志。
- 左侧对话区系统回执。

建议 API：

- `getSnapshot()`
- `subscribe(listener)`
- `apply(event)`
- `reset()`

所有 UI 都从 `TaskStore` snapshot 渲染。前端不解析模型文本，不直接消费原始 RPC event。

## 实时通道

第一版使用 SSE。

原因：

- demo 主要需要后端向浏览器推送状态。
- SSE 实现简单，浏览器原生支持。
- 用户操作可以用普通 HTTP POST。

接口建议：

- `GET /`：静态页面。
- `GET /events`：SSE snapshot / event stream。
- `POST /runs/start`：开始 run。
- `POST /runs/stop`：停止当前 run。
- `POST /runs/replace`：用新指令替换当前 run。
- `POST /runs/reset`：清空并恢复初始骨架。

## 错误处理

必须处理：

- 子进程 spawn 失败：子任务 `fail`，父任务重新聚合。
- RPC prompt 被拒绝：子任务 `fail`。
- stdout 出现非法 JSONL：记录诊断日志，连续失败超过阈值后标记 `fail`。
- 子进程在 `agent_end` 前退出：如果不是 stopping，标记 `fail`。
- process close 非 0：如果不是 stopping，标记 `fail`。
- 停止超时：先 abort，再 kill，最终标记 `stopped`，并写入停止诊断。
- Browser 断开：后端 run 继续，新连接拿最新 snapshot。

## 手动验收

第一版执行顺序是后端核心先开发并自测通过，再做 UI 手动验收。UI 不做浏览器自动化测试，避免第一版 demo 被前端测试基础设施拖大；但 UI 仍必须按下面清单逐项手动验收。

- 打开本地 Web 控制台后能看到完整父子任务骨架。
- 初始状态显示“等待”。
- 点击开始后按钮变为“停止”。
- 启动 run 后会创建真实 Pi RPC 子进程。
- 并发大于 1 时，至少两个子任务并发运行。
- 子任务状态能从 `loading` 变为 `running`，再变为 `complete`、`fail` 或 `stopped`。
- 父任务状态能根据子任务状态聚合更新。
- 至少一个子任务展示失败状态。
- 至少一个子任务展示 `video` 卡片。
- 至少一个子任务展示 `map` 或 `table` 卡片。
- 失败子任务不强行渲染原业务卡片，错误信息出现在任务行和日志中。
- 运行中输入新指令会停止旧 run，并自动开始新 run。
- 点击停止会停止当前 run，但不会自动开始新 run。
- 未启动子任务在停止时标记 `stopped`。
- 运行中的子任务优先通过 `steer` 停止，超时后再 `abort` / kill。
- 每个子进程完成或停止后都会被清理。

## 自动化测试目标

自动化测试聚焦后端核心链路，不覆盖纯 HTML UI。后端状态机、停止策略、并发调度和 JSONL 解析必须先自测稳定，再进入 UI 联调。

- `TaskStore` reducer 状态转换。
- 父任务状态聚合规则。
- `RunManager` 新指令替换流程。
- 停止按钮流程。
- `TaskDispatcher` 并发限制。
- 未启动子任务 stop -> `stopped`。
- running 子任务 stop 优先 `steer`，超时后 `abort`。
- `ChildAgentProcess` JSONL parsing。
- process close 非 0 -> `fail`。
- card upsert 和状态同步。

## 实现位置

建议放在：

```text
packages/coding-agent/examples/rpc-task-console/
```

原因：这个 demo 验证的是 coding-agent RPC 集成，不是根目录临时页面，也不是现有 web-ui 产品功能。

现有静态线框 `self/docs/task-console-wireframe.html` 作为 UI 初稿参考。实现时如需保留或复用，应迁移到 example 目录下，例如：

```text
packages/coding-agent/examples/rpc-task-console/index.html
packages/coding-agent/examples/rpc-task-console/styles.css
packages/coding-agent/examples/rpc-task-console/app.js
```

第一版不引入 React、Vite 或其他前端构建链。

子进程启动支持两种方式：

- 默认：使用 PATH 中的 `pi`。
- 可配置：`PI_DEMO_PI_COMMAND` / `PI_DEMO_PI_ARGS`，方便从源码运行。

LLM 接入按 Pi 文档使用 OpenAI 兼容协议。example 目录下创建本地 `.env` 文件提供 OpenAI 兼容参数，demo 启动时读取后传递给子 Pi RPC 进程。`.env` 只用于本地运行，不提交密钥。

建议 `.env` 字段：

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=
PI_DEMO_PI_COMMAND=pi
PI_DEMO_PI_ARGS=--mode rpc --no-session
```

## 后续扩展

固定清单 demo 跑通后再扩展：

1. 接入上游 Pi agent。
2. 注册 `dispatch_tasks` tool。
3. 上游 Pi agent 根据用户宏观指令生成父子任务清单。
4. 复用同一套 `RunManager`、`TaskDispatcher`、`TaskStore`。
5. 子业务 tool 返回结构化 result 或 `details.uiCard`。
6. 增加真实媒体流、真实地图、真实业务表格。
7. 增加更丰富的停止策略，例如按业务优先级停止、保留已完成卡片、继续未受影响任务等。

## 设计 Review

### 结论

当前设计适合第一版真实 demo。它把用户想验证的核心效果拆成清晰链路：固定父子任务骨架、真实 Pi RPC 子进程、子任务独立状态更新、父任务聚合、子任务卡片渲染、运行中替换指令和停止按钮。

### 关键取舍

- 子任务内部步骤保留为自然语言 `instruction`，符合业务系统已有形态。
- 不引入结构化 `steps[]`，避免 demo 把业务字段设计得过早。
- 不做单独 `ui_card` tool，避免 UI 依赖模型是否记得调用工具。
- 停止按钮和新指令替换共用停止策略，降低状态机复杂度。
- `stopped` 与 `fail` 分离，避免把用户主动停止误报为业务失败。

### 风险

- Pi 的 `steer` 是单 session 能力。多个子进程需要 demo 自己广播停止指令。
- `steer` 的安全边界是当前 assistant turn 的工具调用结束后，不一定是单个工具调用结束后。
- 如果工具不响应 abort signal，最终仍需要 kill 兜底。
- 第一版若所有子任务都真实调用 LLM，会依赖本机 auth/model 配置。
- 失败展示如果过度依赖 demoOutcome，会验证 UI 效果但不能代表真实业务错误语义。
- 新指令替换和停止按钮会与子进程自然完成产生竞态。实现时必须用 run id 和 sub task id 校验事件归属，忽略旧 run 的迟到事件。
- process close 和 `agent_end` 顺序不稳定。实现时应只允许最终状态写入一次，避免 `complete` 被后到的 close 事件覆盖。

### 建议

- 第一版先实现固定清单和确定性 demo card data。
- 停止超时使用短时间窗口，例如 steer 等待 5 秒，abort 等待 3 秒，再 kill。
- UI 明确区分“失败”和“已停止”。
- 左侧系统消息全部由后端状态生成。
- 后续接入真实业务 tool 后，再把 `details.uiCard` 纳入卡片数据来源。
- 所有从子进程回来的事件都必须携带或补齐 `runId`、`parentId`、`subTaskId`，再进入 `TaskStore`。
