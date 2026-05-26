import type { DataField, RuntimeStep, RuntimeTask } from "./types.js";

export interface TaskPromptInput {
	readonly userInstruction: string;
	readonly step: RuntimeStep;
	readonly task: RuntimeTask;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
	const lines = [
		"你是被任务控制台派发的子 agent，只负责完成当前这一个 task。",
		"不要修改任务范围，不要输出任务外信息。",
		"",
		`用户指令：${input.userInstruction}`,
		`步骤标题：${input.step.title}`,
		`任务标题：${input.task.title}`,
		`任务描述：${input.task.description}`,
	];

	if (input.task.tools.length > 0) {
		lines.push(`可用工具：${input.task.tools.join(", ")}`);
	}
	if (input.task.skills.length > 0) {
		lines.push(`可用技能：${input.task.skills.join(", ")}`);
	}

	lines.push("", "最终回复必须只输出一个 JSON 对象，不要输出 Markdown 代码块。");
	if (input.task.card_type) {
		const dataStructure = input.task.data_structure ?? [];
		lines.push('输出格式：{ "content": string, "data": { ... } }');
		lines.push("data 必须是 JSON object；key 必须来自 data_structure[].field。");
		lines.push("data 的值必须是最终业务数据，不是 schema。");
		lines.push(`输出示例：${JSON.stringify({ content: "任务完成摘要", data: buildExampleData(dataStructure) })}`);
		lines.push("其中 data 必须满足以下 data_structure：");
		lines.push(JSON.stringify(dataStructure, null, 2));
		lines.push("不要把 data 输出成 data_structure 数组、schema descriptor array。");
		lines.push("不要输出 field/type/required/description/value 包装对象。");
	} else {
		lines.push('输出格式：{ "content": string }');
	}
	lines.push("不要输出 card title、card type，也不要输出完整 card object。");

	return lines.join("\n");
}

function buildExampleData(fields: readonly DataField[]): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const field of fields) {
		if (!field.field) {
			continue;
		}
		data[field.field] = buildExampleValue(field);
	}
	return data;
}

function buildExampleValue(field: DataField): unknown {
	if (field.type === "string") {
		return "示例文本";
	}
	if (field.type === "number") {
		return 12.34;
	}
	if (field.type === "integer") {
		return 1;
	}
	if (field.type === "boolean") {
		return true;
	}
	if (field.type === "array") {
		return [field.items ? buildExampleValue(field.items) : "示例文本"];
	}
	if (field.fields && field.fields.length > 0) {
		return buildExampleData(field.fields);
	}
	return { 示例字段: "示例值" };
}
