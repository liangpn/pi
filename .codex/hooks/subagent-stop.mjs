import { continueTurn, hasHarnessConfig, readInput, textHasReportShape } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessConfig(input.cwd) || input.stop_hook_active) {
  process.exit(0);
}

if (!textHasReportShape(input.last_assistant_message || "")) {
  continueTurn(
    "请补充简短子代理收尾报告：完成内容、涉及文件、验证结果、风险/未决问题；未运行验证要明确说明。"
  );
}
