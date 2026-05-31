import type { CardType, DataField, PlanStep, TaskRetryPolicy, TaskRetryReason } from "./types.js";

const CARD_TYPES = new Set<CardType>(["media", "map", "table", "json", "text"]);
const RETRY_REASONS = new Set<TaskRetryReason>([
	"process_error",
	"process_closed_before_agent_end",
	"provider_error",
	"timeout",
	"tool_limit_exceeded",
	"validation_error",
]);

export function validatePlanSteps(steps: readonly PlanStep[]): readonly PlanStep[] {
	const stepIds = new Set<string>();
	const taskIds = new Set<string>();

	return steps.map((step) => {
		if (stepIds.has(step.id)) {
			throw new Error(`Duplicate step id "${step.id}"`);
		}
		stepIds.add(step.id);

		return {
			id: step.id,
			title: step.title,
			tasks: step.tasks.map((task) => validatePlanTask(task, taskIds)),
		};
	});
}

function validatePlanTask(task: PlanStep["tasks"][number], taskIds: Set<string>): PlanStep["tasks"][number] {
	if (taskIds.has(task.id)) {
		throw new Error(`Duplicate task id "${task.id}"`);
	}
	taskIds.add(task.id);

	validateCardConfiguration(task);

	return {
		id: task.id,
		title: task.title,
		description: task.description,
		tools: task.tools ? [...task.tools] : [],
		skills: task.skills ? [...task.skills] : [],
		retry: task.retry ? validateRetryPolicy(task.retry, task.id) : undefined,
		card_type: task.card_type,
		data_structure: task.data_structure?.map(cloneDataField),
		demoOutcome: task.demoOutcome,
	};
}

function validateCardConfiguration(task: PlanStep["tasks"][number]): void {
	const cardType = task.card_type as CardType | "" | undefined;
	if (cardType !== undefined) {
		if (!isCardType(cardType)) {
			throw new Error(`Task "${task.id}" has invalid card_type "${cardType}"`);
		}
		if (!task.data_structure || task.data_structure.length === 0) {
			throw new Error(`Task "${task.id}" requires a non-empty data_structure when card_type is set`);
		}
		return;
	}

	if (task.data_structure && task.data_structure.length > 0) {
		throw new Error(`Task "${task.id}" must not define data_structure without card_type`);
	}
}

function validateRetryPolicy(retry: TaskRetryPolicy, taskId: string): TaskRetryPolicy {
	if (retry.max_attempts !== undefined && !isPositiveInteger(retry.max_attempts)) {
		throw new Error(`Task "${taskId}" has invalid retry.max_attempts`);
	}
	if (retry.max_tool_calls !== undefined && !isPositiveInteger(retry.max_tool_calls)) {
		throw new Error(`Task "${taskId}" has invalid retry.max_tool_calls`);
	}
	if (retry.base_delay_ms !== undefined && !isNonNegativeInteger(retry.base_delay_ms)) {
		throw new Error(`Task "${taskId}" has invalid retry.base_delay_ms`);
	}
	if (retry.retry_on !== undefined) {
		for (const reason of retry.retry_on) {
			if (!RETRY_REASONS.has(reason)) {
				throw new Error(`Task "${taskId}" has invalid retry.retry_on value "${reason}"`);
			}
		}
	}

	return {
		max_attempts: retry.max_attempts,
		base_delay_ms: retry.base_delay_ms,
		max_tool_calls: retry.max_tool_calls,
		retry_on: retry.retry_on ? [...retry.retry_on] : undefined,
	};
}

function cloneDataField(field: DataField): DataField {
	return {
		...field,
		items: field.items ? cloneDataField(field.items) : undefined,
		fields: field.fields?.map(cloneDataField),
	};
}

function isCardType(value: CardType | ""): value is CardType {
	return CARD_TYPES.has(value as CardType);
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: number): boolean {
	return Number.isInteger(value) && value >= 0;
}
