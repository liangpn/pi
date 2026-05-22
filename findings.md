# Findings & Decisions

## Requirements
- Build a Pi RPC task console demo under `packages/coding-agent/examples/rpc-task-console/`.
- First version uses a fixed parent/subtask list from `self/docs/2026-05-19-pi-rpc-task-console-design.md`.
- Parent tasks are grouping and aggregation only; child tasks each run an independent Pi RPC subprocess.
- UI must show the full task skeleton on initial load.
- Backend pushes state to the browser via SSE; user actions use HTTP POST.
- UI is pure HTML/CSS/JS, no React, Vite, or frontend build chain.
- Existing `self/docs/task-console-wireframe.html` is the UI reference and may be migrated/split.
- OpenAI-compatible LLM configuration comes from a local `.env` in the example directory.
- Backend core must be implemented and self-tested before UI manual testing.
- Automated tests focus on backend state, parsing, dispatching, and stop/replace behavior; pure HTML UI is manually verified.
- No changelog entry for this demo.

## Research Findings
- The design document was updated to include backend-first testing, pure HTML constraints, `.env` OpenAI-compatible configuration, and UI migration guidance.
- Parallel read-only subagents are currently investigating RPC protocol, package/test conventions, and wireframe reuse.
- UI wireframe findings: reuse visual tokens, dark console styling, focus rings, pane/card primitives, status colors, scroll containers, message/composer UI, parent/subtask row styling, selected state, control rail, and card renderer ideas.
- UI implementation must restructure the wireframe around the design doc's three-zone layout: conversation/control, task index, and selected subtask detail. The existing wireframe is closer to a two-column global card board plus right-side task flow.
- UI plan must add missing pieces from the design doc: search/filter, per-task instruction summaries, agent run metadata, per-task event logs, failure detail behavior, and exact run button state model.
- Package/example convention findings: add `example:rpc-task-console` to `packages/coding-agent/package.json` with `npx tsx examples/rpc-task-console/server.ts`; run from `packages/coding-agent`.
- Backend tests should live in `packages/coding-agent/test/rpc-task-console.test.ts` and run with `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/rpc-task-console.test.ts`.
- After code changes, run `npm run check` from repo root. Do not run `npm test` or `npm run build`.
- TypeScript constraints: ESM, strict, `erasableSyntaxOnly`; avoid enum, namespace, constructor parameter properties, `import =`, `export =`, inline/dynamic imports, and `any` except where unavoidable.
- RPC input JSONL commands are one JSON object per LF: `{"id":"...","type":"prompt","message":"..."}`, `{"id":"...","type":"steer","message":"..."}`, and `{"id":"...","type":"abort"}`. Prompt may include `streamingBehavior: "steer" | "followUp"` when used during streaming.
- RPC stdout is mixed JSONL: response lines (`type:"response"`) and agent/session events (`agent_start`, `message_update`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `message_end`, `agent_end`, `queue_update`).
- Existing strict JSONL helpers are in `packages/coding-agent/src/modes/rpc/jsonl.ts`: `serializeJsonLine` and `attachJsonlLineReader`. Child process parsing should reuse these instead of Node `readline`.
- `prompt` success means request accepted, not task complete. Task final state must come from `message_end`/`agent_end` plus process close, with care for `agent_end.willRetry`.
- `message_end` assistant `stopReason: "error"` or `"aborted"` carries failure/stop details. Tool events are useful for logs; `message_update.assistantMessageEvent.type === "text_delta"` is useful for live text.
- Child process risks: collect stderr for startup/auth/model failures, ignore unknown RPC/extension events, correlate responses by id, treat late events with run/subtask ownership checks, and keep process kill separate from RPC abort.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Use file-based planning for this task | Work spans multiple subsystems and will exceed a few tool calls. |
| Dispatch three read-only subagents | RPC protocol, package/test conventions, and UI wireframe analysis are independent. |
| Use default subagents with `gpt-5.5 high` | User explicitly requested this model/reasoning for subagents. |
| Plan first, no code changes | User asked to align task order and planning before implementation. |
| Use one backend test file for first implementation | Keeps the demo test surface focused while covering store, parser, dispatcher, and run manager. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| First subagent dispatch used role agents with fixed model settings | Shut them down and redispatched with explicit `gpt-5.5` and `high`. |

## Resources
- `self/docs/2026-05-19-pi-rpc-task-console-design.md`
- `self/docs/task-console-wireframe.html`
- `packages/coding-agent/src/modes/rpc/`
- `packages/coding-agent/test/rpc*.test.ts`
- `packages/coding-agent/examples/rpc-extension-ui.ts`
- `packages/coding-agent/package.json`
- `packages/coding-agent/test/rpc-task-console.test.ts` (planned)
- `packages/coding-agent/src/modes/rpc/jsonl.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`

## Visual/Browser Findings
- Wireframe was inspected by a read-only subagent. It can provide styling and component patterns, but its information architecture differs from the approved design document and must not be copied directly.
