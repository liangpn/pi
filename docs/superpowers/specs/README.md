# Pi 任务控制台文档索引

## 规范文档

- `spec-pi-task-console.md`：Pi 任务控制台第一版 POC 规范文档。第一版固定 SOP runtime 以它为准。
- `spec-pi-task-console-main-agent.md`：后续 main agent、`spawn_agent`、`run_workflow` 和统一执行模型规划。

其他支撑材料位于 `references/`。参考文档和规范文档冲突时，以对应阶段的 spec 为准；第一版 POC 仍以 `spec-pi-task-console.md` 为准。

## 参考文档

- `references/pi-rpc-mechanisms.md`：Pi RPC、JSON 事件流、扩展工具、subagent 示例、最终结果解析机制复核。
- `references/police-command-workflow.json`：公安指挥 workflow 示例。
- `references/workflow-steps-schema.md`：`table_plan.steps` 数据结构说明。
- `references/task-console-ui-reference.md`：任务控制台 UI 信息架构说明。
- `references/task-console-ui-wireframe.html`：任务控制台 UI 静态线框。

## 执行追踪

进入代码开发时，使用 superpowers 相关规则追踪执行：

- 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 执行 `docs/superpowers/plans/plan-pi-task-console.md`。
- 以 plan 中的 checkbox 和阶段性 Gate 记录进度。
- 每个 Gate 都累计复核从 Task 1 到当前阶段的全部结果。
- 完成实现前使用 `superpowers:verification-before-completion` 做验证。
