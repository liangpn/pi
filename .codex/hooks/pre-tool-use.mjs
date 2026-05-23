import { blockPreTool, commandText, hasHarnessSkill, isDangerousCommand, outputContext, readInput } from "./lib.mjs";

const input = await readInput();
const command = commandText(input);

if (isDangerousCommand(command)) {
  blockPreTool("阻止潜在破坏性命令。需要删除、重置或清理工作树时，先向用户说明影响范围并获得明确确认。");
  process.exit(0);
}

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

outputContext(
  "PreToolUse",
  "harness/spec/plan/ledger/agent/hook 的结构或语义变更必须已获用户确认；例行 plan/ledger 事实状态更新可直接记录。"
);
