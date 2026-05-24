import type { McpStreamableHttpServerConfig } from "./mcp-config.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpStreamableHttpClientOptions {
	readonly server: McpStreamableHttpServerConfig;
	readonly fetchFn?: typeof fetch;
}

export interface McpToolResult {
	readonly content: readonly McpContentItem[];
	readonly isError?: boolean;
	readonly structuredContent?: unknown;
}

export type McpContentItem =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "audio"; readonly data: string; readonly mimeType: string }
	| { readonly type: "resource_link"; readonly uri: string; readonly name?: string; readonly description?: string }
	| { readonly type: "resource"; readonly resource: unknown };

interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id?: number;
	readonly method: string;
	readonly params?: unknown;
}

interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id?: number;
	readonly result?: unknown;
	readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

export class McpStreamableHttpClient {
	private readonly server: McpStreamableHttpServerConfig;
	private readonly fetchFn: typeof fetch;
	private nextId = 1;
	private initialized = false;
	private protocolVersion = MCP_PROTOCOL_VERSION;
	private sessionId: string | undefined;

	constructor(options: McpStreamableHttpClientOptions) {
		this.server = options.server;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<McpToolResult> {
		try {
			await this.ensureInitialized(signal);
			const response = await this.sendRequest(
				{
					jsonrpc: "2.0",
					id: this.nextRequestId(),
					method: "tools/call",
					params: { name, arguments: args },
				},
				signal,
			);
			if (!isMcpToolResult(response.result)) {
				throw new Error(`MCP protocol error: tools/call for "${name}" returned an invalid result`);
			}
			return response.result;
		} catch (error: unknown) {
			throw wrapToolCallError(name, error);
		}
	}

	private async ensureInitialized(signal: AbortSignal | undefined): Promise<void> {
		if (this.initialized) {
			return;
		}
		const response = await this.sendRequest(
			{
				jsonrpc: "2.0",
				id: this.nextRequestId(),
				method: "initialize",
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-rpc-task-console", version: "0.1.0" },
				},
			},
			signal,
		);
		if (isInitializeResult(response.result) && response.result.protocolVersion.length > 0) {
			this.protocolVersion = response.result.protocolVersion;
		}
		await this.sendNotification("notifications/initialized", signal);
		this.initialized = true;
	}

	private async sendNotification(method: string, signal: AbortSignal | undefined): Promise<void> {
		const response = await this.fetchFn(this.server.url, {
			method: "POST",
			headers: this.createHeaders(),
			body: JSON.stringify({ jsonrpc: "2.0", method }),
			signal,
		});
		if (response.status !== 202 && !response.ok) {
			throw new Error(`MCP notification "${method}" failed with HTTP ${response.status}`);
		}
	}

	private async sendRequest(request: JsonRpcRequest, signal: AbortSignal | undefined): Promise<JsonRpcResponse> {
		const response = await this.fetchFn(this.server.url, {
			method: "POST",
			headers: this.createHeaders(),
			body: JSON.stringify(request),
			signal,
		});
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId && sessionId.length > 0) {
			this.sessionId = sessionId;
		}
		if (!response.ok) {
			throw new Error(`MCP request "${request.method}" failed with HTTP ${response.status}`);
		}
		const message = await readJsonRpcResponse(response);
		if (message.error) {
			const code = typeof message.error.code === "number" ? ` ${message.error.code}` : "";
			const messageText = message.error.message ?? `MCP request "${request.method}" failed`;
			throw new Error(`MCP request "${request.method}" failed with JSON-RPC error${code}: ${messageText}`);
		}
		return message;
	}

	private createHeaders(): Headers {
		const headers = new Headers(this.server.headers);
		headers.set("content-type", "application/json");
		headers.set("accept", "application/json, text/event-stream");
		headers.set("mcp-protocol-version", this.protocolVersion);
		if (this.sessionId) {
			headers.set("mcp-session-id", this.sessionId);
		}
		return headers;
	}

	private nextRequestId(): number {
		const id = this.nextId;
		this.nextId += 1;
		return id;
	}
}

async function readJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		return readSseJsonRpcResponse(await response.text());
	}
	const value = (await response.json()) as unknown;
	if (!isJsonRpcResponse(value)) {
		throw new Error("MCP protocol error: HTTP response was not a JSON-RPC response");
	}
	return value;
}

function readSseJsonRpcResponse(body: string): JsonRpcResponse {
	for (const eventBlock of body.split(/\r?\n\r?\n/)) {
		const dataLines = eventBlock
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trimStart());
		if (dataLines.length === 0) {
			continue;
		}
		const value = JSON.parse(dataLines.join("\n")) as unknown;
		if (isJsonRpcResponse(value)) {
			return value;
		}
	}
	throw new Error("MCP protocol error: SSE response did not contain a JSON-RPC response");
}

function isInitializeResult(value: unknown): value is { readonly protocolVersion: string } {
	if (!isRecord(value)) {
		return false;
	}
	return typeof value.protocolVersion === "string";
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	if (!isRecord(value)) {
		return false;
	}
	return value.jsonrpc === "2.0" && ("result" in value || "error" in value);
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
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`MCP tool "${toolName}" failed: ${message}`);
}

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
}
