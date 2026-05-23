# RPC Task Console 执行台账

## 权威来源

- Spec：`docs/superpowers/specs/spec-rpc-task-console.md`
- Plan：`docs/superpowers/plans/plan-rpc-task-console.md`
- 参考资料：`docs/superpowers/specs/references/`

## 当前状态

- 阶段：进入代码开发前的执行追踪准备。
- 已完成：spec 文档整理、plan 文档对齐、plan 多轮全文 review。
- 待开始：按 `plan-rpc-task-console.md` 从 Task 1 开始执行代码开发。

## 执行规则

- 主会话负责需求对齐、计划控制、任务委派、复核判断和台账更新。
- 子代理负责被委派的只读调研、实现、测试或 review。
- 每个 cumulative gate 必须覆盖前序已完成内容，不只检查当前 task。
- 代码变更后必须按项目规则运行 `npm run check`；只改文档不要求运行该命令。
- 不提交 commit，除非用户明确要求。

## 下一个动作

按 plan 进入 Task 1：对齐 workflow 输入契约和公安流程参考结构。

## 记录

### 2026-05-23

- 启用项目级 harness 追踪。
- 确认 spec、plan、ledger 的权威路径。
- 根目录旧 `task_plan.md`、`findings.md`、`progress.md` 不再作为当前任务的执行依据。
