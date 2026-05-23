# Pi RPC 机制参考

## 定位

本文只记录 Pi 可复用机制和对任务控制台规范的技术判断。规范性要求以 `docs/superpowers/specs/spec-rpc-task-console.md` 为准。

## RPC Mode

Pi RPC Mode 使用 stdin/stdout JSONL 协议。输入 command、输出 response 和 event 都是一行一个 JSON 对象。

任务控制台第一版使用 RPC Mode 作为 child agent 主通道，原因是 RPC Mode 同时支持：

- `prompt`：提交 task prompt。
- `steer`：运行中插入收束指令。
- `abort`：中止当前 agent run。
- 事件流：输出 `agent_*`、`turn_*`、`message_*`、`tool_execution_*`、`auto_retry_*` 等运行事件。

`prompt` success 只表示请求被 child process 接收，不表示 task 完成。Task 完成必须由后续事件和最终 assistant result 解析决定。

RPC JSONL 分帧必须复用项目已有 JSONL helper。不能用会错误切分 Unicode separator 的临时 line reader。

## JSON Event Stream Mode

JSON Event Stream Mode 通过 `pi --mode json "prompt"` 输出 session events JSONL。

该模式适合做事件 schema 参考和一次性命令调试，不作为任务控制台第一版主通道。原因是它不提供运行时 stdin command 控制，不能满足 stop、replace 和多 child session 管理要求。

## Event 生命周期

任务控制台关心的 Pi 事件包括：

- `agent_start`：agent run 开始。
- `turn_start`：一次 assistant turn 开始。
- `message_start`：一条 message 开始。
- `message_update`：模型流式增量或工具执行过程更新。
- `message_end`：一条 message 完成。
- `tool_execution_start`：工具调用开始。
- `tool_execution_update`：工具执行过程更新。
- `tool_execution_end`：工具调用结束。
- `turn_end`：一次 assistant response 及该 response 触发的 tool results 完成。
- `agent_end`：整个 prompt run 完成。
- `auto_retry_start` / `auto_retry_end`：Pi provider 层自动重试开始和结束。

结果解析规则：

- `message_update` 只用于日志和运行中诊断，不作为最终结构化结果。
- assistant `message_end` 是正常完成路径下解析 `{ content, data? }` 的输入事件。
- `turn_end` 可用于诊断 assistant response 和 tool results 的完整性。
- `agent_end` 表示 run 完成。收到 `agent_end` 时，dispatcher 必须确认 attempt 是否已经进入终态。
- `agent_end.willRetry === true` 表示 Pi provider 层会继续 retry，dispatcher 不能结算当前 attempt。

## Tool 和 Extension 机制

Pi extension API 支持 `registerTool`。Tool execution 接收 `AbortSignal`、`onUpdate` 和 extension context，并返回 `AgentToolResult`。

`onUpdate` 可以产生 `tool_execution_update`，该更新对 runtime/UI 可见。模型通常要等 tool 完整返回、tool result message 进入上下文后，才能在下一轮推理中看到工具结果。

这个边界影响第二版设计：

- Runtime/UI 可以在 task 完成时立即得到 snapshot 和任务消息。
- 主 agent 模型是否需要在 workflow 未结束时消费某个 task result，必须另行设计主 agent turn 注入或外部 runtime 协调机制。
- 第一版不依赖主 agent tool 调用，不需要解决该问题。

Pi `subagent` extension 示例提供了可参考机制：

- 通过 extension tool 委派子 agent。
- 支持并发限制。
- 使用 `onUpdate` 发布 partial details。
- 通过 `AbortSignal` 传播停止。
- 子进程停止时先 SIGTERM，超时后 SIGKILL。

这些机制是后续计划对齐的参考，不改变第一版规范文档。

## Tool Call 限制

Pi agent loop 没有独立的 `maxToolCalls` 配置。它会按模型输出继续执行工具调用，并把工具结果写回上下文。

任务控制台第一版在 dispatcher 层实现 tool call 次数限制：

- 监听 child RPC `tool_execution_start`。
- 每个 task attempt 独立计数。
- 超过上限后对 child 发送 `abort`。
- abort 超时后 kill child。
- 当前 attempt 以 `tool_limit_exceeded` 失败。

单次工具调用返回 error 不等于 task attempt 立即失败。Pi 会把 tool error 作为 tool result 放回模型上下文，模型可能继续修复。只有 attempt 命中终态失败条件时，dispatcher 才结算 attempt。

## Session 和持久化

第一版 child process 默认使用：

```bash
pi --mode rpc --no-session
```

Pi 原生 session 文件不作为第一版事实源。第一版事实源是 TaskStore、snapshot、task logs、RPC events、stderr、conversation task messages 和 runtime 本地输出目录。

如果后续启用 child Pi session，session 目录必须由配置显式指定，并且要与 run/task/attempt 建立可追踪关系。

## 机制出处

- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/docs/json.md`
- `packages/coding-agent/src/modes/rpc/jsonl.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/examples/extensions/subagent/index.ts`
