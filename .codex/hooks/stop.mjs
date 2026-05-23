import { continueTurn, hasHarnessConfig, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessConfig(input.cwd) || input.stop_hook_active) {
  process.exit(0);
}

const message = input.last_assistant_message || "";
const hasEvidence =
  /验证|test|check|未运行|无法运行|evidence|风险|risk|未决/.test(message);

if (!hasEvidence) {
  continueTurn("项目已启用 harness。结束前请补充本轮完成事实、验证情况、风险/未决问题；如果没有运行验证，也要明确说明。");
}
