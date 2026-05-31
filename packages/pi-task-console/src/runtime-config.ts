import { readFileSync } from "node:fs";
import type { TaskRetryReason } from "./types.js";

export interface RuntimeConfig {
	readonly concurrency_limit: number;
	readonly stop_steer_timeout_ms: number;
	readonly stop_abort_timeout_ms: number;
	readonly retry: {
		readonly max_attempts: number;
		readonly base_delay_ms: number;
		readonly max_tool_calls: number;
		readonly retry_on: readonly TaskRetryReason[];
	};
	readonly minimal_system_tools: readonly string[];
}

const TASK_RETRY_REASONS = [
	"process_error",
	"process_closed_before_agent_end",
	"provider_error",
	"timeout",
	"tool_limit_exceeded",
	"validation_error",
] as const satisfies readonly TaskRetryReason[];

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
	concurrency_limit: 2,
	stop_steer_timeout_ms: 5000,
	stop_abort_timeout_ms: 3000,
	retry: {
		max_attempts: 2,
		base_delay_ms: 1000,
		max_tool_calls: 8,
		retry_on: [...TASK_RETRY_REASONS],
	},
	minimal_system_tools: [],
};

export function loadRuntimeConfig(configPath: string | URL): RuntimeConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error: unknown) {
		throw new Error(`Failed to read runtime config at ${String(configPath)}: ${formatError(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		throw new Error(`Runtime config at ${String(configPath)} is not valid JSON: ${formatError(error)}`);
	}

	return validateRuntimeConfig(parsed);
}

export function validateRuntimeConfig(value: unknown): RuntimeConfig {
	if (!isRecord(value)) {
		throw new Error("Runtime config must be a JSON object");
	}

	return {
		concurrency_limit: readPositiveInteger(value, "concurrency_limit"),
		stop_steer_timeout_ms: readNonNegativeInteger(value, "stop_steer_timeout_ms"),
		stop_abort_timeout_ms: readNonNegativeInteger(value, "stop_abort_timeout_ms"),
		retry: readRetryConfig(value.retry),
		minimal_system_tools: readStringArray(value, "minimal_system_tools"),
	};
}

function readRetryConfig(value: unknown): RuntimeConfig["retry"] {
	if (!isRecord(value)) {
		throw new Error("runtime config retry must be a JSON object");
	}

	return {
		max_attempts: readPositiveInteger(value, "max_attempts", "retry"),
		base_delay_ms: readNonNegativeInteger(value, "base_delay_ms", "retry"),
		max_tool_calls: readPositiveInteger(value, "max_tool_calls", "retry"),
		retry_on: readRetryReasons(value.retry_on),
	};
}

function readRetryReasons(value: unknown): readonly TaskRetryReason[] {
	if (!Array.isArray(value)) {
		throw new Error("runtime config retry.retry_on must be an array");
	}
	const reasons = value.map((item) => {
		if (typeof item !== "string" || !TASK_RETRY_REASONS.includes(item as TaskRetryReason)) {
			throw new Error(`runtime config retry.retry_on contains invalid value: ${String(item)}`);
		}
		return item as TaskRetryReason;
	});
	return reasons;
}

function readStringArray(value: Record<string, unknown>, key: string): readonly string[] {
	const field = value[key];
	if (!Array.isArray(field)) {
		throw new Error(`runtime config ${key} must be an array`);
	}
	const items = field.map((item) => {
		if (typeof item !== "string") {
			throw new Error(`runtime config ${key} must contain only strings`);
		}
		return item;
	});
	return items;
}

function readPositiveInteger(value: Record<string, unknown>, key: string, prefix?: string): number {
	return readInteger(value, key, prefix, 1);
}

function readNonNegativeInteger(value: Record<string, unknown>, key: string, prefix?: string): number {
	return readInteger(value, key, prefix, 0);
}

function readInteger(value: Record<string, unknown>, key: string, prefix: string | undefined, minimum: number): number {
	const field = value[key];
	const label = prefix ? `${prefix}.${key}` : key;
	if (!Number.isInteger(field) || (field as number) < minimum) {
		throw new Error(`runtime config ${label} must be an integer >= ${minimum}`);
	}
	return field as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
