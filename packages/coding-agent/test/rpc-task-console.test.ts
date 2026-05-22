import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChildAgentProcess, normalizeChildLine } from "../examples/rpc-task-console/child-agent-process.js";
import { loadDemoEnv } from "../examples/rpc-task-console/env.js";
import { loadMcpConfig } from "../examples/rpc-task-console/mcp-config.js";
import { McpStreamableHttpClient } from "../examples/rpc-task-console/mcp-streamable-http-client.js";
import { RunManager } from "../examples/rpc-task-console/run-manager.js";
import { createRpcTaskConsoleServer } from "../examples/rpc-task-console/server.js";
import { TaskDispatcher } from "../examples/rpc-task-console/task-dispatcher.js";
import { aggregateStepStatus, TaskStore } from "../examples/rpc-task-console/task-store.js";
import { createInitialSteps, createRuntimeSteps } from "../examples/rpc-task-console/tasks.js";
import type {
	ChildAgentProcessFactoryOptions,
	ChildAgentProcessLike,
	NormalizedChildEvent,
	PlanStep,
	TaskRun,
	TaskSnapshot,
} from "../examples/rpc-task-console/types.js";

describe("rpc task console model", () => {
	test("defines a full steps/tasks plan skeleton", () => {
		const steps = createInitialSteps();

		expect(steps).toHaveLength(2);
		expect(steps.flatMap((step) => step.tasks)).toHaveLength(5);
		expect(steps[0]?.id).toBe("step-1");
		expect(steps[0]?.tasks[1]?.card_type).toBe("media");
		expect(steps[0]?.tasks[1]?.data_structure?.[0]?.field).toBe("gbids");
		expect(steps[1]?.tasks[1]?.card_type).toBeUndefined();
	});

	test("clones plan steps into runtime steps without mutating the plan", () => {
		const planSteps = createInitialSteps();
		const runtimeSteps = createRuntimeSteps(planSteps);

		expect(runtimeSteps[0]?.status).toBe("loading");
		expect(runtimeSteps[0]?.tasks[0]?.status).toBe("loading");
		expect(runtimeSteps[0]?.tasks[0]?.stepId).toBe("step-1");
		expect(planSteps[0]?.tasks[0]).not.toHaveProperty("status");
	});
});

describe("rpc task console env", () => {
	test("loads custom provider details from llm.config.json and injects MCP extension when configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeFileSync(
				join(dir, ".env"),
				[
					"OPENAI_API_KEY=test-key",
					"PI_DEMO_LLM_CONFIG=llm.config.json",
					"PI_DEMO_MCP_CONFIG=mcp.config.json",
					"PI_DEMO_PI_COMMAND=tsx",
					"PI_DEMO_PORT=4555",
				].join("\n"),
			);
			writeFileSync(
				join(dir, "llm.config.json"),
				JSON.stringify(
					{
						provider: "rpc-demo",
						baseUrl: "https://llm.example.test/v1",
						api: "openai-completions",
						apiKeyEnv: "OPENAI_API_KEY",
						models: ["model-a", "model-b"],
						selectedModel: "model-b",
						compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					},
					null,
					2,
				),
			);
			writeFileSync(
				join(dir, "mcp.config.json"),
				JSON.stringify(
					{
						servers: {
							caseTools: {
								transport: "streamable-http",
								url: "http://127.0.0.1:9001/mcp",
							},
						},
						tools: [
							{
								name: "jcj-get-case-detail",
								server: "caseTools",
								mcpTool: "jcj-get-case-detail",
								description: "Get case detail",
							},
						],
					},
					null,
					2,
				),
			);

			const demoEnv = loadDemoEnv(dir, {});
			const modelsJsonPath = demoEnv.modelsJsonPath;
			if (!modelsJsonPath) {
				throw new Error("Expected models.json path");
			}
			const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as {
				readonly providers: {
					readonly "rpc-demo": { readonly baseUrl: string; readonly models: readonly { readonly id: string }[] };
				};
			};

			expect(demoEnv.port).toBe(4555);
			expect(demoEnv.piArgs).toEqual([
				"src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--provider",
				"rpc-demo",
				"--model",
				"model-b",
				"--extension",
				join(dir, "extensions", "mcp-tools.ts"),
			]);
			expect(demoEnv.childEnv.PI_DEMO_MCP_CONFIG_PATH).toBe(join(dir, "mcp.config.json"));
			expect(modelsJson.providers["rpc-demo"].baseUrl).toBe("https://llm.example.test/v1");
			expect(modelsJson.providers["rpc-demo"].models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("generates local models.json from OpenAI-compatible .env fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeFileSync(
				join(dir, ".env"),
				[
					"OPENAI_API_KEY=test-key",
					"PI_DEMO_LLM_PROVIDER=rpc-demo",
					"PI_DEMO_LLM_BASE_URL=https://llm.example.test/v1",
					"PI_DEMO_LLM_MODELS=model-a, model-b",
					"PI_DEMO_LLM_MODEL=model-b",
					"PI_DEMO_PI_COMMAND=tsx",
					"PI_DEMO_PORT=4555",
				].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, {});
			const modelsJsonPath = demoEnv.modelsJsonPath;
			if (!modelsJsonPath) {
				throw new Error("Expected models.json path");
			}
			const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as {
				readonly providers: {
					readonly "rpc-demo": {
						readonly baseUrl: string;
						readonly api: string;
						readonly apiKey: string;
						readonly models: readonly { readonly id: string }[];
					};
				};
			};

			expect(demoEnv.port).toBe(4555);
			expect(demoEnv.piCommand).toBe("tsx");
			expect(demoEnv.piArgs).toEqual([
				"src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--provider",
				"rpc-demo",
				"--model",
				"model-b",
			]);
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(dir, ".pi-agent"));
			expect(modelsJson.providers["rpc-demo"].baseUrl).toBe("https://llm.example.test/v1");
			expect(modelsJson.providers["rpc-demo"].api).toBe("openai-completions");
			expect(modelsJson.providers["rpc-demo"].apiKey).toBe("OPENAI_API_KEY");
			expect(modelsJson.providers["rpc-demo"].models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults to built-in OpenAI model when custom baseUrl is not configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=test-key\nPI_DEMO_LLM_PROVIDER=rpc-demo\n");

			const demoEnv = loadDemoEnv(dir, {});

			expect(demoEnv.modelsJsonPath).toBeUndefined();
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(demoEnv.piCommand).toBe("../../node_modules/.bin/tsx");
			expect(demoEnv.piArgs).toEqual([
				"src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--provider",
				"openai",
				"--model",
				"gpt-5.4",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("uses selected model as the custom model list when only PI_DEMO_LLM_MODEL is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeFileSync(
				join(dir, ".env"),
				[
					"OPENAI_API_KEY=test-key",
					"PI_DEMO_LLM_PROVIDER=rpc-demo",
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=qwen-local",
				].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, {});
			const modelsJsonPath = demoEnv.modelsJsonPath;
			if (!modelsJsonPath) {
				throw new Error("Expected models.json path");
			}
			const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as {
				readonly providers: { readonly "rpc-demo": { readonly models: readonly { readonly id: string }[] } };
			};

			expect(demoEnv.piArgs).toEqual([
				"src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--provider",
				"rpc-demo",
				"--model",
				"qwen-local",
			]);
			expect(modelsJson.providers["rpc-demo"].models.map((model) => model.id)).toEqual(["qwen-local"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console MCP config", () => {
	test("loads Streamable HTTP server URL and tool mappings from config", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			const configPath = join(dir, "mcp.config.json");
			writeFileSync(
				configPath,
				JSON.stringify(
					{
						servers: {
							caseTools: {
								transport: "streamable-http",
								url: "http://127.0.0.1:9001/mcp",
								headers: { Authorization: "Bearer " + "$" + "{MCP_TOKEN}" },
							},
						},
						tools: [
							{
								name: "panel-operate",
								server: "caseTools",
								mcpTool: "panel-operate",
								description: "Operate panel",
								parameters: { type: "object", properties: { action: { type: "string" } } },
							},
						],
					},
					null,
					2,
				),
			);

			const config = loadMcpConfig(configPath, { MCP_TOKEN: "secret-token" });

			expect(config.servers.caseTools?.url).toBe("http://127.0.0.1:9001/mcp");
			expect(config.servers.caseTools?.headers.Authorization).toBe("Bearer secret-token");
			expect(config.tools[0]?.name).toBe("panel-operate");
			expect(config.tools[0]?.mcpTool).toBe("panel-operate");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console MCP Streamable HTTP client", () => {
	test("initializes and calls tools over Streamable HTTP", async () => {
		const received: Array<{ readonly method: string; readonly sessionId?: string; readonly accept?: string }> = [];
		const server = createServer((request, response) => {
			void handleFakeMcpRequest(request, response, received, false);
		});
		const baseUrl = await listen(server);
		try {
			const client = new McpStreamableHttpClient({
				server: {
					transport: "streamable-http",
					url: `${baseUrl}/mcp`,
					headers: {},
				},
			});

			const result = await client.callTool("echo", { text: "hello" }, undefined);

			expect(result.content[0]).toEqual({ type: "text", text: "called echo" });
			expect(received).toEqual([
				{ method: "initialize", sessionId: undefined, accept: "application/json, text/event-stream" },
				{
					method: "notifications/initialized",
					sessionId: "session-1",
					accept: "application/json, text/event-stream",
				},
				{ method: "tools/call", sessionId: "session-1", accept: "application/json, text/event-stream" },
			]);
		} finally {
			await closeServer(server);
		}
	});

	test("reads a tools/call result from a Streamable HTTP SSE response", async () => {
		const received: Array<{ readonly method: string; readonly sessionId?: string; readonly accept?: string }> = [];
		const server = createServer((request, response) => {
			void handleFakeMcpRequest(request, response, received, true);
		});
		const baseUrl = await listen(server);
		try {
			const client = new McpStreamableHttpClient({
				server: {
					transport: "streamable-http",
					url: `${baseUrl}/mcp`,
					headers: {},
				},
			});

			const result = await client.callTool("echo", { text: "hello" }, undefined);

			expect(result.content[0]).toEqual({ type: "text", text: "called echo" });
			expect(received.map((item) => item.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
		} finally {
			await closeServer(server);
		}
	});
});

describe("rpc task console TaskStore", () => {
	test("initializes a full steps/tasks runtime skeleton", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const snapshot = store.getSnapshot();

		expect(snapshot.run.status).toBe("idle");
		expect(snapshot.run.steps).toHaveLength(2);
		expect(snapshot.run.steps.flatMap((step) => step.tasks)).toHaveLength(5);
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("loading");
	});

	test("aggregates step status from task statuses", () => {
		expect(aggregateStepStatus(["loading", "loading"])).toBe("loading");
		expect(aggregateStepStatus(["running", "loading"])).toBe("running");
		expect(aggregateStepStatus(["complete", "loading"])).toBe("running");
		expect(aggregateStepStatus(["complete", "complete"])).toBe("complete");
		expect(aggregateStepStatus(["stopped", "stopped"])).toBe("stopped");
		expect(aggregateStepStatus(["stopped", "loading"])).toBe("stopped");
		expect(aggregateStepStatus(["fail", "complete"])).toBe("fail");
	});

	test("updates task status, logs, cards, and system receipts", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const run = store.startRun("run-1", "demo instruction", 100);

		store.apply({ type: "task_started", runId: run.id, stepId: "step-1", taskId: "task-1", time: 101 });
		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-1",
			taskId: "task-1",
			result: {
				status: "complete",
				content: "done",
				card_data: { text: "done" },
			},
			time: 102,
		});

		const task = store.getSnapshot().run.steps[0]?.tasks[0];
		expect(task?.status).toBe("complete");
		expect(task?.result?.status).toBe("complete");
		expect(store.getSnapshot().cards.some((card) => card.taskId === "task-1" && card.type === "text")).toBe(true);
		expect(store.getSnapshot().receipts.length).toBeGreaterThan(0);
	});

	test("keeps a completed task card when later logs arrive", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const run = store.startRun("run-1", "demo instruction", 100);

		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-1",
			taskId: "task-2",
			result: {
				status: "complete",
				content: "opened",
				card_data: { gbids: ["gbid-1", "gbid-2"] },
			},
			time: 101,
		});
		store.apply({
			type: "task_log",
			runId: run.id,
			stepId: "step-1",
			taskId: "task-2",
			logType: "message_update",
			message: "late log",
			time: 102,
		});

		const card = store.getSnapshot().cards.find((candidate) => candidate.taskId === "task-2");
		expect(card?.type).toBe("media");
		expect(card?.title).toBe("打开服务监控");
		expect(card?.data).toEqual({ gbids: ["gbid-1", "gbid-2"] });
	});

	test("does not create business cards for tasks without card_type", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const run = store.startRun("run-1", "demo instruction", 100);

		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-2",
			taskId: "task-5",
			result: {
				status: "complete",
				content: "done",
				card_data: { text: "done" },
			},
			time: 101,
		});

		expect(store.getSnapshot().cards.some((card) => card.taskId === "task-5")).toBe(false);
	});

	test("does not change run finishedAt after a terminal run receives a late log", () => {
		const store = TaskStore.createIdle([
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "done", mcp: [], skills: [] }],
			},
		]);
		const run = store.startRun("run-1", "demo instruction", 100);

		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			result: { status: "complete", content: "done" },
			time: 101,
		});
		store.apply({
			type: "task_log",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			logType: "message_update",
			message: "late log",
			time: 200,
		});

		expect(store.getSnapshot().run.status).toBe("complete");
		expect(store.getSnapshot().run.finishedAt).toBe(101);
	});

	test("ignores stale events from an old run", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		store.startRun("run-1", "old", 100);
		store.startRun("run-2", "new", 200);

		store.apply({ type: "task_started", runId: "run-1", stepId: "step-1", taskId: "task-1", time: 201 });

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("loading");
	});
});

describe("rpc task console ChildAgentProcess", () => {
	test("normalizes RPC responses, agent events, and malformed child lines", () => {
		expect(
			normalizeChildLine(JSON.stringify({ type: "response", id: "req-1", command: "prompt", success: true })),
		).toEqual({
			type: "rpc_response",
			id: "req-1",
			command: "prompt",
			success: true,
			error: undefined,
		});
		expect(
			normalizeChildLine(
				JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "ok" }),
			),
		).toEqual({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: "ok",
			isError: false,
		});
		expect(normalizeChildLine("{not-json").type).toBe("diagnostic");
	});

	test("starts a child process and sends prompt, steer, and abort JSONL commands", async () => {
		const events: NormalizedChildEvent[] = [];
		const child = new ChildAgentProcess({
			runId: "run-1",
			stepId: "step-1",
			taskId: "task-1",
			command: process.execPath,
			args: ["-e", createEchoRpcScript()],
			env: process.env,
			onEvent: (event) => {
				events.push(event);
			},
		});

		child.start();
		const promptId = child.sendPrompt("hello");
		const steerId = child.sendSteer("adjust");
		const abortId = child.sendAbort();

		await waitUntil(() =>
			[promptId, steerId, abortId].every((id) =>
				events.some((event) => event.type === "rpc_response" && event.id === id),
			),
		);
		child.kill("SIGTERM");
		await waitUntil(() => events.some((event) => event.type === "process_close"));

		expect(events.some((event) => event.type === "child_started" && typeof event.processId === "number")).toBe(true);
		expect(events.some((event) => event.type === "agent_start")).toBe(true);
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		expect(
			events.some((event) => event.type === "process_close" && event.stderrTail?.includes("echo child ready")),
		).toBe(true);
	});
});

function createEchoRpcScript(): string {
	return [
		"process.stdin.setEncoding('utf8');",
		"let buffer = '';",
		"process.stderr.write('echo child ready\\n');",
		"process.stdin.on('data', (chunk) => {",
		"buffer += chunk;",
		"const lines = buffer.split('\\n');",
		"buffer = lines.pop() ?? '';",
		"for (const line of lines) {",
		"if (!line) continue;",
		"const command = JSON.parse(line);",
		"process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true }) + '\\n');",
		"if (command.type === 'prompt') {",
		"process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');",
		"process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [], willRetry: false }) + '\\n');",
		"}",
		"}",
		"});",
	].join("");
}

function waitUntil(predicate: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - startedAt > 2_000) {
				clearInterval(timer);
				reject(new Error("Timed out waiting for condition"));
			}
		}, 10);
	});
}

describe("rpc task console TaskDispatcher", () => {
	test("runs steps serially and tasks inside each step concurrently", async () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const run = store.startRun("run-1", "demo", 100);
		const startedTaskIds: string[] = [];
		const factory = createImmediateAgentFactory(startedTaskIds);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: createInitialSteps(),
			store,
			childFactory: factory,
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(startedTaskIds.slice(0, 3).sort()).toEqual(["task-1", "task-2", "task-3"]);
		expect(startedTaskIds.slice(3)).toEqual(["task-4", "task-5"]);
		expect(store.getSnapshot().run.steps[0]?.status).toBe("complete");
		expect(store.getSnapshot().run.steps[1]?.status).toBe("fail");
		expect(store.getSnapshot().run.status).toBe("fail");
		expect(store.getSnapshot().cards.find((card) => card.taskId === "task-2")?.data).toEqual({
			gbids: ["gbid-service-a-001"],
		});
		expect(store.getSnapshot().run.steps[1]?.tasks[1]?.error?.status).toBe("fail");
	});

	test("stops active child agents and marks running tasks stopped", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [
					{ id: "task-a", title: "任务 A", description: "pending", mcp: [], skills: [] },
					{ id: "task-b", title: "任务 B", description: "pending", mcp: [], skills: [] },
				],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, []);
				children.push(child);
				return child;
			},
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		const running = dispatcher.run();
		await waitUntil(() => children.length === 2);
		dispatcher.stop("user_stopped");
		await running;

		expect(children.every((child) => child.abortCount === 1 && child.killSignals.includes("SIGTERM"))).toBe(true);
		expect(store.getSnapshot().run.status).toBe("stopped");
		expect(store.getSnapshot().run.steps[0]?.tasks.map((task) => task.status)).toEqual(["stopped", "stopped"]);
	});
});

function createImmediateAgentFactory(startedTaskIds: string[]) {
	return (options: ChildAgentProcessFactoryOptions): ChildAgentProcessLike => {
		return new FakeChildAgentProcess(options, startedTaskIds, () => {
			queueMicrotask(() => {
				options.onEvent({ type: "agent_end", messages: [], willRetry: false });
			});
		});
	};
}

class FakeChildAgentProcess implements ChildAgentProcessLike {
	readonly agentRunId: string;
	readonly processId = 1234;
	readonly killSignals: NodeJS.Signals[] = [];
	abortCount = 0;
	private readonly options: ChildAgentProcessFactoryOptions;
	private readonly startedTaskIds: string[];
	private readonly afterPrompt: (() => void) | undefined;

	constructor(options: ChildAgentProcessFactoryOptions, startedTaskIds: string[], afterPrompt?: () => void) {
		this.options = options;
		this.startedTaskIds = startedTaskIds;
		this.afterPrompt = afterPrompt;
		this.agentRunId = `fake-${options.taskId}`;
	}

	start(): void {
		this.options.onEvent({ type: "child_started", processId: this.processId });
	}

	sendPrompt(_message: string): string {
		this.startedTaskIds.push(this.options.taskId);
		this.afterPrompt?.();
		return `prompt-${this.options.taskId}`;
	}

	sendSteer(_message: string): string {
		return `steer-${this.options.taskId}`;
	}

	sendAbort(): string {
		this.abortCount += 1;
		return `abort-${this.options.taskId}`;
	}

	kill(signal: NodeJS.Signals): void {
		this.killSignals.push(signal);
	}

	emit(event: NormalizedChildEvent): void {
		this.options.onEvent(event);
	}
}

function createClock(startAt: number): () => number {
	let next = startAt;
	return () => next++;
}

describe("rpc task console RunManager", () => {
	test("starts a run and exposes the final snapshot", async () => {
		const manager = new RunManager({
			demoEnv: createDemoEnv(),
			childFactory: createImmediateAgentFactory([]),
			now: createClock(100),
		});

		const run = manager.start("demo");
		await manager.waitForIdle();

		expect(run.id).toBe("run-100-1");
		expect(manager.getSnapshot().run.id).toBe(run.id);
		expect(manager.getSnapshot().run.status).toBe("fail");
		expect(manager.getSnapshot().cards.length).toBe(4);
	});

	test("replaces a running instruction without letting stale events mutate the new run", async () => {
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			demoEnv: createDemoEnv(),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, []);
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		const oldRun = manager.start("old instruction");
		await waitUntil(() => children.length === 3);
		const newRun = manager.start("new instruction");
		children[0]?.emit({ type: "agent_end", messages: [], willRetry: false });

		expect(newRun.id).not.toBe(oldRun.id);
		expect(manager.getSnapshot().run.id).toBe(newRun.id);
		expect(manager.getSnapshot().run.userInstruction).toBe("new instruction");
		expect(manager.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("running");
		expect(manager.getSnapshot().cards.some((card) => card.taskId === "task-1")).toBe(false);
	});

	test("resets to idle state", async () => {
		const manager = new RunManager({
			demoEnv: createDemoEnv(),
			childFactory: createImmediateAgentFactory([]),
			now: createClock(100),
		});

		manager.start("demo");
		manager.reset();

		expect(manager.getSnapshot().run.status).toBe("idle");
		expect(manager.getSnapshot().cards).toEqual([]);
		expect(manager.getSnapshot().receipts[0]?.message).toBe("已重置任务骨架");
	});
});

function createDemoEnv() {
	return {
		port: 4175,
		piCommand: "pi",
		piArgs: ["--mode", "rpc", "--no-session"],
		childEnv: process.env,
	};
}

describe("rpc task console HTTP API", () => {
	test("serves snapshots and starts runs through runtime API routes", async () => {
		const server = createRpcTaskConsoleServer(createDemoEnv(), {
			runManagerOptions: {
				childFactory: createImmediateAgentFactory([]),
				now: createClock(100),
			},
		});
		const baseUrl = await listen(server);
		try {
			const initialResponse = await fetch(`${baseUrl}/api/snapshot`);
			expect(initialResponse.status).toBe(200);
			const initialSnapshot = await readJson<TaskSnapshot>(initialResponse);
			expect(initialSnapshot.run.status).toBe("idle");

			const runResponse = await fetch(`${baseUrl}/api/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ instruction: "demo" }),
			});
			expect(runResponse.status).toBe(202);
			const runBody = await readJson<{ readonly run: TaskRun }>(runResponse);
			expect(runBody.run.id).toBe("run-100-1");

			await waitUntilSnapshot(baseUrl, (snapshot) => snapshot.run.status === "fail");
			const finalResponse = await fetch(`${baseUrl}/api/snapshot`);
			const finalSnapshot = await readJson<TaskSnapshot>(finalResponse);
			expect(finalSnapshot.cards).toHaveLength(4);
		} finally {
			await closeServer(server);
		}
	});

	test("streams snapshot events over SSE", async () => {
		const server = createRpcTaskConsoleServer(createDemoEnv(), {
			runManagerOptions: {
				childFactory: createImmediateAgentFactory([]),
				now: createClock(100),
			},
		});
		const baseUrl = await listen(server);
		try {
			const controller = new AbortController();
			const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Missing SSE response body");
			}
			const chunk = await reader.read();
			controller.abort();
			const text = new TextDecoder().decode(chunk.value);
			expect(text).toContain("event: snapshot");
			expect(text).toContain('"status":"idle"');
		} finally {
			await closeServer(server);
		}
	});
});

interface FakeMcpRequest {
	readonly jsonrpc: string;
	readonly id?: string | number;
	readonly method: string;
	readonly params?: unknown;
}

async function handleFakeMcpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	received: Array<{ readonly method: string; readonly sessionId?: string; readonly accept?: string }>,
	useSseToolResult: boolean,
): Promise<void> {
	const message = await readRequestJson(request);
	received.push({
		method: message.method,
		sessionId: request.headers["mcp-session-id"]?.toString(),
		accept: request.headers.accept,
	});
	if (message.method === "initialize") {
		response.setHeader("content-type", "application/json");
		response.setHeader("MCP-Session-Id", "session-1");
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fake-mcp", version: "1.0.0" },
				},
			}),
		);
		return;
	}
	if (message.method === "notifications/initialized") {
		response.statusCode = 202;
		response.end();
		return;
	}
	if (message.method === "tools/call") {
		const result = {
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [{ type: "text", text: "called echo" }],
				isError: false,
			},
		};
		if (useSseToolResult) {
			response.setHeader("content-type", "text/event-stream");
			response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(result));
		return;
	}
	response.statusCode = 400;
	response.end("unexpected request");
}

async function readRequestJson(request: IncomingMessage): Promise<FakeMcpRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	if (!isFakeMcpRequest(value)) {
		throw new Error("Expected fake MCP request");
	}
	return value;
}

function isFakeMcpRequest(value: unknown): value is FakeMcpRequest {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as { readonly jsonrpc?: unknown; readonly method?: unknown };
	return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!isAddressInfo(address)) {
		throw new Error("Server did not expose a TCP address");
	}
	return `http://${address.address}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	server.close();
	await once(server, "close");
}

function waitUntilSnapshot(baseUrl: string, predicate: (snapshot: TaskSnapshot) => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let pending = false;
		const timer = setInterval(() => {
			if (pending) {
				return;
			}
			pending = true;
			void fetch(`${baseUrl}/api/snapshot`)
				.then((response) => readJson<TaskSnapshot>(response))
				.then((snapshot) => {
					if (predicate(snapshot)) {
						clearInterval(timer);
						resolve();
					} else if (Date.now() - startedAt > 2_000) {
						clearInterval(timer);
						reject(new Error("Timed out waiting for snapshot"));
					}
				})
				.catch((error: unknown) => {
					clearInterval(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				})
				.finally(() => {
					pending = false;
				});
		}, 10);
	});
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
	return typeof address === "object" && address !== null;
}
