import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DemoEnv } from "./env.js";
import { loadDemoEnv } from "./env.js";
import { RunManager, type RunManagerOptions } from "./run-manager.js";
import type { TaskSnapshot } from "./types.js";

const exampleDir = dirname(fileURLToPath(import.meta.url));
const staticDir = exampleDir;

export interface RpcTaskConsoleServerOptions {
	readonly runManager?: RunManager;
	readonly runManagerOptions?: Omit<RunManagerOptions, "demoEnv">;
}

export function createRpcTaskConsoleServer(demoEnv: DemoEnv, options: RpcTaskConsoleServerOptions = {}): Server {
	const manager = options.runManager ?? new RunManager({ demoEnv, ...options.runManagerOptions });
	const sseClients = new Set<ServerResponse>();

	const unsubscribe = manager.subscribe((snapshot) => {
		for (const client of sseClients) {
			writeSseSnapshot(client, snapshot);
		}
	});

	const server = createServer((request, response) => {
		void handleRequest(request, response, manager, sseClients);
	});
	server.on("close", () => {
		unsubscribe();
		for (const client of sseClients) {
			client.end();
		}
		sseClients.clear();
	});
	return server;
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	manager: RunManager,
	sseClients: Set<ServerResponse>,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (request.method === "GET" && url.pathname === "/api/snapshot") {
		writeJson(response, 200, manager.getSnapshot());
		return;
	}
	if (request.method === "GET" && url.pathname === "/events") {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		sseClients.add(response);
		writeSseSnapshot(response, manager.getSnapshot());
		request.on("close", () => {
			sseClients.delete(response);
		});
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/run") {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.instruction !== "string" || body.instruction.trim().length === 0) {
			writeJson(response, 400, { error: "instruction is required" });
			return;
		}
		const run = manager.start(body.instruction.trim());
		writeJson(response, 202, { run });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/stop") {
		manager.stop("user_stopped");
		writeJson(response, 202, { snapshot: manager.getSnapshot() });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/reset") {
		manager.reset();
		writeJson(response, 200, { snapshot: manager.getSnapshot() });
		return;
	}
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		await serveFile(response, join(staticDir, "index.html"), "text/html; charset=utf-8");
		return;
	}
	if (request.method === "GET" && url.pathname === "/styles.css") {
		await serveFile(response, join(staticDir, "styles.css"), "text/css; charset=utf-8");
		return;
	}
	if (request.method === "GET" && url.pathname === "/app.js") {
		await serveFile(response, join(staticDir, "app.js"), "text/javascript; charset=utf-8");
		return;
	}
	writeJson(response, 404, { error: "not found" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	let raw = "";
	for await (const chunk of request) {
		raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	}
	if (raw.trim().length === 0) {
		return undefined;
	}
	return JSON.parse(raw);
}

async function serveFile(response: ServerResponse, path: string, contentType: string): Promise<void> {
	try {
		const content = await readFile(path);
		response.writeHead(200, { "content-type": contentType });
		response.end(content);
	} catch {
		writeJson(response, 404, { error: "not found" });
	}
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function writeSseSnapshot(response: ServerResponse, snapshot: TaskSnapshot): void {
	response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const demoEnv = loadDemoEnv(exampleDir, process.env);
	const server = createRpcTaskConsoleServer(demoEnv);
	server.listen(demoEnv.port, () => {
		console.log(`RPC task console listening on http://localhost:${demoEnv.port}`);
		console.log(`Child Pi command: ${demoEnv.piCommand} ${demoEnv.piArgs.join(" ")}`);
	});
}
