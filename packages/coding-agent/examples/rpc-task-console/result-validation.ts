import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTaskResult, DataField, RuntimeTask, TaskResult } from "./types.js";

export class TaskResultValidationError extends Error {
	readonly detail?: string;

	constructor(message: string, detail?: string) {
		super(message);
		this.name = "TaskResultValidationError";
		this.detail = detail;
	}
}

export function parseTaskResultFromAssistantMessage(message: unknown): AgentTaskResult {
	if (!isAssistantMessage(message)) {
		throw new TaskResultValidationError("最终结果必须来自 assistant message_end。");
	}

	const text = readAssistantText(message);
	if (!text) {
		throw new TaskResultValidationError("assistant 最终消息缺少 JSON 文本。");
	}

	const jsonText = unwrapJsonFence(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error: unknown) {
		throw new TaskResultValidationError(
			"assistant 最终消息不是合法 JSON。",
			error instanceof Error ? error.message : String(error),
		);
	}

	if (!isRecord(parsed)) {
		throw new TaskResultValidationError("assistant 最终 JSON 必须是对象。");
	}

	const content = parsed.content;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new TaskResultValidationError('assistant 最终 JSON 必须包含非空字符串字段 "content"。');
	}

	return "data" in parsed ? { content, data: parsed.data } : { content };
}

export function validateTaskResult(task: RuntimeTask, result: AgentTaskResult): TaskResult {
	if (task.card_type) {
		if (result.data === undefined) {
			throw new TaskResultValidationError(`任务 "${task.id}" 配置了 card_type，结果必须包含 data。`);
		}
		validateDataStructure(task.data_structure ?? [], result.data, "data");
		return {
			status: "complete",
			content: result.content,
			data: result.data,
		};
	}

	return result.data === undefined
		? { status: "complete", content: result.content }
		: { status: "complete", content: result.content, data: result.data };
}

function readAssistantText(message: AssistantMessage): string {
	let text = "";
	for (const part of message.content) {
		if (part.type === "text") {
			text += part.text;
		}
	}
	return text.trim();
}

function unwrapJsonFence(text: string): string {
	const trimmed = text.trim();
	const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
	return fencedMatch?.[1]?.trim() ?? trimmed;
}

function validateDataStructure(fields: readonly DataField[], value: unknown, path: string): void {
	if (!isRecord(value)) {
		throw new TaskResultValidationError(`${path} 必须是对象。`);
	}

	for (const field of fields) {
		const fieldName = field.field;
		if (!fieldName) {
			throw new TaskResultValidationError(`${path} 的 data_structure 存在缺少 field 的定义。`);
		}
		validateField(field, value[fieldName], `${path}.${fieldName}`);
	}
}

function validateField(field: DataField, value: unknown, path: string): void {
	if (value === undefined) {
		if (field.required) {
			throw new TaskResultValidationError(`${path} 是必填字段。`);
		}
		return;
	}

	if (field.type === "string") {
		if (typeof value !== "string") {
			throw new TaskResultValidationError(`${path} 必须是 string。`);
		}
		return;
	}

	if (field.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new TaskResultValidationError(`${path} 必须是 number。`);
		}
		return;
	}

	if (field.type === "integer") {
		if (typeof value !== "number" || !Number.isInteger(value)) {
			throw new TaskResultValidationError(`${path} 必须是 integer。`);
		}
		return;
	}

	if (field.type === "boolean") {
		if (typeof value !== "boolean") {
			throw new TaskResultValidationError(`${path} 必须是 boolean。`);
		}
		return;
	}

	if (field.type === "array") {
		if (!Array.isArray(value)) {
			throw new TaskResultValidationError(`${path} 必须是 array。`);
		}
		if (!field.items) {
			return;
		}
		const itemField: DataField = {
			field: field.items.field,
			type: field.items.type,
			required: true,
			description: field.items.description,
			items: field.items.items,
			fields: field.items.fields,
		};
		value.forEach((item, index) => {
			validateField(itemField, item, `${path}[${index}]`);
		});
		return;
	}

	if (!isRecord(value)) {
		throw new TaskResultValidationError(`${path} 必须是 object。`);
	}
	for (const nestedField of field.fields ?? []) {
		const nestedFieldName = nestedField.field;
		if (!nestedFieldName) {
			throw new TaskResultValidationError(`${path} 的 object 定义存在缺少 field 的字段。`);
		}
		validateField(nestedField, value[nestedFieldName], `${path}.${nestedFieldName}`);
	}
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
