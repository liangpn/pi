import { buildTaskPrompt } from "./prompt-builder.js";
import {
	parseTaskResultFromAssistantMessage,
	TaskResultValidationError,
	validateTaskResult,
} from "./result-validation.js";
import type { TaskStore } from "./task-store.js";
import type {
	ChildAgentProcessFactory,
	ChildAgentProcessLike,
	NormalizedChildEvent,
	PlanStep,
	PlanTask,
	RuntimeStep,
	RuntimeTask,
	StopReason,
	TaskError,
	TaskResult,
	TaskStopped,
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
			activeTask.stopRequested = true;
			activeTask.child.sendAbort();
			activeTask.child.kill("SIGTERM");
			this.emitStopped(activeTask);
			this.settleTask(activeTask);
		}
	}

	private runTask(step: PlanStep, task: PlanTask): Promise<void> {
		if (this.stopReason) {
			this.options.store.apply({
				type: "task_stopped",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				stopped: createStoppedState(this.stopReason),
				time: this.options.now(),
			});
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
			const activeTask: ActiveTask = {
				stepId: step.id,
				taskId: task.id,
				child,
				resolve,
				settled: false,
				attemptId: createAttemptId(task.id, 1),
				attempt: 1,
				agentRunId: child.agentRunId,
				command: [this.options.command, ...this.options.args],
			};
			this.activeTasks.set(task.id, activeTask);
			const runtimeTarget = this.getRuntimeStepTask(step.id, task.id);
			if (!runtimeTarget) {
				this.failTask(
					step.id,
					task.id,
					{
						status: "fail",
						code: "validation_error",
						message: `未找到运行态 task：${step.id}/${task.id}`,
					},
					activeTask,
				);
				this.settleTask(activeTask);
				return;
			}
			child.start();
			child.sendPrompt(
				buildTaskPrompt({
					userInstruction: this.options.userInstruction,
					step: runtimeTarget.step,
					task: runtimeTarget.task,
				}),
			);
		});
	}

	private handleChildEvent(
		step: PlanStep,
		task: PlanTask,
		child: ChildAgentProcessLike,
		event: NormalizedChildEvent,
		resolve: () => void,
	): void {
		const activeTask = this.activeTasks.get(task.id);
		if (event.type === "child_spawned") {
			if (activeTask) {
				activeTask.processId = event.processId ?? child.processId;
			}
			if (activeTask && !activeTask.started) {
				activeTask.started = true;
				this.options.store.apply({
					type: "task_started",
					runId: this.options.runId,
					stepId: step.id,
					taskId: task.id,
					...createAttemptDiagnostics(activeTask, task.id, [this.options.command, ...this.options.args], child),
					agent: createAgentMetadata(
						activeTask.command,
						activeTask.processId ?? child.processId,
						activeTask.sessionDir,
					),
					time: this.options.now(),
				});
			}
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, [this.options.command, ...this.options.args], child),
				agent: createAgentMetadata(
					activeTask?.command ?? [this.options.command, ...this.options.args],
					activeTask?.processId,
					activeTask?.sessionDir,
				),
				logType: "child_spawned",
				message: `子进程已启动${event.processId ? ` pid=${event.processId}` : ""}`,
				detail: event,
				time: this.options.now(),
			});
			return;
		}
		if (event.type === "prompt_response_failure") {
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, [this.options.command, ...this.options.args], child),
				logType: "prompt_response_failure",
				message: event.error ?? "子进程拒绝了 prompt 请求",
				detail: event,
				time: this.options.now(),
			});
			this.failTask(
				step.id,
				task.id,
				{
					status: "fail",
					code: "prompt_response_failure",
					message: event.error ?? "子进程拒绝了 prompt 请求",
				},
				activeTask,
			);
			if (activeTask) {
				this.settleTask(activeTask);
			} else {
				resolve();
			}
			return;
		}
		if (event.type === "process_close") {
			const process = {
				closeCode: event.exitCode,
				signal: event.signal,
				stderrTail: event.stderrTail,
			};
			if (activeTask) {
				activeTask.process = process;
			}
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, [this.options.command, ...this.options.args], child),
				process: activeTask?.process ?? process,
				logType: "process_close",
				message: "子进程已退出",
				detail: event,
				time: this.options.now(),
			});
			if (activeTask && !activeTask.stopRequested && !activeTask.agentEnded && !activeTask.validResult) {
				this.failTask(
					step.id,
					task.id,
					{
						status: "fail",
						code: "process_closed_before_agent_end",
						message: "子进程在 agent_end 前退出",
						detail: event.stderrTail,
					},
					activeTask,
				);
				this.settleTask(activeTask);
			}
			return;
		}
		if (event.type === "process_error") {
			const process = {
				stderrTail: event.stderrTail,
			};
			if (activeTask) {
				activeTask.process = { ...activeTask.process, ...process };
			}
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, [this.options.command, ...this.options.args], child),
				process: activeTask?.process ?? process,
				logType: "process_error",
				message: event.error,
				detail: event,
				time: this.options.now(),
			});
			this.failTask(
				step.id,
				task.id,
				{
					status: "fail",
					code: "process_error",
					message: event.error,
					detail: event.stderrTail,
				},
				activeTask,
			);
			if (activeTask) {
				this.settleTask(activeTask);
			}
			return;
		}
		if (event.type === "message_end") {
			this.logChildEvent(step.id, task.id, activeTask, child, event);
			if (isAssistantMessageEvent(event.message)) {
				const runtimeTarget = this.getRuntimeStepTask(step.id, task.id);
				if (runtimeTarget && activeTask) {
					try {
						const parsedResult = parseTaskResultFromAssistantMessage(event.message);
						activeTask.validResult = validateTaskResult(runtimeTarget.task, parsedResult);
						activeTask.validationError = undefined;
					} catch (error: unknown) {
						const validationError = toValidationError(error, task.id);
						activeTask.validResult = undefined;
						activeTask.validationError = validationError;
						this.options.store.apply({
							type: "task_log",
							runId: this.options.runId,
							stepId: step.id,
							taskId: task.id,
							...createAttemptDiagnostics(
								activeTask,
								task.id,
								[this.options.command, ...this.options.args],
								child,
							),
							logType: "validation_error",
							message: validationError.message,
							detail: {
								error: validationError,
								message: event.message,
							},
							time: this.options.now(),
						});
					}
				}
			}
			return;
		}
		if (event.type === "agent_end") {
			this.logChildEvent(step.id, task.id, activeTask, child, event);
			this.finishTask(step, task, child, event, resolve);
			return;
		}
		this.logChildEvent(step.id, task.id, activeTask, child, event);
	}

	private finishTask(
		step: PlanStep,
		task: PlanTask,
		child: ChildAgentProcessLike,
		event: Extract<NormalizedChildEvent, { type: "agent_end" }>,
		resolve: () => void,
	): void {
		const activeTask = this.activeTasks.get(task.id);
		if (activeTask) {
			activeTask.agentEnded = true;
		}
		if (this.stopReason) {
			if (activeTask) {
				this.emitStopped(activeTask);
			}
			if (activeTask) {
				this.settleTask(activeTask);
			} else {
				resolve();
			}
			return;
		}
		if (event.willRetry === true) {
			return;
		}
		if (activeTask?.validResult) {
			this.options.store.apply({
				type: "task_completed",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, [this.options.command, ...this.options.args], child),
				process: activeTask.process,
				result: activeTask.validResult,
				time: this.options.now(),
			});
			child.kill("SIGTERM");
			this.settleTask(activeTask);
			return;
		}
		this.failTask(
			step.id,
			task.id,
			activeTask?.validationError ?? {
				status: "fail",
				code: "validation_error",
				message: "agent_end 前没有得到合法的最终 task 结果。",
			},
			activeTask,
		);
		if (activeTask) {
			this.settleTask(activeTask);
		} else {
			resolve();
		}
	}

	private getRuntimeStepTask(
		stepId: string,
		taskId: string,
	): { readonly step: RuntimeStep; readonly task: RuntimeTask } | undefined {
		const step = this.options.store.getSnapshot().run.steps.find((candidate) => candidate.id === stepId);
		const task = step?.tasks.find((candidate) => candidate.id === taskId);
		return step && task ? { step, task } : undefined;
	}

	private logChildEvent(
		stepId: string,
		taskId: string,
		activeTask: ActiveTask | undefined,
		child: ChildAgentProcessLike,
		event: NormalizedChildEvent,
	): void {
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId,
			taskId,
			...createAttemptDiagnostics(activeTask, taskId, [this.options.command, ...this.options.args], child),
			process: activeTask?.process,
			logType: event.type,
			message: childEventMessage(event),
			detail: event,
			time: this.options.now(),
		});
	}

	private failTask(stepId: string, taskId: string, error: TaskError, activeTask: ActiveTask | undefined): void {
		this.options.store.apply({
			type: "task_failed",
			runId: this.options.runId,
			stepId,
			taskId,
			...createAttemptDiagnostics(
				activeTask,
				taskId,
				activeTask?.command ?? [this.options.command, ...this.options.args],
			),
			process: activeTask?.process,
			error,
			time: this.options.now(),
		});
	}

	private emitStopped(activeTask: ActiveTask): void {
		this.options.store.apply({
			type: "task_stopped",
			runId: this.options.runId,
			stepId: activeTask.stepId,
			taskId: activeTask.taskId,
			...createAttemptDiagnostics(activeTask, activeTask.taskId, activeTask.command),
			process: activeTask.process,
			stopped: createStoppedState(this.stopReason),
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
	readonly attemptId: string;
	readonly attempt: number;
	readonly agentRunId: string;
	readonly command: readonly string[];
	started?: boolean;
	processId?: number;
	sessionDir?: string;
	process?: {
		readonly closeCode?: number | null;
		readonly signal?: string | null;
		readonly stderrTail?: string;
	};
	validResult?: TaskResult;
	validationError?: TaskError;
	agentEnded?: boolean;
	stopRequested?: boolean;
	settled: boolean;
}

function createAttemptId(taskId: string, attempt: number): string {
	return `${taskId}-attempt-${attempt}`;
}

function createAgentMetadata(command: readonly string[], processId?: number, sessionDir?: string) {
	return {
		command,
		processId,
		sessionDir,
	};
}

function createAttemptDiagnostics(
	activeTask: ActiveTask | undefined,
	taskId: string,
	command: readonly string[],
	child?: ChildAgentProcessLike,
) {
	if (!activeTask) {
		if (!child) {
			return {};
		}
		return {
			attemptId: createAttemptId(taskId, 1),
			attempt: 1,
			agentRunId: child.agentRunId,
			agent: createAgentMetadata(command, child.processId),
		};
	}
	return {
		attemptId: activeTask.attemptId,
		attempt: activeTask.attempt,
		agentRunId: activeTask.agentRunId,
		agent: createAgentMetadata(activeTask.command, activeTask.processId ?? child?.processId, activeTask.sessionDir),
	};
}

function createStoppedState(reason: StopReason | undefined): TaskStopped {
	return {
		status: "stopped",
		reason: reason ?? "user_stopped",
		message: reason === "replaced_by_new_instruction" ? "任务被新指令替换" : "任务已停止",
		detail:
			reason === "replaced_by_new_instruction"
				? "任务因收到新指令而停止当前 attempt"
				: "任务因用户停止请求而停止当前 attempt",
	};
}

function childEventMessage(event: NormalizedChildEvent): string {
	if (event.type === "rpc_response") {
		return event.success ? `RPC ${event.command ?? "unknown"} 已确认` : `RPC ${event.command ?? "unknown"} 失败`;
	}
	if (event.type === "prompt_response_failure") {
		return event.error ?? "prompt 请求失败";
	}
	if (event.type === "tool_execution_start") {
		return `工具开始：${event.toolName ?? event.toolCallId ?? "unknown"}`;
	}
	if (event.type === "tool_execution_end") {
		return event.isError
			? `工具报错：${event.toolName ?? event.toolCallId ?? "unknown"}`
			: `工具结束：${event.toolName ?? event.toolCallId ?? "unknown"}`;
	}
	if (event.type === "unknown_json_event") {
		return event.message;
	}
	return event.type;
}

function isAssistantMessageEvent(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message as { readonly role?: unknown }).role === "assistant"
	);
}

function toValidationError(error: unknown, taskId: string): TaskError {
	if (error instanceof TaskResultValidationError) {
		return {
			status: "fail",
			code: "validation_error",
			message: error.message,
			detail: error.detail,
		};
	}
	return {
		status: "fail",
		code: "validation_error",
		message: `任务 "${taskId}" 的最终结果校验失败。`,
		detail: error instanceof Error ? error.message : String(error),
	};
}
