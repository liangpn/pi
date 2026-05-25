import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpStreamableHttpServerConfig } from "./mcp-config.js";

export interface McpStreamableHttpClientOptions {
	readonly server: McpStreamableHttpServerConfig;
	readonly fetchFn?: typeof fetch;
}

export type McpToolResult = CallToolResult;
export type McpContentItem = CallToolResult["content"][number];
export type McpRemoteTool = Tool;

export class McpStreamableHttpClient {
	private readonly server: McpStreamableHttpServerConfig;
	private readonly fetchFn: typeof fetch;
	private client: Client | undefined;
	private connectPromise: Promise<Client> | undefined;

	constructor(options: McpStreamableHttpClientOptions) {
		this.server = options.server;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async listTools(signal: AbortSignal | undefined): Promise<McpRemoteTool[]> {
		const client = await this.ensureConnected(signal);
		const tools: McpRemoteTool[] = [];
		let cursor: string | undefined;
		do {
			const result = await client.listTools(cursor ? { cursor } : undefined, this.createRequestOptions(signal));
			tools.push(...result.tools);
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<McpToolResult> {
		try {
			const client = await this.ensureConnected(signal);
			const result = await client.callTool(
				{ name, arguments: args },
				CallToolResultSchema,
				this.createRequestOptions(signal),
			);
			if (!isMcpToolResult(result)) {
				throw new Error(`MCP protocol error: tools/call for "${name}" returned an invalid result`);
			}
			return result;
		} catch (error: unknown) {
			throw wrapToolCallError(name, error);
		}
	}

	private async ensureConnected(signal: AbortSignal | undefined): Promise<Client> {
		if (this.client) {
			return this.client;
		}
		if (this.connectPromise) {
			return this.connectPromise;
		}
		this.connectPromise = this.connect(signal);
		try {
			this.client = await this.connectPromise;
			return this.client;
		} catch (error: unknown) {
			this.connectPromise = undefined;
			throw error;
		}
	}

	private async connect(signal: AbortSignal | undefined): Promise<Client> {
		const client = new Client({ name: "pi-rpc-task-console", version: "0.1.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
			fetch: this.fetchFn,
			requestInit: { headers: this.server.headers },
		});
		await client.connect(transport, this.createRequestOptions(signal));
		return client;
	}

	private createRequestOptions(signal: AbortSignal | undefined) {
		return {
			...(signal === undefined ? {} : { signal }),
			...(this.server.timeoutMs === undefined ? {} : { timeout: this.server.timeoutMs }),
		};
	}
}

function isMcpToolResult(value: unknown): value is McpToolResult {
	if (!isRecord(value)) {
		return false;
	}
	return Array.isArray(value.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function wrapToolCallError(toolName: string, error: unknown): Error {
	if (isAbortError(error)) {
		return error;
	}
	return new Error(`MCP tool "${toolName}" failed: ${formatError(error)}`);
}

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const code = isRecord(error) && typeof error.code === "number" ? error.code : undefined;
	if (message.startsWith("Streamable HTTP error")) {
		return code === undefined ? message : `HTTP ${code}: ${message}`;
	}
	if (message.startsWith("MCP error")) {
		return `JSON-RPC ${message}`;
	}
	if (message.includes("Invalid input") || message.includes("invalid_union")) {
		return `MCP protocol error: ${message}`;
	}
	return message;
}
