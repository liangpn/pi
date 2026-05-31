import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type JsonObject,
	loadMcpConfig,
	type McpToolMapping,
	type RpcTaskConsoleMcpConfig,
} from "../src/mcp-config.js";
import {
	type McpContentItem,
	type McpRemoteTool,
	McpStreamableHttpClient,
	type McpToolResult,
} from "../src/mcp-streamable-http-client.js";

const PERMISSIVE_PARAMETERS_SCHEMA = { type: "object", additionalProperties: true };

interface ResolvedMcpToolMapping extends McpToolMapping {
	readonly description: string;
	readonly parameters: JsonObject;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const configPath = process.env.PI_DEMO_MCP_CONFIG_PATH;
	if (!configPath) {
		return;
	}
	const config = loadMcpConfig(configPath, process.env);
	const clients = new Map<string, McpStreamableHttpClient>();
	const resolvedMappings = await resolveMcpToolMappings(config, clients);
	const allowedTools = new Set(
		resolvedMappings.map((mapping) => `${mapping.server}\0${mapping.name}\0${mapping.mcpTool}`),
	);

	for (const mapping of resolvedMappings) {
		const parameters = createParametersSchema(mapping);
		pi.registerTool(
			defineTool({
				name: mapping.name,
				label: mapping.name,
				description: mapping.description,
				parameters,
				async execute(_toolCallId, params, signal) {
					if (!allowedTools.has(`${mapping.server}\0${mapping.name}\0${mapping.mcpTool}`)) {
						return createToolErrorResult(
							mapping,
							new Error(`Tool "${mapping.name}" is not allowed by MCP config`),
						);
					}
					const client = getClient(config, clients, mapping.server);
					try {
						const result = await client.callTool(mapping.mcpTool, params, signal);
						return {
							content: [{ type: "text", text: mcpResultToText(result) }],
							details: {
								server: mapping.server,
								mcpTool: mapping.mcpTool,
								result,
								isError: result.isError === true,
							},
						};
					} catch (error: unknown) {
						if (isAbortError(error)) {
							throw error;
						}
						return createToolErrorResult(mapping, error);
					}
				},
			}),
		);
	}
}

async function resolveMcpToolMappings(
	config: RpcTaskConsoleMcpConfig,
	clients: Map<string, McpStreamableHttpClient>,
): Promise<ResolvedMcpToolMapping[]> {
	const remoteToolsByServer = new Map<string, Map<string, McpRemoteTool>>();
	for (const serverName of new Set(config.tools.map((mapping) => mapping.server))) {
		const client = getClient(config, clients, serverName);
		const remoteTools = await client.listTools(undefined);
		remoteToolsByServer.set(serverName, new Map(remoteTools.map((tool) => [tool.name, tool])));
	}

	const missingTools: string[] = [];
	const resolvedMappings: ResolvedMcpToolMapping[] = [];
	for (const mapping of config.tools) {
		const remoteTool = remoteToolsByServer.get(mapping.server)?.get(mapping.mcpTool);
		if (!remoteTool) {
			missingTools.push(`${mapping.server}/${mapping.mcpTool}`);
			continue;
		}
		resolvedMappings.push({
			...mapping,
			description: mapping.description ?? remoteTool.description ?? mapping.name,
			parameters: resolveParametersSchema(mapping, remoteTool),
		});
	}
	if (missingTools.length > 0) {
		throw new Error(`MCP config exposes tools not returned by remote tools/list: ${missingTools.join(", ")}`);
	}
	return resolvedMappings;
}

function getClient(
	config: RpcTaskConsoleMcpConfig,
	clients: Map<string, McpStreamableHttpClient>,
	serverName: string,
): McpStreamableHttpClient {
	const existing = clients.get(serverName);
	if (existing) {
		return existing;
	}
	const server = config.servers[serverName];
	if (!server) {
		throw new Error(`Unknown MCP server "${serverName}"`);
	}
	const client = new McpStreamableHttpClient({ server });
	clients.set(serverName, client);
	return client;
}

function createParametersSchema(mapping: ResolvedMcpToolMapping) {
	return Type.Unsafe<Record<string, unknown>>(mapping.parameters);
}

function resolveParametersSchema(mapping: McpToolMapping, remoteTool: McpRemoteTool): JsonObject {
	if (mapping.parameters) {
		return mapping.parameters;
	}
	if (isJsonObject(remoteTool.inputSchema)) {
		return remoteTool.inputSchema;
	}
	console.warn(`MCP tool "${mapping.mcpTool}" did not include inputSchema; using a permissive object schema`);
	return PERMISSIVE_PARAMETERS_SCHEMA;
}

function mcpResultToText(result: McpToolResult): string {
	const textItems = result.content.map((item) => contentItemToText(item)).filter((text) => text.length > 0);
	if (textItems.length > 0) {
		return textItems.join("\n");
	}
	if (result.structuredContent !== undefined) {
		return JSON.stringify(result.structuredContent);
	}
	return result.isError ? "MCP tool returned an error without text content" : "MCP tool returned no text content";
}

function contentItemToText(item: McpContentItem): string {
	if (item.type === "text") {
		return item.text;
	}
	if (item.type === "resource_link") {
		return item.uri;
	}
	return JSON.stringify(item);
}

function createToolErrorResult(mapping: McpToolMapping, error: unknown) {
	const message = formatError(error);
	const result = {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
	return {
		content: [{ type: "text" as const, text: `MCP tool "${mapping.name}" failed: ${message}` }],
		details: {
			server: mapping.server,
			mcpTool: mapping.mcpTool,
			result,
			isError: true,
			error: message,
		},
	};
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
