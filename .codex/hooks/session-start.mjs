import { hasHarnessConfig, hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

const active = hasHarnessConfig(input.cwd);
const additionalContext = active
  ? [
      "本项目已启用 harness。长期、复杂或多代理协作开发任务开始前，先读 .codex-harness.toml 和 $codex-harness。",
      "详细规则以 AGENTS.md 和 $codex-harness 为准；hooks 只做时机提醒。"
    ].join("\n")
  : [
      "本项目提供 $codex-harness skill。长期、复杂或多代理协作开发任务开始前，先用该 skill 做只读检查。",
      "详细规则以 AGENTS.md 和 $codex-harness 为准；hooks 只做时机提醒。"
    ].join("\n");

outputContext("SessionStart", additionalContext);
