export type TaskStatus = "loading" | "running" | "complete" | "fail" | "stopped";
export type RunStatus = "idle" | "running" | "stopping" | "complete" | "fail" | "stopped";
export type CardType = "media" | "map" | "table" | "json" | "text";
export type DataFieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";
export type StopReason = "user_stopped" | "replaced_by_new_instruction" | "timeout_after_stop";
export type TaskRetryReason =
	| "process_error"
	| "process_closed_before_agent_end"
	| "provider_error"
	| "timeout"
	| "tool_limit_exceeded"
	| "validation_error";

export interface PlanStep {
	readonly id: string;
	readonly title: string;
	readonly tasks: readonly PlanTask[];
}

export interface PlanTask {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly tools?: readonly string[];
	readonly skills?: readonly string[];
	readonly retry?: TaskRetryPolicy;
	readonly card_type?: CardType;
	readonly data_structure?: readonly DataField[];
	readonly demoOutcome?: "normal" | "force_fail_after_run";
}

export interface TaskRetryPolicy {
	readonly max_attempts?: number;
	readonly base_delay_ms?: number;
	readonly max_tool_calls?: number;
	readonly retry_on?: readonly TaskRetryReason[];
}

export interface DataField {
	readonly field?: string;
	readonly type: DataFieldType;
	readonly required?: boolean;
	readonly description?: string;
	readonly items?: DataField;
	readonly fields?: readonly DataField[];
}

export interface RuntimeStep {
	readonly id: string;
	readonly title: string;
	readonly status: TaskStatus;
	readonly tasks: readonly RuntimeTask[];
}

export interface RuntimeTask {
	readonly id: string;
	readonly stepId: string;
	readonly title: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly retry?: TaskRetryPolicy;
	readonly card_type?: CardType;
	readonly data_structure?: readonly DataField[];
	readonly attempts: readonly TaskAttempt[];
	readonly status: TaskStatus;
	readonly agent?: TaskAgentMetadata;
	readonly process?: TaskProcessMetadata;
	readonly agentRun?: AgentRunState;
	readonly result?: TaskResult;
	readonly error?: TaskError;
	readonly stopped?: TaskStopped;
	readonly eventCount: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly demoOutcome?: "normal" | "force_fail_after_run";
}

export interface TaskAttempt {
	readonly id: string;
	readonly taskId: string;
	readonly attempt: number;
	readonly agentRunId: string;
	readonly status: "running" | "complete" | "fail" | "stopped";
	readonly toolCallCount: number;
	readonly agent?: TaskAgentMetadata;
	readonly process?: TaskProcessMetadata;
	readonly stopped?: TaskStopped;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly errorCode?: string;
	readonly errorMessage?: string;
}

export interface TaskAgentMetadata {
	readonly processId?: number;
	readonly sessionDir?: string;
	readonly command: readonly string[];
}

export interface TaskProcessMetadata {
	readonly closeCode?: number | null;
	readonly signal?: string | null;
	readonly stderrTail?: string;
}

export interface AgentRunState {
	readonly agentRunId: string;
	readonly processId?: number;
	readonly command: string;
	readonly args: readonly string[];
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly stderrTail?: string;
}

export interface AgentTaskResult<TData = unknown> {
	readonly content: string;
	readonly data?: TData;
}

export interface TaskResult<TData = unknown> {
	readonly status: "complete";
	readonly content: string;
	readonly data?: TData;
}

export interface TaskError {
	readonly status: "fail";
	readonly code?: string;
	readonly message: string;
	readonly detail?: string;
}

export interface TaskStopped {
	readonly status: "stopped";
	readonly reason: StopReason;
	readonly message: string;
	readonly detail?: string;
}

export interface TaskConversationMessage {
	readonly id: string;
	readonly runId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly content: string;
	readonly time: number;
}

export interface TextCardData {
	readonly text: string;
}

export interface TableCardData {
	readonly columns?: readonly { readonly key: string; readonly label: string }[];
	readonly rows: readonly Record<string, string | number | boolean | null>[];
}

export interface MapCardData {
	readonly center?: { readonly lat: number; readonly lng: number };
	readonly markers: readonly {
		readonly label: string;
		readonly lat: number;
		readonly lng: number;
		readonly status?: string;
	}[];
	readonly layers?: readonly string[];
}

export interface MediaCardData {
	readonly gbids: readonly string[];
}

export interface JsonCardData {
	readonly value: unknown;
}

export interface BaseUICard<TType extends CardType, TData> {
	readonly id: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly type: TType;
	readonly title: string;
	readonly status: TaskStatus;
	readonly data: TData;
}

export type UICard =
	| BaseUICard<"text", TextCardData>
	| BaseUICard<"table", TableCardData>
	| BaseUICard<"map", MapCardData>
	| BaseUICard<"media", MediaCardData>
	| BaseUICard<"json", JsonCardData>;

export interface TaskLogEntry {
	readonly id: string;
	readonly runId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly type: string;
	readonly message: string;
	readonly time: number;
	readonly detail?: unknown;
}

export interface SystemReceipt {
	readonly id: string;
	readonly runId?: string;
	readonly message: string;
	readonly time: number;
	readonly level: "info" | "error";
}

export interface TaskRun {
	readonly id: string;
	readonly userInstruction: string;
	readonly status: RunStatus;
	readonly stopReason?: "user_stopped" | "replaced_by_new_instruction";
	readonly replacementInstruction?: string;
	readonly steps: readonly RuntimeStep[];
	readonly createdAt: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
}

export interface TaskSnapshot {
	readonly run: TaskRun;
	readonly cards: readonly UICard[];
	readonly logs: readonly TaskLogEntry[];
	readonly receipts: readonly SystemReceipt[];
	readonly conversationMessages: readonly TaskConversationMessage[];
}

interface TaskStoreDiagnosticFields {
	readonly attemptId?: string;
	readonly attempt?: number;
	readonly agentRunId?: string;
	readonly toolCallCount?: number;
	readonly agent?: TaskAgentMetadata;
	readonly process?: TaskProcessMetadata;
}

export type TaskStoreEvent =
	| ({
			readonly type: "task_started";
			readonly runId: string;
			readonly stepId: string;
			readonly taskId: string;
			readonly time: number;
	  } & TaskStoreDiagnosticFields)
	| ({
			readonly type: "task_completed";
			readonly runId: string;
			readonly stepId: string;
			readonly taskId: string;
			readonly result: TaskResult;
			readonly time: number;
	  } & TaskStoreDiagnosticFields)
	| ({
			readonly type: "task_attempt_failed";
			readonly runId: string;
			readonly stepId: string;
			readonly taskId: string;
			readonly error: TaskError;
			readonly time: number;
	  } & TaskStoreDiagnosticFields)
	| ({
			readonly type: "task_failed";
			readonly runId: string;
			readonly stepId: string;
			readonly taskId: string;
			readonly error: TaskError;
			readonly time: number;
	  } & TaskStoreDiagnosticFields)
	| ({
			readonly type: "task_stopped";
			readonly runId: string;
			readonly stepId: string;
			readonly taskId: string;
			readonly stopped: TaskStopped;
			readonly time: number;
	  } & TaskStoreDiagnosticFields)
	| ({
			readonly type: "task_log";
			readonly runId: string;
			readonly stepId: string;
			readonly taskId: string;
			readonly message: string;
			readonly logType: string;
			readonly detail?: unknown;
			readonly time: number;
	  } & TaskStoreDiagnosticFields);

export type NormalizedChildEvent =
	| { readonly type: "child_spawned"; readonly processId?: number }
	| {
			readonly type: "rpc_response";
			readonly id?: string;
			readonly command?: string;
			readonly success: boolean;
			readonly error?: string;
	  }
	| {
			readonly type: "prompt_response_failure";
			readonly id?: string;
			readonly error?: string;
	  }
	| { readonly type: "agent_start" }
	| { readonly type: "message_update"; readonly message?: unknown; readonly assistantMessageEvent?: unknown }
	| {
			readonly type: "tool_execution_start";
			readonly toolCallId?: string;
			readonly toolName?: string;
			readonly args?: unknown;
	  }
	| {
			readonly type: "tool_execution_update";
			readonly toolCallId?: string;
			readonly toolName?: string;
			readonly args?: unknown;
			readonly partialResult?: unknown;
	  }
	| {
			readonly type: "tool_execution_end";
			readonly toolCallId?: string;
			readonly toolName?: string;
			readonly result?: unknown;
			readonly isError?: boolean;
	  }
	| { readonly type: "message_start"; readonly message?: unknown }
	| { readonly type: "message_end"; readonly message?: unknown }
	| { readonly type: "turn_start" }
	| { readonly type: "turn_end"; readonly message?: unknown; readonly toolResults?: unknown }
	| { readonly type: "agent_end"; readonly messages?: unknown; readonly willRetry?: boolean }
	| {
			readonly type: "auto_retry_start";
			readonly attempt?: number;
			readonly maxAttempts?: number;
			readonly delayMs?: number;
			readonly errorMessage?: string;
	  }
	| {
			readonly type: "auto_retry_end";
			readonly success?: boolean;
			readonly attempt?: number;
			readonly finalError?: string;
	  }
	| {
			readonly type: "process_close";
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly stderrTail?: string;
	  }
	| { readonly type: "process_error"; readonly error: string; readonly stderrTail?: string }
	| {
			readonly type: "unknown_json_event";
			readonly message: string;
			readonly eventType?: string;
			readonly rawLine?: string;
			readonly detail?: unknown;
	  };

export interface ChildAgentProcessLike {
	readonly agentRunId: string;
	readonly processId?: number;
	start(): void;
	sendPrompt(message: string): string;
	sendSteer(message: string): string;
	sendAbort(): string;
	kill(signal: NodeJS.Signals): void;
}

export type ChildAgentProcessFactory = (options: ChildAgentProcessFactoryOptions) => ChildAgentProcessLike;

export interface ChildAgentProcessFactoryOptions {
	readonly runId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly onEvent: (event: NormalizedChildEvent) => void;
}
