import { hasHarnessConfig, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessConfig(input.cwd)) {
  process.exit(0);
}

outputContext(
  "PostToolUse",
  "如工具产生了当前 harness 任务的关键事实、验证结果或风险，后续回复或 ledger 需保留证据；普通过程不要写成流水账。"
);
