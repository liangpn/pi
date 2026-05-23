import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedChildEvent, TaskConversationMessage, TaskLogEntry, TaskSnapshot } from "./types.js";

export interface PersistenceWriterOptions {
	readonly snapshotDir?: string;
	readonly logDir?: string;
	readonly rpcEventDir?: string;
	readonly childStderrDir?: string;
	readonly conversationDir?: string;
}

export interface RpcEventRecord {
	readonly runId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly agentRunId?: string;
	readonly time: number;
	readonly event: NormalizedChildEvent;
}

export interface ChildStderrRecord {
	readonly runId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly agentRunId?: string;
	readonly stderrTail: string;
}

export function createPersistenceWriter(options: PersistenceWriterOptions) {
	return {
		async writeSnapshot(snapshot: TaskSnapshot): Promise<string> {
			return writeJsonFile(
				options.snapshotDir,
				`${sanitize(snapshot.run.id)}.json`,
				`${JSON.stringify(snapshot, null, 2)}\n`,
			);
		},

		async appendTaskLog(entry: TaskLogEntry): Promise<string> {
			return appendJsonLine(options.logDir, `${sanitize(entry.runId)}.jsonl`, entry);
		},

		async appendRpcEvent(record: RpcEventRecord): Promise<string> {
			return appendJsonLine(
				options.rpcEventDir,
				join(sanitize(record.runId), buildTaskFileName(record.stepId, record.taskId, record.agentRunId, "jsonl")),
				record,
			);
		},

		async writeChildStderr(record: ChildStderrRecord): Promise<string> {
			return writeJsonFile(
				options.childStderrDir,
				join(sanitize(record.runId), buildTaskFileName(record.stepId, record.taskId, record.agentRunId, "log")),
				record.stderrTail,
			);
		},

		async appendConversationMessage(message: TaskConversationMessage): Promise<string> {
			return appendJsonLine(options.conversationDir, `${sanitize(message.runId)}.jsonl`, message);
		},
	};
}

async function writeJsonFile(baseDir: string | undefined, relativePath: string, contents: string): Promise<string> {
	const filePath = resolveFilePath(baseDir, relativePath);
	if (!filePath) {
		return "";
	}
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, contents, "utf8");
	return filePath;
}

async function appendJsonLine(baseDir: string | undefined, relativePath: string, value: unknown): Promise<string> {
	const filePath = resolveFilePath(baseDir, relativePath);
	if (!filePath) {
		return "";
	}
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
	return filePath;
}

function resolveFilePath(baseDir: string | undefined, relativePath: string): string | undefined {
	if (!baseDir) {
		return undefined;
	}
	return join(baseDir, relativePath);
}

function buildTaskFileName(stepId: string, taskId: string, agentRunId: string | undefined, extension: string): string {
	const suffix = agentRunId ? `__${sanitize(agentRunId)}` : "";
	return `${sanitize(stepId)}__${sanitize(taskId)}${suffix}.${extension}`;
}

function sanitize(value: string): string {
	return value.replaceAll(/[\\/]/g, "_");
}
