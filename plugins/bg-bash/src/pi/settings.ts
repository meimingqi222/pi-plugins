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

/**
 * Ceiling on log files kept when retention cannot bound them.
 *
 * Only reached when retention is long enough that a directory can hold more
 * than this many *unexpired* logs, which is the one case where the age rule
 * alone leaves the directory unbounded. It never deletes an unexpired log to
 * satisfy the number — see `sweepLogDir`.
 */
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
 * Delete log files past the retention window. Runs on session start; never throws.
 *
 * The count cap is deliberately *not* a second deletion rule over the survivors.
 * It used to be: after the age sweep, anything past MAX_LOG_FILES was unlinked
 * newest-kept — and the survivors are by definition unexpired, so the cap could
 * only ever delete a live log. A second pi process holding two hundred older
 * logs made a new session's sweep take the oldest, and a *quiet* job — running,
 * but not writing, so its mtime looked old — lost the very file its
 * "Full output:" notice still pointed at, and the model then read a truncated
 * log and reported a build as passing.
 *
 * So the cap now only trims when the directory holds more than MAX_LOG_FILES
 * files that are all still inside retention, which is the single case the age
 * rule cannot bound. Even then it takes the oldest, and a job writing to its log
 * moves that file to the front of the queue.
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
	// Retention could not bound the directory: everything in it is unexpired and
	// there is more of it than the ceiling. Trim the oldest, which a job writing
	// to its log escapes by definition — output moves its mtime to the front.
	if (survivors.length > MAX_LOG_FILES) {
		survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const entry of survivors.slice(0, survivors.length - MAX_LOG_FILES)) {
			try {
				unlinkSync(join(dir, entry.name));
			} catch {
				// Best effort.
			}
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
