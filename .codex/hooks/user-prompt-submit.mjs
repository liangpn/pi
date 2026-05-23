import { hasHarnessSkill, outputContext, readInput } from "./lib.mjs";

const input = await readInput();

if (!hasHarnessSkill(input.cwd)) {
  process.exit(0);
}

outputContext(
  "UserPromptSubmit",
  "处理用户请求前先判断任务规模：只读或轻量修改保持轻量；长期、复杂、多代理协作，或需要规范/计划对齐的开发任务，应使用 $codex-harness 做项目事实检查。任何 harness 文件创建或修改前都必须先向用户说明方案并等待确认。"
);
