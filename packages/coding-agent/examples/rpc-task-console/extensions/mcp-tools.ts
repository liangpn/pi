import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadMcpConfig, type McpToolMapping, type RpcTaskConsoleMcpConfig } from "../mcp-config.js";
import { type McpContentItem, McpStreamableHttpClient, type McpToolResult } from "../mcp-streamable-http-client.js";

export default function (pi: ExtensionAPI): void {
	const configPath = process.env.PI_DEMO_MCP_CONFIG_PATH;
	if (!configPath) {
		return;
	}
	const config = loadMcpConfig(configPath, process.env);
	const clients = new Map<string, McpStreamableHttpClient>();

	for (const mapping of config.tools) {
		const parameters = createParametersSchema(mapping);
		pi.registerTool(
			defineTool({
				name: mapping.name,
				label: mapping.name,
				description: mapping.description,
				parameters,
				async execute(_toolCallId, params, signal) {
					const client = getClient(config, clients, mapping.server);
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
				},
			}),
		);
	}
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

function createParametersSchema(mapping: McpToolMapping) {
	return Type.Unsafe<Record<string, unknown>>(mapping.parameters ?? { type: "object", additionalProperties: true });
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
