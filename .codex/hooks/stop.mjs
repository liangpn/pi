import { continueTurn, hasHarnessConfig, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessConfig(input.cwd) || input.stop_hook_active) {
  process.exit(0);
}

continueTurn(
  "结束前请补充本轮完成事实、验证情况、风险/未决问题；未运行验证也要明确说明。"
);
