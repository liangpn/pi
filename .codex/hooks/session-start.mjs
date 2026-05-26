import { hasHarnessConfig, hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

const active = hasHarnessConfig(input.cwd);
const additionalContext = active
  ? [
      "长期、复杂或多代理协作开发任务开始前，先读 .codex-harness.toml 和 codex-harness skill。详细规则以 AGENTS.md 和 codex-harness skill 为准；",
      "代码变更、review、debug 或 refactor 前，先使用并遵守 karpathy-guidelines skill；除非更具体规则覆盖，它是本项目通用 coding discipline 的宪法性约束。"
    ].join("\n")
  : [
      "长期、复杂或多代理协作开发任务开始前，遵循 codex-harness skill 做只读检查。详细规则以 AGENTS.md 和 codex-harness skill 为准；",
      "代码变更、review、debug 或 refactor 前，先使用并遵守 karpathy-guidelines skill；除非更具体规则覆盖，它是本项目通用 coding discipline 的宪法性约束。"
    ].join("\n");

outputContext("SessionStart", additionalContext);
