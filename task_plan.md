# Task Plan: RPC Task Console Implementation Planning

## Goal
Create a concrete implementation plan for the Pi RPC task console demo, using the approved design document and read-only reconnaissance from parallel subagents.

## Current Phase
Phase 4

## Phases

### Phase 1: Requirements & Discovery
- [x] Capture user-approved constraints from the design discussion.
- [x] Use `superpowers:using-superpowers` as requested.
- [x] Use `karpathy-guidelines` for code-change discipline.
- [x] Use `planning-with-files` to persist planning state.
- [x] Dispatch parallel read-only subagents with `gpt-5.5` high reasoning.
- [x] Collect subagent findings.
- [x] Record findings in `findings.md`.
- **Status:** complete

### Phase 2: Implementation Plan
- [x] Use `superpowers:writing-plans` to produce a detailed task plan.
- [x] Save the implementation plan under `docs/superpowers/plans/`.
- [x] Include exact files, tests, commands, and verification gates.
- [x] Keep plan scoped to planning only; do not implement code.
- **Status:** complete

### Phase 3: Review & Handoff
- [x] Self-review the plan for missing requirements and placeholders.
- [x] Present the plan path and execution options to the user.
- **Status:** complete

### Phase 4: POC Implementation
- [x] Implement backend state, RPC child process wrapper, dispatcher, run manager, HTTP/SSE API, and wireframe HTML integration.
- [x] Run focused backend tests.
- [x] Run repo check.
- [x] Diagnose manual UI spawn failure.
- [x] Change demo child process command from installed `pi` binary to `tsx src/cli.ts`.
- [x] Move demo baseUrl/model/provider/API settings into `.env` and generate local Pi `models.json`.
- [x] Move custom provider details from hardcoded defaults into `llm.config.json`.
- [x] Add Pi extension that adapts configured MCP Streamable HTTP servers into `pi.registerTool()` tools.
- [ ] Fill real LLM credentials/model configuration and retest with a real provider.
- **Status:** implemented, pending real MCP endpoint manual test

## Key Questions
1. What exact Pi RPC JSONL input and output message shapes must `ChildAgentProcess` support?
2. What local package/test conventions should the implementation follow?
3. Which parts of `self/docs/task-console-wireframe.html` should be migrated into the example?
4. What file decomposition gives the smallest reliable backend-first implementation?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use pure HTML/CSS/JS for UI | User explicitly approved no React/Vite. |
| Put demo under `packages/coding-agent/examples/rpc-task-console/` | Design document says the demo validates coding-agent RPC integration. |
| Develop backend core first | User agreed backend should be self-tested before UI manual testing. |
| Use `.env` in example directory for OpenAI-compatible LLM parameters | User requested local `.env`; avoids hardcoding keys. |
| Use concurrency 2 | User approved default concurrency of 2. |
| Stop strategy is steer 5s, abort 3s, then kill | User approved design-document strategy. |
| Do not write changelog | User explicitly requested no changelog. |
| MCP server access goes through Pi extensions | Pi core documents "No MCP"; the POC will register extension tools and bridge those tool calls to configured MCP Streamable HTTP endpoints. |
| Custom provider details live in config files | `.env` should point to config files and hold secrets/runtime knobs; provider/model/baseUrl details should not be hardcoded in source. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Initial subagents used fixed role models, not user-requested `gpt-5.5 high` | 1 | Closed them and redispatched default subagents with `model=gpt-5.5`, `reasoning_effort=high`. |
| Demo spawned `pi`, but no `pi` executable was available in PATH | 1 | Updated `packages/coding-agent/examples/rpc-task-console/.env` to use `../../node_modules/.bin/tsx src/cli.ts`. |

## Current Development Task: MCP Adapter Extension

### Files
- Modify: `packages/coding-agent/examples/rpc-task-console/env.ts`
- Modify: `packages/coding-agent/examples/rpc-task-console/.env.example`
- Create: `packages/coding-agent/examples/rpc-task-console/llm.config.example.json`
- Create: `packages/coding-agent/examples/rpc-task-console/mcp.config.example.json`
- Create: `packages/coding-agent/examples/rpc-task-console/mcp-streamable-http-client.ts`
- Create: `packages/coding-agent/examples/rpc-task-console/mcp-config.ts`
- Create: `packages/coding-agent/examples/rpc-task-console/extensions/mcp-tools.ts`
- Modify: `packages/coding-agent/test/rpc-task-console.test.ts`

### Acceptance Criteria
- `.env` can point to `PI_DEMO_LLM_CONFIG`; demo generates local `.pi-agent/models.json` from that file.
- `.env` can point to `PI_DEMO_MCP_CONFIG`; child Pi starts with `--extension examples/rpc-task-console/extensions/mcp-tools.ts`.
- MCP config supports multiple servers and multiple tool mappings.
- Extension registers configured tool names exactly as referenced by `self/docs/test_steps.md`, for example `jcj-get-case-detail`, `panel-operate`, `background-check`, `getPrettyPlanInstance`, and `device-operate`.
- MCP config puts each server URL in the config file.
- MCP bridge supports Streamable HTTP JSON-RPC and calls `tools/call`.
- Focused tests and `npm run check` pass.

## Notes
- Do not commit unless the user asks.
- After future code changes, run `npm run check` from repo root and specific test files from package root as required.
