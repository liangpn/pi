import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ChildAgentProcess, normalizeChildLine } from "../src/child-agent-process.js";
import {
	prepareChildSettings,
	prewarmMcpMetadataCache,
	readPrewarmedMcpDirectToolSpecs,
} from "../src/child-settings.js";
import { loadDemoEnv, PI_MCP_ADAPTER_PACKAGE_SOURCE, type RpcTaskConsoleEnv } from "../src/env.js";
import { createPersistenceWriter } from "../src/persistence.js";
import { validatePlanSteps } from "../src/plan-validation.js";
import { buildTaskPrompt } from "../src/prompt-builder.js";
import { parseTaskResultFromAssistantMessage, validateTaskResult } from "../src/result-validation.js";
import { RunManager } from "../src/run-manager.js";
import { DEFAULT_RUNTIME_CONFIG, loadRuntimeConfig } from "../src/runtime-config.js";
import {
	createRpcTaskConsoleServer,
	formatRpcTaskConsoleListenMessage,
	startRpcTaskConsoleServer,
} from "../src/server.js";
import {
	createMcpDirectToolsEnvValue,
	MCP_DIRECT_TOOLS_ENV,
	parseFutureMcpIdentity,
	TaskDispatcher,
} from "../src/task-dispatcher.js";
import { aggregateStepStatus, TaskStore } from "../src/task-store.js";
import { createInitialSteps, createRuntimeSteps } from "../src/tasks.js";
import type {
	ChildAgentProcessFactoryOptions,
	ChildAgentProcessLike,
	NormalizedChildEvent,
	PlanStep,
	RuntimeStep,
	RuntimeTask,
	TaskResult,
	TaskRun,
	TaskSnapshot,
} from "../src/types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PROJECT_LOG_DIR = join(PROJECT_ROOT, "logs");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function createDemoPlanSteps(): readonly PlanStep[] {
	return validatePlanSteps([
		{
			id: "step-1",
			title: "先期处置",
			tasks: [
				{
					id: "task-1",
					title: "总结当前目录",
					description: "请用一句话说明当前目录是什么项目。不要修改文件。",
					tools: [],
					skills: [],
					card_type: "text",
					data_structure: [{ field: "text", type: "string", required: true, description: "目录摘要文本" }],
					demoOutcome: "normal",
				},
				{
					id: "task-2",
					title: "打开服务监控",
					description:
						"1、调用 @get_jw@ 获取经纬度 2、调用 @get_address@ 获取地址 3、调用 @open_camera@ 打开 service-a 监控",
					tools: [],
					skills: [],
					card_type: "media",
					data_structure: [
						{
							field: "gbids",
							type: "array",
							required: true,
							description: "监控设备 GBID 列表",
							items: { type: "string" },
						},
					],
					demoOutcome: "normal",
				},
				{
					id: "task-3",
					title: "查询地图点位",
					description: "模拟查询目标周边点位，返回中心点和若干 marker。",
					tools: [],
					skills: [],
					card_type: "map",
					data_structure: [
						{
							field: "center",
							type: "object",
							required: false,
							fields: [
								{ field: "lat", type: "number", required: true },
								{ field: "lng", type: "number", required: true },
							],
						},
						{
							field: "markers",
							type: "array",
							required: true,
							items: {
								type: "object",
								fields: [
									{ field: "label", type: "string", required: true },
									{ field: "lat", type: "number", required: true },
									{ field: "lng", type: "number", required: true },
									{ field: "status", type: "string", required: false },
								],
							},
						},
					],
					demoOutcome: "normal",
				},
			],
		},
		{
			id: "step-2",
			title: "资源确认",
			tasks: [
				{
					id: "task-4",
					title: "拉取资源清单",
					description: "模拟拉取可用资源清单，输出表格数据。",
					tools: [],
					skills: [],
					retry: {
						max_attempts: 2,
						base_delay_ms: 250,
						max_tool_calls: 3,
						retry_on: ["process_error", "timeout"],
					},
					card_type: "table",
					data_structure: [{ field: "rows", type: "array", required: true, description: "资源表格行数据" }],
					demoOutcome: "normal",
				},
				{
					id: "task-5",
					title: "模拟失败任务",
					description: "请尝试读取一个不存在的文件 docs/definitely-missing-demo-file.txt，并报告错误。",
					tools: [],
					skills: [],
					demoOutcome: "force_fail_after_run",
				},
			],
		},
	]);
}

describe("rpc task console model", () => {
	test("initializes a cold-start plan with no preselected workflow steps", () => {
		const steps = createInitialSteps();

		expect(steps).toEqual([]);
	});

	test("clones plan steps into runtime steps without mutating the plan", () => {
		const planSteps = createDemoPlanSteps();
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
						data_structure: [
							{ field: "address", type: "string", required: true },
							{ field: "confirmed", type: "boolean", required: true },
							{ field: "gbids", type: "array", required: true, items: { type: "string" } },
							{ field: "unitCount", type: "integer", required: true },
							{
								field: "location",
								type: "object",
								required: true,
								fields: [{ field: "label", type: "string", required: true }],
							},
						],
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
		expect(prompt).toContain('{ "content": string, "data": { ... } }');
		expect(prompt).toContain("data 必须是 JSON object");
		expect(prompt).toContain("key 必须来自 data_structure[].field");
		expect(prompt).toContain(
			'输出示例：{"content":"任务完成摘要","data":{"address":"示例文本","confirmed":true,"gbids":["示例文本"],"unitCount":1,"location":{"label":"示例文本"}}}',
		);
		expect(prompt).toContain("不要把 data 输出成 data_structure 数组");
		expect(prompt).toContain("不要输出 field/type/required/description/value 包装对象");
		expect(prompt).toContain('"field": "address"');
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
		const packageDir = new URL("../", import.meta.url);
		const runtimeConfigPath = new URL("runtime.config.json", packageDir);
		const runtimeConfigExamplePath = new URL("runtime.config.example.json", packageDir);

		expect(loadRuntimeConfig(runtimeConfigPath)).toEqual(DEFAULT_RUNTIME_CONFIG);
		expect(loadRuntimeConfig(runtimeConfigExamplePath)).toEqual(DEFAULT_RUNTIME_CONFIG);
	});

	test("rejects missing and invalid runtime config files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
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

	test("fails env loading when the runtime config is missing or invalid", () => {
		const missingDir = mkdtempSync(join(tmpdir(), "pi-task-console-missing-runtime-"));
		const invalidDir = mkdtempSync(join(tmpdir(), "pi-task-console-invalid-runtime-"));
		try {
			expect(() => loadDemoEnv(missingDir, {})).toThrow(/runtime config/i);

			writeFileSync(
				join(invalidDir, "runtime.config.json"),
				JSON.stringify({ ...DEFAULT_RUNTIME_CONFIG, concurrency_limit: 0 }),
			);

			expect(() => loadDemoEnv(invalidDir, {})).toThrow(/concurrency_limit/i);
		} finally {
			rmSync(missingDir, { recursive: true, force: true });
			rmSync(invalidDir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console env", () => {
	test("loads custom provider details and configures the fixed MCP package adapter", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"OPENAI_API_KEY=test-key",
					"PI_DEMO_LLM_CONFIG=llm.config.json",
					"PI_DEMO_MCP_CONFIG=.mcp.json",
					"PI_DEMO_PI_MCP_CONFIG=.pi/mcp.json",
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
				join(dir, ".mcp.json"),
				JSON.stringify(
					{
						mcpServers: {
							caseTools: {
								url: "http://127.0.0.1:9001/mcp",
								auth: false,
								exposeResources: false,
							},
						},
					},
					null,
					2,
				),
			);
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "mcp.json"),
				JSON.stringify(
					{
						settings: {
							toolPrefix: "none",
							directTools: true,
							disableProxyTool: true,
							sampling: false,
						},
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
				"../coding-agent/src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--provider",
				"rpc-demo",
				"--model",
				"model-b",
				"--mcp-config",
				join(PROJECT_LOG_DIR, "pi-agent", "mcp.json"),
			]);
			expect(demoEnv.mcpConfigPath).toBe(join(dir, ".mcp.json"));
			expect(demoEnv.piMcpConfigPath).toBe(join(dir, ".pi", "mcp.json"));
			expect(demoEnv.childEnv.PI_DEMO_MCP_CONFIG_PATH).toBe(join(dir, ".mcp.json"));
			expect(demoEnv.childEnv.PI_DEMO_PI_MCP_CONFIG_PATH).toBe(join(dir, ".pi", "mcp.json"));
			expect(demoEnv.childEnv.PI_DEMO_CHILD_MCP_CONFIG_PATH).toBe(join(PROJECT_LOG_DIR, "pi-agent", "mcp.json"));
			expect(demoEnv.childEnv.NPM_CONFIG_CACHE).toBe(join(PROJECT_LOG_DIR, "npm-cache"));
			expect(demoEnv.outputDir).toBe(PROJECT_LOG_DIR);
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(PROJECT_LOG_DIR, "pi-agent"));
			const childSettings = JSON.parse(readFileSync(demoEnv.childSettingsPath, "utf8")) as {
				readonly packages: readonly string[];
			};
			const childMcpConfig = JSON.parse(readFileSync(join(PROJECT_LOG_DIR, "pi-agent", "mcp.json"), "utf8")) as {
				readonly settings: { readonly directTools: boolean; readonly disableProxyTool: boolean };
				readonly mcpServers: { readonly caseTools: { readonly url: string } };
			};
			expect(childSettings.packages).toContain(PI_MCP_ADAPTER_PACKAGE_SOURCE);
			expect(childMcpConfig.settings.directTools).toBe(true);
			expect(childMcpConfig.settings.disableProxyTool).toBe(true);
			expect(childMcpConfig.mcpServers.caseTools.url).toBe("http://127.0.0.1:9001/mcp");
			expect(modelsJson.providers["rpc-demo"].baseUrl).toBe("https://llm.example.test/v1");
			expect(modelsJson.providers["rpc-demo"].models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("formats startup logs without assuming a localhost public address", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				["PI_DEMO_PORT=4555", "PI_DEMO_PUBLIC_URL=https://demo.example.test/tasks"].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, {});
			const defaultEnv = loadDemoEnv(dir, { PI_DEMO_PUBLIC_URL: "" });

			expect(demoEnv.publicUrl).toBe("https://demo.example.test/tasks");
			expect(formatRpcTaskConsoleListenMessage(demoEnv)).toBe(
				"RPC task console listening on https://demo.example.test/tasks",
			);
			expect(formatRpcTaskConsoleListenMessage({ ...defaultEnv, publicUrl: undefined })).toBe(
				"RPC task console listening on port 4555",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("generates local models.json from OpenAI-compatible .env fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
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
				"../coding-agent/src/cli.ts",
				"--mode",
				"rpc",
				"--no-session",
				"--provider",
				"rpc-demo",
				"--model",
				"model-b",
			]);
			expect(demoEnv.outputDir).toBe(PROJECT_LOG_DIR);
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(PROJECT_LOG_DIR, "pi-agent"));
			expect(demoEnv.childEnv.NPM_CONFIG_CACHE).toBe(join(PROJECT_LOG_DIR, "npm-cache"));
			expect(modelsJson.providers["rpc-demo"].baseUrl).toBe("https://llm.example.test/v1");
			expect(modelsJson.providers["rpc-demo"].api).toBe("openai-completions");
			expect(modelsJson.providers["rpc-demo"].apiKey).toBe("OPENAI_API_KEY");
			expect(modelsJson.providers["rpc-demo"].models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults to built-in OpenAI model when custom baseUrl is not configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=test-key\nPI_DEMO_LLM_PROVIDER=rpc-demo\n");

			const demoEnv = loadDemoEnv(dir, {});

			expect(demoEnv.modelsJsonPath).toBeUndefined();
			expect(demoEnv.outputDir).toBe(PROJECT_LOG_DIR);
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(PROJECT_LOG_DIR, "pi-agent"));
			expect(demoEnv.piCommand).toBe("../../node_modules/.bin/tsx");
			expect(demoEnv.childEnv.NPM_CONFIG_CACHE).toBe(join(PROJECT_LOG_DIR, "npm-cache"));
			expect(demoEnv.piArgs).toEqual([
				"../coding-agent/src/cli.ts",
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
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
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
				"../coding-agent/src/cli.ts",
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

	test("preserves an explicit npm cache from the environment", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			const configuredCacheDir = join(dir, "custom-npm-cache");
			writeFileSync(
				join(dir, ".env"),
				["PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1", "PI_DEMO_LLM_MODEL=demo-model"].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, { NPM_CONFIG_CACHE: configuredCacheDir });

			expect(demoEnv.childEnv.NPM_CONFIG_CACHE).toBe(configuredCacheDir);
			expect(demoEnv.childEnv.npm_config_cache).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resolves derived, relative, and absolute runtime output directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
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
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(join(dir, ".env"), "PI_DEMO_ENABLE_CHILD_SESSION=true\n");

			expect(() => loadDemoEnv(dir, {})).toThrow(/child session dir/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("removes --no-session and configures a child session directory when enabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
					"PI_DEMO_ENABLE_CHILD_SESSION=true",
					"PI_DEMO_CHILD_SESSION_DIR=.pi-task-console/sessions",
				].join("\n"),
			);

			const demoEnv = loadDemoEnv(dir, {});

			expect(demoEnv.enableChildSession).toBe(true);
			expect(demoEnv.piArgs.includes("--no-session")).toBe(false);
			expect(demoEnv.piArgs).toContain("--session-dir");
			expect(demoEnv.piArgs).toContain(join(dir, ".pi-task-console", "sessions"));
			expect(demoEnv.outputDir).toBe(PROJECT_LOG_DIR);
			expect(demoEnv.childEnv.PI_CODING_AGENT_DIR).toBe(join(PROJECT_LOG_DIR, "pi-agent"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console child settings", () => {
	test("writes child settings.json with retry and transport config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
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
				readonly packages: readonly string[];
			};

			expect(paths.agentDir).toBe(join(PROJECT_LOG_DIR, "pi-agent"));
			expect(paths.sessionDir).toBeUndefined();
			expect(settings.retry.enabled).toBe(true);
			expect(settings.retry.maxRetries).toBe(3);
			expect(settings.retry.baseDelayMs).toBe(2000);
			expect(settings.retry.provider.timeoutMs).toBe(300000);
			expect(settings.retry.provider.maxRetries).toBe(0);
			expect(settings.retry.provider.maxRetryDelayMs).toBe(60000);
			expect(settings.transport).toBe("sse");
			expect(settings.packages).toEqual([PI_MCP_ADAPTER_PACKAGE_SOURCE]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rpc task console persistence", () => {
	test("writes snapshot, logs, rpc events, stderr tails, and conversation messages", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			const writer = createPersistenceWriter({
				snapshotDir: join(dir, "snapshots"),
				logDir: join(dir, "logs"),
				rpcEventDir: join(dir, "rpc-events"),
				childStderrDir: join(dir, "stderr"),
				conversationDir: join(dir, "conversation"),
			});
			const steps = createDemoPlanSteps();
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

describe("rpc task console MCP package adapter", () => {
	test("prewarms MCP metadata cache from standard config before child attempts", async () => {
		const received: Array<{ readonly method: string; readonly sessionId?: string; readonly accept?: string }> = [];
		const server = createServer((request, response) => {
			void handleFakeMcpRequest(request, response, received, { mode: "json" });
		});
		const baseUrl = await listen(server);
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_OUTPUT_DIR=out",
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
					"PI_DEMO_MCP_CONFIG=.mcp.json",
					"PI_DEMO_PI_MCP_CONFIG=.pi/mcp.json",
				].join("\n"),
			);
			writeMcpPackageConfig(dir, `${baseUrl}/mcp`);

			const demoEnv = loadDemoEnv(dir, {});
			const result = await prewarmMcpMetadataCache(demoEnv.childEnv);
			const specs = readPrewarmedMcpDirectToolSpecs(demoEnv.childEnv);

			if (!result) {
				throw new Error("Expected MCP prewarm result");
			}
			expect(result.servers).toEqual(["caseTools"]);
			expect(result.toolNames).toEqual(["jcj-get-case-detail", "panel-operate", "background-check"]);
			expect(specs.map((spec) => spec.name)).toEqual(["jcj-get-case-detail", "panel-operate", "background-check"]);
			expect(createMcpDirectToolsEnvValue(["panel-operate", "read"], specs)).toBe("caseTools/panel-operate");
			expect(received.map((item) => item.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
		} finally {
			await closeServer(server);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails MCP prewarm with a clear connection error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_OUTPUT_DIR=out",
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
					"PI_DEMO_MCP_CONFIG=.mcp.json",
				].join("\n"),
			);
			writeMcpPackageConfig(dir, "http://127.0.0.1:9/mcp");

			const demoEnv = loadDemoEnv(dir, {});
			await expect(prewarmMcpMetadataCache(demoEnv.childEnv)).rejects.toThrow(/MCP prewarm failed|fetch failed/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps current POC on bare tool names and reserves future server-qualified identities", () => {
		const specs = [
			{
				name: "panel-operate",
				server: "caseTools",
				mcpTool: "panel-operate",
				adapterSpec: "caseTools/panel-operate",
			},
			{
				name: "background-check",
				server: "caseTools",
				mcpTool: "background-check",
				adapterSpec: "caseTools/background-check",
			},
		];

		expect(createMcpDirectToolsEnvValue(["panel-operate"], specs)).toBe("caseTools/panel-operate");
		expect(createMcpDirectToolsEnvValue(["background-check", "panel-operate"], specs)).toBe(
			"caseTools/background-check,caseTools/panel-operate",
		);
		expect(parseFutureMcpIdentity("$mcp_caseTools:panel-operate")).toEqual({
			server: "caseTools",
			tool: "panel-operate",
		});
		expect(createMcpDirectToolsEnvValue(["$mcp_caseTools:panel-operate"], specs)).toBe("caseTools/panel-operate");
	});
});

describe("rpc task console TaskStore", () => {
	test("initializes an idle runtime snapshot with no preselected workflow steps", () => {
		const store = TaskStore.createIdle(createInitialSteps());
		const snapshot = store.getSnapshot();

		expect(snapshot.run.status).toBe("idle");
		expect(snapshot.run.steps).toEqual([]);
		expect(snapshot.conversationMessages).toEqual([]);
	});

	test("resets to an idle snapshot for the provided selected steps and clears in-memory state", () => {
		const defaultSteps = createDemoPlanSteps();
		const replacementSteps: PlanStep[] = [
			{
				id: "step-selected",
				title: "选中步骤",
				tasks: [
					{
						id: "task-selected",
						title: "选中任务",
						description: "done",
						tools: [],
						skills: [],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const store = TaskStore.createIdle(defaultSteps);
		const run = store.startRun("run-1", "demo instruction", 100, replacementSteps);

		store.apply({
			type: "task_completed",
			runId: run.id,
			stepId: "step-selected",
			taskId: "task-selected",
			result: {
				status: "complete",
				content: "done",
				data: { text: "done" },
			},
			time: 101,
		});

		store.reset(102, replacementSteps);

		const snapshot = store.getSnapshot();
		expect(snapshot.run.id).toBe("idle");
		expect(snapshot.run.status).toBe("idle");
		expect(snapshot.run.userInstruction).toBe("");
		expect(snapshot.run.steps).toHaveLength(1);
		expect(snapshot.run.steps[0]?.id).toBe("step-selected");
		expect(snapshot.run.steps[0]?.tasks[0]?.id).toBe("task-selected");
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("loading");
		expect(snapshot.cards).toEqual([]);
		expect(snapshot.logs).toEqual([]);
		expect(snapshot.receipts).toEqual([]);
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
		const store = TaskStore.createIdle(createDemoPlanSteps());
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
			id: expect.stringMatching(UUID_PATTERN),
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
		const store = TaskStore.createIdle(createDemoPlanSteps());
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
		const store = TaskStore.createIdle(createDemoPlanSteps());
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
		const store = TaskStore.createIdle(createDemoPlanSteps());
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

	test("projects run-level stopping and replacement metadata until cleanup completes", () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "done", tools: [], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "old instruction", 100);

		store.markRunStopping(run.id, "replaced_by_new_instruction", 101, "new instruction");
		store.apply({
			type: "task_stopped",
			runId: run.id,
			stepId: "step-test",
			taskId: "task-test",
			stopped: {
				status: "stopped",
				reason: "replaced_by_new_instruction",
				message: "任务被新指令替换",
				detail: "received replacement while child was running",
			},
			time: 102,
		});

		const stoppingSnapshot = store.getSnapshot();
		expect(stoppingSnapshot.run.status).toBe("stopping");
		expect(stoppingSnapshot.run.stopReason).toBe("replaced_by_new_instruction");
		expect(stoppingSnapshot.run.replacementInstruction).toBe("new instruction");

		store.markRunStopped(run.id, 103);

		const stoppedSnapshot = store.getSnapshot();
		expect(stoppedSnapshot.run.status).toBe("stopped");
		expect(stoppedSnapshot.run.finishedAt).toBe(103);
		expect(stoppedSnapshot.run.stopReason).toBe("replaced_by_new_instruction");
		expect(stoppedSnapshot.run.replacementInstruction).toBe("new instruction");
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
		const store = TaskStore.createIdle(createDemoPlanSteps());
		store.startRun("run-1", "old", 100);
		store.startRun("run-2", "new", 200);

		store.apply({ type: "task_started", runId: "run-1", stepId: "step-1", taskId: "task-1", time: 201 });

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("loading");
		expect(
			store
				.getSnapshot()
				.logs.some(
					(log) =>
						log.type === "diagnostic" && log.message.includes("run-1") && log.message.includes("task_started"),
				),
		).toBe(true);
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
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
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
			expect(child.agentRunId).toMatch(UUID_PATTERN);
			await waitUntil(() => {
				try {
					return readFileSync(join(rpcEventDir, "run-1", `${child.agentRunId}.jsonl`), "utf8").includes(
						'"type":"agent_end"',
					);
				} catch {
					return false;
				}
			});

			const rpcEvents = readFileSync(join(rpcEventDir, "run-1", `${child.agentRunId}.jsonl`), "utf8");
			const stderrTail = readFileSync(join(childStderrDir, "run-1", `${child.agentRunId}.log`), "utf8");

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
		const store = TaskStore.createIdle(createDemoPlanSteps());
		const run = store.startRun("run-1", "demo", 100);
		const startedTaskIds: string[] = [];
		const factory = createImmediateAgentFactory(startedTaskIds);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: createDemoPlanSteps(),
			store,
			childFactory: factory,
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			runtimeConfig: {
				...DEFAULT_RUNTIME_CONFIG,
				stop_steer_timeout_ms: 0,
				stop_abort_timeout_ms: 0,
			},
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

	test("does not start later steps after the current step has a final failed task", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-one",
				title: "第一步",
				tasks: [
					{
						id: "task-fails",
						title: "失败任务",
						description: "fail",
						tools: [],
						skills: [],
						retry: { max_attempts: 1, base_delay_ms: 0, retry_on: [] },
					},
				],
			},
			{
				id: "step-two",
				title: "第二步",
				tasks: [{ id: "task-should-not-start", title: "不应启动", description: "pending", tools: [], skills: [] }],
			},
		];
		const startedTaskIds: string[] = [];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) =>
				new FakeChildAgentProcess(options, startedTaskIds, {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({ type: "prompt_response_failure", error: "final failure" });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			runtimeConfig: { ...DEFAULT_RUNTIME_CONFIG, concurrency_limit: 1 },
			now: createClock(101),
		});

		await dispatcher.run();

		expect(startedTaskIds).toEqual(["task-fails"]);
		expect(store.getSnapshot().run.status).toBe("fail");
		expect(store.getSnapshot().run.steps[0]?.status).toBe("fail");
		expect(store.getSnapshot().run.steps[1]?.status).toBe("loading");
		expect(store.getSnapshot().run.steps[1]?.tasks[0]?.attempts).toEqual([]);
	});

	test("lets active and queued sibling tasks converge after a concurrent task finally fails", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-one",
				title: "第一步",
				tasks: [
					{
						id: "task-fails",
						title: "失败任务",
						description: "fail",
						tools: [],
						skills: [],
						retry: { max_attempts: 1, base_delay_ms: 0, retry_on: [] },
					},
					{ id: "task-running", title: "运行任务", description: "running", tools: [], skills: [] },
					{ id: "task-queued", title: "排队任务", description: "queued", tools: [], skills: [] },
				],
			},
			{
				id: "step-two",
				title: "第二步",
				tasks: [{ id: "task-next-step", title: "后续任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const startedTaskIds: string[] = [];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, startedTaskIds, {
					onPrompt: (runningChild) => {
						if (options.taskId === "task-fails") {
							queueMicrotask(() => {
								runningChild.emit({ type: "prompt_response_failure", error: "final failure" });
							});
						}
						if (options.taskId === "task-running") {
							queueMicrotask(() => {
								runningChild.emit({
									type: "message_end",
									message: createAssistantMessage(JSON.stringify({ content: "sibling completed" })),
								});
								runningChild.emit({ type: "agent_end", messages: [], willRetry: false });
							});
						}
						if (options.taskId === "task-queued") {
							queueMicrotask(() => {
								runningChild.emit({ type: "prompt_response_failure", error: "queued sibling failure" });
							});
						}
					},
					onKill: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({
								type: "process_close",
								exitCode: 143,
								signal: "SIGTERM",
								stderrTail: `${options.taskId} stopped`,
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
			runtimeConfig: {
				...DEFAULT_RUNTIME_CONFIG,
				concurrency_limit: 2,
				stop_steer_timeout_ms: 0,
				stop_abort_timeout_ms: 0,
			},
			now: createClock(101),
		});

		await dispatcher.run();

		const snapshot = store.getSnapshot();
		const step = snapshot.run.steps[0];
		const failedTask = step?.tasks.find((task) => task.id === "task-fails");
		const runningSibling = step?.tasks.find((task) => task.id === "task-running");
		const queuedSibling = step?.tasks.find((task) => task.id === "task-queued");
		const allAttempts = snapshot.run.steps.flatMap((runtimeStep) =>
			runtimeStep.tasks.flatMap((task) => task.attempts),
		);

		expect(startedTaskIds.sort()).toEqual(["task-fails", "task-queued", "task-running"]);
		expect(snapshot.run.status).toBe("fail");
		expect(step?.status).toBe("fail");
		expect(failedTask?.status).toBe("fail");
		expect(runningSibling?.status).toBe("complete");
		expect(runningSibling?.stopped).toBeUndefined();
		expect(runningSibling?.attempts[0]?.status).toBe("complete");
		expect(queuedSibling?.status).toBe("fail");
		expect(queuedSibling?.stopped).toBeUndefined();
		expect(queuedSibling?.attempts[0]?.status).toBe("fail");
		expect(snapshot.run.steps[1]?.status).toBe("loading");
		expect(snapshot.run.steps[1]?.tasks[0]?.attempts).toEqual([]);
		expect(
			snapshot.run.steps.flatMap((runtimeStep) => runtimeStep.tasks).some((task) => task.status === "running"),
		).toBe(false);
		expect(allAttempts.some((attempt) => attempt.status === "running")).toBe(false);
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
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({
								type: "process_close",
								exitCode: 143,
								signal: "SIGTERM",
								stderrTail: "stopped child",
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
			runtimeConfig: {
				...DEFAULT_RUNTIME_CONFIG,
				stop_steer_timeout_ms: 0,
				stop_abort_timeout_ms: 0,
			},
			now: createClock(101),
		});

		const running = dispatcher.run();
		await waitUntil(() => children.length === 2);
		dispatcher.stop("user_stopped");
		await running;

		expect(
			children.every(
				(child) =>
					child.steerMessages.length === 1 && child.abortCount === 1 && child.killSignals.includes("SIGTERM"),
			),
		).toBe(true);
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
			runtimeConfig: {
				...DEFAULT_RUNTIME_CONFIG,
				stop_steer_timeout_ms: 0,
				stop_abort_timeout_ms: 0,
			},
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
			agentRunId: expect.stringContaining("fake-task-test"),
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
			runtimeConfig: {
				...DEFAULT_RUNTIME_CONFIG,
				stop_steer_timeout_ms: 0,
				stop_abort_timeout_ms: 0,
			},
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
			agentRunId: expect.stringContaining("fake-task-test"),
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

	test("records stop timeout diagnostics and keeps stopped tasks out of retry flow", async () => {
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
						retry: {
							max_attempts: 3,
							base_delay_ms: 0,
							retry_on: ["timeout", "process_error"],
						},
					},
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
			runtimeConfig: {
				...DEFAULT_RUNTIME_CONFIG,
				stop_steer_timeout_ms: 0,
				stop_abort_timeout_ms: 0,
			},
			now: createClock(101),
		});

		const running = dispatcher.run();
		await waitUntil(() => children.length === 1);
		dispatcher.stop("user_stopped");
		await running;

		const snapshot = store.getSnapshot();
		const task = snapshot.run.steps[0]?.tasks[0];
		expect(children[0]?.steerMessages).toHaveLength(1);
		expect(children[0]?.abortCount).toBe(1);
		expect(children[0]?.killSignals).toEqual(["SIGTERM"]);
		expect(task?.status).toBe("stopped");
		expect(task?.stopped?.reason).toBe("timeout_after_stop");
		expect(task?.attempts).toHaveLength(1);
		expect(snapshot.run.status).toBe("stopped");
		expect(
			snapshot.logs.some((log) => log.type === "diagnostic" && log.message.includes("等待 steer 停止超时")),
		).toBe(true);
		expect(
			snapshot.logs.some((log) => log.type === "diagnostic" && log.message.includes("等待 abort 停止超时")),
		).toBe(true);
		expect(snapshot.logs.some((log) => log.type === "diagnostic" && log.message.includes("timeout_after_stop"))).toBe(
			true,
		);
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
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

	test("records retry and tool error logs while filtering message update logs before final agent_end", async () => {
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
			now: createClock(101),
		});

		await dispatcher.run();

		const snapshot = store.getSnapshot();
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(snapshot.logs.some((log) => log.type === "auto_retry_start")).toBe(true);
		expect(snapshot.logs.some((log) => log.type === "auto_retry_end")).toBe(true);
		expect(snapshot.logs.some((log) => log.type === "message_update")).toBe(false);
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("fail");
		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.error?.code).toBe("validation_error");
	});

	test("does not log validation_error for assistant tool-call message_end before final text result", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: ["read"], skills: [] }],
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
							child.emit({ type: "message_end", message: createAssistantToolCallMessage() });
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
			now: createClock(101),
		});

		await dispatcher.run();

		const snapshot = store.getSnapshot();
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("complete");
		expect(snapshot.logs.some((log) => log.taskId === "task-test" && log.type === "message_end")).toBe(true);
		expect(snapshot.logs.some((log) => log.taskId === "task-test" && log.type === "validation_error")).toBe(false);
	});

	test("fails with validation_error when assistant only emits tool-call message_end before agent_end", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: ["read"], skills: [] }],
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
							child.emit({ type: "message_end", message: createAssistantToolCallMessage() });
							child.emit({ type: "agent_end", messages: [], willRetry: false });
						});
					},
				}),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
			now: createClock(101),
		});

		await dispatcher.run();

		const task = store.getSnapshot().run.steps[0]?.tasks[0];
		expect(task?.status).toBe("fail");
		expect(task?.error?.code).toBe("validation_error");
		expect(task?.error?.message).toBe("agent_end 前没有得到合法的最终 task 结果。");
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
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
			now: createClock(101),
		});

		await dispatcher.run();

		expect(store.getSnapshot().run.steps[0]?.tasks[0]?.error?.code).toBe("process_closed_before_agent_end");
	});

	test("passes a task-scoped --tools allowlist and MCP allowlist env to each child", async () => {
		const server = createServer((request, response) => {
			void handleFakeMcpRequest(request, response, [], { mode: "json" });
		});
		const baseUrl = await listen(server);
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-"));
		try {
			const childMcpConfigPath = join(dir, "mcp.json");
			const mcpCachePath = join(dir, "mcp-cache.json");
			writeMcpPackageConfig(dir, `${baseUrl}/mcp`, "mcp.json");
			const plan: PlanStep[] = [
				{
					id: "step-test",
					title: "测试步骤",
					tasks: [
						{
							id: "task-a",
							title: "任务 A",
							description: "pending",
							tools: ["panel-operate", "read"],
							skills: [],
						},
						{
							id: "task-b",
							title: "任务 B",
							description: "pending",
							tools: ["background-check"],
							skills: [],
						},
					],
				},
			];
			const store = TaskStore.createIdle(plan);
			const run = store.startRun("run-1", "demo", 100);
			const launches: ChildAgentProcessFactoryOptions[] = [];
			const env = {
				...process.env,
				PI_DEMO_CHILD_MCP_CONFIG_PATH: childMcpConfigPath,
				PI_DEMO_MCP_CACHE_PATH: mcpCachePath,
			};
			await prewarmMcpMetadataCache(env);
			const dispatcher = new TaskDispatcher({
				runId: run.id,
				userInstruction: run.userInstruction,
				steps: plan,
				store,
				childFactory: (options) => {
					launches.push(options);
					return new FakeChildAgentProcess(options, [], {
						onPrompt: (child) => {
							queueMicrotask(() => {
								child.emit({
									type: "message_end",
									message: createAssistantMessage(JSON.stringify({ content: `${options.taskId} done` })),
								});
								child.emit({ type: "agent_end", messages: [], willRetry: false });
								child.emit({
									type: "process_close",
									exitCode: 0,
									signal: null,
									stderrTail: `${options.taskId} stderr`,
								});
							});
						},
					});
				},
				command: "pi",
				args: ["--mode", "rpc", "--no-session"],
				env,
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					concurrency_limit: 1,
					minimal_system_tools: ["ls", "read"],
				},
				now: createClock(100),
			});

			await dispatcher.run();

			expect(launches).toHaveLength(2);
			expect(launches[0]?.args).toEqual(["--mode", "rpc", "--no-session", "--tools", "panel-operate,read,ls"]);
			expect(launches[0]?.env.PI_DEMO_TASK_ALLOWED_TOOLS).toBe(JSON.stringify(["panel-operate", "read", "ls"]));
			expect(launches[0]?.env[MCP_DIRECT_TOOLS_ENV]).toBe("caseTools/panel-operate");
			expect(launches[1]?.args).toEqual(["--mode", "rpc", "--no-session", "--tools", "background-check,ls,read"]);
			expect(launches[1]?.env.PI_DEMO_TASK_ALLOWED_TOOLS).toBe(JSON.stringify(["background-check", "ls", "read"]));
			expect(launches[1]?.env[MCP_DIRECT_TOOLS_ENV]).toBe("caseTools/background-check");
		} finally {
			await closeServer(server);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects the MCP proxy tool in task allowlists", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-a", title: "任务 A", description: "pending", tools: ["mcp"], skills: [] }],
			},
		];
		const store = TaskStore.createIdle(plan);
		const run = store.startRun("run-1", "demo", 100);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction: run.userInstruction,
			steps: plan,
			store,
			childFactory: (options) => new FakeChildAgentProcess(options, []),
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
			env: process.env,
			runtimeConfig: DEFAULT_RUNTIME_CONFIG,
			now: createClock(100),
		});

		await expect(dispatcher.run()).rejects.toThrow(/must not allow.*mcp/i);
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

function writeMcpPackageConfig(dir: string, url: string, fileName = ".mcp.json"): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(dir, fileName),
		JSON.stringify(
			{
				settings: {
					toolPrefix: "none",
					directTools: true,
					disableProxyTool: true,
					sampling: false,
				},
				mcpServers: {
					caseTools: {
						url,
						auth: false,
						lifecycle: "lazy",
						exposeResources: false,
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(dir, ".pi", "mcp.json"),
		JSON.stringify(
			{
				settings: {
					toolPrefix: "none",
					directTools: true,
					disableProxyTool: true,
					sampling: false,
				},
			},
			null,
			2,
		),
	);
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

function createAssistantToolCallMessage() {
	return {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "README.md" } }],
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
		stopReason: "toolUse" as const,
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
	readonly processId: number;
	readonly killSignals: NodeJS.Signals[] = [];
	readonly steerMessages: string[] = [];
	abortCount = 0;
	private readonly options: ChildAgentProcessFactoryOptions;
	private readonly startedTaskIds: string[];
	private readonly hooks: FakeChildHooks | undefined;

	constructor(options: ChildAgentProcessFactoryOptions, startedTaskIds: string[], hooks?: FakeChildHooks) {
		this.options = options;
		this.startedTaskIds = startedTaskIds;
		this.hooks = hooks;
		this.agentRunId = `fake-${options.taskId}`;
		this.processId = hooks?.processId ?? 1234;
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
		this.steerMessages.push(_message);
		this.hooks?.onSteer?.(this, _message);
		return `steer-${this.options.taskId}`;
	}

	sendAbort(): string {
		this.abortCount += 1;
		this.hooks?.onAbort?.(this);
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
	readonly processId?: number;
	readonly onStart?: (child: FakeChildAgentProcess) => void;
	readonly onPrompt?: (child: FakeChildAgentProcess) => void;
	readonly onSteer?: (child: FakeChildAgentProcess, message: string) => void;
	readonly onAbort?: (child: FakeChildAgentProcess) => void;
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
			steps: createDemoPlanSteps(),
			demoEnv: createDemoEnv(),
			childFactory: createImmediateAgentFactory([]),
			now: createClock(100),
		});

		const run = manager.start("demo");
		await manager.waitForIdle();

		expect(run.id).toMatch(UUID_PATTERN);
		expect(manager.getSnapshot().run.id).toBe(run.id);
		expect(manager.getSnapshot().run.status).toBe("fail");
		expect(manager.getSnapshot().cards.length).toBe(4);
	});

	test("persists latest snapshot, task logs, and conversation messages during a real run without duplicates", async () => {
		const outputDir = mkdtempSync(join(tmpdir(), "pi-task-console-run-manager-"));
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

	test("reset clears in-memory snapshot without deleting local persistence files", async () => {
		const outputDir = mkdtempSync(join(tmpdir(), "pi-task-console-reset-persistence-"));
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
								message: createAssistantMessage(JSON.stringify({ content: "persisted", data: { text: "ok" } })),
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
			const snapshotPath = join(outputDir, "snapshots", `${run.id}.json`);
			const logPath = join(outputDir, "logs", `${run.id}.jsonl`);
			const conversationPath = join(outputDir, "conversation", `${run.id}.jsonl`);
			expect(existsSync(snapshotPath)).toBe(true);
			expect(existsSync(logPath)).toBe(true);
			expect(existsSync(conversationPath)).toBe(true);

			manager.reset();
			await manager.waitForIdle();

			const resetSnapshot = manager.getSnapshot();
			expect(resetSnapshot.run.status).toBe("idle");
			expect(resetSnapshot.cards).toEqual([]);
			expect(resetSnapshot.logs).toEqual([]);
			expect(resetSnapshot.receipts).toEqual([]);
			expect(resetSnapshot.conversationMessages).toEqual([]);
			expect(existsSync(snapshotPath)).toBe(true);
			expect(existsSync(logPath)).toBe(true);
			expect(existsSync(conversationPath)).toBe(true);
		} finally {
			rmSync(outputDir, { recursive: true, force: true });
		}
	});

	test("replaces a running instruction without letting stale events mutate the new run", async () => {
		const children: FakeChildAgentProcess[] = [];
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [{ id: "task-test", title: "测试任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const manager = new RunManager({
			steps: plan,
			demoEnv: createDemoEnv(undefined, {
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					concurrency_limit: 1,
					stop_steer_timeout_ms: 0,
					stop_abort_timeout_ms: 0,
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						if (children.length === 1) {
							queueMicrotask(() => {
								runningChild.emit({
									type: "process_close",
									exitCode: 143,
									signal: "SIGTERM",
									stderrTail: "old run killed",
								});
							});
						}
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		const oldRun = manager.start("old instruction");
		await waitUntil(() => children.length === 1);
		const newRun = manager.start("new instruction");

		const stoppingSnapshot = manager.getSnapshot();
		expect(stoppingSnapshot.run.id).toBe(oldRun.id);
		expect(stoppingSnapshot.run.status).toBe("stopping");
		expect(stoppingSnapshot.run.stopReason).toBe("replaced_by_new_instruction");
		expect(stoppingSnapshot.run.replacementInstruction).toBe("new instruction");

		await waitUntil(() => children.length === 2 && manager.getSnapshot().run.id === newRun.id);
		expect(newRun.id).not.toBe(oldRun.id);
		expect(manager.getSnapshot().run.userInstruction).toBe("new instruction");
		expect(manager.getSnapshot().run.steps[0]?.tasks[0]?.status).toBe("running");
		expect(manager.getSnapshot().run.steps[0]?.tasks[0]?.process).toBeUndefined();

		children[0]?.emit({
			type: "message_update",
			message: createAssistantMessage("late old partial"),
			assistantMessageEvent: { type: "text_delta", delta: "late old partial" },
		});
		children[0]?.emit({ type: "agent_end", messages: [], willRetry: false });
		children[0]?.emit({
			type: "process_close",
			exitCode: 143,
			signal: "SIGTERM",
			stderrTail: "late old close",
		});

		const afterStaleEvents = manager.getSnapshot();
		expect(afterStaleEvents.run.id).toBe(newRun.id);
		expect(afterStaleEvents.run.steps[0]?.tasks[0]?.status).toBe("running");
		expect(afterStaleEvents.run.steps[0]?.tasks[0]?.process).toBeUndefined();

		children[1]?.emit({
			type: "message_end",
			message: createAssistantMessage(JSON.stringify({ content: "new run done" })),
		});
		children[1]?.emit({ type: "agent_end", messages: [], willRetry: false });
		children[1]?.emit({
			type: "process_close",
			exitCode: 0,
			signal: null,
			stderrTail: "new run close",
		});
		await manager.waitForIdle();
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
		expect(manager.getSnapshot().logs).toEqual([]);
		expect(manager.getSnapshot().receipts).toEqual([]);
		expect(manager.getSnapshot().conversationMessages).toEqual([]);
	});

	test("reset during replacement keeps the selected idle snapshot and prevents pending replacement start", async () => {
		const oldSteps: PlanStep[] = [
			{
				id: "step-old",
				title: "旧步骤",
				tasks: [{ id: "task-old", title: "旧任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const replacementSteps: PlanStep[] = [
			{
				id: "step-replacement",
				title: "替换步骤",
				tasks: [{ id: "task-replacement", title: "替换任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const resetSteps: PlanStep[] = [
			{
				id: "step-reset",
				title: "重置步骤",
				tasks: [{ id: "task-reset", title: "重置任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			steps: oldSteps,
			demoEnv: createDemoEnv(undefined, {
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					concurrency_limit: 1,
					stop_steer_timeout_ms: 0,
					stop_abort_timeout_ms: 0,
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "late old done" })),
							});
							runningChild.emit({ type: "agent_end", messages: [], willRetry: false });
							runningChild.emit({
								type: "process_close",
								exitCode: 143,
								signal: "SIGTERM",
								stderrTail: "late old close",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		manager.start("old instruction", oldSteps);
		await waitUntil(() => children.length === 1);
		manager.replace("replacement instruction", replacementSteps);
		manager.reset(resetSteps);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});

		const snapshot = manager.getSnapshot();
		expect(children).toHaveLength(1);
		expect(snapshot.run.id).toBe("idle");
		expect(snapshot.run.status).toBe("idle");
		expect(snapshot.run.steps.map((step) => step.id)).toEqual(["step-reset"]);
		expect(snapshot.run.steps[0]?.tasks[0]?.status).toBe("loading");
		expect(snapshot.cards).toEqual([]);
		expect(snapshot.logs).toEqual([]);
		expect(snapshot.receipts).toEqual([]);
		expect(snapshot.conversationMessages).toEqual([]);
	});

	test("uses route-selected steps as the source of truth for start, replace, and reset snapshots", async () => {
		const oldSteps: PlanStep[] = [
			{
				id: "step-old",
				title: "旧步骤",
				tasks: [{ id: "task-old", title: "旧任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const newSteps: PlanStep[] = [
			{
				id: "step-new",
				title: "新步骤",
				tasks: [
					{
						id: "task-new",
						title: "新任务",
						description: "done",
						tools: [],
						skills: [],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			steps: createDemoPlanSteps(),
			demoEnv: createDemoEnv(undefined, {
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					concurrency_limit: 1,
					stop_steer_timeout_ms: 0,
					stop_abort_timeout_ms: 0,
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						if (children.length === 1) {
							queueMicrotask(() => {
								runningChild.emit({
									type: "process_close",
									exitCode: 143,
									signal: "SIGTERM",
									stderrTail: "old run killed",
								});
							});
						}
					},
					onPrompt: (runningChild) => {
						if (options.taskId !== "task-new") {
							return;
						}
						queueMicrotask(() => {
							runningChild.emit({
								type: "message_end",
								message: createAssistantMessage(
									JSON.stringify({ content: "new run done", data: { text: "ok" } }),
								),
							});
							runningChild.emit({ type: "agent_end", messages: [], willRetry: false });
							runningChild.emit({
								type: "process_close",
								exitCode: 0,
								signal: null,
								stderrTail: "new run close",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		const oldRun = manager.start("old instruction", oldSteps);
		await waitUntil(() => children.length === 1);
		expect(manager.getSnapshot().run.steps.map((step) => step.id)).toEqual(["step-old"]);

		manager.start("new instruction", newSteps);
		await waitUntil(() => children.length === 2 && manager.getSnapshot().run.id !== oldRun.id);
		expect(manager.getSnapshot().run.userInstruction).toBe("new instruction");
		expect(manager.getSnapshot().run.steps.map((step) => step.id)).toEqual(["step-new"]);

		await manager.waitForIdle();
		manager.reset();

		const snapshot = manager.getSnapshot();
		expect(snapshot.run.status).toBe("idle");
		expect(snapshot.run.steps.map((step) => step.id)).toEqual(["step-new"]);
		expect(snapshot.cards).toEqual([]);
		expect(snapshot.logs).toEqual([]);
		expect(snapshot.receipts).toEqual([]);
		expect(snapshot.conversationMessages).toEqual([]);
	});

	test("respects runtime concurrency limit and stops queued tasks before they start", async () => {
		const plan: PlanStep[] = [
			{
				id: "step-test",
				title: "测试步骤",
				tasks: [
					{ id: "task-a", title: "任务 A", description: "pending", tools: [], skills: [] },
					{ id: "task-b", title: "任务 B", description: "pending", tools: [], skills: [] },
					{ id: "task-c", title: "任务 C", description: "pending", tools: [], skills: [] },
				],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			steps: plan,
			demoEnv: createDemoEnv(undefined, {
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					concurrency_limit: 1,
					stop_steer_timeout_ms: 0,
					stop_abort_timeout_ms: 0,
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({
								type: "process_close",
								exitCode: 143,
								signal: "SIGTERM",
								stderrTail: "stopped before queued launch",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		manager.start("demo");
		await waitUntil(() => children.length >= 1);
		manager.stop("user_stopped");
		await manager.waitForIdle();

		const tasks = manager.getSnapshot().run.steps[0]?.tasks ?? [];
		expect(children).toHaveLength(1);
		expect(tasks.map((task) => task.status)).toEqual(["stopped", "stopped", "stopped"]);
		expect(tasks[1]?.attempts).toEqual([]);
		expect(tasks[2]?.attempts).toEqual([]);
		expect(
			manager
				.getSnapshot()
				.logs.some((log) => log.type === "diagnostic" && log.message.includes("未启动") && log.taskId === "task-b"),
		).toBe(true);
	});

	test("retries failed attempts with a fresh child process and preserves attempt metadata", async () => {
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
						retry: {
							max_attempts: 2,
							base_delay_ms: 0,
							retry_on: ["process_error"],
						},
					},
				],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			steps: plan,
			demoEnv: createDemoEnv(undefined, {
				enableChildSession: true,
				childSessionDir: "/tmp/pi-task-console-session",
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					retry: {
						...DEFAULT_RUNTIME_CONFIG.retry,
						max_attempts: 3,
						base_delay_ms: 10,
						retry_on: ["process_error", "timeout"],
					},
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					processId: 2000 + children.length,
					onPrompt: (runningChild) => {
						queueMicrotask(() => {
							if (children.length === 1) {
								runningChild.emit({
									type: "process_error",
									error: "attempt one failed",
									stderrTail: "attempt one stderr",
								});
								runningChild.emit({
									type: "process_close",
									exitCode: 1,
									signal: null,
									stderrTail: "attempt one stderr",
								});
								return;
							}
							runningChild.emit({
								type: "message_end",
								message: createAssistantMessage(JSON.stringify({ content: "done" })),
							});
							runningChild.emit({ type: "agent_end", messages: [], willRetry: false });
							runningChild.emit({
								type: "process_close",
								exitCode: 0,
								signal: null,
								stderrTail: "attempt two stderr",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		manager.start("demo");
		await manager.waitForIdle();

		const task = manager.getSnapshot().run.steps[0]?.tasks[0];
		expect(manager.getSnapshot().run.status).toBe("complete");
		expect(children).toHaveLength(2);
		expect(task?.attempts).toHaveLength(2);
		expect(task?.attempts[0]).toMatchObject({
			attempt: 1,
			status: "fail",
			errorCode: "process_error",
			agent: {
				processId: 2000,
				sessionDir: "/tmp/pi-task-console-session",
			},
		});
		expect(task?.attempts[1]).toMatchObject({
			attempt: 2,
			status: "complete",
			agent: {
				processId: 2001,
				sessionDir: "/tmp/pi-task-console-session",
			},
		});
		expect(task?.attempts[0]?.id).not.toBe(task?.attempts[1]?.id);
	});

	test("aborts attempts that exceed max_tool_calls and does not retry when retry_on is empty", async () => {
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
						skills: [],
						retry: {
							max_attempts: 3,
							base_delay_ms: 0,
							max_tool_calls: 1,
							retry_on: [],
						},
					},
				],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			steps: plan,
			demoEnv: createDemoEnv(undefined, {
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					stop_abort_timeout_ms: 0,
					retry: {
						...DEFAULT_RUNTIME_CONFIG.retry,
						max_attempts: 5,
						max_tool_calls: 99,
						retry_on: ["tool_limit_exceeded", "process_error"],
					},
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onPrompt: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read" });
							runningChild.emit({ type: "tool_execution_start", toolCallId: "tool-2", toolName: "read" });
							runningChild.emit({
								type: "process_close",
								exitCode: 1,
								signal: null,
								stderrTail: "tool limit close",
							});
						});
					},
					onAbort: (runningChild) => {
						queueMicrotask(() => {
							runningChild.emit({
								type: "process_close",
								exitCode: 143,
								signal: "SIGTERM",
								stderrTail: "tool limit abort",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});

		manager.start("demo");
		await manager.waitForIdle();

		const task = manager.getSnapshot().run.steps[0]?.tasks[0];
		expect(children).toHaveLength(1);
		expect(children[0]?.abortCount).toBe(1);
		expect(task?.status).toBe("fail");
		expect(task?.error?.code).toBe("tool_limit_exceeded");
		expect(task?.attempts).toHaveLength(1);
		expect(task?.attempts[0]).toMatchObject({
			attempt: 1,
			status: "fail",
			toolCallCount: 2,
			errorCode: "tool_limit_exceeded",
		});
	});
});

function createDemoEnv(
	exampleDir = mkdtempSync(join(tmpdir(), "pi-task-console-demo-env-")),
	overrides: Partial<RpcTaskConsoleEnv> = {},
): RpcTaskConsoleEnv {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...overrides.childEnv };
	if (overrides.childSessionDir) {
		childEnv.PI_DEMO_CHILD_SESSION_DIR = overrides.childSessionDir;
		childEnv.PI_CODING_AGENT_SESSION_DIR = overrides.childSessionDir;
	}
	return {
		exampleDir,
		port: 4175,
		piCommand: "pi",
		piArgs: ["--mode", "rpc", "--no-session"],
		childEnv,
		outputDir: join(exampleDir, ".pi-task-console"),
		snapshotDir: join(exampleDir, "snapshots"),
		logDir: join(exampleDir, "logs"),
		rpcEventDir: join(exampleDir, "rpc-events"),
		childStderrDir: join(exampleDir, "stderr"),
		conversationDir: join(exampleDir, "conversation"),
		childAgentDir: join(exampleDir, "pi-agent"),
		childSessionDir: overrides.childSessionDir,
		enableChildSession: false,
		runtimeConfigPath: join(exampleDir, "runtime.config.json"),
		runtimeConfig: DEFAULT_RUNTIME_CONFIG,
		childSettingsPath: join(exampleDir, "pi-agent", "settings.json"),
		...overrides,
	};
}

interface FrontendHarnessFetchCall {
	readonly path: string;
	readonly init?: RequestInit;
}

interface FrontendHarness {
	readonly instruction: FakeTextAreaElement;
	readonly mainAction: FakeButtonElement;
	readonly testRun: FakeButtonElement;
	readonly fetchCalls: FrontendHarnessFetchCall[];
	readonly alerts: string[];
	readonly initPromise: Promise<void>;
	readonly setSnapshot: (snapshot: TaskSnapshot) => void;
	readonly setRequestPending: (value: boolean) => void;
	readonly submitComposer: () => void;
	readonly clickTestRun: () => void;
	readonly getTestRunText: () => string;
	readonly getTestRunTitle: () => string | null;
	readonly getTestRunAriaLabel: () => string | null;
}

type FakeDataset = Record<string, string>;
type FakeResizeObserverEntry = { readonly contentRect: { readonly width: number } };
type FakeResizeObserverCallback = (entries: readonly FakeResizeObserverEntry[]) => void;

function createFrontendHarness(): FrontendHarness {
	const html = readConsoleAsset("index.html");
	const app = readConsoleAsset("app.js").replace(
		"void initializePoliceWorkflow();",
		"const __initPromise = initializePoliceWorkflow();",
	);
	const alerts: string[] = [];
	const fetchCalls: FrontendHarnessFetchCall[] = [];
	const workflowPayload = {
		steps: createDemoPlanSteps(),
		defaultUserInstruction: "默认测试指令",
	};

	const instruction = new FakeTextAreaElement({ selector: "[data-instruction]", value: "" });
	const mainActionText = new FakeElement({ selector: "[data-main-action-text]" });
	const mainAction = new FakeButtonElement({
		selector: "[data-main-action]",
		childrenBySelector: {
			"[data-main-action-text]": mainActionText,
		},
	});
	const resetRun = new FakeButtonElement({ selector: "[data-reset-run]" });
	const testRun = new FakeButtonElement({ selector: "[data-test-run]", textContent: "测试" });
	const runStatusText = new FakeElement({ selector: "[data-run-status-text]" });
	const runStatusSymbol = new FakeElement({ selector: ".status-symbol", textContent: "○" });
	const runStatus = new FakeElement({
		selector: "[data-run-status]",
		childrenBySelector: {
			".status-symbol": runStatusSymbol,
			"[data-run-status-text]": runStatusText,
		},
	});
	const composer = new FakeFormElement({ selector: "[data-composer]" });
	const messages = new FakeElement({ selector: "[data-messages]" });
	const flowList = new FakeElement({ selector: "[data-flow-list]" });
	const totalProgress = new FakeElement({ selector: "[data-total-progress]" });
	const selectedTask = new FakeElement({ selector: "[data-selected-task]" });
	const cardBoard = new FakeElement({ selector: "[data-card-board]" });
	const cardGrid = new FakeElement({ selector: "[data-card-grid]" });
	const rail = new FakeButtonElement({ selector: "[data-rail]" });
	const toggleButtons = [
		new FakeButtonElement({ selector: "[data-toggle-control]" }),
		new FakeButtonElement({ selector: "[data-toggle-control]" }),
	];
	const sidebarTabs = [
		new FakeButtonElement({ selector: '[data-sidebar-tab="smart"]', dataset: { sidebarTab: "smart" } }),
		new FakeButtonElement({ selector: '[data-sidebar-tab="history"]', dataset: { sidebarTab: "history" } }),
		new FakeButtonElement({ selector: '[data-sidebar-tab="todo"]', dataset: { sidebarTab: "todo" } }),
	];
	const tabPanels = [
		new FakeElement({ selector: '[data-tab-panel="smart"]', dataset: { tabPanel: "smart" } }),
		new FakeElement({ selector: '[data-tab-panel="history"]', dataset: { tabPanel: "history" } }),
		new FakeElement({ selector: '[data-tab-panel="todo"]', dataset: { tabPanel: "todo" } }),
	];

	const document = new FakeDocument(
		{
			"[data-card-board]": cardBoard,
			"[data-card-grid]": cardGrid,
			"[data-messages]": messages,
			"[data-flow-list]": flowList,
			"[data-total-progress]": totalProgress,
			"[data-selected-task]": selectedTask,
			"[data-run-status]": runStatus,
			"[data-run-status-text]": runStatusText,
			"[data-instruction]": instruction,
			"[data-main-action]": mainAction,
			"[data-main-action-text]": mainActionText,
			"[data-reset-run]": resetRun,
			"[data-test-run]": testRun,
			"[data-composer]": composer,
			"[data-rail]": rail,
		},
		{
			"[data-toggle-control]": toggleButtons,
			"[data-sidebar-tab]": sidebarTabs,
			"[data-tab-panel]": tabPanels,
		},
	);
	const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
		fetchCalls.push({ path, init });
		if (path === "/police-workflow.json") {
			return createJsonResponse(workflowPayload);
		}
		if (path === "/runs/start") {
			return createJsonResponse({ ok: true }, 202);
		}
		if (path === "/runs/stop") {
			return createJsonResponse({ ok: true }, 200);
		}
		if (path === "/runs/reset") {
			return createJsonResponse({ ok: true }, 200);
		}
		throw new Error(`Unexpected fetch path: ${path}`);
	};
	const windowObject = {
		matchMedia: () => ({ matches: false }),
		addEventListener: () => undefined,
		alert: (message: string) => {
			alerts.push(message);
		},
		getComputedStyle: () => ({ maxHeight: "144" }),
		innerHeight: 900,
		innerWidth: 1440,
		CSS: { escape: (value: string) => value },
	};
	class FakeEventSource {
		addEventListener(_name: string, _handler: (event: { readonly data?: string }) => void): void {}
	}
	class FakeResizeObserver {
		readonly callback: FakeResizeObserverCallback;

		constructor(callback: FakeResizeObserverCallback) {
			this.callback = callback;
		}

		observe(_target: FakeElement): void {}
	}
	const bootstrap = new Function(
		"document",
		"window",
		"fetch",
		"EventSource",
		"ResizeObserver",
		"HTMLElement",
		"HTMLButtonElement",
		"HTMLTextAreaElement",
		"HTMLFormElement",
		"console",
		`${app}
return {
	initPromise: __initPromise,
	setSnapshot: (snapshot) => {
		latestSnapshot = snapshot;
		updateActionState();
	},
	setRequestPending: (value) => {
		requestPending = value;
		updateActionState();
	},
	submitComposer: () => {
		elements.composer.dispatchEvent({
			type: "submit",
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
		});
	},
	clickTestRun: () => {
		elements.testRun.dispatchEvent({ type: "click" });
	},
	getTestRunText: () => elements.testRun.textContent,
	getTestRunTitle: () => elements.testRun.title,
	getTestRunAriaLabel: () => elements.testRun.getAttribute("aria-label"),
};`,
	);
	const runtime = bootstrap(
		document,
		windowObject,
		fetch,
		FakeEventSource,
		FakeResizeObserver,
		FakeElement,
		FakeButtonElement,
		FakeTextAreaElement,
		FakeFormElement,
		console,
	) as Omit<FrontendHarness, "instruction" | "mainAction" | "testRun" | "fetchCalls" | "alerts">;

	expect(html).toContain("data-test-run");

	return {
		...runtime,
		instruction,
		mainAction,
		testRun,
		fetchCalls,
		alerts,
	};
}

class FakeClassList {
	private readonly values = new Set<string>();

	toggle(name: string, force?: boolean): boolean {
		const shouldAdd = force ?? !this.values.has(name);
		if (shouldAdd) {
			this.values.add(name);
			return true;
		}
		this.values.delete(name);
		return false;
	}

	add(...names: string[]): void {
		for (const name of names) {
			this.values.add(name);
		}
	}

	remove(...names: string[]): void {
		for (const name of names) {
			this.values.delete(name);
		}
	}
}

class FakeStyle {
	private readonly values = new Map<string, string>();
	height = "";
	overflowY = "";

	setProperty(name: string, value: string): void {
		this.values.set(name, value);
	}

	removeProperty(name: string): void {
		this.values.delete(name);
	}
}

class FakeElement {
	readonly dataset: FakeDataset;
	readonly style = new FakeStyle();
	readonly classList = new FakeClassList();
	readonly childrenBySelector: Map<string, FakeElement>;
	readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
	readonly attributes = new Map<string, string>();
	textContent: string;
	title = "";
	innerHTML = "";
	hidden = false;
	tabIndex = 0;
	offsetHeight = 36;
	scrollHeight = 38;
	clientWidth = 1200;
	scrollTop = 0;
	scrollHeightValue = 0;

	constructor(
		options: {
			readonly selector?: string;
			readonly dataset?: Record<string, string>;
			readonly textContent?: string;
			readonly childrenBySelector?: Record<string, FakeElement>;
		} = {},
	) {
		this.dataset = { ...(options.dataset ?? {}) };
		this.textContent = options.textContent ?? "";
		this.childrenBySelector = new Map(Object.entries(options.childrenBySelector ?? {}));
		if (options.selector) {
			this.attributes.set("data-selector", options.selector);
		}
	}

	addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
		const existing = this.listeners.get(type) ?? [];
		existing.push(listener);
		this.listeners.set(type, existing);
	}

	dispatchEvent(event: Record<string, unknown>): void {
		const listeners = this.listeners.get(String(event.type)) ?? [];
		for (const listener of listeners) {
			listener(event);
		}
	}

	querySelector(selector: string): FakeElement | null {
		return this.childrenBySelector.get(selector) ?? null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		const child = this.childrenBySelector.get(selector);
		return child ? [child] : [];
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
		if (name === "title") {
			this.title = value;
		}
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	append(_node: FakeElement): void {}

	appendChild(node: FakeElement): FakeElement {
		return node;
	}

	replaceChildren(..._nodes: FakeElement[]): void {}

	getBoundingClientRect() {
		return {
			x: 0,
			y: 0,
			width: 120,
			height: 36,
			top: 0,
			right: 120,
			bottom: 36,
			left: 0,
			toJSON: () => ({}),
		};
	}

	hasPointerCapture(_pointerId: number): boolean {
		return false;
	}

	setPointerCapture(_pointerId: number): void {}

	releasePointerCapture(_pointerId: number): void {}
}

class FakeButtonElement extends FakeElement {
	disabled = false;
}

class FakeTextAreaElement extends FakeElement {
	disabled = false;
	value: string;

	constructor(options: ConstructorParameters<typeof FakeElement>[0] & { readonly value?: string } = {}) {
		super(options);
		this.value = options.value ?? "";
	}
}

class FakeFormElement extends FakeElement {}

class FakeDocument {
	readonly body = new FakeElement();
	readonly documentElement = new FakeElement();
	private readonly elementsBySelector: Record<string, FakeElement>;
	private readonly arraysBySelector: Record<string, FakeElement[]>;

	constructor(elementsBySelector: Record<string, FakeElement>, arraysBySelector: Record<string, FakeElement[]>) {
		this.elementsBySelector = elementsBySelector;
		this.arraysBySelector = arraysBySelector;
	}

	querySelector(selector: string): FakeElement | null {
		return this.elementsBySelector[selector] ?? null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		return this.arraysBySelector[selector] ?? [];
	}

	createDocumentFragment() {
		return {
			childNodes: [],
			append: (..._nodes: unknown[]) => undefined,
		};
	}

	createElement(_tagName: string): FakeElement {
		return new FakeElement();
	}
}

function createJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("rpc task console frontend static contracts", () => {
	test("renders backend conversation messages and receipts without rendering freeform user instructions", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const renderMessages = extractFunctionSource(app, "renderMessages");

		expect(renderMessages).toContain("snapshot.receipts ?? []");
		expect(renderMessages).toContain("snapshot.conversationMessages ?? []");
		expect(renderMessages).toContain("resolveTaskTitle(snapshot.run.steps, message.taskId)");
		expect(renderMessages).not.toContain("userInstruction");
		expect(html).not.toContain("等待后端回执。");
		expect(renderMessages).not.toContain("empty-message");
		expect(html).not.toContain("主 agent");
		expect(html).not.toContain("free-chat");
	});

	test("keeps canonical route usage while the sidebar composer is a placeholder and the top-right test button owns start-stop", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const setupComposer = extractFunctionSource(app, "setupComposer");
		const startPoliceWorkflowTest = extractFunctionSource(app, "startPoliceWorkflowTest");
		const postStop = extractFunctionSource(app, "postStop");
		const postReset = extractFunctionSource(app, "postReset");
		const updateActionState = extractFunctionSource(app, "updateActionState");
		const topActionsStart = html.indexOf('class="top-actions"');
		const sidePanelStart = html.indexOf('class="side-panel"');

		expect(html).toContain("data-main-action");
		expect(html).toContain("data-reset-run");
		expect(topActionsStart).toBeGreaterThan(-1);
		expect(sidePanelStart).toBeGreaterThan(topActionsStart);
		expect(html.indexOf("data-reset-run")).toBeLessThan(sidePanelStart);
		expect(html.indexOf("data-test-run")).toBeLessThan(html.indexOf("data-reset-run"));
		expect(html).not.toContain("data-stop");
		expect(html).not.toContain("data-submit");
		expect(setupComposer).toContain("showConversationUnsupportedNotice()");
		expect(app).toContain('window.alert("暂不支持对话功能")');
		expect(setupComposer).not.toContain("postPrimaryAction");
		expect(setupComposer).toContain("postReset()");
		expect(startPoliceWorkflowTest).toContain('"/runs/start"');
		expect(startPoliceWorkflowTest).toContain("steps: workflow.steps");
		expect(startPoliceWorkflowTest).toContain("userInstruction: instruction");
		expect(postStop).toContain('fetch("/runs/stop"');
		expect(postReset).toContain('fetch("/runs/reset", { method: "POST" })');
		expect(updateActionState).toContain("elements.mainAction.disabled");
		expect(updateActionState).toContain("elements.resetRun.disabled");
		expect(updateActionState).toContain("elements.testRun.disabled");
		expect(updateActionState).toContain('status === "running"');
		expect(updateActionState).toContain('status === "stopping"');
		expect(app).not.toContain("/api/");
	});

	test("renders reset snapshots back to an empty card workspace", () => {
		const app = readConsoleAsset("app.js");
		const renderSnapshot = extractFunctionSource(app, "renderSnapshot");
		const renderCards = extractFunctionSource(app, "renderCards");
		const updateSelectedTask = extractFunctionSource(app, "updateSelectedTask");
		const getOrCreateTaskNode = extractFunctionSource(app, "getOrCreateTaskNode");

		expect(renderSnapshot).toContain("isResetIdleSnapshot(snapshot)");
		expect(renderSnapshot).toContain("selectedTaskId = undefined");
		expect(renderSnapshot).toContain("steps: []");
		expect(renderSnapshot).toContain("updateSelectedTask(displayRun)");
		expect(renderSnapshot).toContain("renderFlow(displayRun.steps)");
		expect(renderSnapshot).not.toContain("updateSelectedTask(snapshot.run)");
		expect(renderSnapshot).not.toContain("renderFlow(snapshot.run.steps)");
		expect(renderSnapshot).toContain("renderCards(snapshot.cards)");
		expect(updateSelectedTask).toContain('run.status === "running" || run.status === "stopping"');
		expect(updateSelectedTask).not.toContain("tasks[0]?.id");
		expect(getOrCreateTaskNode).toContain("updateSelectedTask(latestSnapshot.run)");
		expect(renderCards).toContain("cards.length === 0");
		expect(renderCards).toContain("cardUiState.clear()");
		expect(renderCards).toContain("data-empty-state>暂无业务卡片");
	});

	test("renders all first-version card types, including media GBID references", () => {
		const app = readConsoleAsset("app.js");
		const renderCardBody = extractFunctionSource(app, "renderCardBody");

		expect(renderCardBody).toContain('card.type === "media"');
		expect(renderCardBody).toContain('card.type === "map"');
		expect(renderCardBody).toContain('card.type === "table"');
		expect(renderCardBody).toContain('card.type === "text"');
		expect(renderCardBody).toContain("json-stack");
		expect(renderCardBody).toContain("card.data?.gbids");
		expect(renderCardBody).toContain("media-ref");
		expect(renderCardBody).toContain("监控引用数据，不拉取视频流字节");
	});

	test("updates selected task and workflow row status text, title, and accessibility metadata", () => {
		const app = readConsoleAsset("app.js");
		const css = readConsoleAsset("styles.css");
		const updateSelectedTask = extractFunctionSource(app, "updateSelectedTask");
		const getOrCreateTaskNode = extractFunctionSource(app, "getOrCreateTaskNode");
		const updateTaskNode = extractFunctionSource(app, "updateTaskNode");

		expect(updateSelectedTask).toContain("statusText[selected.status]");
		expect(updateSelectedTask).toContain("elements.selectedTask.textContent");
		expect(updateSelectedTask).toContain("elements.selectedTask.title");
		expect(updateSelectedTask).toContain('setAttribute(\n      "aria-label"');
		expect(getOrCreateTaskNode).toContain("data-task-status");
		expect(getOrCreateTaskNode).not.toContain("<p>");
		expect(updateTaskNode).toContain("taskNode.title");
		expect(updateTaskNode).toContain('taskNode.setAttribute("aria-label"');
		expect(updateTaskNode).toContain('taskNode.setAttribute("aria-current"');
		expect(updateTaskNode).toContain('marker.setAttribute("aria-hidden", "true")');
		expect(updateTaskNode).toContain('const text = taskNode.querySelector("[data-task-status]")');
		expect(updateTaskNode).toContain("text.textContent = `状态：");
		expect(css).toContain(".sr-only");
	});

	test("uses sidebar-level collaboration tabs for smart content, history, and todo without faking data", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const css = readConsoleAsset("styles.css");
		const setupSidebarTabs = extractFunctionSource(app, "setupSidebarTabs");
		const renderSidebarTabs = extractFunctionSource(app, "renderSidebarTabs");
		const controlFullStart = html.indexOf('class="control-full"');
		const tabListStart = html.indexOf('class="tab-list"');
		const smartPanelStart = html.indexOf('data-tab-panel="smart"');
		const historyPanelStart = html.indexOf('data-tab-panel="history"');

		expect(html).toContain('role="tablist"');
		expect(html).toContain('data-sidebar-tab="smart"');
		expect(html).toContain('data-sidebar-tab="history"');
		expect(html).toContain('data-sidebar-tab="todo"');
		expect(html).toContain('data-tab-panel="smart"');
		expect(html).toContain('data-tab-panel="history"');
		expect(html).toContain('data-tab-panel="todo"');
		expect(html).toContain("暂无历史会话");
		expect(html).toContain("暂无待办事件");
		expect(controlFullStart).toBeGreaterThan(-1);
		expect(tabListStart).toBeGreaterThan(controlFullStart);
		expect(smartPanelStart).toBeGreaterThan(tabListStart);
		expect(historyPanelStart).toBeGreaterThan(smartPanelStart);
		expect(html.indexOf("data-messages")).toBeGreaterThan(smartPanelStart);
		expect(html.indexOf("data-flow-list")).toBeGreaterThan(smartPanelStart);
		expect(html.indexOf("data-flow-list")).toBeLessThan(historyPanelStart);
		expect(setupSidebarTabs).toContain("elements.messages");
		expect(setupSidebarTabs).toContain("elements.composer");
		expect(renderSidebarTabs).toContain('setAttribute("aria-selected"');
		expect(renderSidebarTabs).toContain("panel.hidden");
		expect(css).toContain(".sidebar-tabs-head");
		expect(css).toContain(".sidebar-tab-panels");
		expect(css).toContain(".smart-sidebar");
		expect(css).toContain(".tab-list");
		expect(css).toContain(".tab-button");
		expect(css).toContain(".tab-panel");
	});

	test("shows workflow progress counts only when real steps exist and keeps click-selected tasks from snapshot data", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const renderFlow = extractFunctionSource(app, "renderFlow");
		const updateStepNode = extractFunctionSource(app, "updateStepNode");
		const getOrCreateTaskNode = extractFunctionSource(app, "getOrCreateTaskNode");

		expect(renderFlow).toContain("steps.flatMap((step) => step.tasks)");
		expect(renderFlow).toContain("allTasks.length > 0");
		expect(renderFlow).toContain("elements.totalProgress.hidden");
		expect(renderFlow).toContain("elements.totalProgress.textContent");
		expect(renderFlow).toContain(`已完成 \${doneTasks} 个，共 \${allTasks.length} 个`);
		expect(updateStepNode).toContain(`progress.textContent = \`\${done} / \${step.tasks.length}\``);
		expect(updateStepNode).toContain(`阶段进度：\${done} / \${step.tasks.length}`);
		expect(getOrCreateTaskNode).toContain("selectedTaskId = taskId");
		expect(getOrCreateTaskNode).toContain("renderFlow(latestSnapshot?.run.steps ?? [])");
		expect(html).not.toContain(">0 / 0<");
	});

	test("surfaces stopping state and disables the single primary action during stop or pending requests", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const renderRunStatus = extractFunctionSource(app, "renderRunStatus");
		const updateActionState = extractFunctionSource(app, "updateActionState");

		expect(app).toContain('stopping: "停止中"');
		expect(renderRunStatus).toContain("statusText[status]");
		expect(updateActionState).toContain('status === "running"');
		expect(updateActionState).toContain('status === "stopping"');
		expect(updateActionState).toContain("elements.mainAction.disabled");
		expect(updateActionState).toContain("elements.mainAction.dataset.mode");
		expect(updateActionState).toContain("elements.instruction.disabled");
		expect(html).toContain("data-main-action");
	});

	test("guards workflow ordering so status-only snapshots update existing flow nodes in place", () => {
		const app = readConsoleAsset("app.js");
		const renderFlow = extractFunctionSource(app, "renderFlow");
		const updateStepNode = extractFunctionSource(app, "updateStepNode");
		const syncOrderedChildren = extractFunctionSource(app, "syncOrderedChildren");

		expect(renderFlow).toContain("syncOrderedChildren(");
		expect(renderFlow).not.toContain("elements.flowList.append(");
		expect(updateStepNode).toContain("syncOrderedChildren(");
		expect(updateStepNode).not.toContain("taskList.append(");
		expect(syncOrderedChildren).toContain("hasChildOrderChanged");
		expect(syncOrderedChildren.indexOf("hasChildOrderChanged")).toBeLessThan(
			syncOrderedChildren.indexOf("parent.append(createNode(id))"),
		);
	});

	test("keeps frontend-only rail docking classes and left/right docking styles", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const css = readConsoleAsset("styles.css");

		expect(html).toContain('<body class="control-edge-right">');
		expect(app).toContain('classList.toggle("control-edge-left"');
		expect(app).toContain('classList.toggle("control-edge-right"');
		expect(css).toContain("body.control-edge-left .workspace");
		expect(css).toContain("body.control-edge-left .side-panel");
		expect(css).toContain("body.control-edge-left .control-rail");
	});

	test("keeps rail drag feedback, edge commit, and drag cleanup logic in the frontend contract", () => {
		const app = readConsoleAsset("app.js");
		const css = readConsoleAsset("styles.css");
		const setupControlPanel = extractFunctionSource(app, "setupControlPanel");

		expect(setupControlPanel).toContain('elements.rail.addEventListener("pointermove"');
		expect(setupControlPanel).toContain('elements.rail.addEventListener("pointerup"');
		expect(setupControlPanel).toContain("event.clientX");
		expect(app).toContain('style.setProperty("--rail-drag-x"');
		expect(setupControlPanel).toContain("clientX < window.innerWidth / 2");
		expect(setupControlPanel).toContain('elements.rail.dataset.dragged = "true"');
		expect(setupControlPanel).toContain('button.dataset.dragged === "true"');
		expect(setupControlPanel).toContain('elements.rail.addEventListener("pointercancel"');
		expect(setupControlPanel).toContain('elements.rail.addEventListener("lostpointercapture"');
		expect(app).toContain('style.removeProperty("--rail-drag-x")');
		expect(css).toContain("--rail-drag-x");
		expect(css).toContain("transform: translate3d(var(--rail-drag-x), 0, 0);");
		expect(css).toContain(".control-rail.dragging");
	});

	test("uses card board width and ResizeObserver for 3/2/1 responsive cards without mobile horizontal overflow", () => {
		const app = readConsoleAsset("app.js");
		const css = readConsoleAsset("styles.css");
		const setupCardColumns = extractFunctionSource(app, "setupCardColumns");

		expect(setupCardColumns).toContain("new ResizeObserver");
		expect(setupCardColumns).toContain("entry?.contentRect.width");
		expect(setupCardColumns).toContain("width >= 1060 ? 3 : width >= 700 ? 2 : 1");
		expect(setupCardColumns).toContain('--card-columns", String(columns)');
		expect(css).toContain("grid-template-columns: repeat(var(--card-columns), minmax(0, 1fr));");
		expect(css).toContain("max-width: 100%;");
		expect(css).toContain("overflow-x: hidden;");
		expect(css).toContain("@media (max-width: 760px)");
	});

	test("auto-resizes the instruction textarea with a capped height and internal scroll", () => {
		const app = readConsoleAsset("app.js");
		const css = readConsoleAsset("styles.css");
		const setupComposer = extractFunctionSource(app, "setupComposer");

		expect(setupComposer).toContain("syncInstructionHeight()");
		expect(app).toContain("function syncInstructionHeight()");
		expect(app).toContain('style.height = "auto"');
		expect(app).toContain("scrollHeight");
		expect(css).toContain(".composer textarea");
		expect(css).toContain("overflow-y: auto;");
		expect(css).toContain("max-height:");
	});

	test("keeps fixed viewport layout with independent scroll regions", () => {
		const html = readConsoleAsset("index.html");
		const css = readConsoleAsset("styles.css");

		expect(html).toContain('class="scroll-area card-board"');
		expect(html).toContain('class="scroll-area messages"');
		expect(html).toContain('class="scroll-area flow-list"');
		expect(css).toContain("height: 100dvh;");
		expect(css).toContain("overflow: hidden;");
		expect(css).toContain(".scroll-area");
		expect(css).toContain("overflow: auto;");
		expect(css).toContain(".pane-body.only-scroll");
	});

	test("keeps card collapse and maximize handlers with maximized cards confined to the card workspace", () => {
		const app = readConsoleAsset("app.js");
		const css = readConsoleAsset("styles.css");
		const bindCardActions = extractFunctionSource(app, "bindCardActions");

		expect(bindCardActions).toContain("[data-collapse]");
		expect(bindCardActions).toContain("[data-maximize]");
		expect(bindCardActions).toContain("state.collapsed = !state.collapsed");
		expect(bindCardActions).toContain("nextMaximized");
		expect(app).toContain("function collapseMaximizedCards");
		expect(css).toContain(".card-board {\n  position: relative;");
		expect(css).toContain(".card.maximized");
		expect(css).toContain("position: absolute;");
		expect(css).toContain("inset: 14px;");
	});

	test("marks dynamic error receipts as alerts and exposes the receipts area as live", () => {
		const app = readConsoleAsset("app.js");
		const html = readConsoleAsset("index.html");
		const css = readConsoleAsset("styles.css");
		const renderMessages = extractFunctionSource(app, "renderMessages");
		const renderLocalError = extractFunctionSource(app, "renderLocalError");

		expect(html).toContain('aria-live="polite" data-messages');
		expect(renderMessages).toContain('node.setAttribute("role", "alert")');
		expect(renderMessages).toContain('node.setAttribute("aria-label"');
		expect(renderMessages).toContain("错误回执");
		expect(renderMessages).toContain("receipt.message");
		expect(renderLocalError).toContain('node.setAttribute("role", "alert")');
		expect(renderLocalError).toContain('node.setAttribute("aria-label"');
		expect(renderLocalError).toContain("前端错误");
		expect(renderLocalError).toContain("message");
		expect(html).toContain('aria-label="暂不支持对话功能"');
		expect(html).toContain('aria-label="开始测试"');
		expect(css).toContain("button:focus-visible");
		expect(css).toContain("textarea:focus-visible");
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		expect(css).toContain("animation-duration: 0.01ms !important;");
	});

	test("widens the collaboration sidebar on desktop while keeping mobile viewport bounds", () => {
		const css = readConsoleAsset("styles.css");

		expect(css).toContain("--side-width: min(570px, 56vw);");
		expect(css).not.toContain("--side-width: min(380px, 40vw);");
		expect(css).toContain("--side-width: min(360px, 92vw);");
		expect(css).toContain("--side-width: min(360px, 100vw);");
	});
});

describe("rpc task console frontend interactions", () => {
	test("alerts that chat is unsupported and does not call runtime routes when the sidebar composer submits", async () => {
		const harness = createFrontendHarness();
		await harness.initPromise;
		harness.setSnapshot({
			run: {
				id: "idle",
				status: "idle",
				userInstruction: "",
				steps: [],
				createdAt: 0,
			},
			cards: [],
			logs: [],
			receipts: [],
			conversationMessages: [],
		});
		harness.instruction.value = "不要启动 runtime";

		harness.submitComposer();

		expect(harness.alerts).toEqual(["暂不支持对话功能"]);
		expect(
			harness.fetchCalls.some((call) => ["/runs/start", "/runs/stop", "/runs/replace"].includes(call.path)),
		).toBe(false);
	});

	test("starts the top-right test run with police workflow steps and the current instruction", async () => {
		const harness = createFrontendHarness();
		await harness.initPromise;
		harness.setSnapshot({
			run: {
				id: "idle",
				status: "idle",
				userInstruction: "",
				steps: [],
				createdAt: 0,
			},
			cards: [],
			logs: [],
			receipts: [],
			conversationMessages: [],
		});
		harness.instruction.value = "测试指令";

		harness.clickTestRun();
		await Promise.resolve();

		const startCall = harness.fetchCalls.find((call) => call.path === "/runs/start");
		expect(startCall).toBeDefined();
		expect(startCall?.init?.method).toBe("POST");
		expect(JSON.parse(String(startCall?.init?.body))).toMatchObject({
			userInstruction: "测试指令",
			steps: JSON.parse(JSON.stringify(createDemoPlanSteps())),
		});
	});

	test("switches the top-right test run button into stop mode for running snapshots", async () => {
		const harness = createFrontendHarness();
		await harness.initPromise;
		harness.setSnapshot({
			run: {
				id: "run-1",
				status: "running",
				userInstruction: "进行中",
				steps: createRuntimeSteps(createDemoPlanSteps()) as readonly RuntimeStep[],
				createdAt: 0,
			},
			cards: [],
			logs: [],
			receipts: [],
			conversationMessages: [],
		});

		expect(harness.getTestRunText()).toBe("停止");
		expect(harness.getTestRunTitle()).toBe("停止");
		expect(harness.getTestRunAriaLabel()).toBe("停止");
		expect(harness.testRun.disabled).toBe(false);

		harness.clickTestRun();
		await Promise.resolve();

		expect(harness.fetchCalls.some((call) => call.path === "/runs/stop")).toBe(true);
	});
});

describe("rpc task console HTTP API", () => {
	test("prewarms MCP metadata before listening and does not reconnect for each run", async () => {
		const received: Array<{ readonly method: string; readonly sessionId?: string; readonly accept?: string }> = [];
		const mcpServer = createServer((request, response) => {
			void handleFakeMcpRequest(request, response, received, { mode: "json" });
		});
		const mcpBaseUrl = await listen(mcpServer);
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-startup-mcp-"));
		let server: Server | undefined;
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_OUTPUT_DIR=out",
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
					"PI_DEMO_MCP_CONFIG=.mcp.json",
				].join("\n"),
			);
			writeMcpPackageConfig(dir, `${mcpBaseUrl}/mcp`);
			const demoEnv = { ...loadDemoEnv(dir, {}), port: 0 };
			const manager = new RunManager({
				demoEnv,
				childFactory: createImmediateAgentFactory([]),
				now: createClock(100),
			});

			server = await startRpcTaskConsoleServer(demoEnv, { runManager: manager });

			expect(received.map((item) => item.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
			const requestCountAfterStartup = received.length;
			const runResponse = await fetch(`${getServerBaseUrl(server)}/runs/start`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: createDemoPlanSteps(), userInstruction: "demo" }),
			});
			expect(runResponse.status).toBe(202);

			await manager.waitForIdle();
			expect(received).toHaveLength(requestCountAfterStartup);
		} finally {
			if (server) {
				await closeServer(server);
			}
			await closeServer(mcpServer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects startup before /runs/start can return 202 when MCP prewarm fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-console-startup-mcp-fail-"));
		try {
			writeDefaultRuntimeConfigFile(dir);
			writeFileSync(
				join(dir, ".env"),
				[
					"PI_DEMO_OUTPUT_DIR=out",
					"PI_DEMO_LLM_BASE_URL=http://localhost:9111/v1",
					"PI_DEMO_LLM_MODEL=demo-model",
					"PI_DEMO_MCP_CONFIG=.mcp.json",
				].join("\n"),
			);
			writeMcpPackageConfig(dir, "http://127.0.0.1:9/mcp");
			const demoEnv = { ...loadDemoEnv(dir, {}), port: 0 };

			await expect(startRpcTaskConsoleServer(demoEnv)).rejects.toThrow(/MCP prewarm failed|fetch failed/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("serves canonical shell routes and starts runs through canonical runtime routes", async () => {
		const manager = new RunManager({
			demoEnv: createDemoEnv(),
			childFactory: createImmediateAgentFactory([]),
			now: createClock(100),
		});
		const server = createRpcTaskConsoleServer(createDemoEnv(), { runManager: manager });
		const baseUrl = await listen(server);
		try {
			const htmlResponse = await fetch(`${baseUrl}/`);
			expect(htmlResponse.status).toBe(200);
			expect(await htmlResponse.text()).toContain("/styles.css");

			const stylesResponse = await fetch(`${baseUrl}/styles.css`);
			expect(stylesResponse.status).toBe(200);
			expect(stylesResponse.headers.get("content-type")).toContain("text/css");

			const appResponse = await fetch(`${baseUrl}/app.js`);
			expect(appResponse.status).toBe(200);
			expect(await appResponse.text()).toContain("/runs/start");

			const initialSnapshot = await readFirstSseSnapshot(baseUrl);
			expect(initialSnapshot.run.status).toBe("idle");
			expect(initialSnapshot.run.steps).toEqual([]);

			const runResponse = await fetch(`${baseUrl}/runs/start`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: createDemoPlanSteps(), userInstruction: "demo" }),
			});
			expect(runResponse.status).toBe(202);
			const runBody = await readJson<{ readonly run: TaskRun }>(runResponse);
			expect(runBody.run.id).toMatch(UUID_PATTERN);

			await manager.waitForIdle();
			const finalSnapshot = await readFirstSseSnapshot(baseUrl);
			expect(finalSnapshot.cards).toHaveLength(4);
		} finally {
			await closeServer(server);
		}
	});

	test("serves the shell with real static asset files and no initial business cards", async () => {
		const publicDir = new URL("../public/", import.meta.url);
		const expectedStyles = readFileSync(new URL("styles.css", publicDir), "utf8");
		const expectedApp = readFileSync(new URL("app.js", publicDir), "utf8");
		const server = createRpcTaskConsoleServer(createDemoEnv(), {
			runManager: new RunManager({
				demoEnv: createDemoEnv(),
				childFactory: createImmediateAgentFactory([]),
				now: createClock(100),
			}),
		});
		const baseUrl = await listen(server);
		try {
			const htmlResponse = await fetch(`${baseUrl}/`);
			const html = await htmlResponse.text();
			expect(htmlResponse.status).toBe(200);
			expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
			expect(html).toContain('<script type="module" src="/app.js"></script>');
			expect(html).not.toContain("<style>");
			expect(html).not.toContain("<script>");
			expect(html).not.toContain("service-a 监控");
			expect(html).not.toContain("资源清单");
			expect(html).toContain("公安指挥任务控制台");

			const stylesResponse = await fetch(`${baseUrl}/styles.css`);
			expect(stylesResponse.status).toBe(200);
			expect(stylesResponse.headers.get("content-type")).toContain("text/css");
			expect(await stylesResponse.text()).toBe(expectedStyles);

			const appResponse = await fetch(`${baseUrl}/app.js`);
			expect(appResponse.status).toBe(200);
			expect(appResponse.headers.get("content-type")).toContain("text/javascript");
			expect(await appResponse.text()).toBe(expectedApp);

			const configResponse = await fetch(`${baseUrl}/runtime.config.json`);
			expect(configResponse.status).toBe(404);
			const traversalResponse = await fetch(`${baseUrl}/../pi-task-console/app.js`);
			expect(traversalResponse.status).toBe(404);
		} finally {
			await closeServer(server);
		}
	});

	test("validates canonical runtime payloads, replaces runs, and resets to the latest selected steps", async () => {
		const firstSteps: PlanStep[] = [
			{
				id: "step-first",
				title: "第一步",
				tasks: [{ id: "task-first", title: "第一任务", description: "pending", tools: [], skills: [] }],
			},
		];
		const secondSteps: PlanStep[] = [
			{
				id: "step-second",
				title: "第二步",
				tasks: [
					{
						id: "task-second",
						title: "第二任务",
						description: "done",
						tools: [],
						skills: [],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const children: FakeChildAgentProcess[] = [];
		const manager = new RunManager({
			steps: createDemoPlanSteps(),
			demoEnv: createDemoEnv(undefined, {
				runtimeConfig: {
					...DEFAULT_RUNTIME_CONFIG,
					concurrency_limit: 1,
					stop_steer_timeout_ms: 0,
					stop_abort_timeout_ms: 0,
				},
			}),
			childFactory: (options) => {
				const child = new FakeChildAgentProcess(options, [], {
					onKill: (runningChild) => {
						if (children.length === 1) {
							queueMicrotask(() => {
								runningChild.emit({
									type: "process_close",
									exitCode: 143,
									signal: "SIGTERM",
									stderrTail: "old run killed",
								});
							});
						}
					},
					onPrompt: (runningChild) => {
						if (options.taskId !== "task-second") {
							return;
						}
						queueMicrotask(() => {
							runningChild.emit({
								type: "message_end",
								message: createAssistantMessage(
									JSON.stringify({ content: "replacement done", data: { text: "ok" } }),
								),
							});
							runningChild.emit({ type: "agent_end", messages: [], willRetry: false });
							runningChild.emit({
								type: "process_close",
								exitCode: 0,
								signal: null,
								stderrTail: "replacement close",
							});
						});
					},
				});
				children.push(child);
				return child;
			},
			now: createClock(100),
		});
		const server = createRpcTaskConsoleServer(createDemoEnv(), { runManager: manager });
		const baseUrl = await listen(server);
		try {
			const missingStepsResponse = await fetch(`${baseUrl}/runs/start`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ userInstruction: "demo" }),
			});
			expect(missingStepsResponse.status).toBe(400);

			const missingInstructionResponse = await fetch(`${baseUrl}/runs/replace`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: secondSteps }),
			});
			expect(missingInstructionResponse.status).toBe(400);

			const startResponse = await fetch(`${baseUrl}/runs/start`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: firstSteps, userInstruction: "first instruction" }),
			});
			expect(startResponse.status).toBe(202);
			await waitUntil(() => children.length === 1);
			expect(manager.getSnapshot().run.steps.map((step) => step.id)).toEqual(["step-first"]);

			const replaceResponse = await fetch(`${baseUrl}/runs/replace`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: secondSteps, userInstruction: "replacement instruction" }),
			});
			expect(replaceResponse.status).toBe(202);
			await waitUntil(() => children.length === 2);
			await manager.waitForIdle();

			const replacedSnapshot = await readFirstSseSnapshot(baseUrl);
			expect(replacedSnapshot.run.userInstruction).toBe("replacement instruction");
			expect(replacedSnapshot.run.steps.map((step) => step.id)).toEqual(["step-second"]);

			const resetResponse = await fetch(`${baseUrl}/runs/reset`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: secondSteps }),
			});
			expect(resetResponse.status).toBe(200);

			const resetSnapshot = await readFirstSseSnapshot(baseUrl);
			expect(resetSnapshot.run.status).toBe("idle");
			expect(resetSnapshot.run.steps.map((step) => step.id)).toEqual(["step-second"]);
			expect(resetSnapshot.cards).toEqual([]);
			expect(resetSnapshot.logs).toEqual([]);
			expect(resetSnapshot.receipts).toEqual([]);
			expect(resetSnapshot.conversationMessages).toEqual([]);

			const emptyResetResponse = await fetch(`${baseUrl}/runs/reset`, { method: "POST" });
			expect(emptyResetResponse.status).toBe(200);
			const emptyResetSnapshot = await readJson<{ readonly snapshot: TaskSnapshot }>(emptyResetResponse);
			expect(emptyResetSnapshot.snapshot.run.status).toBe("idle");
			expect(emptyResetSnapshot.snapshot.run.steps.map((step) => step.id)).toEqual(["step-second"]);
			expect(emptyResetSnapshot.snapshot.cards).toEqual([]);
		} finally {
			await closeServer(server);
		}
	});

	test("streams complete snapshots over SSE and reconnects with the latest backend state", async () => {
		const selectedSteps: PlanStep[] = [
			{
				id: "step-sse",
				title: "SSE 步骤",
				tasks: [
					{
						id: "task-sse",
						title: "SSE 任务",
						description: "done",
						tools: [],
						skills: [],
						card_type: "text",
						data_structure: [{ field: "text", type: "string", required: true }],
					},
				],
			},
		];
		const manager = new RunManager({
			steps: createDemoPlanSteps(),
			demoEnv: createDemoEnv(),
			childFactory: (options) =>
				new FakeChildAgentProcess(options, [], {
					onPrompt: (child) => {
						queueMicrotask(() => {
							child.emit({
								type: "message_end",
								message: createAssistantMessage(
									JSON.stringify({ content: "sse done", data: { text: "done" } }),
								),
							});
							child.emit({ type: "agent_end", messages: [], willRetry: false });
							child.emit({
								type: "process_close",
								exitCode: 0,
								signal: null,
								stderrTail: "sse close",
							});
						});
					},
				}),
			now: createClock(100),
		});
		const server = createRpcTaskConsoleServer(createDemoEnv(), { runManager: manager });
		const baseUrl = await listen(server);
		const stream = await openSseSnapshotStream(baseUrl);
		try {
			const initialSnapshot = await readNextSseSnapshot(stream);
			expect(initialSnapshot.run.status).toBe("idle");

			const startResponse = await fetch(`${baseUrl}/runs/start`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ steps: selectedSteps, userInstruction: "stream me" }),
			});
			expect(startResponse.status).toBe(202);

			const completedSnapshot = await waitForSseSnapshot(stream, (snapshot) => snapshot.run.status === "complete");
			expect(completedSnapshot.run.steps[0]?.tasks[0]?.result).toEqual({
				status: "complete",
				content: "sse done",
				data: { text: "done" },
			});
			expect(completedSnapshot.cards).toHaveLength(1);
			expect(completedSnapshot.cards[0]?.taskId).toBe("task-sse");
			expect(completedSnapshot.conversationMessages).toHaveLength(1);
			expect(completedSnapshot.conversationMessages[0]).toMatchObject({
				id: expect.stringMatching(UUID_PATTERN),
				runId: completedSnapshot.run.id,
				stepId: "step-sse",
				taskId: "task-sse",
				content: "sse done",
			});
			expect(typeof completedSnapshot.conversationMessages[0]?.time).toBe("number");
			expect(
				completedSnapshot.receipts.some((receipt) => receipt.message.includes("【SSE 步骤】【SSE 任务】已完成")),
			).toBe(true);

			stream.controller.abort();
			const reconnectedSnapshot = await readFirstSseSnapshot(baseUrl);
			expect(reconnectedSnapshot).toEqual(completedSnapshot);
		} finally {
			stream.controller.abort();
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
	options: { readonly mode: "json" | "sse" | "http-error" | "jsonrpc-error" | "protocol-mismatch" },
): Promise<void> {
	if (request.method === "GET") {
		response.statusCode = 405;
		response.end();
		return;
	}
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
		if (options.mode === "http-error") {
			response.statusCode = 502;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ error: "upstream failed" }));
			return;
		}
		if (options.mode === "jsonrpc-error") {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: {
						code: -32001,
						message: "tool exploded",
						data: { retryable: false },
					},
				}),
			);
			return;
		}
		if (options.mode === "protocol-mismatch") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ ok: true, tool: "echo" }));
			return;
		}
		const result = {
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [{ type: "text", text: "called echo" }],
				isError: false,
				structuredContent: {
					tool: readFakeMcpToolName(message.params),
					echoedArguments: readFakeMcpToolArguments(message.params),
				},
			},
		};
		if (options.mode === "sse") {
			response.setHeader("content-type", "text/event-stream");
			response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(result));
		return;
	}
	if (message.method === "tools/list") {
		const result = {
			jsonrpc: "2.0",
			id: message.id,
			result: {
				tools: [
					{
						name: "jcj-get-case-detail",
						description: "Get case detail by JJDBH",
						inputSchema: {
							type: "object",
							properties: {
								jjdbh: { type: "string" },
							},
							required: ["jjdbh"],
						},
					},
					{
						name: "panel-operate",
						description: "Operate panel",
						inputSchema: {
							type: "object",
							additionalProperties: true,
						},
					},
					{
						name: "background-check",
						description: "Run background check",
						inputSchema: {
							type: "object",
							additionalProperties: true,
						},
					},
				],
			},
		};
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

function readFakeMcpToolArguments(value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const params = value as { readonly arguments?: unknown };
	return params.arguments;
}

function readFakeMcpToolName(value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const params = value as { readonly name?: unknown };
	return params.name;
}

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return getServerBaseUrl(server);
}

function getServerBaseUrl(server: Server): string {
	const address = server.address();
	if (!isAddressInfo(address)) {
		throw new Error("Server did not expose a TCP address");
	}
	const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
	return `http://${host}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	server.close();
	await once(server, "close");
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

interface SseSnapshotStream {
	readonly controller: AbortController;
	readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	readonly decoder: InstanceType<typeof TextDecoder>;
	buffer: string;
}

async function openSseSnapshotStream(baseUrl: string): Promise<SseSnapshotStream> {
	const controller = new AbortController();
	const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
	if (response.status !== 200) {
		throw new Error(`Expected SSE 200, received ${response.status}`);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Missing SSE response body");
	}
	return {
		controller,
		reader,
		decoder: new TextDecoder(),
		buffer: "",
	};
}

async function readFirstSseSnapshot(baseUrl: string): Promise<TaskSnapshot> {
	const stream = await openSseSnapshotStream(baseUrl);
	try {
		return await readNextSseSnapshot(stream);
	} finally {
		stream.controller.abort();
	}
}

async function waitForSseSnapshot(
	stream: SseSnapshotStream,
	predicate: (snapshot: TaskSnapshot) => boolean,
): Promise<TaskSnapshot> {
	const startedAt = Date.now();
	while (Date.now() - startedAt <= 2_000) {
		const snapshot = await readNextSseSnapshot(stream);
		if (predicate(snapshot)) {
			return snapshot;
		}
	}
	throw new Error("Timed out waiting for SSE snapshot");
}

async function readNextSseSnapshot(stream: SseSnapshotStream): Promise<TaskSnapshot> {
	while (true) {
		const delimiterIndex = stream.buffer.indexOf("\n\n");
		if (delimiterIndex >= 0) {
			const frame = stream.buffer.slice(0, delimiterIndex);
			stream.buffer = stream.buffer.slice(delimiterIndex + 2);
			const snapshot = parseSseSnapshotFrame(frame);
			if (snapshot) {
				return snapshot;
			}
			continue;
		}
		const chunk = await stream.reader.read();
		if (chunk.done) {
			throw new Error("SSE stream closed before snapshot arrived");
		}
		stream.buffer += stream.decoder.decode(chunk.value, { stream: true });
	}
}

function parseSseSnapshotFrame(frame: string): TaskSnapshot | undefined {
	const lines = frame.split("\n");
	let eventName = "";
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("event:")) {
			eventName = line.slice("event:".length).trim();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trim());
		}
	}
	if (eventName !== "snapshot" || dataLines.length === 0) {
		return undefined;
	}
	return JSON.parse(dataLines.join("\n")) as TaskSnapshot;
}

function readJsonLines<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

function readConsoleAsset(name: "app.js" | "styles.css" | "index.html"): string {
	return readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
}

function extractFunctionSource(source: string, functionName: string): string {
	const start = source.indexOf(`function ${functionName}(`);
	if (start < 0) {
		throw new Error(`Missing function ${functionName}`);
	}
	const next = source.indexOf("\nfunction ", start + 1);
	return source.slice(start, next < 0 ? source.length : next);
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
	return typeof address === "object" && address !== null;
}
