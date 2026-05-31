# Pi 任务控制台 Ledger

## 当前事实

- Spec: `docs/superpowers/specs/spec-pi-task-console.md`
- Plan: `docs/superpowers/plans/plan-pi-task-console.md`
- Package: `packages/pi-task-console`
- Package name: `@ning/pi-task-console`
- 主会话职责: control-plane 复核、计划和 ledger 更新、子代理委派、验证调度；不得接管业务代码实现。

## Runtime / MCP

- 当前实现基于独立 package，而不是直接扩展 Pi core 源码目录。
- Runtime 使用 subprocess RPC 链路驱动 child Pi agents。
- MCP 接入使用 `pi-mcp-adapter@2.8.0`，配置入口为标准 `.mcp.json` / `mcpServers`。
- 当前 MCP server URL: `http://210.21.53.138:30080/pacc-mcp-server/mcp?toolset=shijiazhuang&clientid=zyhxx`。
- 默认 proxy `mcp` 工具禁用，task `tools` allowlist 仍由 Pi CLI / AgentSession 主防线和 adapter/package 第二道限制共同约束。

## UI / Workflow

- 第一版固定 workflow POC 已通过用户浏览器复验：状态更新、卡片生成、reset 空态和持久化链路可用。
- 业务侧 caveat: `device-operate` / `panel-operate` 可能返回“调用出错: 前端离线”，但当前 tool result `isError=false`，不影响 runtime 完成语义。

## 验证事实

- `npm run check` 最近一次通过，包含 Biome、`tsgo --noEmit` 和 `check:browser-smoke`。
- 用户重新启动服务后确认当前 package 服务验证正常。
- `packages/pi-task-console/test/pi-task-console.test.ts` 最近一次通过，102 tests passed。
- 全仓旧命名残留检索无结果。
