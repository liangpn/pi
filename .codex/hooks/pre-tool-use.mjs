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
  "如果这次工具调用会创建或修改 harness/spec/plan/ledger/agent/hook 配置，必须已经向用户说明原因、影响文件和方案，并获得确认。"
);
