import { hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

outputContext(
  "SubagentStart",
  [
    "你是被委派的子代理：只做父会话明确委派的任务，不扩大范围。",
    "有写入范围时只改范围内文件；没有明确写入范围时保持只读。",
    "不得提交 commit；不清楚、受阻或发现范围冲突时，向父会话报告。",
    "结束时简短汇报完成内容、涉及文件、验证结果、风险/未决问题。"
  ].join("\n")
);
