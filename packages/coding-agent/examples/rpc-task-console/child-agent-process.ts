import type { ChildProcess } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.js";
import { spawnProcess } from "../../src/utils/child-process.js";
import type { ChildAgentProcessFactoryOptions, ChildAgentProcessLike, NormalizedChildEvent } from "./types.js";

const STDERR_TAIL_LIMIT = 4_000;

export class ChildAgentProcess implements ChildAgentProcessLike {
	readonly agentRunId: string;
	private readonly options: ChildAgentProcessFactoryOptions;
	private child: ChildProcess | undefined;
	private requestSequence = 0;
	private stderrTail = "";
	private detachStdout: (() => void) | undefined;

	constructor(options: ChildAgentProcessFactoryOptions) {
		this.options = options;
		this.agentRunId = `agent-${options.runId}-${options.stepId}-${options.taskId}`;
	}

	get processId(): number | undefined {
		return this.child?.pid;
	}

	start(): void {
		if (this.child) {
			return;
		}

		const child = spawnProcess(this.options.command, [...this.options.args], {
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.options.onEvent({ type: "child_started", processId: child.pid });

		if (child.stdout) {
			this.detachStdout = attachJsonlLineReader(child.stdout, (line) => {
				this.options.onEvent(normalizeChildLine(line));
			});
		}
		child.stderr?.on("data", (chunk: string | Buffer) => {
			this.stderrTail = appendTail(this.stderrTail, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		});
		child.on("error", (error) => {
			this.options.onEvent({ type: "process_error", error: error.message, stderrTail: this.stderrTail });
		});
		child.on("close", (exitCode, signal) => {
			this.detachStdout?.();
			this.detachStdout = undefined;
			this.options.onEvent({ type: "process_close", exitCode, signal, stderrTail: this.stderrTail });
		});
	}

	sendPrompt(message: string): string {
		return this.send({ type: "prompt", message });
	}

	sendSteer(message: string): string {
		return this.send({ type: "steer", message });
	}

	sendAbort(): string {
		return this.send({ type: "abort" });
	}

	kill(signal: NodeJS.Signals): void {
		this.child?.kill(signal);
	}

	private send(
		command: { readonly type: "prompt" | "steer"; readonly message: string } | { readonly type: "abort" },
	): string {
		const id = `${this.agentRunId}-${command.type}-${++this.requestSequence}`;
		this.child?.stdin?.write(serializeJsonLine({ ...command, id }));
		return id;
	}
}

export function createChildAgentProcess(options: ChildAgentProcessFactoryOptions): ChildAgentProcessLike {
	return new ChildAgentProcess(options);
}

export function normalizeChildLine(line: string): NormalizedChildEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		return {
			type: "diagnostic",
			message: "Failed to parse child JSONL line",
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	if (!isRecord(parsed)) {
		return { type: "diagnostic", message: "Child JSONL line was not an object", detail: parsed };
	}

	const eventType = stringField(parsed, "type");
	if (eventType === "response") {
		return {
			type: "rpc_response",
			id: stringField(parsed, "id"),
			command: stringField(parsed, "command"),
			success: parsed.success === true,
			error: stringField(parsed, "error"),
		};
	}
	if (eventType === "agent_start") {
		return { type: "agent_start" };
	}
	if (eventType === "message_update") {
		return {
			type: "message_update",
			message: parsed.message,
			assistantMessageEvent: parsed.assistantMessageEvent,
		};
	}
	if (eventType === "tool_execution_start") {
		return {
			type: "tool_execution_start",
			toolCallId: stringField(parsed, "toolCallId"),
			toolName: stringField(parsed, "toolName"),
			args: parsed.args,
		};
	}
	if (eventType === "tool_execution_update") {
		return {
			type: "tool_execution_update",
			toolCallId: stringField(parsed, "toolCallId"),
			toolName: stringField(parsed, "toolName"),
			partialResult: parsed.partialResult,
		};
	}
	if (eventType === "tool_execution_end") {
		return {
			type: "tool_execution_end",
			toolCallId: stringField(parsed, "toolCallId"),
			toolName: stringField(parsed, "toolName"),
			result: parsed.result,
			isError: parsed.isError === true,
		};
	}
	if (eventType === "message_start") {
		return { type: "message_start", message: parsed.message };
	}
	if (eventType === "message_end") {
		return { type: "message_end", message: parsed.message };
	}
	if (eventType === "turn_start") {
		return { type: "turn_start" };
	}
	if (eventType === "turn_end") {
		return { type: "turn_end", message: parsed.message };
	}
	if (eventType === "agent_end") {
		return { type: "agent_end", messages: parsed.messages, willRetry: parsed.willRetry === true };
	}
	return { type: "diagnostic", message: `Unhandled child event: ${eventType ?? "unknown"}`, detail: parsed };
}

function appendTail(current: string, value: string): string {
	const next = current + value;
	return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
	const candidate = value[field];
	return typeof candidate === "string" ? candidate : undefined;
}
