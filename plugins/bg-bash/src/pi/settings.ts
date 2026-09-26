/**
 * Filesystem-facing configuration.
 *
 * Everything that touches disk for the plugin lives here, so the threshold
 * precedence in `core/config.ts` stays pure and independently testable.
 */

import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSeconds, type ThresholdSources } from "../core/config.ts";

export const ENV_THRESHOLD = "PI_BG_BASH_THRESHOLD";
export const ENV_LOG_RETENTION_DAYS = "PI_BG_BASH_LOG_RETENTION_DAYS";

/** Logs older than this are deleted on session start. `0` disables the sweep. */
export const DEFAULT_LOG_RETENTION_DAYS = 7;

/** After the age sweep, at most this many log files are kept (newest first). */
export const MAX_LOG_FILES = 200;
const PROJECT_FILE = join(".pi", "bg-bash.json");
const GLOBAL_FILE = join(".pi", "bg-bash.json");

/** Directory where per-job full output is appended. */
export function defaultLogDir(): string {
	return resolve(process.env.PI_BG_BASH_LOG_DIR || join(homedir(), ".pi", "bg-bash", "logs"));
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

/**
 * Ensure the log directory exists and return a path for one job.
 *
 * Job ids restart at bg001 in every process, so the session id is part of the
 * file name: without it a new session appends to a previous session's file,
 * and two concurrent pi processes interleave into the same one.
 */
export function allocateLogPath(jobId: string, sessionId?: string): string | undefined {
	const dir = defaultLogDir();
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// No directory means no log file; returning a path here would leave a
		// dangling "Full output:" pointer to a file that can never exist.
		return undefined;
	}
	const prefix = sessionId ? `${sanitizeFileName(sessionId)}-` : "";
	return join(dir, `${prefix}${jobId}.log`);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Delete log files past the retention window, then cap the directory at
 * MAX_LOG_FILES (newest kept). Runs on session start; never throws.
 */
export function sweepLogDir(dir = defaultLogDir(), now = Date.now()): void {
	const retentionDays = parseSeconds(process.env[ENV_LOG_RETENTION_DAYS]) ?? DEFAULT_LOG_RETENTION_DAYS;
	if (retentionDays <= 0) return;
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith(".log"));
	} catch {
		return;
	}
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const survivors: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of entries) {
		const path = join(dir, name);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < cutoff) {
			try {
				unlinkSync(path);
			} catch {
				// Locked or already gone; leave it for the next sweep.
			}
		} else {
			survivors.push({ name, mtimeMs });
		}
	}
	survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const entry of survivors.slice(MAX_LOG_FILES)) {
		try {
			unlinkSync(join(dir, entry.name));
		} catch {
			// Best effort.
		}
	}
}

/** Read at most `maxBytes` from the end of a log file. */
export function readLogTail(path: string, maxBytes = 256 * 1024): string {
	if (!path) return "";
	let fd: number | undefined;
	try {
		if (lstatSync(path).isSymbolicLink()) return "";
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, start);
		let text = buffer.toString("utf8");
		// A mid-file start lands inside a line; drop the partial line so the
		// tail begins on a boundary. Only when the whole tail is one line do we
		// keep it as-is.
		if (start > 0) {
			const newline = text.indexOf("\n");
			if (newline !== -1) text = text.slice(newline + 1);
		}
		return text;
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
