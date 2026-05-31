import { validatePlanSteps } from "./plan-validation.js";
import type { PlanStep, RuntimeStep } from "./types.js";

const PLAN_STEPS: readonly PlanStep[] = [];

export function createInitialSteps(): PlanStep[] {
	return validatePlanSteps(PLAN_STEPS).map((step) => ({
		...step,
		tasks: step.tasks.map((task) => ({
			...task,
			tools: [...(task.tools ?? [])],
			skills: [...(task.skills ?? [])],
			retry: cloneRetryPolicy(task.retry),
			data_structure: task.data_structure?.map(cloneDataField),
		})),
	}));
}

export function createRuntimeSteps(planSteps: readonly PlanStep[]): RuntimeStep[] {
	return validatePlanSteps(planSteps).map((step) => ({
		id: step.id,
		title: step.title,
		status: "loading",
		tasks: step.tasks.map((task) => ({
			id: task.id,
			stepId: step.id,
			title: task.title,
			description: task.description,
			tools: [...(task.tools ?? [])],
			skills: [...(task.skills ?? [])],
			retry: cloneRetryPolicy(task.retry),
			card_type: task.card_type,
			data_structure: task.data_structure?.map(cloneDataField),
			attempts: [],
			status: "loading",
			eventCount: 0,
			demoOutcome: task.demoOutcome,
		})),
	}));
}

function cloneDataField<T extends NonNullable<PlanStep["tasks"][number]["data_structure"]>[number]>(field: T): T {
	return {
		...field,
		items: field.items ? cloneDataField(field.items) : undefined,
		fields: field.fields?.map(cloneDataField),
	};
}

function cloneRetryPolicy(retry: PlanStep["tasks"][number]["retry"]): PlanStep["tasks"][number]["retry"] {
	if (!retry) {
		return undefined;
	}
	return {
		max_attempts: retry.max_attempts,
		base_delay_ms: retry.base_delay_ms,
		max_tool_calls: retry.max_tool_calls,
		retry_on: retry.retry_on ? [...retry.retry_on] : undefined,
	};
}
