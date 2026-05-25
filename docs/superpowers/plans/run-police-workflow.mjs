#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = "http://localhost:4175";
const DEFAULT_USER_INSTRUCTION =
	"请以接警单编号 44010620260525085000433002 为目标，执行公安指挥处置 workflow，按阶段完成警情要素识别、基础研判、现场态势展开和出警资源可视化，并严格按各任务要求返回结果。";

const options = parseArgs(process.argv.slice(2));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(scriptDir, "../specs/references/police-command-workflow.json");
const steps = JSON.parse(await readFile(workflowPath, "utf8"));
const response = await fetch(new URL("/runs/start", options.base), {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		steps,
		userInstruction: options.userInstruction,
	}),
});
const responseText = await response.text();

if (!response.ok) {
	console.error(responseText);
	process.exitCode = 1;
} else {
	console.log(responseText);
}

function parseArgs(args) {
	let base = DEFAULT_BASE;
	let userInstruction = DEFAULT_USER_INSTRUCTION;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--base") {
			base = readOptionValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--base=")) {
			base = arg.slice("--base=".length);
			continue;
		}
		if (arg === "--userInstruction") {
			userInstruction = readOptionValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--userInstruction=")) {
			userInstruction = arg.slice("--userInstruction=".length);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { base, userInstruction };
}

function readOptionValue(args, index, name) {
	const value = args[index + 1];
	if (!value) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}
