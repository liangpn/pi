import { createChildAgentProcess } from "./child-agent-process.js";
import type { DemoEnv } from "./env.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { TaskStore } from "./task-store.js";
import { createInitialSteps } from "./tasks.js";
import type { ChildAgentProcessFactory, PlanStep, StopReason, TaskSnapshot } from "./types.js";

export interface RunManagerOptions {
	readonly steps?: readonly PlanStep[];
	readonly demoEnv: DemoEnv;
	readonly childFactory?: ChildAgentProcessFactory;
	readonly now?: () => number;
}

export class RunManager {
	private readonly steps: readonly PlanStep[];
	private readonly store: TaskStore;
	private readonly demoEnv: DemoEnv;
	private readonly childFactory: ChildAgentProcessFactory;
	private readonly now: () => number;
	private activeDispatcher: TaskDispatcher | undefined;
	private activeRunId: string | undefined;
	private activeRunPromise: Promise<void> | undefined;
	private runSequence = 0;

	constructor(options: RunManagerOptions) {
		this.steps = options.steps ?? createInitialSteps();
		this.store = TaskStore.createIdle(this.steps);
		this.demoEnv = options.demoEnv;
		this.childFactory = options.childFactory ?? createChildAgentProcess;
		this.now = options.now ?? Date.now;
	}

	getSnapshot(): TaskSnapshot {
		return this.store.getSnapshot();
	}

	subscribe(listener: (snapshot: TaskSnapshot) => void): () => void {
		return this.store.subscribe(listener);
	}

	start(userInstruction: string): TaskSnapshot["run"] {
		if (this.activeDispatcher) {
			this.activeDispatcher.stop("replaced_by_new_instruction");
		}

		const run = this.store.startRun(this.nextRunId(), userInstruction, this.now());
		const dispatcher = new TaskDispatcher({
			runId: run.id,
			userInstruction,
			steps: this.steps,
			store: this.store,
			childFactory: this.childFactory,
			command: this.demoEnv.piCommand,
			args: this.demoEnv.piArgs,
			env: this.demoEnv.childEnv,
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

	stop(reason: StopReason = "user_stopped"): void {
		this.activeDispatcher?.stop(reason);
	}

	reset(): void {
		this.stop("user_stopped");
		this.activeDispatcher = undefined;
		this.activeRunId = undefined;
		this.activeRunPromise = undefined;
		this.store.reset(this.now());
	}

	async waitForIdle(): Promise<void> {
		await this.activeRunPromise;
	}

	private nextRunId(): string {
		return `run-${this.now()}-${++this.runSequence}`;
	}
}
