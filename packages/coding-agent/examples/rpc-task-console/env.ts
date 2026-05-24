import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { prepareChildSettingsSync } from "./child-settings.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";

export const PI_DEMO_TASK_ALLOWED_TOOLS_ENV = "PI_DEMO_TASK_ALLOWED_TOOLS";

export interface RpcTaskConsoleEnv {
	readonly exampleDir: string;
	readonly port: number;
	readonly piCommand: string;
	readonly piArgs: string[];
	readonly childEnv: NodeJS.ProcessEnv;
	readonly modelsJsonPath?: string;
	readonly mcpConfigPath?: string;
	readonly outputDir: string;
	readonly snapshotDir: string;
	readonly logDir: string;
	readonly rpcEventDir: string;
	readonly childStderrDir: string;
	readonly conversationDir: string;
	readonly childAgentDir: string;
	readonly childSessionDir?: string;
	readonly enableChildSession: boolean;
	readonly runtimeConfigPath: string;
	readonly runtimeConfig: RuntimeConfig;
	readonly childSettingsPath: string;
}

export type DemoEnv = RpcTaskConsoleEnv;

export function loadDemoEnv(exampleDir: string, baseEnv: NodeJS.ProcessEnv): RpcTaskConsoleEnv {
	const envFile = join(exampleDir, ".env");
	const localEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
	const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...localEnv };
	const outputDir = resolvePath(exampleDir, readEnv(childEnv, "PI_DEMO_OUTPUT_DIR") ?? ".rpc-task-console");
	const snapshotDir = resolveOutputDir(exampleDir, childEnv, "PI_DEMO_SNAPSHOT_DIR", outputDir, "snapshots");
	const logDir = resolveOutputDir(exampleDir, childEnv, "PI_DEMO_LOG_DIR", outputDir, "logs");
	const rpcEventDir = resolveOutputDir(exampleDir, childEnv, "PI_DEMO_RPC_EVENT_DIR", outputDir, "rpc-events");
	const childStderrDir = resolveOutputDir(exampleDir, childEnv, "PI_DEMO_CHILD_STDERR_DIR", outputDir, "stderr");
	const conversationDir = resolveOutputDir(
		exampleDir,
		childEnv,
		"PI_DEMO_CONVERSATION_DIR",
		outputDir,
		"conversation",
	);
	const childAgentDir = resolveOutputDir(exampleDir, childEnv, "PI_DEMO_CHILD_AGENT_DIR", outputDir, "pi-agent");
	const enableChildSession = parseBoolean(childEnv.PI_DEMO_ENABLE_CHILD_SESSION, false);
	const configuredChildSessionDir = readEnv(childEnv, "PI_DEMO_CHILD_SESSION_DIR");
	const childSessionDir = configuredChildSessionDir ? resolvePath(exampleDir, configuredChildSessionDir) : undefined;
	if (enableChildSession && !childSessionDir) {
		throw new Error("Child session dir is required when PI_DEMO_ENABLE_CHILD_SESSION=true");
	}

	const runtimeConfigPath = resolveRequiredConfigPath(
		exampleDir,
		readEnv(childEnv, "PI_DEMO_RUNTIME_CONFIG") ?? "runtime.config.json",
		"runtime config",
	);
	const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);

	childEnv.PI_DEMO_OUTPUT_DIR = outputDir;
	childEnv.PI_DEMO_SNAPSHOT_DIR = snapshotDir;
	childEnv.PI_DEMO_LOG_DIR = logDir;
	childEnv.PI_DEMO_RPC_EVENT_DIR = rpcEventDir;
	childEnv.PI_DEMO_CHILD_STDERR_DIR = childStderrDir;
	childEnv.PI_DEMO_CONVERSATION_DIR = conversationDir;
	childEnv.PI_DEMO_CHILD_AGENT_DIR = childAgentDir;
	childEnv.PI_CODING_AGENT_DIR = childAgentDir;
	childEnv.PI_DEMO_RUNTIME_CONFIG_PATH = runtimeConfigPath;
	if (childSessionDir) {
		childEnv.PI_DEMO_CHILD_SESSION_DIR = childSessionDir;
		childEnv.PI_CODING_AGENT_SESSION_DIR = childSessionDir;
	} else {
		delete childEnv.PI_CODING_AGENT_SESSION_DIR;
	}

	const llmConfig = loadLlmConfig(exampleDir, childEnv);
	const modelConfig = writeDemoModelsJson(childAgentDir, childEnv, llmConfig);
	const mcpConfigPath = resolveOptionalConfigPath(
		exampleDir,
		readEnv(childEnv, "PI_DEMO_MCP_CONFIG"),
		"mcp.config.json",
	);
	if (mcpConfigPath) {
		childEnv.PI_DEMO_MCP_CONFIG_PATH = mcpConfigPath;
	}

	const port = parsePort(childEnv.PI_DEMO_PORT);
	const piCommand =
		childEnv.PI_DEMO_PI_COMMAND && childEnv.PI_DEMO_PI_COMMAND.trim().length > 0
			? childEnv.PI_DEMO_PI_COMMAND
			: "../../node_modules/.bin/tsx";
	const basePiArgs =
		childEnv.PI_DEMO_PI_ARGS && childEnv.PI_DEMO_PI_ARGS.trim().length > 0
			? splitArgs(childEnv.PI_DEMO_PI_ARGS)
			: [
					"src/cli.ts",
					"--mode",
					"rpc",
					"--no-session",
					"--provider",
					modelConfig.provider,
					"--model",
					modelConfig.selectedModel,
				];
	const piArgs = applyMcpExtensionArgs(
		applyChildSessionArgs(basePiArgs, enableChildSession ? childSessionDir : undefined),
		mcpConfigPath,
		exampleDir,
	);

	const env: RpcTaskConsoleEnv = {
		exampleDir,
		port,
		piCommand,
		piArgs,
		childEnv,
		modelsJsonPath: modelConfig.modelsJsonPath,
		mcpConfigPath,
		outputDir,
		snapshotDir,
		logDir,
		rpcEventDir,
		childStderrDir,
		conversationDir,
		childAgentDir,
		childSessionDir,
		enableChildSession,
		runtimeConfigPath,
		runtimeConfig,
		childSettingsPath: "",
	};
	const childSettings = prepareChildSettingsSync(env);

	return {
		...env,
		childSettingsPath: childSettings.settingsPath,
	};
}

export function parseEnvFile(content: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const equalsIndex = line.indexOf("=");
		if (equalsIndex === -1) {
			continue;
		}
		const key = line.slice(0, equalsIndex).trim();
		if (key.length === 0) {
			continue;
		}
		values[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
	}
	return values;
}

export function splitArgs(value: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;

	for (const char of value) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaping) {
		current += "\\";
	}
	if (current.length > 0) {
		args.push(current);
	}
	return args;
}

function parsePort(value: string | undefined): number {
	if (!value) {
		return 4175;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 4175;
}

interface DemoModelConfig {
	readonly provider: string;
	readonly selectedModel: string;
	readonly modelsJsonPath?: string;
}

interface DemoLlmConfig {
	readonly provider?: string;
	readonly baseUrl?: string;
	readonly api?: string;
	readonly apiKeyEnv?: string;
	readonly models: readonly string[];
	readonly selectedModel?: string;
	readonly compat?: {
		readonly supportsDeveloperRole?: boolean;
		readonly supportsReasoningEffort?: boolean;
	};
}

function writeDemoModelsJson(
	childAgentDir: string,
	childEnv: NodeJS.ProcessEnv,
	llmConfig: DemoLlmConfig | undefined,
): DemoModelConfig {
	const provider = readEnv(childEnv, "PI_DEMO_LLM_PROVIDER") ?? llmConfig?.provider ?? "openai";
	const configuredModels = readListEnv(childEnv, "PI_DEMO_LLM_MODELS");
	const selectedModel =
		readEnv(childEnv, "PI_DEMO_LLM_MODEL") ??
		llmConfig?.selectedModel ??
		configuredModels[0] ??
		llmConfig?.models[0] ??
		"gpt-5.4";
	const baseUrl = readEnv(childEnv, "PI_DEMO_LLM_BASE_URL") ?? llmConfig?.baseUrl;
	const modelIds = mergeModelIds(
		configuredModels.length > 0 ? configuredModels : (llmConfig?.models ?? []),
		selectedModel,
	);

	if (!baseUrl || modelIds.length === 0) {
		return { provider: "openai", selectedModel };
	}

	mkdirSync(childAgentDir, { recursive: true });
	const modelsJsonPath = join(childAgentDir, "models.json");
	const config = {
		providers: {
			[provider]: {
				baseUrl,
				api: readEnv(childEnv, "PI_DEMO_LLM_API") ?? llmConfig?.api ?? "openai-completions",
				apiKey: readEnv(childEnv, "PI_DEMO_LLM_API_KEY_ENV") ?? llmConfig?.apiKeyEnv ?? "OPENAI_API_KEY",
				compat: {
					supportsDeveloperRole:
						readBooleanEnv(childEnv, "PI_DEMO_LLM_SUPPORTS_DEVELOPER_ROLE") ??
						llmConfig?.compat?.supportsDeveloperRole ??
						false,
					supportsReasoningEffort:
						readBooleanEnv(childEnv, "PI_DEMO_LLM_SUPPORTS_REASONING_EFFORT") ??
						llmConfig?.compat?.supportsReasoningEffort ??
						false,
				},
				models: modelIds.map((id) => ({ id })),
			},
		},
	};
	writeFileSync(modelsJsonPath, `${JSON.stringify(config, null, 2)}\n`);
	return { provider, selectedModel, modelsJsonPath };
}

function loadLlmConfig(exampleDir: string, env: NodeJS.ProcessEnv): DemoLlmConfig | undefined {
	const configPath = resolveOptionalConfigPath(exampleDir, readEnv(env, "PI_DEMO_LLM_CONFIG"), "llm.config.json");
	if (!configPath) {
		return undefined;
	}
	const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
	if (!isRecord(parsed)) {
		throw new Error("LLM config must be a JSON object");
	}
	return {
		provider: readStringProperty(parsed, "provider"),
		baseUrl: readStringProperty(parsed, "baseUrl"),
		api: readStringProperty(parsed, "api"),
		apiKeyEnv: readStringProperty(parsed, "apiKeyEnv"),
		models: readStringListProperty(parsed, "models"),
		selectedModel: readStringProperty(parsed, "selectedModel"),
		compat: readCompatProperty(parsed.compat),
	};
}

function resolveOptionalConfigPath(
	exampleDir: string,
	configuredPath: string | undefined,
	defaultFileName: string,
): string | undefined {
	if (configuredPath) {
		const path = resolvePath(exampleDir, configuredPath);
		return existsSync(path) ? path : undefined;
	}
	const defaultPath = join(exampleDir, defaultFileName);
	return existsSync(defaultPath) ? defaultPath : undefined;
}

function resolveRequiredConfigPath(exampleDir: string, configuredPath: string, label: string): string {
	const path = resolvePath(exampleDir, configuredPath);
	if (!existsSync(path)) {
		throw new Error(`Failed to resolve ${label} at ${path}`);
	}
	return path;
}

function resolveOutputDir(
	exampleDir: string,
	env: NodeJS.ProcessEnv,
	key: string,
	outputDir: string,
	defaultName: string,
): string {
	const configured = readEnv(env, key);
	return configured ? resolvePath(exampleDir, configured) : join(outputDir, defaultName);
}

function resolvePath(exampleDir: string, configuredPath: string): string {
	return isAbsolute(configuredPath) ? configuredPath : join(exampleDir, configuredPath);
}

function applyMcpExtensionArgs(
	args: readonly string[],
	mcpConfigPath: string | undefined,
	exampleDir: string,
): string[] {
	if (!mcpConfigPath || args.includes("--extension") || args.includes("-e")) {
		return [...args];
	}
	return [...args, "--extension", join(exampleDir, "extensions", "mcp-tools.ts")];
}

function applyChildSessionArgs(args: readonly string[], childSessionDir: string | undefined): string[] {
	if (childSessionDir) {
		return [...stripSessionArgs(args), "--session-dir", childSessionDir];
	}
	const normalized: string[] = [];
	let hasNoSession = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--session-dir") {
			index += 1;
			continue;
		}
		if (arg === "--no-session") {
			hasNoSession = true;
			normalized.push(arg);
			continue;
		}
		normalized.push(arg);
	}
	return hasNoSession ? normalized : [...normalized, "--no-session"];
}

function stripSessionArgs(args: readonly string[]): string[] {
	const normalized: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--no-session") {
			continue;
		}
		if (arg === "--session-dir") {
			index += 1;
			continue;
		}
		normalized.push(arg);
	}
	return normalized;
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim();
	return value && value.length > 0 ? value : undefined;
}

function readListEnv(env: NodeJS.ProcessEnv, key: string): string[] {
	const value = readEnv(env, key);
	if (!value) {
		return [];
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function readBooleanEnv(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
	const value = env[key];
	return value === undefined ? undefined : parseBoolean(value, false);
}

function mergeModelIds(modelIds: readonly string[], selectedModel: string): string[] {
	if (modelIds.includes(selectedModel)) {
		return [...modelIds];
	}
	return [...modelIds, selectedModel];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	return fallback;
}

function readStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const fieldValue = value[key];
	return typeof fieldValue === "string" && fieldValue.trim().length > 0 ? fieldValue : undefined;
}

function readStringListProperty(value: Record<string, unknown>, key: string): string[] {
	const fieldValue = value[key];
	if (!Array.isArray(fieldValue)) {
		return [];
	}
	return fieldValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readCompatProperty(value: unknown): DemoLlmConfig["compat"] {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		supportsDeveloperRole: typeof value.supportsDeveloperRole === "boolean" ? value.supportsDeveloperRole : undefined,
		supportsReasoningEffort:
			typeof value.supportsReasoningEffort === "boolean" ? value.supportsReasoningEffort : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquoteEnvValue(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}
