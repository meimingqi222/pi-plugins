import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Job, JobRecord } from "../core/jobs.ts";
import { defaultLogDir } from "./settings.ts";

export const BG_BASH_STATE_ENTRY = "bg_bash_state";
export const BG_BASH_COMPLETION_ENTRY = "bg_bash_completion";

export function recordFor(job: Job): JobRecord {
	return {
		schema: 1,
		id: job.id,
		mode: job.mode,
		status: job.status,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		logPath: job.logPath,
	};
}

/** Treat session data as untrusted before turning it into a readable log pointer. */
function parseRecord(value: unknown): JobRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Partial<JobRecord>;
	if (data.schema !== 1 || typeof data.id !== "string" || !/^bg\d{3,9}$/.test(data.id)) return undefined;
	if (data.mode !== "background") return undefined;
	if (!["running", "exited", "failed", "killed", "timedout", "interrupted"].includes(String(data.status))) return undefined;
	if (!validTime(data.startedAt)) return undefined;
	if (data.endedAt !== undefined && !validTime(data.endedAt)) return undefined;
	if (data.endedAt !== undefined && data.endedAt < data.startedAt) return undefined;
	if (data.exitCode !== null && (typeof data.exitCode !== "number" || !Number.isSafeInteger(data.exitCode))) return undefined;
	const path = data.logPath;
	const logPath = typeof path === "string" && safeLogPath(path, data.id) ? path : undefined;
	return {
		schema: 1,
		id: data.id,
		mode: "background",
		status: data.status!,
		startedAt: data.startedAt,
		endedAt: data.endedAt,
		exitCode: data.exitCode,
		logPath,
	};
}

function validTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
}

function safeLogPath(path: string, id: string): boolean {
	if (!isAbsolute(path)) return false;
	const name = basename(path);
	return dirname(resolve(path)) === resolve(defaultLogDir()) &&
		(name === `${id}.log` || name.endsWith(`-${id}.log`));
}

export function recordsFromBranch(entries: readonly unknown[]): JobRecord[] {
	const latest = new Map<string, JobRecord>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (item.type !== "custom" || (item.customType !== BG_BASH_STATE_ENTRY && item.customType !== BG_BASH_COMPLETION_ENTRY)) continue;
		const record = parseRecord(item.data);
		if (record) latest.set(record.id, record);
	}
	return [...latest.values()].sort((a, b) => a.startedAt - b.startedAt);
}
