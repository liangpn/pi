import { PI_DEMO_TASK_ALLOWED_TOOLS_ENV } from "./env.js";
import { buildTaskPrompt } from "./prompt-builder.js";
import {
	parseTaskResultFromAssistantMessage,
	TaskResultValidationError,
	validateTaskResult,
} from "./result-validation.js";
import type { RuntimeConfig } from "./runtime-config.js";
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
	TaskRetryPolicy,
	TaskRetryReason,
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
	readonly runtimeConfig: RuntimeConfig;
	readonly now: () => number;
}

interface StopOptions {
	readonly replacementInstruction?: string;
}

export class TaskDispatcher {
	private readonly options: TaskDispatcherOptions;
	private readonly activeTasks = new Map<string, ActiveTask>();
	private readonly cancelledQueuedTasks = new Set<string>();
	private stopReason: StopReason | undefined;
	private activeStepIndex = -1;
	private queuedTasks: readonly PlanTask[] = [];

	constructor(options: TaskDispatcherOptions) {
		this.options = options;
	}

	async run(): Promise<void> {
		for (let stepIndex = 0; stepIndex < this.options.steps.length; stepIndex += 1) {
			this.activeStepIndex = stepIndex;
			const step = this.options.steps[stepIndex];
			if (!step) {
				continue;
			}
			if (this.stopReason) {
				this.cancelQueuedTasks(stepIndex);
				break;
			}
			const stepShouldStop = await this.runStep(stepIndex, step);
			if (stepShouldStop) {
				break;
			}
		}
		this.activeStepIndex = -1;
		this.queuedTasks = [];
		if (this.stopReason) {
			this.options.store.markRunStopped(this.options.runId, this.options.now());
		}
	}

	stop(reason: StopReason, options: StopOptions = {}): void {
		if (this.stopReason) {
			return;
		}
		this.stopReason = reason;
		if (reason !== "timeout_after_stop") {
			this.options.store.markRunStopping(
				this.options.runId,
				reason,
				this.options.now(),
				options.replacementInstruction,
			);
		}
		this.cancelQueuedTasks(this.activeStepIndex >= 0 ? this.activeStepIndex : 0);
		for (const activeTask of this.activeTasks.values()) {
			void this.stopActiveTask(activeTask);
		}
	}

	private async runStep(stepIndex: number, step: PlanStep): Promise<boolean> {
		const concurrencyLimit = Math.max(1, this.options.runtimeConfig.concurrency_limit);
		const queuedTasks = [...step.tasks];
		this.queuedTasks = queuedTasks;
		const runningTasks = new Set<Promise<TaskRunResult>>();
		let finalTaskFailed = false;

		const launchNextTask = () => {
			while (
				!this.stopReason &&
				!finalTaskFailed &&
				runningTasks.size < concurrencyLimit &&
				queuedTasks.length > 0
			) {
				const task = queuedTasks.shift();
				if (!task) {
					break;
				}
				this.queuedTasks = queuedTasks;
				const runningTask = this.runTask(step, task)
					.then((result) => {
						if (result === "fail") {
							finalTaskFailed = true;
						}
						return result;
					})
					.finally(() => {
						runningTasks.delete(runningTask);
					});
				runningTasks.add(runningTask);
			}
		};

		launchNextTask();
		while (runningTasks.size > 0) {
			await Promise.race(runningTasks);
			if (this.stopReason) {
				this.cancelQueuedTasks(stepIndex);
				continue;
			}
			if (!finalTaskFailed) {
				launchNextTask();
			}
		}

		if (this.stopReason) {
			this.cancelQueuedTasks(stepIndex);
			return true;
		}
		return finalTaskFailed;
	}

	private async runTask(step: PlanStep, task: PlanTask): Promise<TaskRunResult> {
		const retryPolicy = mergeRetryPolicy(this.options.runtimeConfig.retry, task.retry);
		let attempt = 1;
		while (attempt <= retryPolicy.max_attempts) {
			if (this.stopReason) {
				this.emitQueuedTaskStopped(step.id, task.id, this.stopReason);
				return "stopped";
			}

			const outcome = await this.runAttempt(step, task, attempt, retryPolicy.max_tool_calls);
			if (outcome.type === "complete") {
				return "complete";
			}
			if (outcome.type === "stopped") {
				return "stopped";
			}

			const shouldRetry =
				!this.stopReason &&
				attempt < retryPolicy.max_attempts &&
				outcome.reason !== undefined &&
				retryPolicy.retry_on.includes(outcome.reason);
			if (!shouldRetry) {
				this.options.store.apply({
					type: "task_failed",
					runId: this.options.runId,
					stepId: step.id,
					taskId: task.id,
					...createAttemptDiagnostics(outcome.activeTask, task.id, outcome.activeTask.command),
					process: outcome.process,
					error: outcome.error,
					time: this.options.now(),
				});
				return "fail";
			}

			this.options.store.apply({
				type: "task_attempt_failed",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(outcome.activeTask, task.id, outcome.activeTask.command),
				process: outcome.process,
				error: outcome.error,
				time: this.options.now(),
			});
			await sleep(retryPolicy.base_delay_ms);
			attempt += 1;
		}
		return "fail";
	}

	private runAttempt(step: PlanStep, task: PlanTask, attempt: number, maxToolCalls: number): Promise<AttemptOutcome> {
		return new Promise((resolve) => {
			const attemptId = createAttemptId(task.id, attempt);
			const child = this.options.childFactory({
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				command: this.options.command,
				args: this.createChildArgs(task),
				env: this.createChildEnv(task),
				onEvent: (event) => {
					void this.handleChildEvent(activeTask, step, task, event);
				},
			});
			const activeTask: ActiveTask = {
				stepId: step.id,
				taskId: task.id,
				child,
				attemptId,
				attempt,
				agentRunId: `${child.agentRunId}-attempt-${attempt}`,
				command: [this.options.command, ...this.options.args],
				sessionDir: readSessionDir(this.options.env),
				toolCallCount: 0,
				processClosedPromise: undefined,
				processClosedResolver: undefined,
				processClosed: false,
				finalized: false,
				resolve,
				maxToolCalls,
			};
			activeTask.processClosedPromise = new Promise<boolean>((processResolve) => {
				activeTask.processClosedResolver = processResolve;
			});
			this.activeTasks.set(task.id, activeTask);

			const runtimeTarget = this.getRuntimeStepTask(step.id, task.id);
			if (!runtimeTarget) {
				void this.finalizeAttemptFailure(activeTask, {
					status: "fail",
					code: "validation_error",
					message: `未找到运行态 task：${step.id}/${task.id}`,
				});
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

	private createChildArgs(task: PlanTask): string[] {
		const args = stripToolFlags(this.options.args);
		const allowedTools = mergeAllowedTools(task.tools ?? [], this.options.runtimeConfig.minimal_system_tools);
		if (allowedTools.length === 0) {
			return [...args, "--no-tools"];
		}
		return [...args, "--tools", allowedTools.join(",")];
	}

	private createChildEnv(task: PlanTask): NodeJS.ProcessEnv {
		const allowedTools = mergeAllowedTools(task.tools ?? [], this.options.runtimeConfig.minimal_system_tools);
		return {
			...this.options.env,
			[PI_DEMO_TASK_ALLOWED_TOOLS_ENV]: JSON.stringify(allowedTools),
		};
	}

	private async handleChildEvent(
		activeTask: ActiveTask,
		step: PlanStep,
		task: PlanTask,
		event: NormalizedChildEvent,
	): Promise<void> {
		if (activeTask.resolved) {
			this.logIgnoredChildEvent(step.id, task.id, activeTask, event);
			return;
		}
		if (activeTask.finalized && event.type !== "process_close" && event.type !== "process_error") {
			return;
		}
		if (event.type === "child_spawned") {
			activeTask.processId = event.processId ?? activeTask.child.processId;
			if (!activeTask.started) {
				activeTask.started = true;
				this.options.store.apply({
					type: "task_started",
					runId: this.options.runId,
					stepId: step.id,
					taskId: task.id,
					...createAttemptDiagnostics(activeTask, task.id, activeTask.command, activeTask.child),
					agent: createAgentMetadata(activeTask.command, activeTask.processId, activeTask.sessionDir),
					toolCallCount: activeTask.toolCallCount,
					time: this.options.now(),
				});
			}
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, activeTask.command, activeTask.child),
				agent: createAgentMetadata(activeTask.command, activeTask.processId, activeTask.sessionDir),
				toolCallCount: activeTask.toolCallCount,
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
				...createAttemptDiagnostics(activeTask, task.id, activeTask.command, activeTask.child),
				toolCallCount: activeTask.toolCallCount,
				logType: "prompt_response_failure",
				message: event.error ?? "子进程拒绝了 prompt 请求",
				detail: event,
				time: this.options.now(),
			});
			if (activeTask.stopRequested && this.stopReason) {
				return;
			}
			await this.finalizeAttemptFailure(activeTask, {
				status: "fail",
				code: "prompt_response_failure",
				message: event.error ?? "子进程拒绝了 prompt 请求",
			});
			return;
		}

		if (event.type === "process_close") {
			const process = {
				closeCode: event.exitCode,
				signal: event.signal,
				stderrTail: event.stderrTail,
			};
			activeTask.process = process;
			activeTask.processClosed = true;
			activeTask.processClosedResolver?.(true);
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, activeTask.command, activeTask.child),
				process,
				toolCallCount: activeTask.toolCallCount,
				logType: "process_close",
				message: "子进程已退出",
				detail: event,
				time: this.options.now(),
			});
			if (!activeTask.agentEnded && !activeTask.stopRequested && !activeTask.validResult && !activeTask.finalized) {
				await this.finalizeAttemptFailure(activeTask, {
					status: "fail",
					code: "process_closed_before_agent_end",
					message: "子进程在 agent_end 前退出",
					detail: event.stderrTail,
				});
			}
			return;
		}

		if (event.type === "process_error") {
			const process = {
				stderrTail: event.stderrTail,
			};
			activeTask.process = { ...activeTask.process, ...process };
			this.options.store.apply({
				type: "task_log",
				runId: this.options.runId,
				stepId: step.id,
				taskId: task.id,
				...createAttemptDiagnostics(activeTask, task.id, activeTask.command, activeTask.child),
				process: activeTask.process,
				toolCallCount: activeTask.toolCallCount,
				logType: "process_error",
				message: event.error,
				detail: event,
				time: this.options.now(),
			});
			if (activeTask.stopRequested && this.stopReason) {
				return;
			}
			await this.finalizeAttemptFailure(activeTask, {
				status: "fail",
				code: "process_error",
				message: event.error,
				detail: event.stderrTail,
			});
			return;
		}

		if (event.type === "tool_execution_start") {
			activeTask.toolCallCount += 1;
			this.logChildEvent(step.id, task.id, activeTask, event);
			if (activeTask.toolCallCount > activeTask.maxToolCalls && !activeTask.toolLimitExceeded) {
				activeTask.toolLimitExceeded = true;
				activeTask.forcedFailure = {
					status: "fail",
					code: "tool_limit_exceeded",
					message: `工具调用次数超限：${activeTask.toolCallCount}/${activeTask.maxToolCalls}`,
				};
				void this.handleToolLimitExceeded(activeTask);
			}
			return;
		}

		if (event.type === "message_end") {
			this.logChildEvent(step.id, task.id, activeTask, event);
			if (isAssistantMessageEvent(event.message)) {
				const runtimeTarget = this.getRuntimeStepTask(step.id, task.id);
				if (runtimeTarget) {
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
							...createAttemptDiagnostics(activeTask, task.id, activeTask.command, activeTask.child),
							toolCallCount: activeTask.toolCallCount,
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
			this.logChildEvent(step.id, task.id, activeTask, event);
			activeTask.agentEnded = true;
			if (event.willRetry === true || activeTask.finalized) {
				return;
			}
			if (activeTask.stopRequested && this.stopReason) {
				return;
			}
			if (activeTask.forcedFailure) {
				await this.finalizeAttemptFailure(activeTask, activeTask.forcedFailure);
				return;
			}
			if (activeTask.validResult) {
				await this.finalizeAttemptComplete(activeTask, step.id, task.id, activeTask.validResult);
				return;
			}
			await this.finalizeAttemptFailure(
				activeTask,
				activeTask.validationError ?? {
					status: "fail",
					code: "validation_error",
					message: "agent_end 前没有得到合法的最终 task 结果。",
				},
			);
			return;
		}

		this.logChildEvent(step.id, task.id, activeTask, event);
	}

	private async stopActiveTask(activeTask: ActiveTask): Promise<void> {
		if (activeTask.finalized || activeTask.stopRequested || !this.stopReason) {
			return;
		}
		activeTask.stopRequested = true;
		let stopOutcomeReason: StopReason = this.stopReason;
		try {
			activeTask.child.sendSteer(createStopSteerMessage(this.stopReason));
		} catch (error: unknown) {
			this.logCleanupFailure(activeTask, "发送 steer 失败", error);
		}
		const exitedAfterSteer = await this.waitForProcessClose(
			activeTask,
			this.options.runtimeConfig.stop_steer_timeout_ms,
		);
		if (!exitedAfterSteer) {
			this.logStopTimeout(activeTask, "steer");
		}
		if (!activeTask.processClosed) {
			try {
				activeTask.child.sendAbort();
			} catch (error: unknown) {
				this.logCleanupFailure(activeTask, "发送 abort 失败", error);
			}
			const exitedAfterAbort = await this.waitForProcessClose(
				activeTask,
				this.options.runtimeConfig.stop_abort_timeout_ms,
			);
			if (!exitedAfterAbort) {
				this.logStopTimeout(activeTask, "abort");
			}
		}
		if (!activeTask.processClosed) {
			try {
				activeTask.child.kill("SIGTERM");
			} catch (error: unknown) {
				this.logCleanupFailure(activeTask, "停止子进程失败", error);
			}
			const exitedAfterKill = await this.waitForProcessClose(activeTask, 0);
			if (!exitedAfterKill) {
				stopOutcomeReason = "timeout_after_stop";
				this.logTimeoutAfterStop(activeTask);
			}
		}
		activeTask.cleanupCompleted = true;
		await this.finalizeAttemptStopped(activeTask, stopOutcomeReason, this.stopReason);
	}

	private async handleToolLimitExceeded(activeTask: ActiveTask): Promise<void> {
		if (activeTask.finalized || activeTask.stopRequested) {
			return;
		}
		activeTask.stopRequested = true;
		try {
			activeTask.child.sendAbort();
		} catch (error: unknown) {
			this.logCleanupFailure(activeTask, "工具超限后发送 abort 失败", error);
		}
		const exitedAfterAbort = await this.waitForProcessClose(
			activeTask,
			this.options.runtimeConfig.stop_abort_timeout_ms,
		);
		if (!exitedAfterAbort) {
			try {
				activeTask.child.kill("SIGTERM");
			} catch (error: unknown) {
				this.logCleanupFailure(activeTask, "工具超限后 kill 失败", error);
			}
			await this.waitForProcessClose(activeTask, 0);
		}
		if (activeTask.forcedFailure) {
			await this.finalizeAttemptFailure(activeTask, activeTask.forcedFailure);
		}
	}

	private async finalizeAttemptComplete(
		activeTask: ActiveTask,
		stepId: string,
		taskId: string,
		result: TaskResult,
	): Promise<void> {
		if (activeTask.finalized) {
			return;
		}
		activeTask.finalized = true;
		await this.cleanupChild(activeTask);
		this.options.store.apply({
			type: "task_completed",
			runId: this.options.runId,
			stepId,
			taskId,
			...createAttemptDiagnostics(activeTask, taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			result,
			time: this.options.now(),
		});
		this.resolveAttempt(activeTask, { type: "complete" });
	}

	private async finalizeAttemptFailure(activeTask: ActiveTask, error: TaskError): Promise<void> {
		if (activeTask.finalized) {
			return;
		}
		activeTask.finalized = true;
		await this.cleanupChild(activeTask);
		this.resolveAttempt(activeTask, {
			type: "fail",
			reason: normalizeRetryReason(error.code),
			error,
			process: activeTask.process,
			activeTask,
		});
	}

	private async finalizeAttemptStopped(
		activeTask: ActiveTask,
		reason: StopReason,
		requestedReason: StopReason = reason,
	): Promise<void> {
		if (activeTask.finalized) {
			return;
		}
		activeTask.finalized = true;
		await this.cleanupChild(activeTask);
		this.options.store.apply({
			type: "task_stopped",
			runId: this.options.runId,
			stepId: activeTask.stepId,
			taskId: activeTask.taskId,
			...createAttemptDiagnostics(activeTask, activeTask.taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			stopped: createStoppedState(reason, requestedReason),
			time: this.options.now(),
		});
		this.resolveAttempt(activeTask, { type: "stopped" });
	}

	private resolveAttempt(activeTask: ActiveTask, outcome: AttemptOutcome): void {
		this.activeTasks.delete(activeTask.taskId);
		activeTask.resolved = true;
		activeTask.processClosedResolver?.(activeTask.processClosed);
		activeTask.resolve(outcome);
	}

	private async cleanupChild(activeTask: ActiveTask): Promise<void> {
		if (activeTask.cleanupCompleted) {
			return;
		}
		if (!activeTask.processClosed) {
			try {
				activeTask.child.kill("SIGTERM");
			} catch (error: unknown) {
				this.logCleanupFailure(activeTask, "释放子进程失败", error);
			}
			const exited = await this.waitForProcessClose(activeTask, 0);
			if (!exited) {
				this.options.store.apply({
					type: "task_log",
					runId: this.options.runId,
					stepId: activeTask.stepId,
					taskId: activeTask.taskId,
					...createAttemptDiagnostics(activeTask, activeTask.taskId, activeTask.command, activeTask.child),
					process: activeTask.process,
					toolCallCount: activeTask.toolCallCount,
					logType: "diagnostic",
					message: "释放 child process 超时，未收到 process_close。",
					time: this.options.now(),
				});
			}
		}
		activeTask.cleanupCompleted = true;
	}

	private async waitForProcessClose(activeTask: ActiveTask, timeoutMs: number): Promise<boolean> {
		if (activeTask.processClosed) {
			return true;
		}
		if (timeoutMs <= 0) {
			await Promise.resolve();
			return activeTask.processClosed;
		}
		const timedOut = await Promise.race([
			activeTask.processClosedPromise ?? Promise.resolve(false),
			sleep(timeoutMs).then(() => false),
		]);
		return timedOut === true;
	}

	private cancelQueuedTasks(fromStepIndex: number): void {
		if (!this.stopReason) {
			return;
		}
		if (fromStepIndex < 0) {
			return;
		}
		const currentStep = this.options.steps[fromStepIndex];
		if (currentStep) {
			for (const task of this.queuedTasks) {
				this.emitQueuedTaskStopped(currentStep.id, task.id, this.stopReason);
			}
		}
		for (let stepIndex = fromStepIndex + 1; stepIndex < this.options.steps.length; stepIndex += 1) {
			const step = this.options.steps[stepIndex];
			if (!step) {
				continue;
			}
			for (const task of step.tasks) {
				this.emitQueuedTaskStopped(step.id, task.id, this.stopReason);
			}
		}
	}

	private emitQueuedTaskStopped(stepId: string, taskId: string, reason: StopReason): void {
		const cancelledTaskKey = `${stepId}:${taskId}`;
		if (this.cancelledQueuedTasks.has(cancelledTaskKey)) {
			return;
		}
		this.cancelledQueuedTasks.add(cancelledTaskKey);
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId,
			taskId,
			logType: "diagnostic",
			message: "任务在启动前被取消，未启动 child process，也未创建 attempt。",
			time: this.options.now(),
		});
		this.options.store.apply({
			type: "task_stopped",
			runId: this.options.runId,
			stepId,
			taskId,
			stopped: createStoppedState(reason),
			time: this.options.now(),
		});
	}

	private getRuntimeStepTask(
		stepId: string,
		taskId: string,
	): { readonly step: RuntimeStep; readonly task: RuntimeTask } | undefined {
		const step = this.options.store.getSnapshot().run.steps.find((candidate) => candidate.id === stepId);
		const task = step?.tasks.find((candidate) => candidate.id === taskId);
		return step && task ? { step, task } : undefined;
	}

	private logChildEvent(stepId: string, taskId: string, activeTask: ActiveTask, event: NormalizedChildEvent): void {
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId,
			taskId,
			...createAttemptDiagnostics(activeTask, taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			logType: event.type,
			message: childEventMessage(event),
			detail: event,
			time: this.options.now(),
		});
	}

	private logCleanupFailure(activeTask: ActiveTask, message: string, error: unknown): void {
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId: activeTask.stepId,
			taskId: activeTask.taskId,
			...createAttemptDiagnostics(activeTask, activeTask.taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			logType: "diagnostic",
			message,
			detail: formatError(error),
			time: this.options.now(),
		});
	}

	private logIgnoredChildEvent(
		stepId: string,
		taskId: string,
		activeTask: ActiveTask,
		event: NormalizedChildEvent,
	): void {
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId,
			taskId,
			...createAttemptDiagnostics(activeTask, taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			logType: "diagnostic",
			message: `忽略迟到 child 事件 ${event.type}：attempt 已完成`,
			detail: event,
			time: this.options.now(),
		});
	}

	private logStopTimeout(activeTask: ActiveTask, phase: "steer" | "abort"): void {
		const phaseLabel = phase === "steer" ? "steer" : "abort";
		const timeoutMs =
			phase === "steer"
				? this.options.runtimeConfig.stop_steer_timeout_ms
				: this.options.runtimeConfig.stop_abort_timeout_ms;
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId: activeTask.stepId,
			taskId: activeTask.taskId,
			...createAttemptDiagnostics(activeTask, activeTask.taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			logType: "diagnostic",
			message: `等待 ${phaseLabel} 停止超时：${timeoutMs}ms，继续升级停止信号。`,
			time: this.options.now(),
		});
	}

	private logTimeoutAfterStop(activeTask: ActiveTask): void {
		this.options.store.apply({
			type: "task_log",
			runId: this.options.runId,
			stepId: activeTask.stepId,
			taskId: activeTask.taskId,
			...createAttemptDiagnostics(activeTask, activeTask.taskId, activeTask.command, activeTask.child),
			process: activeTask.process,
			toolCallCount: activeTask.toolCallCount,
			logType: "diagnostic",
			message: "kill 后仍未收到 process_close，记录 timeout_after_stop 诊断。",
			detail: {
				reason: "timeout_after_stop",
			},
			time: this.options.now(),
		});
	}
}

type TaskRunResult = "complete" | "fail" | "stopped";

type AttemptOutcome =
	| { readonly type: "complete" }
	| { readonly type: "stopped" }
	| {
			readonly type: "fail";
			readonly reason?: TaskRetryReason;
			readonly error: TaskError;
			readonly process?: {
				readonly closeCode?: number | null;
				readonly signal?: string | null;
				readonly stderrTail?: string;
			};
			readonly activeTask: ActiveTask;
	  };

interface ActiveTask {
	readonly stepId: string;
	readonly taskId: string;
	readonly child: ChildAgentProcessLike;
	readonly attemptId: string;
	readonly attempt: number;
	readonly agentRunId: string;
	readonly command: readonly string[];
	readonly maxToolCalls: number;
	readonly resolve: (outcome: AttemptOutcome) => void;
	processClosedPromise?: Promise<boolean>;
	processClosedResolver?: (closed: boolean) => void;
	started?: boolean;
	processId?: number;
	sessionDir?: string;
	process?: {
		readonly closeCode?: number | null;
		readonly signal?: string | null;
		readonly stderrTail?: string;
	};
	toolCallCount: number;
	validResult?: TaskResult;
	validationError?: TaskError;
	agentEnded?: boolean;
	stopRequested?: boolean;
	processClosed: boolean;
	toolLimitExceeded?: boolean;
	forcedFailure?: TaskError;
	finalized: boolean;
	resolved?: boolean;
	cleanupCompleted?: boolean;
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

function createStoppedState(reason: StopReason, requestedReason: StopReason = reason): TaskStopped {
	if (reason === "timeout_after_stop") {
		return {
			status: "stopped",
			reason,
			message: "任务停止超时",
			detail: `已收到 ${requestedReason} 停止请求，但 kill 后仍未收到 process_close。`,
		};
	}
	return {
		status: "stopped",
		reason,
		message: reason === "replaced_by_new_instruction" ? "任务被新指令替换" : "任务已停止",
		detail:
			reason === "replaced_by_new_instruction"
				? "任务因收到新指令而停止当前 attempt"
				: "任务因用户停止请求而停止当前 attempt",
	};
}

function createStopSteerMessage(reason: StopReason): string {
	if (reason === "replaced_by_new_instruction") {
		return "请立即停止当前任务，不再继续输出，并尽快结束当前子任务；当前运行将被新指令替换。";
	}
	return "请立即停止当前任务，不再继续输出，并尽快结束当前子任务。";
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

function mergeRetryPolicy(
	runtimeRetry: RuntimeConfig["retry"],
	taskRetry: TaskRetryPolicy | undefined,
): Required<TaskRetryPolicy> {
	return {
		max_attempts: taskRetry?.max_attempts ?? runtimeRetry.max_attempts,
		base_delay_ms: taskRetry?.base_delay_ms ?? runtimeRetry.base_delay_ms,
		max_tool_calls: taskRetry?.max_tool_calls ?? runtimeRetry.max_tool_calls,
		retry_on: taskRetry?.retry_on ?? runtimeRetry.retry_on,
	};
}

function normalizeRetryReason(code: string | undefined): TaskRetryReason | undefined {
	if (code === "process_error") {
		return "process_error";
	}
	if (code === "process_closed_before_agent_end") {
		return "process_closed_before_agent_end";
	}
	if (code === "provider_error") {
		return "provider_error";
	}
	if (code === "timeout") {
		return "timeout";
	}
	if (code === "tool_limit_exceeded") {
		return "tool_limit_exceeded";
	}
	if (code === "validation_error") {
		return "validation_error";
	}
	return undefined;
}

function readSessionDir(env: NodeJS.ProcessEnv): string | undefined {
	const sessionDir = env.PI_CODING_AGENT_SESSION_DIR ?? env.PI_DEMO_CHILD_SESSION_DIR;
	if (!sessionDir) {
		return undefined;
	}
	const trimmed = sessionDir.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function stripToolFlags(args: readonly string[]): string[] {
	const normalized: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (
			arg === "--tools" ||
			arg === "-t" ||
			arg === "--no-tools" ||
			arg === "-nt" ||
			arg === "--no-builtin-tools" ||
			arg === "-nbt"
		) {
			if (arg === "--tools" || arg === "-t") {
				index += 1;
			}
			continue;
		}
		normalized.push(arg);
	}
	return normalized;
}

function mergeAllowedTools(primary: readonly string[], fallback: readonly string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const tool of [...primary, ...fallback]) {
		if (tool.length === 0 || seen.has(tool)) {
			continue;
		}
		seen.add(tool);
		merged.push(tool);
	}
	return merged;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
