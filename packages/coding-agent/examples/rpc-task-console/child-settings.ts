import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PI_MCP_ADAPTER_PACKAGE_SOURCE, type RpcTaskConsoleEnv } from "./env.js";

export interface ChildSettingsPaths {
	readonly agentDir: string;
	readonly settingsPath: string;
	readonly sessionDir?: string;
}

interface ChildSettingsFile {
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
	readonly transport: "sse";
	readonly packages: readonly string[];
}

const DEFAULT_CHILD_SETTINGS: ChildSettingsFile = {
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		provider: {
			timeoutMs: 300000,
			maxRetries: 0,
			maxRetryDelayMs: 60000,
		},
	},
	transport: "sse",
	packages: [PI_MCP_ADAPTER_PACKAGE_SOURCE],
};

interface McpAdapterConfig {
	readonly settings?: McpAdapterSettings;
	readonly mcpServers: Record<string, McpAdapterServerEntry>;
}

interface McpAdapterSettings {
	readonly toolPrefix?: "server" | "none" | "short";
	readonly directTools?: boolean;
	readonly disableProxyTool?: boolean;
	readonly sampling?: boolean;
	readonly [key: string]: unknown;
}

interface McpAdapterServerEntry {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Record<string, string>;
	readonly auth?: "oauth" | "bearer" | false;
	readonly bearerToken?: string;
	readonly bearerTokenEnv?: string;
	readonly oauth?: unknown;
	readonly lifecycle?: "keep-alive" | "lazy" | "eager";
	readonly idleTimeout?: number;
	readonly exposeResources?: boolean;
	readonly directTools?: boolean | readonly string[];
	readonly excludeTools?: readonly string[];
	readonly debug?: boolean;
	readonly [key: string]: unknown;
}

interface McpCachedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly uiResourceUri?: string;
	readonly uiStreamMode?: "eager" | "stream-first";
}

interface McpServerCacheEntry {
	readonly configHash: string;
	readonly tools: readonly McpCachedTool[];
	readonly resources: readonly unknown[];
	readonly cachedAt: number;
}

interface McpMetadataCache {
	readonly version: 1;
	readonly servers: Record<string, McpServerCacheEntry>;
}

export interface McpPrewarmResult {
	readonly configPath: string;
	readonly cachePath: string;
	readonly servers: readonly string[];
	readonly toolNames: readonly string[];
}

export interface McpDirectToolSpec {
	readonly name: string;
	readonly server: string;
	readonly mcpTool: string;
	readonly adapterSpec: string;
}

export async function prepareChildSettings(env: RpcTaskConsoleEnv): Promise<ChildSettingsPaths> {
	return prepareChildSettingsSync(env);
}

export function prepareChildSettingsSync(env: RpcTaskConsoleEnv): ChildSettingsPaths {
	mkdirSync(env.childAgentDir, { recursive: true });
	const settingsPath = join(env.childAgentDir, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify(DEFAULT_CHILD_SETTINGS, null, 2)}\n`);
	syncChildMcpConfig(env);
	return {
		agentDir: env.childAgentDir,
		settingsPath,
		sessionDir: env.enableChildSession ? env.childSessionDir : undefined,
	};
}

export async function prewarmMcpMetadataCache(env: NodeJS.ProcessEnv): Promise<McpPrewarmResult | undefined> {
	const configPath = readEnv(env, "PI_DEMO_CHILD_MCP_CONFIG_PATH");
	const cachePath = readEnv(env, "PI_DEMO_MCP_CACHE_PATH");
	if (!configPath || !cachePath) {
		return undefined;
	}
	const config = readMcpAdapterConfig(configPath, "child MCP config");
	const serverEntries = Object.entries(config.mcpServers);
	if (serverEntries.length === 0) {
		throw new Error(`MCP prewarm failed: child MCP config has no mcpServers (${configPath})`);
	}

	const cacheServers: Record<string, McpServerCacheEntry> = {};
	for (const [serverName, server] of serverEntries) {
		if (!server.url) {
			throw new Error(
				`MCP prewarm failed: server "${serverName}" is missing url; this POC requires HTTP MCP servers`,
			);
		}
		const tools = await listRemoteMcpTools(serverName, server, env);
		cacheServers[serverName] = {
			configHash: computeServerHash(server, env),
			tools,
			resources: [],
			cachedAt: Date.now(),
		};
	}

	const cache: McpMetadataCache = { version: 1, servers: cacheServers };
	writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
	return {
		configPath,
		cachePath,
		servers: Object.keys(cacheServers),
		toolNames: Object.values(cacheServers).flatMap((entry) => entry.tools.map((tool) => tool.name)),
	};
}

export function assertMcpMetadataCachePrewarmed(env: NodeJS.ProcessEnv): void {
	const configPath = readEnv(env, "PI_DEMO_CHILD_MCP_CONFIG_PATH");
	const cachePath = readEnv(env, "PI_DEMO_MCP_CACHE_PATH");
	if (!configPath && !cachePath) {
		return;
	}
	if (!configPath || !cachePath) {
		throw new Error("MCP metadata cache is not prewarmed: child MCP config path and cache path are required");
	}
	const config = readMcpAdapterConfig(configPath, "child MCP config");
	const serverEntries = Object.entries(config.mcpServers);
	if (serverEntries.length === 0) {
		throw new Error(`MCP metadata cache is not prewarmed: child MCP config has no mcpServers (${configPath})`);
	}
	if (!existsSync(cachePath)) {
		throw new Error(`MCP metadata cache is not prewarmed: missing cache file (${cachePath})`);
	}
	const cache = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
	if (!isRecord(cache) || cache.version !== 1 || !isRecord(cache.servers)) {
		throw new Error(`MCP metadata cache is invalid: ${cachePath}`);
	}
	for (const [serverName, server] of serverEntries) {
		if (!server.url) {
			throw new Error(
				`MCP metadata cache is not prewarmed: server "${serverName}" is missing url; this POC requires HTTP MCP servers`,
			);
		}
		const serverCache = cache.servers[serverName];
		if (!isRecord(serverCache)) {
			throw new Error(`MCP metadata cache is not prewarmed: missing server "${serverName}" (${cachePath})`);
		}
		if (serverCache.configHash !== computeServerHash(server, env)) {
			throw new Error(`MCP metadata cache is stale for server "${serverName}" (${cachePath})`);
		}
		if (!Array.isArray(serverCache.tools)) {
			throw new Error(`MCP metadata cache is invalid for server "${serverName}" (${cachePath})`);
		}
	}
}

export function readPrewarmedMcpDirectToolSpecs(env: NodeJS.ProcessEnv): McpDirectToolSpec[] {
	const configPath = readEnv(env, "PI_DEMO_CHILD_MCP_CONFIG_PATH");
	const cachePath = readEnv(env, "PI_DEMO_MCP_CACHE_PATH");
	if (!configPath || !cachePath || !existsSync(cachePath)) {
		return [];
	}
	const config = readMcpAdapterConfig(configPath, "child MCP config");
	const cache = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
	if (!isRecord(cache) || cache.version !== 1 || !isRecord(cache.servers)) {
		throw new Error(`MCP cache is invalid: ${cachePath}`);
	}
	const prefix = config.settings?.toolPrefix ?? "server";
	const specs: McpDirectToolSpec[] = [];
	for (const [serverName, server] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName];
		if (!isRecord(serverCache)) {
			continue;
		}
		if (serverCache.configHash !== computeServerHash(server, env)) {
			continue;
		}
		const tools = Array.isArray(serverCache.tools) ? serverCache.tools : [];
		for (const rawTool of tools) {
			if (!isRecord(rawTool) || typeof rawTool.name !== "string" || rawTool.name.trim().length === 0) {
				continue;
			}
			if (isToolExcluded(rawTool.name, serverName, prefix, server.excludeTools)) {
				continue;
			}
			specs.push({
				name: formatToolName(rawTool.name, serverName, prefix),
				server: serverName,
				mcpTool: rawTool.name,
				adapterSpec: `${serverName}/${rawTool.name}`,
			});
		}
	}
	return specs;
}

function syncChildMcpConfig(env: RpcTaskConsoleEnv): void {
	if (!env.mcpConfigPath || !env.childMcpConfigPath) {
		return;
	}
	const sharedConfig = readMcpAdapterConfig(env.mcpConfigPath, "standard MCP config", true);
	const piConfig = env.piMcpConfigPath ? readMcpAdapterConfig(env.piMcpConfigPath, "Pi MCP config", false) : undefined;
	const merged = mergeMcpAdapterConfigs(sharedConfig, piConfig);
	if (Object.keys(merged.mcpServers).length === 0) {
		throw new Error(`MCP config must define at least one mcpServers entry: ${env.mcpConfigPath}`);
	}
	mkdirSync(env.childAgentDir, { recursive: true });
	writeFileSync(env.childMcpConfigPath, `${JSON.stringify(merged, null, 2)}\n`);
}

function mergeMcpAdapterConfigs(
	sharedConfig: McpAdapterConfig,
	piConfig: McpAdapterConfig | undefined,
): McpAdapterConfig {
	return {
		settings: {
			toolPrefix: "none",
			directTools: true,
			disableProxyTool: true,
			sampling: false,
			...sharedConfig.settings,
			...piConfig?.settings,
		},
		mcpServers: {
			...sharedConfig.mcpServers,
			...piConfig?.mcpServers,
		},
	};
}

function readMcpAdapterConfig(path: string, label: string, requireServers = true): McpAdapterConfig {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`${label} must be a JSON object`);
	}
	const mcpServers = parsed.mcpServers;
	if (!isRecord(mcpServers)) {
		if (requireServers) {
			throw new Error(`${label} requires mcpServers`);
		}
		const settings = parsed.settings;
		if (settings !== undefined && !isRecord(settings)) {
			throw new Error(`${label} settings must be a JSON object`);
		}
		return {
			...(settings === undefined ? {} : { settings: settings as McpAdapterSettings }),
			mcpServers: {},
		};
	}
	const settings = parsed.settings;
	if (settings !== undefined && !isRecord(settings)) {
		throw new Error(`${label} settings must be a JSON object`);
	}
	const servers: Record<string, McpAdapterServerEntry> = {};
	for (const [serverName, rawServer] of Object.entries(mcpServers)) {
		if (!isRecord(rawServer)) {
			throw new Error(`${label} mcpServers.${serverName} must be a JSON object`);
		}
		servers[serverName] = rawServer;
	}
	return {
		...(settings === undefined ? {} : { settings: settings as McpAdapterSettings }),
		mcpServers: servers,
	};
}

async function listRemoteMcpTools(
	serverName: string,
	server: McpAdapterServerEntry,
	env: NodeJS.ProcessEnv,
): Promise<McpCachedTool[]> {
	const url = server.url;
	if (!url) {
		return [];
	}
	let id = 1;
	const initialize = await postMcpRequest(url, server, env, undefined, {
		jsonrpc: "2.0",
		id: id,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "pi-rpc-task-console", version: "0.1.0" },
		},
	});
	id += 1;
	const sessionId = initialize.sessionId;
	await postMcpRequest(
		url,
		server,
		env,
		sessionId,
		{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
		true,
	);

	const tools: McpCachedTool[] = [];
	let cursor: string | undefined;
	do {
		const response = await postMcpRequest(url, server, env, sessionId, {
			jsonrpc: "2.0",
			id: id,
			method: "tools/list",
			params: cursor ? { cursor } : {},
		});
		id += 1;
		const result = response.json.result;
		if (!isRecord(result) || !Array.isArray(result.tools)) {
			throw new Error(`MCP prewarm failed: server "${serverName}" returned invalid tools/list result`);
		}
		for (const rawTool of result.tools) {
			if (!isRecord(rawTool) || typeof rawTool.name !== "string" || rawTool.name.trim().length === 0) {
				continue;
			}
			tools.push({
				name: rawTool.name,
				...(typeof rawTool.description === "string" ? { description: rawTool.description } : {}),
				...(rawTool.inputSchema === undefined ? {} : { inputSchema: rawTool.inputSchema }),
			});
		}
		cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
	} while (cursor);
	return tools;
}

async function postMcpRequest(
	url: string,
	server: McpAdapterServerEntry,
	env: NodeJS.ProcessEnv,
	sessionId: string | undefined,
	body: unknown,
	allowEmptyResponse = false,
): Promise<{ readonly json: Record<string, unknown>; readonly sessionId?: string }> {
	const headers: Record<string, string> = {
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		...interpolateEnvRecord(server.headers, env),
	};
	if (sessionId) {
		headers["mcp-session-id"] = sessionId;
	}
	const bearerToken = resolveBearerToken(server, env);
	if (bearerToken && headers.Authorization === undefined && headers.authorization === undefined) {
		headers.Authorization = `Bearer ${bearerToken}`;
	}
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`MCP prewarm failed: ${url} returned HTTP ${response.status}`);
	}
	const responseText = await response.text();
	if (responseText.trim().length === 0 && allowEmptyResponse) {
		return { json: {}, sessionId: response.headers.get("mcp-session-id") ?? undefined };
	}
	const json = parseMcpResponseBody(responseText);
	if (isRecord(json.error)) {
		throw new Error(`MCP prewarm failed: ${JSON.stringify(json.error)}`);
	}
	return {
		json,
		sessionId: response.headers.get("mcp-session-id") ?? undefined,
	};
}

function parseMcpResponseBody(responseText: string): Record<string, unknown> {
	const trimmed = responseText.trim();
	if (trimmed.startsWith("{")) {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isRecord(parsed)) {
			throw new Error("MCP prewarm failed: response JSON was not an object");
		}
		return parsed;
	}
	for (const line of responseText.split(/\r?\n/)) {
		if (!line.startsWith("data:")) {
			continue;
		}
		const parsed = JSON.parse(line.slice("data:".length).trim()) as unknown;
		if (isRecord(parsed)) {
			return parsed;
		}
	}
	throw new Error("MCP prewarm failed: response was neither JSON nor MCP SSE data");
}

function computeServerHash(server: McpAdapterServerEntry, env: NodeJS.ProcessEnv): string {
	const identity = {
		command: server.command,
		args: server.args,
		env: interpolateEnvRecord(server.env, env),
		cwd: interpolateEnvValue(server.cwd, env),
		url: server.url,
		headers: interpolateEnvRecord(server.headers, env),
		auth: server.auth,
		bearerToken: interpolateEnvValue(server.bearerToken, env),
		bearerTokenEnv: server.bearerTokenEnv,
		exposeResources: server.exposeResources,
		excludeTools: server.excludeTools,
	};
	return createSha256(stableStringify(identity));
}

function formatToolName(toolName: string, serverName: string, prefix: "server" | "none" | "short"): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}

function getServerPrefix(serverName: string, prefix: "server" | "none" | "short"): string {
	if (prefix === "none") {
		return "";
	}
	if (prefix === "short") {
		const shortName = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return shortName.length > 0 ? shortName : "mcp";
	}
	return serverName.replace(/-/g, "_");
}

function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
	excludeTools: readonly string[] | undefined,
): boolean {
	if (!excludeTools || excludeTools.length === 0) {
		return false;
	}
	const candidates = new Set([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);
	return excludeTools.some((excluded) => candidates.has(normalizeToolName(excluded)));
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function createSha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function resolveBearerToken(server: McpAdapterServerEntry, env: NodeJS.ProcessEnv): string | undefined {
	if (server.bearerToken !== undefined) {
		return interpolateEnvValue(server.bearerToken, env);
	}
	return server.bearerTokenEnv ? env[server.bearerTokenEnv] : undefined;
}

function interpolateEnvRecord(
	values: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
	if (!values) {
		return undefined;
	}
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		resolved[key] = interpolateEnvValue(value, env) ?? "";
	}
	return resolved;
}

function interpolateEnvValue(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	return value
		?.replace(/\$\{(\w+)\}/g, (_match, name: string) => env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_match, name: string) => env[name] ?? "");
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim();
	return value && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
