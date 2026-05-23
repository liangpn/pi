import { hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

outputContext(
  "SubagentStart",
  "你是被委派的执行子代理。只完成父会话给出的任务，不接管全局计划，不扩大范围。结束时用简短结构汇报：完成内容、涉及文件、验证结果、风险/未决问题。不要要求用户确认；不清楚时向父会话报告。"
);
