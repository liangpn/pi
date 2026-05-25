import { randomUUID } from "node:crypto";
import { createChildAgentProcess } from "./child-agent-process.js";
import type { DemoEnv } from "./env.js";
import { createPersistenceWriter } from "./persistence.js";
import { validatePlanSteps } from "./plan-validation.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { TaskStore } from "./task-store.js";
import { createInitialSteps, createRuntimeSteps } from "./tasks.js";
import type { ChildAgentProcessFactory, PlanStep, StopReason, TaskSnapshot } from "./types.js";

export interface RunManagerOptions {
	readonly steps?: readonly PlanStep[];
	readonly demoEnv: DemoEnv;
	readonly childFactory?: ChildAgentProcessFactory;
	readonly now?: () => number;
}

export class RunManager {
	private readonly defaultSteps: readonly PlanStep[];
	private selectedSteps: readonly PlanStep[];
	private readonly store: TaskStore;
	private readonly demoEnv: DemoEnv;
	private readonly childFactory: ChildAgentProcessFactory;
	private readonly now: () => number;
	private readonly persistenceWriter: ReturnType<typeof createPersistenceWriter>;
	private activeDispatcher: TaskDispatcher | undefined;
	private activeRunId: string | undefined;
	private activeRunPromise: Promise<void> | undefined;
	private persistenceRunId: string | undefined;
	private persistedLogCount = 0;
	private persistedConversationCount = 0;
	private pendingPersistence: Promise<void> = Promise.resolve();
	private pendingReplacement: PendingRun | undefined;
	private pendingStartPromise: Promise<void> | undefined;

	constructor(options: RunManagerOptions) {
		this.defaultSteps = clonePlanSteps(options.steps ?? createInitialSteps());
		this.selectedSteps = this.defaultSteps;
		this.store = TaskStore.createIdle(this.selectedSteps);
		this.demoEnv = options.demoEnv;
		this.childFactory = options.childFactory ?? createChildAgentProcess;
		this.now = options.now ?? Date.now;
		this.persistenceWriter = createPersistenceWriter({
			snapshotDir: this.demoEnv.snapshotDir,
			logDir: this.demoEnv.logDir,
			conversationDir: this.demoEnv.conversationDir,
			rpcEventDir: this.demoEnv.rpcEventDir,
			childStderrDir: this.demoEnv.childStderrDir,
		});
		this.store.subscribe((snapshot) => {
			this.persistSnapshot(snapshot);
		});
	}

	getSnapshot(): TaskSnapshot {
		return this.store.getSnapshot();
	}

	subscribe(listener: (snapshot: TaskSnapshot) => void): () => void {
		return this.store.subscribe(listener);
	}

	start(userInstruction: string, steps?: readonly PlanStep[]): TaskSnapshot["run"] {
		const selectedSteps = this.resolveSelectedSteps(steps);
		if (this.activeDispatcher || this.activeRunPromise || this.pendingStartPromise) {
			return this.replaceRun(userInstruction, selectedSteps);
		}
		return this.startNow(this.nextRunId(), userInstruction, selectedSteps);
	}

	replace(userInstruction: string, steps?: readonly PlanStep[]): TaskSnapshot["run"] {
		const selectedSteps = this.resolveSelectedSteps(steps);
		if (this.activeDispatcher || this.activeRunPromise || this.pendingStartPromise || this.activeRunId) {
			return this.replaceRun(userInstruction, selectedSteps);
		}
		return this.startNow(this.nextRunId(), userInstruction, selectedSteps);
	}

	stop(reason: StopReason = "user_stopped"): void {
		this.pendingReplacement = undefined;
		this.activeDispatcher?.stop(reason);
	}

	reset(steps?: readonly PlanStep[]): void {
		this.pendingReplacement = undefined;
		this.stop("user_stopped");
		this.activeDispatcher = undefined;
		this.activeRunId = undefined;
		this.activeRunPromise = undefined;
		this.pendingStartPromise = undefined;
		this.selectedSteps = this.resolveSelectedSteps(steps);
		this.store.reset(this.now(), this.selectedSteps);
	}

	async waitForIdle(): Promise<void> {
		while (this.activeRunPromise || this.pendingStartPromise) {
			const runPromise = this.activeRunPromise;
			const pendingStartPromise = this.pendingStartPromise;
			await Promise.all([runPromise, pendingStartPromise]);
		}
		await this.pendingPersistence;
	}

	private startNow(runId: string, userInstruction: string, steps: readonly PlanStep[]): TaskSnapshot["run"] {
		this.selectedSteps = steps;
		const run = this.store.startRun(runId, userInstruction, this.now(), steps);
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction,
			steps,
			store: this.store,
			childFactory: this.childFactory,
			command: this.demoEnv.piCommand,
			args: this.demoEnv.piArgs,
			env: this.demoEnv.childEnv,
			runtimeConfig: this.demoEnv.runtimeConfig,
			now: this.now,
		});

		this.activeDispatcher = dispatcher;
		this.activeRunId = run.id;
		this.activeRunPromise = dispatcher.run().finally(() => {
			if (this.activeRunId === run.id) {
				this.activeDispatcher = undefined;
				this.activeRunId = undefined;
				this.activeRunPromise = undefined;
			}
		});
		return run;
	}

	private replaceRun(userInstruction: string, steps: readonly PlanStep[]): TaskSnapshot["run"] {
		const pendingRun = createPendingRun(this.nextRunId(), userInstruction, this.now(), steps);
		this.pendingReplacement = {
			id: pendingRun.id,
			userInstruction,
			steps,
		};
		if (!this.activeDispatcher && this.activeRunId) {
			this.store.markRunStopping(this.activeRunId, "replaced_by_new_instruction", this.now(), userInstruction);
		}
		this.activeDispatcher?.stop("replaced_by_new_instruction", {
			replacementInstruction: userInstruction,
		});
		if (!this.pendingStartPromise) {
			const currentRunPromise = this.activeRunPromise ?? Promise.resolve();
			const scheduledStartPromise = currentRunPromise.then(() => {
				const replacement = this.pendingReplacement;
				this.pendingReplacement = undefined;
				if (!replacement) {
					return;
				}
				this.startNow(replacement.id, replacement.userInstruction, replacement.steps);
			});
			const trackedPendingStartPromise = scheduledStartPromise.finally(() => {
				if (this.pendingStartPromise === trackedPendingStartPromise) {
					this.pendingStartPromise = undefined;
				}
			});
			this.pendingStartPromise = trackedPendingStartPromise;
		}
		return pendingRun;
	}

	private nextRunId(): string {
		return randomUUID();
	}

	private resolveSelectedSteps(steps?: readonly PlanStep[]): readonly PlanStep[] {
		return clonePlanSteps(steps ?? this.selectedSteps ?? this.defaultSteps);
	}

	private persistSnapshot(snapshot: TaskSnapshot): void {
		if (snapshot.run.id !== this.persistenceRunId) {
			this.persistenceRunId = snapshot.run.id;
			this.persistedLogCount = 0;
			this.persistedConversationCount = 0;
		}
		const newLogs = snapshot.logs.slice(this.persistedLogCount);
		const newConversationMessages = snapshot.conversationMessages.slice(this.persistedConversationCount);
		this.persistedLogCount = snapshot.logs.length;
		this.persistedConversationCount = snapshot.conversationMessages.length;
		const write = async () => {
			await this.persistenceWriter.writeSnapshot(snapshot);
			for (const entry of newLogs) {
				await this.persistenceWriter.appendTaskLog(entry);
			}
			for (const message of newConversationMessages) {
				await this.persistenceWriter.appendConversationMessage(message);
			}
		};
		this.pendingPersistence = this.pendingPersistence.then(write, write);
	}
}

interface PendingRun {
	readonly id: string;
	readonly userInstruction: string;
	readonly steps: readonly PlanStep[];
}

function createPendingRun(runId: string, userInstruction: string, time: number, steps: readonly PlanStep[]) {
	return {
		id: runId,
		userInstruction,
		status: "running" as const,
		steps: createRuntimeSteps(steps),
		createdAt: time,
		startedAt: time,
	};
}

function clonePlanSteps(steps: readonly PlanStep[]): readonly PlanStep[] {
	return validatePlanSteps(structuredClone(steps));
}
