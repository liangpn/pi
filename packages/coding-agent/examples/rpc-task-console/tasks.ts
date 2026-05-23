import { validatePlanSteps } from "./plan-validation.js";
import type { PlanStep, RuntimeStep } from "./types.js";

const PLAN_STEPS: readonly PlanStep[] = [
	{
		id: "step-1",
		title: "先期处置",
		tasks: [
			{
				id: "task-1",
				title: "总结当前目录",
				description: "请用一句话说明当前目录是什么项目。不要修改文件。",
				tools: [],
				skills: [],
				card_type: "text",
				data_structure: [{ field: "text", type: "string", required: true, description: "目录摘要文本" }],
				demoOutcome: "normal",
			},
			{
				id: "task-2",
				title: "打开服务监控",
				description:
					"1、调用 @get_jw@ 获取经纬度 2、调用 @get_address@ 获取地址 3、调用 @open_camera@ 打开 service-a 监控",
				tools: [],
				skills: [],
				card_type: "media",
				data_structure: [
					{
						field: "gbids",
						type: "array",
						required: true,
						description: "监控设备 GBID 列表",
						items: { type: "string" },
					},
				],
				demoOutcome: "normal",
			},
			{
				id: "task-3",
				title: "查询地图点位",
				description: "模拟查询目标周边点位，返回中心点和若干 marker。",
				tools: [],
				skills: [],
				card_type: "map",
				data_structure: [
					{
						field: "center",
						type: "object",
						required: false,
						fields: [
							{ field: "lat", type: "number", required: true },
							{ field: "lng", type: "number", required: true },
						],
					},
					{
						field: "markers",
						type: "array",
						required: true,
						items: {
							type: "object",
							fields: [
								{ field: "label", type: "string", required: true },
								{ field: "lat", type: "number", required: true },
								{ field: "lng", type: "number", required: true },
								{ field: "status", type: "string", required: false },
							],
						},
					},
				],
				demoOutcome: "normal",
			},
		],
	},
	{
		id: "step-2",
		title: "资源确认",
		tasks: [
			{
				id: "task-4",
				title: "拉取资源清单",
				description: "模拟拉取可用资源清单，输出表格数据。",
				tools: [],
				skills: [],
				retry: {
					max_attempts: 2,
					base_delay_ms: 250,
					max_tool_calls: 3,
					retry_on: ["process_error", "timeout"],
				},
				card_type: "table",
				data_structure: [{ field: "rows", type: "array", required: true, description: "资源表格行数据" }],
				demoOutcome: "normal",
			},
			{
				id: "task-5",
				title: "模拟失败任务",
				description: "请尝试读取一个不存在的文件 docs/definitely-missing-demo-file.txt，并报告错误。",
				tools: [],
				skills: [],
				demoOutcome: "force_fail_after_run",
			},
		],
	},
];

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
