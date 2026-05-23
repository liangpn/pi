import { hasHarnessConfig, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessConfig(input.cwd)) {
  process.exit(0);
}

outputContext(
  "PostToolUse",
  "如果刚才的工具调用产生了与当前 harness 任务相关的事实、文件变更、验证结果或风险，请在后续回复或 ledger 中保留证据。"
);
