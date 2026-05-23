import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcTaskConsoleEnv } from "./env.js";

export interface ChildSettingsPaths {
	readonly agentDir: string;
	readonly settingsPath: string;
	readonly sessionDir?: string;
}

interface ChildSettingsFile {
	readonly retry: {
		readonly enabled: boolean;
		readonly maxRetries: number;
		readonly baseDelayMs: number;
		readonly provider: {
			readonly timeoutMs: number;
			readonly maxRetries: number;
			readonly maxRetryDelayMs: number;
		};
	};
	readonly transport: "sse";
}

const DEFAULT_CHILD_SETTINGS: ChildSettingsFile = {
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		provider: {
			timeoutMs: 300000,
			maxRetries: 0,
			maxRetryDelayMs: 60000,
		},
	},
	transport: "sse",
};

export async function prepareChildSettings(env: RpcTaskConsoleEnv): Promise<ChildSettingsPaths> {
	return prepareChildSettingsSync(env);
}

export function prepareChildSettingsSync(env: RpcTaskConsoleEnv): ChildSettingsPaths {
	mkdirSync(env.childAgentDir, { recursive: true });
	const settingsPath = join(env.childAgentDir, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify(DEFAULT_CHILD_SETTINGS, null, 2)}\n`);
	return {
		agentDir: env.childAgentDir,
		settingsPath,
		sessionDir: env.enableChildSession ? env.childSessionDir : undefined,
	};
}
