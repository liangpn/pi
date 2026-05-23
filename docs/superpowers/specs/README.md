# RPC 任务控制台文档索引

## 规范文档

- `spec-rpc-task-console.md`：任务控制台唯一规范文档。后续计划和代码实现以它为准。

`specs/` 根目录只保留一份规范文档。其他文档位于 `references/`，用于支撑规范判断。参考文档和规范文档冲突时，以 `spec-rpc-task-console.md` 为准。

## 参考文档

- `references/pi-rpc-mechanisms.md`：Pi RPC、JSON 事件流、扩展工具、subagent 示例、最终结果解析机制复核。
- `references/police-command-workflow.json`：公安指挥 workflow 示例。
- `references/workflow-steps-schema.md`：`table_plan.steps` 数据结构说明。
- `references/task-console-ui-reference.md`：任务控制台 UI 信息架构说明。
- `references/task-console-ui-wireframe.html`：任务控制台 UI 静态线框。

## 执行追踪

进入代码开发时，使用 superpowers 相关规则追踪执行：

- 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 执行 `docs/superpowers/plans/plan-rpc-task-console.md`。
- 以 plan 中的 checkbox 和阶段性 Gate 记录进度。
- 每个 Gate 都累计复核从 Task 1 到当前阶段的全部结果。
- 完成实现前使用 `superpowers:verification-before-completion` 做验证。
