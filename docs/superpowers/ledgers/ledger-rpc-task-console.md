# RPC Task Console 执行台账

## Current Snapshot

- Spec: `docs/superpowers/specs/spec-rpc-task-console.md`
- Plan: `docs/superpowers/plans/plan-rpc-task-console.md`
- 参考资料: `docs/superpowers/specs/references/`
- 当前阶段: Task 8 已完成并通过主会话复跑验证；下一步是 Task 9 UI 拆分和 snapshot 渲染。
- 主会话职责: 只读检查、需求对齐、计划、子代理委派、复核、验证调度、ledger/plan 更新。
- 实现职责: 由 `implementation_worker` 子代理承担；主会话不得接管业务代码或测试代码实现。
- `.codex/hooks.json` Stop hook 删除: 用户已说明为有意修改，当前不恢复，也不作为 Task 风险处理。

## Task Status

- Task 1 Workflow 输入契约和公安 workflow 参考结构: 已完成，plan Step 1-7 已勾选。
- Task 2 TaskStore、attempts、conversationMessages 和终态 guard: 已完成，plan Step 1-6 已勾选。
- Gate 1: 初次复核未通过；修复 dispatcher/child 真实链路诊断和旧 `card_data` fallback 后通过。
- Task 3 Runtime 配置、本地持久化和 child session 隔离: 已完成，plan Step 1-8 已勾选。
- Task 4 Child Pi RPC 事件、prompt、最终结果解析和校验: 已完成，plan Step 1-6 已勾选。
- Gate 2: 初次复核未通过；补接真实 run 链路 snapshot/task logs/conversation messages 持久化后通过。
- Gate 2 hardening: 已完成；补 `.env.example` 变量示例和 prompt ack 不完成 task 的回归测试。
- Task 5 调度、并发、retry 和 tool call limit: 已完成，plan Step 1-6 已勾选。
- Task 6 停止、替换和旧 run 清理: 已完成，plan Step 1-5 已勾选。
- Task 7 MCP adapter 和 task scoped allowlist: 已完成，plan Step 1-5 已勾选。
- Task 8 HTTP/SSE API 对齐: 已完成，plan Step 1-3 已勾选。

## Useful Findings And Scope Corrections

- Task 2 原 plan 遗漏 `packages/coding-agent/examples/rpc-task-console/task-dispatcher.ts` producer 侧 `card_data -> data` 收口；已补入 Task 2 范围并完成。
- Gate 1 阻断点: dispatcher/child 真实链路未把诊断写入 TaskStore；TaskStore 仍兼容旧 `card_data` fallback。两项均已修复。
- Gate 2 阻断点: Task 3/4 只实现了持久化 helper 和 child RPC/stderr live path，snapshot/task logs/conversation messages 未接入真实 run 链路；已通过 `run-manager.ts` 补接。
- Task 5 实现发现 `run-manager.ts` 需要传递 `runtimeConfig` 给 dispatcher；已纳入实现范围。
- Task 6 实现发现 `task-store.ts` 需要支持 run-level stopping metadata、stale event diagnostics 和 reset/replace 状态处理；已纳入实现范围。
- Task 7 协作问题: 早期委派 prompt 让子代理误判自己是主会话。已按用户确认更新 `AGENTS.md` 和 `.codex/skills/codex-harness/SKILL.md`，后续实现子代理 prompt 只保留极简实现合同，并明确其身份是 `implementation_worker` 子代理。
- Task 8 实现发现 selected `steps` 必须成为 current run/reset snapshot 的事实源；已将 `run-manager.ts` 和 `task-store.ts` 补入 Task 8 范围。

## Latest Verification

- Task 5 主会话复跑 `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 63 tests passed。
- Task 5 主会话复跑 `npm run check`: 通过。
- Task 6 主会话复跑 `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 65 tests passed。
- Task 6 主会话复跑 `npm run check`: 通过。
- Task 7 主会话复跑 `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 70 tests passed。
- Task 7 主会话复跑 `npm run check`: 通过。
- Task 8 子代理报告 `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 73 tests passed。
- Task 8 子代理报告 `npm run check`: 首次因测试辅助类型中 `TextDecoder` 被当作类型使用失败；修复后通过。
- Task 8 主会话复跑 `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`: 73 tests passed。
- Task 8 主会话复跑 `npm run check`: 通过；`biome check --write --error-on-warnings .` 检查 606 个文件且 no fixes applied，`tsgo --noEmit` 通过，`npm run check:browser-smoke` 通过。

## Residual Risks / Open Questions

- Task 6 残留风险: 未额外覆盖 `reset()` 与 replace/stop 同时发生的竞态；`RunManager.start()` 在 replace 场景会先返回 pending new run 元数据，但 snapshot 会停留在旧 run `stopping`，直到 cleanup 完成后才切到新 run，现有用例按该语义验证。
- Task 7 残留风险: 当前验证以单元测试为主，覆盖 child 参数拼装、task-scoped MCP 过滤和 MCP 错误语义；尚未做真实 child Pi 进程 + 实际 extension 装载 + 真实 MCP server 的端到端集成验证。
- Task 8 残留风险: `GET /`、`/styles.css`、`/app.js` 依赖服务端对现有 `index.html` 的内联 `<style>` / `<script>` 正则拆分和脚本改写；后续 UI 拆分时应改成真实静态文件，避免结构变更导致转换失效。
- Task 8 残留风险: UI 的 selected `steps` 来源是最新 snapshot 的 current steps，满足本任务 route 事实源要求，但还不是独立前端选择模型。
- Task 8 残留风险: `/runs/reset` 已覆盖带 `steps` body 的路径；空 body reset 行为尚未单独测试。若 Task 9 UI 增加 reset 控件，应明确是否发送当前 selected steps。
- Gate 4 尚未执行；需等 Task 9 完成后累计复核 Task 8 + Task 9 的 HTTP/SSE API、前端 snapshot 渲染和 UI 行为。
