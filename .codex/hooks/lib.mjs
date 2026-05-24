import fs from "node:fs";
import path from "node:path";

export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  if (input.length === 0) {
    return {};
  }
  return JSON.parse(input);
}

export function findRepoRoot(cwd) {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd || process.cwd());
    }
    current = parent;
  }
}

export function harnessPaths(cwd) {
  const root = findRepoRoot(cwd);
  return {
    root,
    configPath: path.join(root, ".codex-harness.toml"),
    skillPath: path.join(root, ".codex", "skills", "codex-harness", "SKILL.md")
  };
}

export function hasHarnessConfig(cwd) {
  return fs.existsSync(harnessPaths(cwd).configPath);
}

export function hasHarnessSkill(cwd) {
  return fs.existsSync(harnessPaths(cwd).skillPath);
}

export function outputContext(eventName, additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  }));
}

export function outputSystemMessage(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }));
}

export function denyPermission(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message
      }
    }
  }));
}

export function continueTurn(reason) {
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason
  }));
}

export function commandText(input) {
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object") {
    return "";
  }
  const command = toolInput.command;
  return typeof command === "string" ? command : JSON.stringify(toolInput);
}

export function isDangerousCommand(command) {
  return [
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+checkout\s+--\s+\./,
    /\bgit\s+clean\s+-[^\s]*f/,
    /\brm\s+-rf\s+(\/|\*|\.|\.\.)/,
    /\bsudo\s+rm\b/
  ].some((pattern) => pattern.test(command));
}
