import type { TaskStore } from "./task-store.js";
import type {
	ChildAgentProcessFactory,
	ChildAgentProcessLike,
	MapCardData,
	MediaCardData,
	NormalizedChildEvent,
	PlanStep,
	PlanTask,
	StopReason,
	TableCardData,
	TaskError,
	TaskResult,
	TaskStopped,
	TextCardData,
} from "./types.js";

export interface TaskDispatcherOptions {
	readonly runId: string;
	readonly userInstruction: string;
	readonly steps: readonly PlanStep[];
	readonly store: TaskStore;
	readonly childFactory: ChildAgentProcessFactory;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly now: () => number;
}

export class TaskDispatcher {
	private readonly options: TaskDispatcherOptions;
	private readonly activeTasks = new Map<string, ActiveTask>();
	private stopReason: StopReason | undefined;

	constructor(options: TaskDispatcherOptions) {
		this.options = options;
	}

	async run(): Promise<void> {
		for (const step of this.options.steps) {
			if (this.stopReason) {
				break;
			}
			await Promise.all(step.tasks.map((task) => this.runTask(step, task)));
			const stepSnapshot = this.options.store.getSnapshot().run.steps.find((candidate) => candidate.id === step.id);
			if (stepSnapshot?.status === "fail" || stepSnapshot?.status === "stopped") {
				break;
			}
		}
	}

	stop(reason: StopReason): void {
		this.stopReason = reason;
		for (const activeTask of this.activeTasks.values()) {
			activeTask.child.sendAbort();
			activeTask.child.kill("SIGTERM");
			this.emitStopped(activeTask.stepId, activeTask.taskId);
			this.settleTask(activeTask);
		}
	}

	private runTask(step: PlanStep, task: PlanTask): Promise<void> {
		if (this.stopReason) {
			this.emitStopped(step.id, task.id);
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			const child = this.options.childFactory({
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				command: this.options.command,
				args: this.options.args,
				env: this.options.env,
				onEvent: (event) => {
					this.handleChildEvent(step, task, child, event, resolve);
				},
			});
			this.activeTasks.set(task.id, { stepId: step.id, taskId: task.id, child, resolve, settled: false });
			this.options.store.apply({
				type: "task_started",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				time: this.options.now(),
			});
			child.start();
			child.sendPrompt(createTaskPrompt(this.options.userInstruction, step, task));
		});
	}

	private handleChildEvent(
		step: PlanStep,
		task: PlanTask,
		child: ChildAgentProcessLike,
		event: NormalizedChildEvent,
		resolve: () => void,
	): void {
		if (event.type === "child_started") {
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				logType: "child_started",
				message: `子进程已启动${event.processId ? ` pid=${event.processId}` : ""}`,
				detail: event,
				time: this.options.now(),
			});
			return;
		}
		if (event.type === "agent_end") {
			this.finishTask(step, task, child, resolve);
			return;
		}
		if (event.type === "process_close" && this.activeTasks.has(task.id)) {
			this.failTask(step.id, task.id, {
				status: "fail",
				code: "process_closed_before_agent_end",
				message: "子进程在 agent_end 前退出",
				detail: event.stderrTail,
			});
			const activeTask = this.activeTasks.get(task.id);
			if (activeTask) {
				this.settleTask(activeTask);
			}
			return;
		}
		if (event.type === "process_error") {
			this.failTask(step.id, task.id, {
				status: "fail",
				code: "process_error",
				message: event.error,
				detail: event.stderrTail,
			});
			const activeTask = this.activeTasks.get(task.id);
			if (activeTask) {
				this.settleTask(activeTask);
			}
			return;
		}
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId: step.id,
			taskId: task.id,
			logType: event.type,
			message: childEventMessage(event),
			detail: event,
			time: this.options.now(),
		});
	}

	private finishTask(step: PlanStep, task: PlanTask, child: ChildAgentProcessLike, resolve: () => void): void {
		const activeTask = this.activeTasks.get(task.id);
		if (this.stopReason) {
			this.emitStopped(step.id, task.id);
			if (activeTask) {
				this.settleTask(activeTask);
			} else {
				resolve();
			}
			return;
		}
		if (task.demoOutcome === "force_fail_after_run") {
			this.failTask(step.id, task.id, {
				status: "fail",
				code: "demo_failure",
				message: "模拟失败任务按配置返回失败响应",
			});
			if (activeTask) {
				this.settleTask(activeTask);
			} else {
				resolve();
			}
			return;
		}

		this.options.store.apply({
			type: "task_completed",
			runId: this.options.runId,
			stepId: step.id,
			taskId: task.id,
			result: createDemoTaskResult(task),
			time: this.options.now(),
		});
		child.kill("SIGTERM");
		if (activeTask) {
			this.settleTask(activeTask);
		} else {
			resolve();
		}
	}

	private failTask(stepId: string, taskId: string, error: TaskError): void {
		this.options.store.apply({
			type: "task_failed",
			runId: this.options.runId,
			stepId,
			taskId,
			error,
			time: this.options.now(),
		});
	}

	private emitStopped(stepId: string, taskId: string): void {
		const stopped: TaskStopped = {
			status: "stopped",
			reason: this.stopReason ?? "user_stopped",
			message: this.stopReason === "replaced_by_new_instruction" ? "任务被新指令替换" : "任务已停止",
		};
		this.options.store.apply({
			type: "task_stopped",
			runId: this.options.runId,
			stepId,
			taskId,
			stopped,
			time: this.options.now(),
		});
	}

	private settleTask(activeTask: ActiveTask): void {
		if (activeTask.settled) {
			return;
		}
		activeTask.settled = true;
		this.activeTasks.delete(activeTask.taskId);
		activeTask.resolve();
	}
}

interface ActiveTask {
	readonly stepId: string;
	readonly taskId: string;
	readonly child: ChildAgentProcessLike;
	readonly resolve: () => void;
	settled: boolean;
}

function createTaskPrompt(userInstruction: string, step: PlanStep, task: PlanTask): string {
	return [
		`用户指令：${userInstruction}`,
		`当前步骤：${step.title}`,
		`当前任务：${task.title}`,
		`任务描述：${task.description}`,
		"请执行任务。最终结果由宿主按 task 配置生成结构化 task_result；不要修改文件，除非任务描述明确要求。",
	].join("\n");
}

function createDemoTaskResult(task: PlanTask): TaskResult {
	if (task.card_type === "text") {
		const cardData: TextCardData = { text: "当前目录是 Pi coding agent 的源码项目。" };
		return { status: "complete", content: "已完成目录摘要。", card_data: cardData };
	}
	if (task.card_type === "media") {
		const cardData: MediaCardData = { gbids: ["gbid-service-a-001"] };
		return { status: "complete", content: "已打开 service-a 监控。", card_data: cardData };
	}
	if (task.card_type === "map") {
		const cardData: MapCardData = {
			center: { lat: 31.2304, lng: 121.4737 },
			markers: [
				{ label: "目标点", lat: 31.2304, lng: 121.4737, status: "active" },
				{ label: "周边资源", lat: 31.2298, lng: 121.475, status: "standby" },
			],
		};
		return { status: "complete", content: "已查询目标周边点位。", card_data: cardData };
	}
	if (task.card_type === "table") {
		const cardData: TableCardData = {
			columns: [
				{ key: "name", label: "资源" },
				{ key: "status", label: "状态" },
			],
			rows: [
				{ name: "service-a", status: "online" },
				{ name: "service-b", status: "standby" },
			],
		};
		return { status: "complete", content: "已拉取资源清单。", card_data: cardData };
	}
	return { status: "complete", content: `${task.title} 已完成。` };
}

function childEventMessage(event: NormalizedChildEvent): string {
	if (event.type === "rpc_response") {
		return event.success ? `RPC ${event.command ?? "unknown"} 已确认` : `RPC ${event.command ?? "unknown"} 失败`;
	}
	if (event.type === "tool_execution_start") {
		return `工具开始：${event.toolName ?? event.toolCallId ?? "unknown"}`;
	}
	if (event.type === "tool_execution_end") {
		return `工具结束：${event.toolName ?? event.toolCallId ?? "unknown"}`;
	}
	if (event.type === "diagnostic") {
		return event.message;
	}
	return event.type;
}
