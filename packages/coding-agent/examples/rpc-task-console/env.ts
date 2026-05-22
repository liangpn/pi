import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface DemoEnv {
	readonly port: number;
	readonly piCommand: string;
	readonly piArgs: string[];
	readonly childEnv: NodeJS.ProcessEnv;
	readonly modelsJsonPath?: string;
	readonly mcpConfigPath?: string;
}

export function loadDemoEnv(exampleDir: string, baseEnv: NodeJS.ProcessEnv): DemoEnv {
	const envFile = join(exampleDir, ".env");
	const localEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
	const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...localEnv };
	const llmConfig = loadLlmConfig(exampleDir, childEnv);
	const modelConfig = writeDemoModelsJson(exampleDir, childEnv, llmConfig);
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
	const piArgs = mcpConfigPath ? appendMcpExtensionArgs(basePiArgs, exampleDir) : basePiArgs;

	return { port, piCommand, piArgs, childEnv, modelsJsonPath: modelConfig.modelsJsonPath, mcpConfigPath };
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
	exampleDir: string,
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

	const agentDir = join(exampleDir, ".pi-agent");
	mkdirSync(agentDir, { recursive: true });
	childEnv.PI_CODING_AGENT_DIR = agentDir;
	const modelsJsonPath = join(agentDir, "models.json");
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
		const path = isAbsolute(configuredPath) ? configuredPath : join(exampleDir, configuredPath);
		return existsSync(path) ? path : undefined;
	}
	const defaultPath = join(exampleDir, defaultFileName);
	return existsSync(defaultPath) ? defaultPath : undefined;
}

function appendMcpExtensionArgs(args: readonly string[], exampleDir: string): string[] {
	if (args.includes("--extension") || args.includes("-e")) {
		return [...args];
	}
	return [...args, "--extension", join(exampleDir, "extensions", "mcp-tools.ts")];
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
