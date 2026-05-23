import type { RuntimeStep, RuntimeTask } from "./types.js";

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
		lines.push('输出格式：{ "content": string, "data": ... }');
		lines.push("其中 data 必须满足以下 data_structure：");
		lines.push(JSON.stringify(input.task.data_structure ?? [], null, 2));
	} else {
		lines.push('输出格式：{ "content": string }');
	}
	lines.push("不要输出 card title、card type，也不要输出完整 card object。");

	return lines.join("\n");
}
