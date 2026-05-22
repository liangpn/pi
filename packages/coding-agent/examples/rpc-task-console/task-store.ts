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
	TaskLogEntry,
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
	private readonly planSteps: readonly PlanStep[];
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

	startRun(runId: string, userInstruction: string, time: number): TaskSnapshot["run"] {
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
					id: `receipt-${runId}-${time}-created`,
					runId,
					message: `已创建 ${this.planSteps.length} 个步骤，${this.planSteps.flatMap((step) => step.tasks).length} 个任务`,
					time,
					level: "info",
				},
			],
		};
		this.emit();
		return this.getSnapshot().run;
	}

	apply(event: TaskStoreEvent): void {
		if (event.runId !== this.snapshot.run.id) {
			return;
		}

		const task = this.findTask(event.stepId, event.taskId);
		if (!task) {
			return;
		}

		const nextTask = this.applyToTask(task, event);
		const nextSteps = this.snapshot.run.steps.map((step) => {
			if (step.id !== event.stepId) {
				return step;
			}
			const tasks = step.tasks.map((candidate) => (candidate.id === event.taskId ? nextTask : candidate));
			return { ...step, tasks, status: aggregateStepStatus(tasks.map((candidate) => candidate.status)) };
		});

		const nextLogs = [...this.snapshot.logs, this.createLog(event)];
		const nextReceipts = this.appendReceipt(this.snapshot.receipts, nextSteps, nextTask, event);
		const nextCards = this.applyCards(this.snapshot.cards, nextTask, event);
		const runStatus = aggregateRunStatus(nextSteps);

		this.snapshot = {
			run: {
				...this.snapshot.run,
				status: runStatus,
				steps: nextSteps,
				finishedAt: this.snapshot.run.finishedAt ?? (isTerminalRunStatus(runStatus) ? event.time : undefined),
			},
			cards: nextCards,
			logs: nextLogs,
			receipts: nextReceipts,
		};
		this.emit();
	}

	reset(time: number): void {
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
			receipts: [{ id: `receipt-reset-${time}`, message: "已重置任务骨架", time, level: "info" }],
		};
		this.emit();
	}

	private findTask(stepId: string, taskId: string): RuntimeTask | undefined {
		return this.snapshot.run.steps.find((step) => step.id === stepId)?.tasks.find((task) => task.id === taskId);
	}

	private applyToTask(task: RuntimeTask, event: TaskStoreEvent): RuntimeTask {
		const base = { ...task, eventCount: task.eventCount + 1 };
		if (event.type === "task_started") {
			return { ...base, status: "running", startedAt: event.time };
		}
		if (event.type === "task_completed") {
			return { ...base, status: "complete", result: event.result, finishedAt: event.time };
		}
		if (event.type === "task_failed") {
			return { ...base, status: "fail", error: event.error, finishedAt: event.time };
		}
		if (event.type === "task_stopped") {
			return { ...base, status: "stopped", stopped: event.stopped, finishedAt: event.time };
		}
		return base;
	}

	private createLog(event: TaskStoreEvent): TaskLogEntry {
		return {
			id: `log-${event.runId}-${event.stepId}-${event.taskId}-${event.time}-${event.type}`,
			runId: event.runId,
			stepId: event.stepId,
			taskId: event.taskId,
			type: event.type === "task_log" ? event.logType : event.type,
			message: event.type === "task_log" ? event.message : taskEventMessage(event.type),
			time: event.time,
			detail: event.type === "task_log" ? event.detail : event,
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
				id: `receipt-${event.runId}-${event.stepId}-${event.taskId}-${event.time}`,
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
		if (!task.card_type || event.result.card_data === undefined) {
			return remainingCards;
		}
		return [...remainingCards, createCard(event.stepId, task, event.result.card_data)];
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

function createCard(stepId: string, task: RuntimeTask, data: unknown): UICard {
	if (task.card_type === "text") {
		return {
			id: `card-${task.id}`,
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
			id: `card-${task.id}`,
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
			id: `card-${task.id}`,
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
			id: `card-${task.id}`,
			stepId,
			taskId: task.id,
			type: "media",
			title: task.title,
			status: task.status,
			data: data as MediaCardData,
		};
	}
	return {
		id: `card-${task.id}`,
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

function isTerminalRunStatus(status: RunStatus): boolean {
	return status === "complete" || status === "fail" || status === "stopped";
}

function taskEventMessage(type: TaskStoreEvent["type"]): string {
	if (type === "task_started") {
		return "任务开始";
	}
	if (type === "task_completed") {
		return "任务完成";
	}
	if (type === "task_failed") {
		return "任务失败";
	}
	if (type === "task_stopped") {
		return "任务停止";
	}
	return "任务日志";
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
