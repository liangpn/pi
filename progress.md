# Progress Log

## Session: 2026-05-20

### Phase 1: Requirements & Discovery
- **Status:** complete
- **Started:** 2026-05-20
- Actions taken:
  - Read the approved design document.
  - Discussed and confirmed implementation constraints with the user.
  - Updated the design document with backend-first test strategy, pure HTML organization, and `.env` OpenAI-compatible configuration.
  - Used requested skills: `superpowers:using-superpowers`, `planning-with-files`, `superpowers:writing-plans`, `superpowers:dispatching-parallel-agents`, and `karpathy-guidelines`.
  - Initially dispatched three read-only role subagents, then closed them because their fixed model settings did not match the user's `gpt-5.5 high` requirement.
  - Redispatched three read-only default subagents with `model=gpt-5.5` and `reasoning_effort=high`.
  - Collected all three subagent findings and merged them into `findings.md`.
- Files created/modified:
  - `self/docs/2026-05-19-pi-rpc-task-console-design.md` (modified earlier in this discussion)
  - `task_plan.md` (created)
  - `findings.md` (created)
  - `progress.md` (created)

### Phase 2: Implementation Plan
- **Status:** complete
- Actions taken:
  - Started drafting the formal implementation plan under `docs/superpowers/plans/`.
  - Saved the plan at `docs/superpowers/plans/2026-05-20-rpc-task-console.md`.
  - Self-reviewed the plan for placeholder wording, forbidden commands, and missing confirmed constraints.
- Files created/modified:
  - `findings.md` (updated with subagent findings)
  - `task_plan.md` (updated phase status)
  - `docs/superpowers/plans/2026-05-20-rpc-task-console.md` (created)

### Phase 3: Review & Handoff
- **Status:** in_progress
- Actions taken:
  - Preparing user-facing summary and execution options.
  - User completed `npm install`; local `node_modules`, `vitest`, and `tsx` are now available.
  - Updated the implementation plan to the approved `steps/tasks/card_type/data_structure/media` model.
  - Added review gates after model, state, RPC, dispatch, API, UI, and final verification stages.
  - Implemented the backend-first RPC task console POC through HTTP/SSE and connected the existing wireframe HTML to the runtime snapshot.
  - Manual UI test showed task dispatch starts but child process spawn failed because `PI_DEMO_PI_COMMAND=pi` was not resolvable in the local shell.
  - Updated the demo `.env` and `.env.example` to launch Pi from source through `../../node_modules/.bin/tsx src/cli.ts` instead of relying on an installed `pi` binary or built `dist`.
  - Centralized demo LLM settings in `.env`: base URL, provider name, API type, model list, selected model, and compatibility flags now drive a generated local `models.json`.
  - Added current MCP adapter extension task to `task_plan.md`: provider details move to config files, and MCP server access is implemented as Pi extension tools because Pi core does not support direct MCP server configuration.
  - Corrected MCP adapter direction from stdio to Streamable HTTP; MCP endpoint URLs belong in `mcp.config.json`.
  - Implemented config-file provider loading via `llm.config.json`.
  - Implemented MCP Streamable HTTP config parsing, client calls, and a Pi extension that registers configured MCP tools.
  - Moved the local demo LLM provider/baseUrl/model details out of `.env` into `llm.config.json`; `.env` now points to config files.
- Files created/modified:
  - `progress.md` (updated phase status)
  - `docs/superpowers/plans/2026-05-20-rpc-task-console.md` (rewritten for updated model and review gates)
  - `packages/coding-agent/examples/rpc-task-console/.env` (local demo runtime config)
  - `packages/coding-agent/examples/rpc-task-console/.env.example` (documented demo runtime config)

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| `npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` | RPC task console focused tests | TaskStore, RPC child wrapper, dispatcher, run manager, HTTP/SSE pass | 18 tests passed | pass |
| `npm run check` | Repo check | Biome, TypeScript, browser smoke pass | Passed | pass |
| HTTP smoke | `GET /`, `GET /api/snapshot` on local example server | HTML and idle snapshot served | 200 and idle JSON snapshot | pass |
| Spawn smoke | `POST /api/run` after `.env` command change | Child Pi RPC processes start from source | Three child pids observed, no `spawn pi ENOENT`; smoke run stopped | pass |
| `npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` | After `.env` model config generation | Focused tests pass | 20 tests passed | pass |
| `npm run check` | After `.env` model config generation | Repo check passes | Passed | pass |
| `npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts` | After Streamable HTTP MCP adapter | Focused tests pass | 25 tests passed | pass |
| `npm run check` | After Streamable HTTP MCP adapter | Repo check passes | Passed | pass |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-05-20 | Subagents initially dispatched with role-fixed model settings | 1 | Closed role subagents and redispatched default subagents using `gpt-5.5 high`. |
| 2026-05-20 | `npx tsx ...` failed before tests with EROFS writing `/home/liangpn/.npm/_cacache` | 1 | Re-run with `NPM_CONFIG_CACHE=/tmp/npm-cache` so npm uses a writable cache. |
| 2026-05-20 | Test command failed before tests because `node_modules/vitest/dist/cli.js` does not exist | 2 | Install dependencies from existing lockfile with writable npm cache, then re-run the exact test file. |
| 2026-05-21 | Demo run failed with `spawn pi ENOENT` | 1 | Changed demo child process command away from `pi`; direct `pi-test.sh` then failed on unbuilt workspace `dist`, so final config uses `../../node_modules/.bin/tsx src/cli.ts`. |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Ready to resume implementation from Task 0 of the updated plan. |
| Where am I going? | Realign partial code to the updated steps/tasks model, then continue TDD implementation. |
| What's the goal? | Produce a concrete backend-first implementation plan for the Pi RPC task console demo. |
| What have I learned? | See `findings.md`. |
| What have I done? | See Phase 1 actions above. |
