/**
 * Filesystem-facing configuration.
 *
 * Everything that touches disk for the plugin lives here, so the threshold
 * precedence in `core/config.ts` stays pure and independently testable.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThresholdSources } from "../core/config.ts";

export const ENV_THRESHOLD = "PI_BG_BASH_THRESHOLD";
const PROJECT_FILE = join(".pi", "bg-bash.json");
const GLOBAL_FILE = join(".pi", "bg-bash.json");

/** Directory where per-job full output is appended. */
export function defaultLogDir(): string {
	return process.env.PI_BG_BASH_LOG_DIR || join(homedir(), ".pi", "bg-bash", "logs");
}

/** Collect the three threshold sources without deciding anything. */
export function loadThresholdSources(cwd?: string): ThresholdSources {
	return {
		env: process.env[ENV_THRESHOLD],
		project: cwd ? readThreshold(join(cwd, PROJECT_FILE)) : undefined,
		global: readThreshold(join(homedir(), GLOBAL_FILE)),
	};
}

function readThreshold(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		return (parsed as { autoBackgroundAfterSeconds?: unknown }).autoBackgroundAfterSeconds;
	} catch {
		return undefined;
	}
}

/** Ensure the log directory exists and return a path for one job. */
export function allocateLogPath(jobId: string): string {
	const dir = defaultLogDir();
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// The runner retries creation and degrades to memory-only on failure.
	}
	return join(dir, `${jobId}.log`);
}

/** Read at most `maxBytes` from the end of a log file. */
export function readLogTail(path: string, maxBytes = 256 * 1024): string {
	if (!path) return "";
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, start);
		return buffer.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore close failures.
			}
		}
	}
}
