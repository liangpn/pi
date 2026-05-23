import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChildAgentProcess, normalizeChildLine } from "../examples/rpc-task-console/child-agent-process.js";
import { prepareChildSettings } from "../examples/rpc-task-console/child-settings.js";
import { loadDemoEnv, type RpcTaskConsoleEnv } from "../examples/rpc-task-console/env.js";
import { loadMcpConfig } from "../examples/rpc-task-console/mcp-config.js";
import { McpStreamableHttpClient } from "../examples/rpc-task-console/mcp-streamable-http-client.js";
import { createPersistenceWriter } from "../examples/rpc-task-console/persistence.js";
import { validatePlanSteps } from "../examples/rpc-task-console/plan-validation.js";
import { buildTaskPrompt } from "../examples/rpc-task-console/prompt-builder.js";
import {
	parseTaskResultFromAssistantMessage,
	validateTaskResult,
} from "../examples/rpc-task-console/result-validation.js";
import { RunManager } from "../examples/rpc-task-console/run-manager.js";
import { DEFAULT_RUNTIME_CONFIG, loadRuntimeConfig } from "../examples/rpc-task-console/runtime-config.js";
import { createRpcTaskConsoleServer } from "../examples/rpc-task-console/server.js";
import { TaskDispatcher } from "../examples/rpc-task-console/task-dispatcher.js";
import { aggregateStepStatus, TaskStore } from "../examples/rpc-task-console/task-store.js";
import { createInitialSteps, createRuntimeSteps } from "../examples/rpc-task-console/tasks.js";
import type {
	ChildAgentProcessFactoryOptions,
	ChildAgentProcessLike,
	NormalizedChildEvent,
	PlanStep,
	RuntimeTask,
	TaskResult,
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
		expect(steps[0]?.tasks[0]?.tools).toEqual([]);
		expect(steps[0]?.tasks[0]?.skills).toEqual([]);
		expect(steps[1]?.tasks[0]?.retry).toEqual({
			max_attempts: 2,
			base_delay_ms: 250,
			max_tool_calls: 3,
			retry_on: ["process_error", "timeout"],
		});
		expect(steps[1]?.tasks[1]?.card_type).toBeUndefined();
	});

	test("clones plan steps into runtime steps without mutating the plan", () => {
		const planSteps = createInitialSteps();
		const runtimeSteps = createRuntimeSteps(planSteps);

		expect(runtimeSteps[0]?.status).toBe("loading");
		expect(runtimeSteps[0]?.tasks[0]?.status).toBe("loading");
		expect(runtimeSteps[0]?.tasks[0]?.stepId).toBe("step-1");
		expect(runtimeSteps[0]?.tasks[0]?.tools).toEqual([]);
		expect(runtimeSteps[0]?.tasks[0]?.skills).toEqual([]);
		expect(runtimeSteps[0]?.tasks[0]?.attempts).toEqual([]);
		expect(planSteps[0]?.tasks[0]).not.toHaveProperty("status");
	});

	test("validates and normalizes workflow plans", () => {
		const validated = validatePlanSteps([
			{
				id: "step-a",
				title: "Step A",
				tasks: [{ id: "task-a", title: "Task A", description: "Do A" }],
			},
		]);

		expect(validated[0]?.tasks[0]?.tools).toEqual([]);
		expect(validated[0]?.tasks[0]?.skills).toEqual([]);
	});

	test("rejects duplicate step ids", () => {
		expect(() =>
			validatePlanSteps([
				{ id: "step-a", title: "Step A", tasks: [{ id: "task-a", title: "Task A", description: "A" }] },
				{ id: "step-a", title: "Step B", tasks: [{ id: "task-b", title: "Task B", description: "B" }] },
			]),
		).toThrow(/Duplicate step id "step-a"/);
	});

	test("rejects duplicate task ids across steps", () => {
		expect(() =>
			validatePlanSteps([
				{ id: "step-a", title: "Step A", tasks: [{ id: "task-a", title: "Task A", description: "A" }] },
				{ id: "step-b", title: "Step B", tasks: [{ id: "task-a", title: "Task B", description: "B" }] },
			]),
		).toThrow(/Duplicate task id "task-a"/);
	});

	test("rejects empty and invalid card types", () => {
		expect(() =>
			validatePlanSteps([
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", card_type: "" as never }],
				},
			]),
		).toThrow(/invalid card_type/i);

		expect(() =>
			validatePlanSteps([
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", card_type: "video" as never }],
				},
			]),
		).toThrow(/invalid card_type/i);
	});

	test("rejects card_type without non-empty data_structure", () => {
		expect(() =>
			validatePlanSteps([
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", card_type: "text" }],
				},
			]),
		).toThrow(/requires a non-empty data_structure/i);

		expect(() =>
			validatePlanSteps([
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", card_type: "text", data_structure: [] }],
				},
			]),
		).toThrow(/requires a non-empty data_structure/i);
	});

	test("rejects non-empty data_structure without card_type", () => {
		expect(() =>
			validatePlanSteps([
				{
					id: "step-a",
					title: "Step A",
					tasks: [
						{
							id: "task-a",
							title: "Task A",
							description: "A",
							data_structure: [{ field: "text", type: "string" }],
						},
					],
				},
			]),
		).toThrow(/must not define data_structure without card_type/i);
	});

	test("rejects invalid retry settings", () => {
		const invalidPlans: readonly PlanStep[][] = [
			[
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", retry: { max_attempts: 0 } }],
				},
			],
			[
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", retry: { max_tool_calls: 0 } }],
				},
			],
			[
				{
					id: "step-a",
					title: "Step A",
					tasks: [{ id: "task-a", title: "Task A", description: "A", retry: { base_delay_ms: -1 } }],
				},
			],
			[
				{
					id: "step-a",
					title: "Step A",
					tasks: [
						{
							id: "task-a",
							title: "Task A",
							description: "A",
							retry: { retry_on: ["timeout", "not-a-reason" as never] },
						},
					],
				},
			],
		];

		for (const plan of invalidPlans) {
			expect(() => validatePlanSteps(plan)).toThrow();
		}
	});

	test("validates the police workflow reference and clones it into runtime steps", () => {
		const workflowPath = new URL(
			"../../../docs/superpowers/specs/references/police-command-workflow.json",
			import.meta.url,
		);
		const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as PlanStep[];
		const validated = validatePlanSteps(workflow);
		const runtimeSteps = createRuntimeSteps(validated);

		expect(runtimeSteps.map((step) => step.id)).toEqual([
			"step_incident_facts",
			"step_basic_assessment",
			"step_scene_situation",
			"step_dispatch_resource_visualization",
		]);
		expect(runtimeSteps[2]?.tasks[1]?.data_structure?.[2]?.type).toBe("integer");
		expect(
			runtimeSteps.every((step) =>
				step.tasks.every((task) => Array.isArray(task.tools) && Array.isArray(task.skills)),
			),
		).toBe(true);
	});
});

describe("rpc task console task prompt and result validation", () => {
	test("builds a task prompt with instruction, step/task metadata, tools, skills, and card schema", () => {
		const runtimeSteps = createRuntimeSteps([
			{
				id: "step-a",
				title: "Step A",
				tasks: [
					{
						id: "task-a",
						title: "Task A",
						description: "Do A",
						tools: ["read", "grep"],
						skills: ["openai-docs"],
						card_type: "json",
						data_structure: [{ field: "value", type: "string", required: true }],
					},
				],
			},
		]);
		const prompt = buildTaskPrompt({
			userInstruction: "Investigate the issue",
			step: runtimeSteps[0]!,
			task: runtimeSteps[0]!.tasks[0]!,
		});

		expect(prompt).toContain("Investigate the issue");
		expect(prompt).toContain("Step A");
		expect(prompt).toContain("Task A");
		expect(prompt).toContain("Do A");
		expect(prompt).toContain("read, grep");
		expect(prompt).toContain("openai-docs");
		expect(prompt).toContain('{ "content": string, "data": ... }');
		expect(prompt).toContain('"field": "value"');
		expect(prompt).toContain("不要输出 card title、card type，也不要输出完整 card object。");
	});

	test("builds a content-only prompt when card_type is absent", () => {
		const runtimeSteps = createRuntimeSteps([
			{
				id: "step-a",
				title: "Step A",
				tasks: [{ id: "task-a", title: "Task A", description: "Do A", tools: [], skills: [] }],
			},
		]);
		const prompt = buildTaskPrompt({
			userInstruction: "Investigate the issue",
			step: runtimeSteps[0]!,
			task: runtimeSteps[0]!.tasks[0]!,
		});

		expect(prompt).toContain('{ "content": string }');
		expect(prompt).not.toContain('"data": ...');
	});

	test("parses assistant JSON results and validates card data structures", () => {
		const runtimeTask = createRuntimeTask({
			id: "task-a",
			title: "Task A",
			description: "Do A",
			card_type: "text",
			data_structure: [{ field: "text", type: "string", required: true }],
		});
		const parsed = parseTaskResultFromAssistantMessage(
			createAssistantMessage(JSON.stringify({ content: "done", data: { text: "hello" } })),
		);
		const result = validateTaskResult(runtimeTask, parsed);

		expect(result).toEqual({
			status: "complete",
			content: "done",
			data: { text: "hello" },
		});
	});

	test("keeps extra data for tasks without card_type so dispatcher/store can log diagnostics without failing", () => {
		const runtimeTask = createRuntimeTask({
			id: "task-a",
			title: "Task A",
			description: "Do A",
		});
		const parsed = parseTaskResultFromAssistantMessage(
			createAssistantMessage(JSON.stringify({ content: "done", data: { extra: true } })),
		);
		const result = validateTaskResult(runtimeTask, parsed);

		expect(result).toEqual({
			status: "complete",
			content: "done",
			data: { extra: true },
		});
	});

	test("fails validation when card_type requires data that does not match data_structure", () => {
		const runtimeTask = createRuntimeTask({
			id: "task-a",
			title: "Task A",
			description: "Do A",
			card_type: "table",
			data_structure: [{ field: "rows", type: "array", required: true }],
		});
		const parsed = parseTaskResultFromAssistantMessage(createAssistantMessage(JSON.stringify({ content: "done" })));

		expect(() => validateTaskResult(runtimeTask, parsed)).toThrow(/data/);
	});
});

describe("rpc task console runtime config", () => {
	test("loads the default runtime config fixtures", () => {
		const exampleDir = new URL("../examples/rpc-task-console/", import.meta.url);
		const runtimeConfigPath = new URL("runtime.config.json", exampleDir);
		const runtimeConfigExamplePath = new URL("runtime.config.example.json", exampleDir);

		expect(loadRuntimeConfig(runtimeConfigPath)).toEqual(DEFAULT_RUNTIME_CONFIG);
		expect(loadRuntimeConfig(runtimeConfigExamplePath)).toEqual(DEFAULT_RUNTIME_CONFIG);
	});

	test("rejects missing and invalid runtime config files", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			expect(() => loadRuntimeConfig(join(dir, "missing-runtime.config.json"))).toThrow(/runtime config/i);

			const invalidPath = join(dir, "runtime.config.json");
			writeFileSync(
				invalidPath,
				JSON.stringify({
					...DEFAULT_RUNTIME_CONFIG,
					retry: {
						...DEFAULT_RUNTIME_CONFIG.retry,
						retry_on: ["timeout", "unknown-reason"],
					},
				}),
			);

			expect(() => loadRuntimeConfig(invalidPath)).toThrow(/retry_on/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console env", () => {
	test("loads custom provider details from llm.config.json and injects MCP extension when configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
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
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(dir, ".rpc-task-console", "pi-agent"));
			expect(modelsJson.providers["rpc-demo"].baseUrl).toBe("https://llm.example.test/v1");
			expect(modelsJson.providers["rpc-demo"].models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("generates local models.json from OpenAI-compatible .env fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
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
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(dir, ".rpc-task-console", "pi-agent"));
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
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=test-key\nPI_DEMO_LLM_PROVIDER=rpc-demo\n");

			const demoEnv = loadDemoEnv(dir, {});

			expect(demoEnv.modelsJsonPath).toBeUndefined();
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(dir, ".rpc-task-console", "pi-agent"));
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
			writeDefaultRuntimeConfigFile(dir);
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

	test("resolves derived, relative, and absolute runtime output directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		const absoluteLogDir = join(dir, "absolute-logs");
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_OUTPUT_DIR=demo-output",
					`PI_DEMO_LOG_DIR=${absoluteLogDir}`,
					"PI_DEMO_CHILD_SESSION_DIR=sessions",
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
				].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, {});

			expect(demoEnv.outputDir).toBe(join(dir, "demo-output"));
			expect(demoEnv.snapshotDir).toBe(join(dir, "demo-output", "snapshots"));
			expect(demoEnv.logDir).toBe(absoluteLogDir);
			expect(demoEnv.rpcEventDir).toBe(join(dir, "demo-output", "rpc-events"));
			expect(demoEnv.childStderrDir).toBe(join(dir, "demo-output", "stderr"));
			expect(demoEnv.conversationDir).toBe(join(dir, "demo-output", "conversation"));
			expect(demoEnv.childAgentDir).toBe(join(dir, "demo-output", "pi-agent"));
			expect(demoEnv.childSessionDir).toBe(join(dir, "sessions"));
			expect(demoEnv.runtimeConfigPath).toBe(join(dir, "runtime.config.json"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails when child sessions are enabled without a session directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(join(dir, ".env"), "PI_DEMO_ENABLE_CHILD_SESSION=true\n");

			expect(() => loadDemoEnv(dir, {})).toThrow(/child session dir/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("removes --no-session and configures a child session directory when enabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
					"PI_DEMO_ENABLE_CHILD_SESSION=true",
					"PI_DEMO_CHILD_SESSION_DIR=.rpc-task-console/sessions",
				].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, {});

			expect(demoEnv.enableChildSession).toBe(true);
			expect(demoEnv.piArgs.includes("--no-session")).toBe(false);
			expect(demoEnv.piArgs).toContain("--session-dir");
			expect(demoEnv.piArgs).toContain(join(dir, ".rpc-task-console", "sessions"));
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(dir, ".rpc-task-console", "pi-agent"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console child settings", () => {
	test("writes child settings.json with retry and transport config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				["PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1", "PI_DEMO_LLM_MODEL=demo-model"].join("\n"),
			);
			const demoEnv = loadDemoEnv(dir, {});

			const paths = await prepareChildSettings(demoEnv);
			const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8")) as {
				readonly retry: {
					readonly enabled: boolean;
					readonly maxRetries: number;
					readonly baseDelayMs: number;
					readonly provider: {
						readonly timeoutMs: number;
						readonly maxRetries: number;
						readonly maxRetryDelayMs: number;
					};
				};
				readonly transport: string;
			};

			expect(paths.agentDir).toBe(join(dir, ".rpc-task-console", "pi-agent"));
			expect(paths.sessionDir).toBeUndefined();
			expect(settings.retry.enabled).toBe(true);
			expect(settings.retry.maxRetries).toBe(3);
			expect(settings.retry.baseDelayMs).toBe(2000);
			expect(settings.retry.provider.timeoutMs).toBe(300000);
			expect(settings.retry.provider.maxRetries).toBe(0);
			expect(settings.retry.provider.maxRetryDelayMs).toBe(60000);
			expect(settings.transport).toBe("sse");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console persistence", () => {
	test("writes snapshot, logs, rpc events, stderr tails, and conversation messages", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		try {
			const writer = createPersistenceWriter({
				snapshotDir: join(dir, "snapshots"),
				logDir: join(dir, "logs"),
				rpcEventDir: join(dir, "rpc-events"),
				childStderrDir: join(dir, "stderr"),
				conversationDir: join(dir, "conversation"),
			});
			const steps = createInitialSteps();
			const store = TaskStore.createIdle(steps);
			const run = store.startRun("run-1", "demo instruction", 100);
			store.apply({
				type: "task_completed",
				runId: run.id,
				stepId: "step-1",
				taskId: "task-1",
				result: { status: "complete", content: "persisted", data: { text: "persisted" } },
				time: 101,
			});
			const snapshot = store.getSnapshot();

			const snapshotPath = await writer.writeSnapshot(snapshot);
			const logPath = await writer.appendTaskLog({
				id: "log-1",
				runId: run.id,
				stepId: "step-1",
				taskId: "task-1",
				type: "message_update",
				message: "stream update",
				time: 102,
			});
			const rpcEventPath = await writer.appendRpcEvent({
				runId: run.id,
				stepId: "step-1",
				taskId: "task-1",
				agentRunId: "agent-1",
				time: 103,
				event: { type: "agent_start" },
			});
			const stderrPath = await writer.writeChildStderr({
				runId: run.id,
				stepId: "step-1",
				taskId: "task-1",
				agentRunId: "agent-1",
				stderrTail: "stderr tail",
			});
			const conversationPath = await writer.appendConversationMessage(snapshot.conversationMessages[0]!);

			expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toMatchObject({
				run: { id: "run-1", status: "running" },
			});
			expect(readFileSync(logPath, "utf8")).toContain('"message":"stream update"');
			expect(readFileSync(rpcEventPath, "utf8")).toContain('"type":"agent_start"');
			expect(readFileSync(stderrPath, "utf8")).toBe("stderr tail");
			expect(readFileSync(conversationPath, "utf8")).toContain('"content":"persisted"');
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
		expect(snapshot.conversationMessages).toEqual([]);
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

	test("writes task result, conversation message, receipt, and card in the same completion snapshot", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const run = store.startRun("run-1", "demo instruction", 100);
		const snapshots: TaskSnapshot[] = [];
		store.subscribe((snapshot) => {
			snapshots.push(snapshot);
		});

		store.apply({
			type: "task_started",
			runId: run.id,
			stepId: "step-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			attempt: 1,
			agentRunId: "agent-run-1",
			agent: {
				processId: 4321,
				command: ["pi", "--mode", "rpc", "--no-session"],
			},
			time: 101,
		});
		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			agentRunId: "agent-run-1",
			process: {
				closeCode: 0,
				signal: null,
			},
			result: {
				status: "complete",
				content: "done",
				data: { text: "done" },
			},
			time: 102,
		});

		const completionSnapshot = snapshots.at(-1);
		const task = completionSnapshot?.run.steps[0]?.tasks[0];
		expect(task?.status).toBe("complete");
		expect(task?.result?.status).toBe("complete");
		expect(task?.result?.data).toEqual({ text: "done" });
		expect(task?.attempts).toHaveLength(1);
		expect(task?.attempts[0]).toMatchObject({
			id: "attempt-1",
			attempt: 1,
			agentRunId: "agent-run-1",
			status: "complete",
		});
		expect(completionSnapshot?.cards.some((card) => card.taskId === "task-1" && card.type === "text")).toBe(true);
		expect(completionSnapshot?.conversationMessages).toContainEqual({
			id: "message-run-1-step-1-task-1-102",
			runId: "run-1",
			stepId: "step-1",
			taskId: "task-1",
			content: "done",
			time: 102,
		});
		expect(
			completionSnapshot?.receipts.some((receipt) => receipt.message.includes("【先期处置】【总结当前目录】已完成")),
		).toBe(true);
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
				data: { gbids: ["gbid-1", "gbid-2"] },
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
				data: { text: "done" },
			},
			time: 101,
		});

		const snapshot = store.getSnapshot();
		expect(snapshot.cards.some((card) => card.taskId === "task-5")).toBe(false);
		expect(snapshot.run.steps[1]?.tasks[1]?.status).toBe("complete");
		expect(snapshot.logs.some((log) => log.type === "diagnostic" && log.taskId === "task-5")).toBe(true);
		expect(
			snapshot.conversationMessages.some((message) => message.taskId === "task-5" && message.content === "done"),
		).toBe(true);
	});

	test("does not silently consume legacy card_data payloads", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const run = store.startRun("run-1", "demo instruction", 100);
		const legacyResult = {
			status: "complete",
			content: "done",
			card_data: { text: "legacy result payload" },
		} as unknown as TaskResult;

		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-1",
			taskId: "task-1",
			result: legacyResult,
			time: 101,
		});

		const snapshot = store.getSnapshot();
		expect(snapshot.cards.some((card) => card.taskId === "task-1")).toBe(false);
		expect(snapshot.run.steps[0]?.tasks[0]?.result?.data).toBeUndefined();
	});

	test("stores structured attempt, process, and stopped diagnostics in the snapshot", () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "done", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo instruction", 100);

		store.apply({
			type: "task_started",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			attemptId: "attempt-1",
			attempt: 1,
			agentRunId: "agent-run-1",
			agent: {
				processId: 4321,
				sessionDir: "/tmp/pi-session-1",
				command: ["pi", "--mode", "rpc", "--session-dir", "/tmp/pi-session-1"],
			},
			time: 101,
		});
		store.apply({
			type: "task_log",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			attemptId: "attempt-1",
			agentRunId: "agent-run-1",
			process: {
				closeCode: 143,
				signal: "SIGTERM",
				stderrTail: "echo child ready",
			},
			logType: "process_close",
			message: "子进程已退出",
			time: 102,
		});
		store.apply({
			type: "task_stopped",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			attemptId: "attempt-1",
			agentRunId: "agent-run-1",
			process: {
				closeCode: 143,
				signal: "SIGTERM",
				stderrTail: "echo child ready",
			},
			stopped: {
				status: "stopped",
				reason: "replaced_by_new_instruction",
				message: "任务被新指令替换",
				detail: "received replacement while child was running",
			},
			time: 103,
		});

		const task = store.getSnapshot().run.steps[0]?.tasks[0];
		expect(task?.agent).toEqual({
			processId: 4321,
			sessionDir: "/tmp/pi-session-1",
			command: ["pi", "--mode", "rpc", "--session-dir", "/tmp/pi-session-1"],
		});
		expect(task?.process).toEqual({
			closeCode: 143,
			signal: "SIGTERM",
			stderrTail: "echo child ready",
		});
		expect(task?.stopped).toEqual({
			status: "stopped",
			reason: "replaced_by_new_instruction",
			message: "任务被新指令替换",
			detail: "received replacement while child was running",
		});
		expect(task?.attempts[0]).toMatchObject({
			id: "attempt-1",
			attempt: 1,
			agentRunId: "agent-run-1",
			status: "stopped",
			agent: {
				processId: 4321,
				sessionDir: "/tmp/pi-session-1",
				command: ["pi", "--mode", "rpc", "--session-dir", "/tmp/pi-session-1"],
			},
			process: {
				closeCode: 143,
				signal: "SIGTERM",
				stderrTail: "echo child ready",
			},
			stopped: {
				reason: "replaced_by_new_instruction",
				detail: "received replacement while child was running",
			},
		});
	});

	test("does not change run finishedAt after a terminal run receives a late log", () => {
		const store = TaskStore.createIdle([
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "done", tools: [], skills: [] }],
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

	test("ignores late state events after task and run become terminal, but records a diagnostic log", () => {
		const store = TaskStore.createIdle([
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "done", tools: [], skills: [] }],
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
			type: "task_failed",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			error: { status: "fail", code: "late_failure", message: "too late" },
			time: 102,
		});

		const snapshot = store.getSnapshot();
		expect(snapshot.run.status).toBe("complete");
		expect(snapshot.run.finishedAt).toBe(101);
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(snapshot.run.steps[0]?.tasks[0]?.error).toBeUndefined();
		expect(
			snapshot.logs.some(
				(log) =>
					log.type === "diagnostic" && log.message.includes("忽略迟到状态事件") && log.taskId === "task-test",
			),
		).toBe(true);
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
	test("normalizes prompt failures, retry events, agent events, and malformed child lines", () => {
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
				JSON.stringify({ type: "response", id: "req-2", command: "prompt", success: false, error: "nope" }),
			),
		).toEqual({
			type: "prompt_response_failure",
			id: "req-2",
			error: "nope",
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
		expect(
			normalizeChildLine(
				JSON.stringify({
					type: "auto_retry_start",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 250,
					errorMessage: "boom",
				}),
			),
		).toEqual({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 250,
			errorMessage: "boom",
		});
		expect(normalizeChildLine("{not-json")?.type).toBe("unknown_json_event");
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

		expect(events.some((event) => event.type === "child_spawned" && typeof event.processId === "number")).toBe(true);
		expect(events.some((event) => event.type === "agent_start")).toBe(true);
		expect(events.some((event) => event.type === "message_end")).toBe(true);
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		expect(
			events.some((event) => event.type === "process_close" && event.stderrTail?.includes("echo child ready")),
		).toBe(true);
	});

	test("persists normalized rpc events and child stderr tails when output directories are configured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-task-console-"));
		const rpcEventDir = join(dir, "rpc-events");
		const childStderrDir = join(dir, "stderr");
		const events: NormalizedChildEvent[] = [];
		const child = new ChildAgentProcess({
			runId: "run-1",
			stepId: "step-1",
			taskId: "task-1",
			command: process.execPath,
			args: ["-e", createEchoRpcScript()],
			env: {
				...process.env,
				PI_DEMO_RPC_EVENT_DIR: rpcEventDir,
				PI_DEMO_CHILD_STDERR_DIR: childStderrDir,
			},
			onEvent: (event) => {
				events.push(event);
			},
		});

		try {
			child.start();
			child.sendPrompt("hello");
			await waitUntil(() => events.some((event) => event.type === "agent_end"));
			child.kill("SIGTERM");
			await waitUntil(() => {
				try {
					return readFileSync(
						join(rpcEventDir, "run-1", "step-1__task-1__agent-run-1-step-1-task-1.jsonl"),
						"utf8",
					).includes('"type":"agent_end"');
				} catch {
					return false;
				}
			});

			const rpcEvents = readFileSync(
				join(rpcEventDir, "run-1", "step-1__task-1__agent-run-1-step-1-task-1.jsonl"),
				"utf8",
			);
			const stderrTail = readFileSync(
				join(childStderrDir, "run-1", "step-1__task-1__agent-run-1-step-1-task-1.log"),
				"utf8",
			);

			expect(rpcEvents).toContain('"type":"rpc_response"');
			expect(rpcEvents).toContain('"type":"unknown_json_event"');
			expect(rpcEvents).toContain('"type":"agent_end"');
			expect(stderrTail).toContain("echo child ready");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
		"process.stdout.write(JSON.stringify({ type: 'mystery_event', payload: '???' }) + '\\n');",
		"process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{\\\"content\\\":\\\"ok\\\"}' }], api: 'openai-responses', provider: 'openai', model: 'mock', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } }) + '\\n');",
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
					{ id: "task-a", title: "任务 A", description: "pending", tools: [], skills: [] },
					{ id: "task-b", title: "任务 B", description: "pending", tools: [], skills: [] },
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

	test("projects child runtime diagnostics into the final completed snapshot", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [
					{
						id: "task-test",
						title: "测试任务",
						description: "done",
						tools: [],
						skills: [],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done", data: { text: "done" } })),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
							child.emit({
								type: "process_close",
								exitCode: 0,
								signal: null,
								stderrTail: "child complete stderr",
							});
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		const task = store.getSnapshot().run.steps[0]?.tasks[0];
		expect(task?.status).toBe("complete");
		expect(task?.agent).toEqual({
			processId: 1234,
			command: ["pi", "--mode", "rpc", "--no-session"],
		});
		expect(task?.process).toEqual({
			closeCode: 0,
			signal: null,
			stderrTail: "child complete stderr",
		});
		expect(task?.attempts).toHaveLength(1);
		expect(task?.attempts[0]).toMatchObject({
			attempt: 1,
			agentRunId: "fake-task-test",
			status: "complete",
			agent: {
				processId: 1234,
				command: ["pi", "--mode", "rpc", "--no-session"],
			},
			process: {
				closeCode: 0,
				signal: null,
				stderrTail: "child complete stderr",
			},
		});
	});

	test("projects stopped detail and close diagnostics when a child is aborted", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const children: FakeChildAgentProcess[] = [];
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({
								type: "process_close",
								exitCode: 143,
								signal: "SIGTERM",
								stderrTail: "child aborted stderr",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		const running = dispatcher.run();
		await waitUntil(() => children.length === 1);
		dispatcher.stop("replaced_by_new_instruction");
		await running;
		await waitUntil(() => store.getSnapshot().run.steps[0]?.tasks[0]?.process?.closeCode === 143);

		const task = store.getSnapshot().run.steps[0]?.tasks[0];
		expect(task?.status).toBe("stopped");
		expect(task?.process).toEqual({
			closeCode: 143,
			signal: "SIGTERM",
			stderrTail: "child aborted stderr",
		});
		expect(task?.stopped?.detail).toEqual(expect.stringContaining("新指令"));
		expect(task?.attempts).toHaveLength(1);
		expect(task?.attempts[0]).toMatchObject({
			attempt: 1,
			agentRunId: "fake-task-test",
			status: "stopped",
			process: {
				closeCode: 143,
				signal: "SIGTERM",
				stderrTail: "child aborted stderr",
			},
			stopped: {
				reason: "replaced_by_new_instruction",
				detail: expect.stringContaining("新指令"),
			},
		});
	});

	test("marks task running on child_spawned and records a task log before completion", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
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
		await waitUntil(() => store.getSnapshot().run.steps[0]?.tasks[0]?.status === "running");

		const runningSnapshot = store.getSnapshot();
		expect(runningSnapshot.run.steps[0]?.tasks[0]?.status).toBe("running");
		expect(runningSnapshot.logs.some((log) => log.taskId === "task-test" && log.type === "child_spawned")).toBe(true);

		children[0]?.emit({ type: "message_end", message: createAssistantMessage(JSON.stringify({ content: "done" })) });
		children[0]?.emit({ type: "agent_end", messages: [], willRetry: false });
		await running;
	});

	test("fails the current attempt when prompt response is rejected", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({ type: "prompt_response_failure", error: "prompt rejected" });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("fail");
		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.error?.code).toBe("prompt_response_failure");
	});

	test("keeps the task running after a successful prompt ack and only completes after message_end plus final agent_end", async () => {
		const children: FakeChildAgentProcess[] = [];
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
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
		await waitUntil(() => store.getSnapshot().run.steps[0]?.tasks[0]?.status === "running");

		children[0]?.emit({ type: "rpc_response", id: "req-prompt", command: "prompt", success: true });

		const ackSnapshot = store.getSnapshot();
		expect(ackSnapshot.run.steps[0]?.tasks[0]?.status).toBe("running");
		expect(ackSnapshot.run.steps[0]?.tasks[0]?.result).toBeUndefined();
		expect(ackSnapshot.cards).toEqual([]);
		expect(ackSnapshot.conversationMessages).toEqual([]);
		expect(ackSnapshot.logs.some((log) => log.type === "rpc_response" && log.message.includes("prompt 已确认"))).toBe(
			true,
		);

		children[0]?.emit({ type: "message_end", message: createAssistantMessage(JSON.stringify({ content: "done" })) });
		children[0]?.emit({ type: "agent_end", messages: [], willRetry: false });
		await running;

		const completedSnapshot = store.getSnapshot();
		expect(completedSnapshot.run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(completedSnapshot.run.steps[0]?.tasks[0]?.result).toEqual({ status: "complete", content: "done" });
		expect(completedSnapshot.cards).toEqual([]);
		expect(completedSnapshot.conversationMessages).toHaveLength(1);
		expect(completedSnapshot.conversationMessages[0]?.content).toBe("done");
	});

	test("records retry, tool error, and message update logs without settling before final agent_end", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [
					{
						id: "task-test",
						title: "测试任务",
						description: "pending",
						tools: ["read"],
						skills: ["openai-docs"],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "message_update",
								message: createAssistantMessage("partial"),
								assistantMessageEvent: { type: "text_delta", delta: "partial" },
							});
							child.emit({
								type: "auto_retry_start",
								attempt: 1,
								maxAttempts: 3,
								delayMs: 250,
								errorMessage: "temporary failure",
							});
							child.emit({ type: "agent_end", messages: [], willRetry: true });
							child.emit({ type: "auto_retry_end", success: true, attempt: 1 });
							child.emit({
								type: "tool_execution_end",
								toolCallId: "tool-1",
								toolName: "read",
								result: { error: "ENOENT" },
								isError: true,
							});
							child.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done", data: { text: "done" } })),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		const snapshot = store.getSnapshot();
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(snapshot.logs.some((log) => log.type === "auto_retry_start")).toBe(true);
		expect(snapshot.logs.some((log) => log.type === "auto_retry_end")).toBe(true);
		expect(snapshot.logs.some((log) => log.type === "message_update")).toBe(true);
		expect(snapshot.logs.some((log) => log.type === "tool_execution_end" && log.message.includes("工具报错"))).toBe(
			true,
		);
	});

	test("logs unknown child JSON events and completes when a later valid result arrives", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "unknown_json_event",
								message: "Unhandled child event: mystery_event",
								eventType: "mystery_event",
								rawLine: '{"type":"mystery_event"}',
							});
							child.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done" })),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(
			store
				.getSnapshot()
				.logs.some((log) => log.type === "unknown_json_event" && log.message.includes("mystery_event")),
		).toBe(true);
	});

	test("does not fail or create a card when a no-card task returns extra data, but records a diagnostic", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done", data: { extra: true } })),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		const snapshot = store.getSnapshot();
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(snapshot.cards).toEqual([]);
		expect(snapshot.logs.some((log) => log.type === "diagnostic" && log.message.includes("忽略 result.data"))).toBe(
			true,
		);
	});

	test("fails with validation_error when the final assistant result does not satisfy data_structure", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [
					{
						id: "task-test",
						title: "测试任务",
						description: "pending",
						tools: [],
						skills: [],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done", data: { wrong: true } })),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("fail");
		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.error?.code).toBe("validation_error");
	});

	test("fails with process_closed_before_agent_end when the child exits before a valid result is available", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({ type: "process_close", exitCode: 1, signal: null, stderrTail: "boom" });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.error?.code).toBe("process_closed_before_agent_end");
	});
});

function createImmediateAgentFactory(startedTaskIds: string[]) {
	return (options: ChildAgentProcessFactoryOptions): ChildAgentProcessLike => {
		return new FakeChildAgentProcess(options, startedTaskIds, {
			onPrompt: (child) => {
				queueMicrotask(() => {
					if (options.taskId === "task-5") {
						child.emit({ type: "prompt_response_failure", error: "simulated prompt failure" });
						return;
					}
					child.emit({
						type: "message_end",
						message: createAssistantMessage(JSON.stringify(createResultPayloadForTask(options.taskId))),
					});
					child.emit({ type: "agent_end", messages: [], willRetry: false });
				});
			},
		});
	};
}

function createAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function createRuntimeTask(overrides: Partial<RuntimeTask>): RuntimeTask {
	return {
		id: overrides.id ?? "task-test",
		stepId: overrides.stepId ?? "step-test",
		title: overrides.title ?? "测试任务",
		description: overrides.description ?? "pending",
		tools: overrides.tools ?? [],
		skills: overrides.skills ?? [],
		retry: overrides.retry,
		card_type: overrides.card_type,
		data_structure: overrides.data_structure,
		attempts: overrides.attempts ?? [],
		status: overrides.status ?? "loading",
		agent: overrides.agent,
		process: overrides.process,
		agentRun: overrides.agentRun,
		result: overrides.result,
		error: overrides.error,
		stopped: overrides.stopped,
		eventCount: overrides.eventCount ?? 0,
		startedAt: overrides.startedAt,
		finishedAt: overrides.finishedAt,
		demoOutcome: overrides.demoOutcome,
	};
}

function createResultPayloadForTask(taskId: string): { readonly content: string; readonly data?: unknown } {
	if (taskId === "task-1") {
		return { content: "已完成目录摘要。", data: { text: "当前目录是 Pi coding agent 的源码项目。" } };
	}
	if (taskId === "task-2") {
		return { content: "已打开 service-a 监控。", data: { gbids: ["gbid-service-a-001"] } };
	}
	if (taskId === "task-3") {
		return {
			content: "已查询目标周边点位。",
			data: {
				center: { lat: 31.2304, lng: 121.4737 },
				markers: [
					{ label: "目标点", lat: 31.2304, lng: 121.4737, status: "active" },
					{ label: "周边资源", lat: 31.2298, lng: 121.475, status: "standby" },
				],
			},
		};
	}
	if (taskId === "task-4") {
		return {
			content: "已拉取资源清单。",
			data: {
				columns: [
					{ key: "name", label: "资源" },
					{ key: "status", label: "状态" },
				],
				rows: [
					{ name: "service-a", status: "online" },
					{ name: "service-b", status: "standby" },
				],
			},
		};
	}
	return { content: `${taskId} done` };
}

class FakeChildAgentProcess implements ChildAgentProcessLike {
	readonly agentRunId: string;
	readonly processId = 1234;
	readonly killSignals: NodeJS.Signals[] = [];
	abortCount = 0;
	private readonly options: ChildAgentProcessFactoryOptions;
	private readonly startedTaskIds: string[];
	private readonly hooks: FakeChildHooks | undefined;

	constructor(options: ChildAgentProcessFactoryOptions, startedTaskIds: string[], hooks?: FakeChildHooks) {
		this.options = options;
		this.startedTaskIds = startedTaskIds;
		this.hooks = hooks;
		this.agentRunId = `fake-${options.taskId}`;
	}

	start(): void {
		this.hooks?.onStart?.(this);
		this.options.onEvent({ type: "child_spawned", processId: this.processId });
	}

	sendPrompt(_message: string): string {
		this.startedTaskIds.push(this.options.taskId);
		this.hooks?.onPrompt?.(this);
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
		this.hooks?.onKill?.(this, signal);
	}

	emit(event: NormalizedChildEvent): void {
		this.options.onEvent(event);
	}
}

interface FakeChildHooks {
	readonly onStart?: (child: FakeChildAgentProcess) => void;
	readonly onPrompt?: (child: FakeChildAgentProcess) => void;
	readonly onKill?: (child: FakeChildAgentProcess, signal: NodeJS.Signals) => void;
}

function createClock(startAt: number): () => number {
	let next = startAt;
	return () => next++;
}

function writeDefaultRuntimeConfigFile(dir: string): string {
	const runtimeConfigPath = join(dir, "runtime.config.json");
	writeFileSync(runtimeConfigPath, `${JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2)}\n`);
	return runtimeConfigPath;
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

	test("persists latest snapshot, task logs, and conversation messages during a real run without duplicates", async () => {
		const outputDir = mkdtempSync(join(tmpdir(), "rpc-task-console-run-manager-"));
		const manager = new RunManager({
			steps: [
				{
					id: "step-test",
					title: "测试步骤",
					tasks: [
						{
							id: "task-test",
							title: "测试任务",
							description: "完成持久化验证",
							tools: [],
							skills: [],
							card_type: "text",
							data_structure: [{ field: "text", type: "string", required: true }],
						},
					],
				},
			],
			demoEnv: createDemoEnv(outputDir),
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done", data: { text: "done" } })),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
						});
					},
				}),
			now: createClock(100),
		});

		try {
			const run = manager.start("demo");
			await manager.waitForIdle();

			const snapshot = manager.getSnapshot();
			const snapshotPath = join(outputDir, "snapshots", `${run.id}.json`);
			const logPath = join(outputDir, "logs", `${run.id}.jsonl`);
			const conversationPath = join(outputDir, "conversation", `${run.id}.jsonl`);
			const persistedSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskSnapshot;
			const persistedLogs = readJsonLines<{
				readonly id: string;
				readonly type: string;
				readonly message: string;
				readonly taskId: string;
			}>(logPath);
			const persistedMessages = readJsonLines<{
				readonly id: string;
				readonly content: string;
				readonly taskId: string;
			}>(conversationPath);

			expect(snapshot.run.status).toBe("complete");
			expect(persistedSnapshot.run.status).toBe("complete");
			expect(persistedSnapshot.run.finishedAt).toBe(snapshot.run.finishedAt);
			expect(persistedSnapshot.conversationMessages).toEqual(snapshot.conversationMessages);
			expect(persistedLogs).toHaveLength(snapshot.logs.length);
			expect(new Set(persistedLogs.map((entry) => entry.id)).size).toBe(persistedLogs.length);
			expect(persistedMessages).toHaveLength(snapshot.conversationMessages.length);
			expect(new Set(persistedMessages.map((entry) => entry.id)).size).toBe(persistedMessages.length);
			expect(persistedLogs.some((entry) => entry.type === "child_spawned" && entry.taskId === "task-test")).toBe(
				true,
			);
			expect(persistedMessages[0]).toMatchObject({
				id: snapshot.conversationMessages[0]?.id,
				taskId: "task-test",
				content: "done",
			});
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
		}
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

function createDemoEnv(exampleDir = mkdtempSync(join(tmpdir(), "rpc-task-console-demo-env-"))): RpcTaskConsoleEnv {
	return {
		exampleDir,
		port: 4175,
		piCommand: "pi",
		piArgs: ["--mode", "rpc", "--no-session"],
		childEnv: process.env,
		outputDir: join(exampleDir, ".rpc-task-console"),
		snapshotDir: join(exampleDir, "snapshots"),
		logDir: join(exampleDir, "logs"),
		rpcEventDir: join(exampleDir, "rpc-events"),
		childStderrDir: join(exampleDir, "stderr"),
		conversationDir: join(exampleDir, "conversation"),
		childAgentDir: join(exampleDir, "pi-agent"),
		enableChildSession: false,
		runtimeConfigPath: join(exampleDir, "runtime.config.json"),
		runtimeConfig: DEFAULT_RUNTIME_CONFIG,
		childSettingsPath: join(exampleDir, "pi-agent", "settings.json"),
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

function readJsonLines<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
	return typeof address === "object" && address !== null;
}
