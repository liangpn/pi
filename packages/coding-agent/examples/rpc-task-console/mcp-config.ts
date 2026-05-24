import { readFileSync } from "node:fs";
import { PI_DEMO_TASK_ALLOWED_TOOLS_ENV } from "./env.js";

export interface RpcTaskConsoleMcpConfig {
	readonly servers: Record<string, McpStreamableHttpServerConfig>;
	readonly tools: readonly McpToolMapping[];
}

export interface McpStreamableHttpServerConfig {
	readonly transport: "streamable-http";
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly timeoutMs?: number;
}

export interface McpToolMapping {
	readonly name: string;
	readonly server: string;
	readonly mcpTool: string;
	readonly description: string;
	readonly parameters?: JsonObject;
}

export type JsonObject = Record<string, unknown>;

export function loadMcpConfig(path: string, env: NodeJS.ProcessEnv = process.env): RpcTaskConsoleMcpConfig {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isJsonObject(parsed)) {
		throw new Error("MCP config must be a JSON object");
	}
	const servers = parseServers(parsed.servers, env);
	const tools = filterToolMappings(parseTools(parsed.tools, servers), readTaskAllowedTools(env));
	return { servers, tools };
}

function parseServers(value: unknown, env: NodeJS.ProcessEnv): Record<string, McpStreamableHttpServerConfig> {
	if (!isJsonObject(value)) {
		throw new Error("MCP config requires a servers object");
	}
	const servers: Record<string, McpStreamableHttpServerConfig> = {};
	for (const [name, rawServer] of Object.entries(value)) {
		if (!isJsonObject(rawServer)) {
			throw new Error(`MCP server "${name}" must be an object`);
		}
		if (rawServer.transport !== "streamable-http") {
			throw new Error(`MCP server "${name}" must use streamable-http transport`);
		}
		if (typeof rawServer.url !== "string" || rawServer.url.trim().length === 0) {
			throw new Error(`MCP server "${name}" requires a url`);
		}
		const timeoutMs = parseOptionalPositiveInteger(rawServer.timeoutMs, `MCP server "${name}" timeoutMs`);
		servers[name] = {
			transport: "streamable-http",
			url: rawServer.url,
			headers: parseHeaders(rawServer.headers, env, name),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		};
	}
	return servers;
}

function parseTools(value: unknown, servers: Record<string, McpStreamableHttpServerConfig>): McpToolMapping[] {
	if (!Array.isArray(value)) {
		throw new Error("MCP config requires a tools array");
	}
	return value.map((rawTool, index) => {
		if (!isJsonObject(rawTool)) {
			throw new Error(`MCP tool mapping at index ${index} must be an object`);
		}
		const name = readRequiredString(rawTool, "name", `MCP tool mapping at index ${index}`);
		const server = readRequiredString(rawTool, "server", `MCP tool mapping "${name}"`);
		if (!servers[server]) {
			throw new Error(`MCP tool mapping "${name}" references unknown server "${server}"`);
		}
		const mcpTool = readRequiredString(rawTool, "mcpTool", `MCP tool mapping "${name}"`);
		const description = readRequiredString(rawTool, "description", `MCP tool mapping "${name}"`);
		const parameters = rawTool.parameters === undefined ? undefined : parseParameters(rawTool.parameters, name);
		return {
			name,
			server,
			mcpTool,
			description,
			...(parameters === undefined ? {} : { parameters }),
		};
	});
}

function parseHeaders(value: unknown, env: NodeJS.ProcessEnv, serverName: string): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!isJsonObject(value)) {
		throw new Error(`MCP server "${serverName}" headers must be an object`);
	}
	const headers: Record<string, string> = {};
	for (const [name, rawHeader] of Object.entries(value)) {
		if (typeof rawHeader !== "string") {
			throw new Error(`MCP server "${serverName}" header "${name}" must be a string`);
		}
		headers[name] = expandEnvTemplates(rawHeader, env);
	}
	return headers;
}

function parseParameters(value: unknown, toolName: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new Error(`MCP tool mapping "${toolName}" parameters must be a JSON schema object`);
	}
	return value;
}

function readRequiredString(value: JsonObject, key: string, label: string): string {
	const fieldValue = value[key];
	if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
		throw new Error(`${label} requires ${key}`);
	}
	return fieldValue;
}

function parseOptionalPositiveInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function expandEnvTemplates(value: string, env: NodeJS.ProcessEnv): string {
	return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => env[key] ?? "");
}

function readTaskAllowedTools(env: NodeJS.ProcessEnv): Set<string> | undefined {
	const rawValue = env[PI_DEMO_TASK_ALLOWED_TOOLS_ENV];
	if (!rawValue || rawValue.trim().length === 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawValue);
	} catch (error: unknown) {
		throw new Error(`Invalid ${PI_DEMO_TASK_ALLOWED_TOOLS_ENV}: ${formatError(error)}`);
	}
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		throw new Error(`Invalid ${PI_DEMO_TASK_ALLOWED_TOOLS_ENV}: expected a JSON array of strings`);
	}
	return new Set(parsed);
}

function filterToolMappings(tools: readonly McpToolMapping[], allowedTools: Set<string> | undefined): McpToolMapping[] {
	if (!allowedTools) {
		return [...tools];
	}
	return tools.filter((tool) => allowedTools.has(tool.name));
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
