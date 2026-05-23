import { hasHarnessConfig, hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

const active = hasHarnessConfig(input.cwd);
const additionalContext = active
  ? "本项目已启用项目级 harness。长期、复杂或多代理协作开发任务开始前，先读取 .codex-harness.toml 和 $codex-harness；主会话负责对齐、计划、委派、复核和 ledger，子代理负责具体执行。"
  : "本项目提供 $codex-harness skill。遇到长期、复杂、多代理协作，或需要先对齐规范和计划的开发任务时，先使用该 skill 做只读检查，并在创建或修改项目级 harness 文件前等待用户确认。";

outputContext("SessionStart", additionalContext);
