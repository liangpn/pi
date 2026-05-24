import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DemoEnv } from "./env.js";
import { loadDemoEnv } from "./env.js";
import { validatePlanSteps } from "./plan-validation.js";
import { RunManager, type RunManagerOptions } from "./run-manager.js";
import type { PlanStep, TaskSnapshot } from "./types.js";

const exampleDir = dirname(fileURLToPath(import.meta.url));
const staticDir = exampleDir;
const indexHtmlPath = join(staticDir, "index.html");

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
	if (request.method === "POST" && (url.pathname === "/runs/start" || url.pathname === "/api/run")) {
		const body = await readJsonBodySafely(request, response);
		if (body === undefined && response.writableEnded) {
			return;
		}
		const runRequest =
			url.pathname === "/api/run"
				? parseLegacyRunRequest(body)
				: parseCanonicalRunRequest(body, "steps are required");
		if (!runRequest.ok) {
			writeJson(response, 400, { error: runRequest.error });
			return;
		}
		try {
			const run = manager.start(runRequest.userInstruction, runRequest.steps);
			writeJson(response, 202, { run });
		} catch (error) {
			writeJson(response, 400, { error: toErrorMessage(error) });
		}
		return;
	}
	if (request.method === "POST" && url.pathname === "/runs/replace") {
		const body = await readJsonBodySafely(request, response);
		if (body === undefined && response.writableEnded) {
			return;
		}
		const runRequest = parseCanonicalRunRequest(body, "steps are required");
		if (!runRequest.ok) {
			writeJson(response, 400, { error: runRequest.error });
			return;
		}
		try {
			const run = manager.replace(runRequest.userInstruction, runRequest.steps);
			writeJson(response, 202, { run });
		} catch (error) {
			writeJson(response, 400, { error: toErrorMessage(error) });
		}
		return;
	}
	if (request.method === "POST" && (url.pathname === "/runs/stop" || url.pathname === "/api/stop")) {
		manager.stop("user_stopped");
		writeJson(response, 202, { snapshot: manager.getSnapshot() });
		return;
	}
	if (request.method === "POST" && (url.pathname === "/runs/reset" || url.pathname === "/api/reset")) {
		const body = await readJsonBodySafely(request, response);
		if (body === undefined && response.writableEnded) {
			return;
		}
		const stepsRequest = parseOptionalStepsRequest(body);
		if (!stepsRequest.ok) {
			writeJson(response, 400, { error: stepsRequest.error });
			return;
		}
		try {
			manager.reset(stepsRequest.steps);
		} catch (error) {
			writeJson(response, 400, { error: toErrorMessage(error) });
			return;
		}
		writeJson(response, 200, { snapshot: manager.getSnapshot() });
		return;
	}
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		const shell = await readUiShell();
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(shell.html);
		return;
	}
	if (request.method === "GET" && url.pathname === "/styles.css") {
		const shell = await readUiShell();
		response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
		response.end(shell.styles);
		return;
	}
	if (request.method === "GET" && url.pathname === "/app.js") {
		const shell = await readUiShell();
		response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
		response.end(shell.app);
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

async function readJsonBodySafely(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
	try {
		return await readJsonBody(request);
	} catch {
		writeJson(response, 400, { error: "invalid json" });
		return undefined;
	}
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function writeSseSnapshot(response: ServerResponse, snapshot: TaskSnapshot): void {
	response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
}

interface ParsedRunRequest {
	readonly ok: true;
	readonly steps?: readonly PlanStep[];
	readonly userInstruction: string;
}

interface FailedParse {
	readonly ok: false;
	readonly error: string;
}

type RunRequestParseResult = ParsedRunRequest | FailedParse;

interface OptionalStepsParseResult {
	readonly ok: true;
	readonly steps?: readonly PlanStep[];
}

function parseLegacyRunRequest(body: unknown): RunRequestParseResult {
	if (!isRecord(body) || typeof body.instruction !== "string" || body.instruction.trim().length === 0) {
		return { ok: false, error: "instruction is required" };
	}
	return {
		ok: true,
		userInstruction: body.instruction.trim(),
	};
}

function parseCanonicalRunRequest(body: unknown, stepsError: string): RunRequestParseResult {
	if (!isRecord(body)) {
		return { ok: false, error: "request body must be an object" };
	}
	if (typeof body.userInstruction !== "string" || body.userInstruction.trim().length === 0) {
		return { ok: false, error: "userInstruction is required" };
	}
	try {
		const steps = parseRequiredSteps(body.steps, stepsError);
		return {
			ok: true,
			steps,
			userInstruction: body.userInstruction.trim(),
		};
	} catch (error) {
		return { ok: false, error: toErrorMessage(error) };
	}
}

function parseOptionalStepsRequest(body: unknown): OptionalStepsParseResult | FailedParse {
	if (body === undefined) {
		return { ok: true };
	}
	if (!isRecord(body)) {
		return { ok: false, error: "request body must be an object" };
	}
	if (!("steps" in body) || body.steps === undefined) {
		return { ok: true };
	}
	try {
		return { ok: true, steps: parseRequiredSteps(body.steps, "steps are required") };
	} catch (error) {
		return { ok: false, error: toErrorMessage(error) };
	}
}

function parseRequiredSteps(value: unknown, missingMessage: string): readonly PlanStep[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(missingMessage);
	}
	return validatePlanSteps(value as readonly PlanStep[]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface UiShellAssets {
	readonly html: string;
	readonly styles: string;
	readonly app: string;
}

let uiShellPromise: Promise<UiShellAssets> | undefined;

async function readUiShell(): Promise<UiShellAssets> {
	uiShellPromise ??= buildUiShell();
	return uiShellPromise;
}

async function buildUiShell(): Promise<UiShellAssets> {
	const source = await readFile(indexHtmlPath, "utf8");
	const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
	const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
	if (!styleMatch || !scriptMatch) {
		throw new Error("RPC task console index.html is missing inline shell assets");
	}
	const html = source
		.replace(styleMatch[0], '<link rel="stylesheet" href="/styles.css" />')
		.replace(scriptMatch[0], '    <script type="module" src="/app.js"></script>\n  </body>');
	return {
		html,
		styles: styleMatch[1].trim(),
		app: buildAppScript(scriptMatch[1]),
	};
}

function buildAppScript(source: string): string {
	return source
		.replace("      const statusText = {", "      let latestSnapshot;\n\n      const statusText = {")
		.replace(
			'          void fetch("/api/run", {\n            method: "POST",\n            headers: { "content-type": "application/json" },\n            body: JSON.stringify({ instruction }),\n          });',
			[
				'          const runPath = latestSnapshot && latestSnapshot.run && latestSnapshot.run.status !== "idle"',
				'            ? "/runs/replace"',
				'            : "/runs/start";',
				"          void fetch(runPath, {",
				'            method: "POST",',
				'            headers: { "content-type": "application/json" },',
				"            body: JSON.stringify({ steps: getSelectedStepsPayload(), userInstruction: instruction }),",
				"          });",
			].join("\n"),
		)
		.replace(
			'          void fetch("/api/stop", { method: "POST" });',
			'          void fetch("/runs/stop", { method: "POST" });',
		)
		.replace("      void loadInitialSnapshot();\n      connectEvents();", "      connectEvents();")
		.replace(/ {6}async function loadInitialSnapshot\(\) \{[\s\S]*?\n {6}\}\n\n/, "")
		.replace(
			"      function renderSnapshot(snapshot) {\n        renderMessages(snapshot);",
			"      function renderSnapshot(snapshot) {\n        latestSnapshot = snapshot;\n        renderMessages(snapshot);",
		)
		.replace(
			"      function renderMessages(snapshot) {",
			[
				"      function getSelectedStepsPayload() {",
				"        const steps = latestSnapshot?.run?.steps;",
				"        return Array.isArray(steps) ? steps : [];",
				"      }",
				"",
				"      function renderMessages(snapshot) {",
			].join("\n"),
		)
		.trimStart();
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const demoEnv = loadDemoEnv(exampleDir, process.env);
	const server = createRpcTaskConsoleServer(demoEnv);
	server.listen(demoEnv.port, () => {
		console.log(`RPC task console listening on http://localhost:${demoEnv.port}`);
		console.log(`Child Pi command: ${demoEnv.piCommand} ${demoEnv.piArgs.join(" ")}`);
	});
}
