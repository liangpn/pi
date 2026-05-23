import { hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

outputContext(
  "UserPromptSubmit",
  [
    "先判断任务规模：只读或轻量修改保持轻量；长期、复杂、多代理协作或需要规范/计划对齐时，使用 $codex-harness。",
    "harness control-plane 规则以 AGENTS.md 和 $codex-harness 为准。"
  ].join("\n")
);
