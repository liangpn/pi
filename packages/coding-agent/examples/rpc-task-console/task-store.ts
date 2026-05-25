import { randomUUID } from "node:crypto";
import { createRuntimeSteps } from "./tasks.js";
import type {
	JsonCardData,
	MapCardData,
	MediaCardData,
	PlanStep,
	RunStatus,
	RuntimeStep,
	RuntimeTask,
	SystemReceipt,
	TableCardData,
	TaskAttempt,
	TaskLogEntry,
	TaskResult,
	TaskSnapshot,
	TaskStatus,
	TaskStoreEvent,
	TextCardData,
	UICard,
} from "./types.js";

export function aggregateStepStatus(statuses: readonly TaskStatus[]): TaskStatus {
	if (statuses.some((status) => status === "fail")) {
		return "fail";
	}
	if (statuses.length > 0 && statuses.every((status) => status === "complete")) {
		return "complete";
	}
	if (statuses.length > 0 && statuses.every((status) => status === "stopped")) {
		return "stopped";
	}
	if (!statuses.some((status) => status === "running") && statuses.some((status) => status === "stopped")) {
		return "stopped";
	}
	if (statuses.some((status) => status === "running" || status === "complete")) {
		return "running";
	}
	return "loading";
}

export class TaskStore {
	private snapshot: TaskSnapshot;
	private planSteps: readonly PlanStep[];
	private readonly listeners = new Set<(snapshot: TaskSnapshot) => void>();

	private constructor(planSteps: readonly PlanStep[], snapshot: TaskSnapshot) {
		this.planSteps = clone(planSteps);
		this.snapshot = snapshot;
	}

	static createIdle(planSteps: readonly PlanStep[]): TaskStore {
		return new TaskStore(planSteps, {
			run: {
				id: "idle",
				userInstruction: "",
				status: "idle",
				steps: createRuntimeSteps(planSteps),
				createdAt: 0,
			},
			cards: [],
			logs: [],
			receipts: [],
			conversationMessages: [],
		});
	}

	getSnapshot(): TaskSnapshot {
		return clone(this.snapshot);
	}

	subscribe(listener: (snapshot: TaskSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	startRun(
		runId: string,
		userInstruction: string,
		time: number,
		planSteps: readonly PlanStep[] = this.planSteps,
	): TaskSnapshot["run"] {
		this.planSteps = clone(planSteps);
		this.snapshot = {
			run: {
				id: runId,
				userInstruction,
				status: "running",
				steps: createRuntimeSteps(this.planSteps),
				createdAt: time,
				startedAt: time,
			},
			cards: [],
			logs: [],
			receipts: [
				{
					id: randomUUID(),
					runId,
					message: `已创建 ${this.planSteps.length} 个步骤，${this.planSteps.flatMap((step) => step.tasks).length} 个任务`,
					time,
					level: "info",
				},
			],
			conversationMessages: [],
		};
		this.emit();
		return this.getSnapshot().run;
	}

	markRunStopping(
		runId: string,
		reason: NonNullable<TaskSnapshot["run"]["stopReason"]>,
		time: number,
		replacementInstruction?: string,
	): void {
		if (runId !== this.snapshot.run.id || isTerminalRunStatus(this.snapshot.run.status)) {
			return;
		}
		this.snapshot = {
			...this.snapshot,
			run: {
				...this.snapshot.run,
				status: "stopping",
				stopReason: reason,
				replacementInstruction,
				finishedAt: undefined,
				startedAt: this.snapshot.run.startedAt ?? time,
			},
		};
		this.emit();
	}

	markRunStopped(runId: string, time: number): void {
		if (runId !== this.snapshot.run.id) {
			return;
		}
		this.snapshot = {
			...this.snapshot,
			run: {
				...this.snapshot.run,
				status: "stopped",
				finishedAt: this.snapshot.run.finishedAt ?? time,
			},
		};
		this.emit();
	}

	apply(event: TaskStoreEvent): void {
		if (event.runId !== this.snapshot.run.id) {
			if (this.snapshot.run.status === "idle") {
				return;
			}
			this.snapshot = {
				...this.snapshot,
				logs: [...this.snapshot.logs, this.createIgnoredRunLog(event)],
			};
			this.emit();
			return;
		}

		const step = this.findStep(event.stepId);
		const task = step?.tasks.find((candidate) => candidate.id === event.taskId);
		if (!step || !task) {
			return;
		}

		if (isStateEvent(event) && this.isLateStateEvent(step, task)) {
			this.snapshot = {
				...this.snapshot,
				logs: [...this.snapshot.logs, this.createIgnoredStateLog(event, step, task)],
			};
			this.emit();
			return;
		}

		const mutation = this.applyToTask(task, event);
		const nextTask = mutation.task;
		const nextSteps = this.snapshot.run.steps.map((candidateStep) => {
			if (candidateStep.id !== event.stepId) {
				return candidateStep;
			}
			const tasks = candidateStep.tasks.map((candidateTask) =>
				candidateTask.id === event.taskId ? nextTask : candidateTask,
			);
			return {
				...candidateStep,
				tasks,
				status: aggregateStepStatus(tasks.map((candidateTask) => candidateTask.status)),
			};
		});
		const nextLogs = [...this.snapshot.logs, this.createLog(event), ...mutation.extraLogs];
		const nextReceipts = this.appendReceipt(this.snapshot.receipts, nextSteps, nextTask, event);
		const nextCards = this.applyCards(this.snapshot.cards, nextTask, event);
		const nextConversationMessages = mutation.conversationMessage
			? [...this.snapshot.conversationMessages, mutation.conversationMessage]
			: [...this.snapshot.conversationMessages];
		const computedRunStatus = aggregateRunStatus(nextSteps);
		const runStatus = this.snapshot.run.status === "stopping" ? "stopping" : computedRunStatus;

		this.snapshot = {
			run: {
				...this.snapshot.run,
				status: runStatus,
				steps: nextSteps,
				finishedAt:
					runStatus === "stopping"
						? this.snapshot.run.finishedAt
						: (this.snapshot.run.finishedAt ?? (isTerminalRunStatus(runStatus) ? event.time : undefined)),
			},
			cards: nextCards,
			logs: nextLogs,
			receipts: nextReceipts,
			conversationMessages: nextConversationMessages,
		};
		this.emit();
	}

	reset(time: number, planSteps: readonly PlanStep[] = this.planSteps): void {
		this.planSteps = clone(planSteps);
		this.snapshot = {
			run: {
				id: "idle",
				userInstruction: "",
				status: "idle",
				steps: createRuntimeSteps(this.planSteps),
				createdAt: time,
			},
			cards: [],
			logs: [],
			receipts: [],
			conversationMessages: [],
		};
		this.emit();
	}

	private findStep(stepId: string): RuntimeStep | undefined {
		return this.snapshot.run.steps.find((step) => step.id === stepId);
	}

	private isLateStateEvent(step: RuntimeStep, task: RuntimeTask): boolean {
		return (
			isTerminalRunStatus(this.snapshot.run.status) ||
			isTerminalTaskStatus(step.status) ||
			isTerminalTaskStatus(task.status)
		);
	}

	private applyToTask(task: RuntimeTask, event: TaskStoreEvent): TaskMutation {
		const attempts = this.applyToAttempts(task, event);
		const base = {
			...task,
			attempts,
			agent: event.agent ? { ...task.agent, ...event.agent } : task.agent,
			process: event.process ? { ...task.process, ...event.process } : task.process,
			eventCount: task.eventCount + 1,
		};
		if (event.type === "task_started") {
			return {
				task: {
					...base,
					status: "running",
					startedAt: task.startedAt ?? event.time,
				},
				extraLogs: [],
			};
		}
		if (event.type === "task_completed") {
			const result = normalizeTaskResult(event.result);
			const extraLogs =
				!task.card_type && getResultData(result) !== undefined ? [this.createDataIgnoredLog(event)] : [];
			return {
				task: {
					...base,
					status: "complete",
					result,
					finishedAt: event.time,
				},
				extraLogs,
				conversationMessage: {
					id: randomUUID(),
					runId: event.runId,
					stepId: event.stepId,
					taskId: event.taskId,
					content: result.content,
					time: event.time,
				},
			};
		}
		if (event.type === "task_attempt_failed") {
			return {
				task: base,
				extraLogs: [],
			};
		}
		if (event.type === "task_failed") {
			return {
				task: {
					...base,
					status: "fail",
					error: event.error,
					finishedAt: event.time,
				},
				extraLogs: [],
			};
		}
		if (event.type === "task_stopped") {
			return {
				task: {
					...base,
					status: "stopped",
					stopped: event.stopped,
					finishedAt: event.time,
				},
				extraLogs: [],
			};
		}
		return { task: base, extraLogs: [] };
	}

	private applyToAttempts(task: RuntimeTask, event: TaskStoreEvent): TaskAttempt[] {
		const attempts = task.attempts.map((attempt) => ({ ...attempt }));
		const attemptIndex = this.findAttemptIndex(attempts, event);
		if (event.type === "task_stopped" && !hasAttemptMetadata(event) && attemptIndex < 0) {
			return attempts;
		}
		const shouldCreateAttempt = event.type !== "task_log" || hasAttemptMetadata(event);
		if (attemptIndex < 0 && !shouldCreateAttempt) {
			return attempts;
		}

		const existingAttempt = attemptIndex >= 0 ? attempts[attemptIndex] : undefined;
		const resolvedAttemptNumber = event.attempt ?? existingAttempt?.attempt ?? attempts.length + 1;
		const resolvedAttemptId = event.attemptId ?? existingAttempt?.id ?? randomUUID();
		const resolvedAgentRunId = event.agentRunId ?? existingAttempt?.agentRunId ?? resolvedAttemptId;
		const updatedAttempt: TaskAttempt = {
			id: resolvedAttemptId,
			taskId: task.id,
			attempt: resolvedAttemptNumber,
			agentRunId: resolvedAgentRunId,
			status: resolveAttemptStatus(existingAttempt?.status, event.type),
			toolCallCount: event.toolCallCount ?? existingAttempt?.toolCallCount ?? 0,
			agent: event.agent ? { ...existingAttempt?.agent, ...event.agent } : existingAttempt?.agent,
			process: event.process ? { ...existingAttempt?.process, ...event.process } : existingAttempt?.process,
			stopped: event.type === "task_stopped" ? event.stopped : existingAttempt?.stopped,
			startedAt: existingAttempt?.startedAt ?? task.startedAt ?? event.time,
			finishedAt: isTerminalAttemptEvent(event.type) ? event.time : existingAttempt?.finishedAt,
			errorCode:
				event.type === "task_attempt_failed" || event.type === "task_failed"
					? event.error.code
					: existingAttempt?.errorCode,
			errorMessage:
				event.type === "task_attempt_failed" || event.type === "task_failed"
					? event.error.message
					: existingAttempt?.errorMessage,
		};

		if (attemptIndex >= 0) {
			attempts.splice(attemptIndex, 1, updatedAttempt);
			return attempts;
		}
		return [...attempts, updatedAttempt];
	}

	private findAttemptIndex(attempts: readonly TaskAttempt[], event: TaskStoreEvent): number {
		if (event.attemptId) {
			return attempts.findIndex((attempt) => attempt.id === event.attemptId);
		}
		if (event.agentRunId) {
			const byAgentRunId = attempts.findIndex((attempt) => attempt.agentRunId === event.agentRunId);
			if (byAgentRunId >= 0) {
				return byAgentRunId;
			}
		}
		if (event.attempt !== undefined) {
			const byAttemptNumber = attempts.findIndex((attempt) => attempt.attempt === event.attempt);
			if (byAttemptNumber >= 0) {
				return byAttemptNumber;
			}
		}
		if (hasAttemptMetadata(event)) {
			return -1;
		}
		const runningAttemptIndex = attempts.findIndex((attempt) => attempt.status === "running");
		if (runningAttemptIndex >= 0) {
			return runningAttemptIndex;
		}
		return event.type === "task_log" ? -1 : attempts.length - 1;
	}

	private createLog(event: TaskStoreEvent): TaskLogEntry {
		return {
			id: randomUUID(),
			runId: event.runId,
			stepId: event.stepId,
			taskId: event.taskId,
			type: event.type === "task_log" ? event.logType : event.type,
			message: event.type === "task_log" ? event.message : taskEventMessage(event.type),
			time: event.time,
			detail: event.type === "task_log" ? event.detail : event,
		};
	}

	private createDataIgnoredLog(event: Extract<TaskStoreEvent, { type: "task_completed" }>): TaskLogEntry {
		return {
			id: randomUUID(),
			runId: event.runId,
			stepId: event.stepId,
			taskId: event.taskId,
			type: "diagnostic",
			message: "任务未配置 card_type，忽略 result.data，不创建 card。",
			time: event.time,
			detail: event.result,
		};
	}

	private createIgnoredStateLog(event: TaskStoreEvent, step: RuntimeStep, task: RuntimeTask): TaskLogEntry {
		const owner = isTerminalRunStatus(this.snapshot.run.status)
			? `run 已处于 ${this.snapshot.run.status}`
			: isTerminalTaskStatus(step.status)
				? `step 已处于 ${step.status}`
				: `task 已处于 ${task.status}`;
		return {
			id: randomUUID(),
			runId: event.runId,
			stepId: event.stepId,
			taskId: event.taskId,
			type: "diagnostic",
			message: `忽略迟到状态事件 ${event.type}：${owner}`,
			time: event.time,
			detail: event,
		};
	}

	private createIgnoredRunLog(event: TaskStoreEvent): TaskLogEntry {
		return {
			id: randomUUID(),
			runId: this.snapshot.run.id,
			stepId: event.stepId,
			taskId: event.taskId,
			type: "diagnostic",
			message: `忽略来自旧 run ${event.runId} 的迟到事件 ${describeStoreEvent(event)}：当前 run=${this.snapshot.run.id}`,
			time: event.time,
			detail: {
				staleRunId: event.runId,
				currentRunId: this.snapshot.run.id,
				event,
			},
		};
	}

	private appendReceipt(
		receipts: readonly SystemReceipt[],
		steps: readonly RuntimeStep[],
		task: RuntimeTask,
		event: TaskStoreEvent,
	): SystemReceipt[] {
		if (event.type !== "task_completed" && event.type !== "task_failed" && event.type !== "task_stopped") {
			return [...receipts];
		}
		const step = steps.find((candidate) => candidate.id === event.stepId);
		const resultText =
			event.type === "task_completed"
				? "已完成"
				: event.type === "task_failed"
					? `失败：${event.error.message}`
					: "已停止";
		return [
			...receipts,
			{
				id: randomUUID(),
				runId: event.runId,
				message: `【${step?.title ?? event.stepId}】【${task.title}】${resultText}`,
				time: event.time,
				level: event.type === "task_failed" ? "error" : "info",
			},
		];
	}

	private applyCards(cards: readonly UICard[], task: RuntimeTask, event: TaskStoreEvent): UICard[] {
		if (event.type !== "task_completed") {
			return [...cards];
		}
		const remainingCards = cards.filter((card) => card.taskId !== task.id);
		const resultData = getResultData(event.result);
		if (!task.card_type || resultData === undefined) {
			return remainingCards;
		}
		return [...remainingCards, createCard(event.stepId, task, resultData)];
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

interface TaskMutation {
	readonly task: RuntimeTask;
	readonly extraLogs: readonly TaskLogEntry[];
	readonly conversationMessage?: TaskSnapshot["conversationMessages"][number];
}

function createCard(stepId: string, task: RuntimeTask, data: unknown): UICard {
	if (task.card_type === "text") {
		return {
			id: randomUUID(),
			stepId,
			taskId: task.id,
			type: "text",
			title: task.title,
			status: task.status,
			data: data as TextCardData,
		};
	}
	if (task.card_type === "table") {
		return {
			id: randomUUID(),
			stepId,
			taskId: task.id,
			type: "table",
			title: task.title,
			status: task.status,
			data: data as TableCardData,
		};
	}
	if (task.card_type === "map") {
		return {
			id: randomUUID(),
			stepId,
			taskId: task.id,
			type: "map",
			title: task.title,
			status: task.status,
			data: data as MapCardData,
		};
	}
	if (task.card_type === "media") {
		return {
			id: randomUUID(),
			stepId,
			taskId: task.id,
			type: "media",
			title: task.title,
			status: task.status,
			data: data as MediaCardData,
		};
	}
	return {
		id: randomUUID(),
		stepId,
		taskId: task.id,
		type: "json",
		title: task.title,
		status: task.status,
		data: data as JsonCardData,
	};
}

function aggregateRunStatus(steps: readonly RuntimeStep[]): RunStatus {
	if (steps.some((step) => step.status === "fail")) {
		return "fail";
	}
	if (steps.length > 0 && steps.every((step) => step.status === "complete")) {
		return "complete";
	}
	if (steps.length > 0 && steps.every((step) => step.status === "stopped")) {
		return "stopped";
	}
	if (!steps.some((step) => step.status === "running") && steps.some((step) => step.status === "stopped")) {
		return "stopped";
	}
	return "running";
}

function isStateEvent(event: TaskStoreEvent): boolean {
	return (
		event.type === "task_started" ||
		event.type === "task_completed" ||
		event.type === "task_attempt_failed" ||
		event.type === "task_failed" ||
		event.type === "task_stopped"
	);
}

function isTerminalAttemptEvent(type: TaskStoreEvent["type"]): boolean {
	return (
		type === "task_completed" || type === "task_attempt_failed" || type === "task_failed" || type === "task_stopped"
	);
}

function resolveAttemptStatus(
	currentStatus: TaskAttempt["status"] | undefined,
	type: TaskStoreEvent["type"],
): TaskAttempt["status"] {
	if (type === "task_started") {
		return "running";
	}
	if (type === "task_completed") {
		return "complete";
	}
	if (type === "task_attempt_failed") {
		return "fail";
	}
	if (type === "task_failed") {
		return "fail";
	}
	if (type === "task_stopped") {
		return "stopped";
	}
	return currentStatus ?? "running";
}

function hasAttemptMetadata(event: TaskStoreEvent): boolean {
	return event.attemptId !== undefined || event.attempt !== undefined || event.agentRunId !== undefined;
}

function getResultData(result: TaskResult): unknown {
	return result.data;
}

function normalizeTaskResult(result: TaskResult): TaskResult {
	const data = getResultData(result);
	return data === undefined ? result : { ...result, data };
}

function isTerminalRunStatus(status: RunStatus): boolean {
	return status === "complete" || status === "fail" || status === "stopped";
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "complete" || status === "fail" || status === "stopped";
}

function taskEventMessage(type: TaskStoreEvent["type"]): string {
	if (type === "task_started") {
		return "任务开始";
	}
	if (type === "task_completed") {
		return "任务完成";
	}
	if (type === "task_attempt_failed") {
		return "attempt 失败";
	}
	if (type === "task_failed") {
		return "任务失败";
	}
	if (type === "task_stopped") {
		return "任务停止";
	}
	return "任务日志";
}

function describeStoreEvent(event: TaskStoreEvent): string {
	if (event.type !== "task_log") {
		return event.type;
	}
	const childEventType =
		isRecord(event.detail) && typeof event.detail.type === "string" ? event.detail.type : undefined;
	return childEventType ?? event.logType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
