/**
 * Log-file lifecycle: naming, isolation, retention, and failure modes.
 *
 * The registry restarts job ids at bg001 in every process, so the log path
 * must carry the session id — otherwise a new session appends to a previous
 * session's file and two concurrent pi processes interleave into it. The
 * startup sweep is what keeps the directory bounded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateLogPath, readLogTail, sweepLogDir } from "../src/pi/settings.ts";
import { startCommand } from "../src/runner/run.ts";

let logDir: string;
let previousLogDir: string | undefined;
let previousRetention: string | undefined;

beforeEach(() => {
	previousLogDir = process.env.PI_BG_BASH_LOG_DIR;
	previousRetention = process.env.PI_BG_BASH_LOG_RETENTION_DAYS;
	logDir = mkdtempSync(join(tmpdir(), "pi-bg-bash-logs-"));
	process.env.PI_BG_BASH_LOG_DIR = logDir;
});

afterEach(() => {
	if (previousLogDir === undefined) delete process.env.PI_BG_BASH_LOG_DIR;
	else process.env.PI_BG_BASH_LOG_DIR = previousLogDir;
	if (previousRetention === undefined) delete process.env.PI_BG_BASH_LOG_RETENTION_DAYS;
	else process.env.PI_BG_BASH_LOG_RETENTION_DAYS = previousRetention;
	rmSync(logDir, { recursive: true, force: true });
});

async function runToLog(command: string, logPath: string, logHeader?: string): Promise<void> {
	const running = startCommand({ command, cwd: process.cwd(), logPath, logHeader });
	await running.result;
	// The stream flushes asynchronously after the outcome resolves.
	await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("allocateLogPath", () => {
	test("prefixes the file name with a sanitized session id", () => {
		const path = allocateLogPath("bg001", "sess/abc:1");
		expect(path).toBe(join(logDir, "sess_abc_1-bg001.log"));
	});

	test("falls back to the bare job id without a session", () => {
		expect(allocateLogPath("bg001")).toBe(join(logDir, "bg001.log"));
	});

	test("returns undefined when the directory cannot be created", () => {
		// A file where the directory's parent should be makes mkdir fail.
		const blocker = join(logDir, "blocker");
		writeFileSync(blocker, "x");
		process.env.PI_BG_BASH_LOG_DIR = join(blocker, "logs");
		expect(allocateLogPath("bg001", "s")).toBeUndefined();
	});
});

describe("log files", () => {
	test("two sessions reusing the same job id write separate files", async () => {
		await runToLog("echo MARK-AAA", allocateLogPath("bg001", "session-a")!);
		await runToLog("echo MARK-BBB", allocateLogPath("bg001", "session-b")!);

		const files = readdirSync(logDir).sort();
		expect(files).toEqual(["session-a-bg001.log", "session-b-bg001.log"]);
		expect(readFileSync(join(logDir, files[0]), "utf8")).toContain("MARK-AAA");
		expect(readFileSync(join(logDir, files[0]), "utf8")).not.toContain("MARK-BBB");
		expect(readFileSync(join(logDir, files[1]), "utf8")).toContain("MARK-BBB");
	});

	test("a reused path is truncated, not appended", async () => {
		const path = allocateLogPath("bg001", "session-a")!;
		await runToLog("echo FIRST", path);
		await runToLog("echo SECOND", path);
		const text = readFileSync(path, "utf8");
		expect(text).toContain("SECOND");
		expect(text).not.toContain("FIRST");
	});

	test("writes the provenance header before any command output", async () => {
		const path = allocateLogPath("bg001", "session-a")!;
		await runToLog("echo body", path, "# job bg001 session session-a\n# command echo body\n");
		const text = readFileSync(path, "utf8");
		expect(text.startsWith("# job bg001 session session-a")).toBe(true);
		expect(text).toContain("body");
	});

	test("a log path that cannot be opened does not fail the command", async () => {
		// A directory used as the log path makes the write stream fail
		// asynchronously; the run must still complete with its output.
		const badPath = join(logDir, "a-directory");
		mkdirSync(badPath);
		const running = startCommand({ command: "echo still-ran", cwd: process.cwd(), logPath: badPath });
		const outcome = await running.result;
		expect(outcome.exitCode).toBe(0);
	});
});

describe("readLogTail", () => {
	test("a mid-file start drops the partial first line", () => {
		const path = join(logDir, "tail.log");
		writeFileSync(path, "first line\nsecond line\nthird line\n");
		// 20 bytes lands inside "second line"; the tail must start on a boundary.
		expect(readLogTail(path, 20)).toBe("third line\n");
	});

	test("returns everything when the file fits", () => {
		const path = join(logDir, "small.log");
		writeFileSync(path, "only line\n");
		expect(readLogTail(path, 20)).toBe("only line\n");
	});

	test("keeps a single oversized line as-is", () => {
		const path = join(logDir, "oneline.log");
		writeFileSync(path, "abcdefghijklmnopqrstuvwxyz");
		expect(readLogTail(path, 10)).toBe("qrstuvwxyz");
	});
});

describe("sweepLogDir", () => {
	function makeLog(name: string, ageDays: number): string {
		const path = join(logDir, name);
		writeFileSync(path, name);
		const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
		utimesSync(path, mtime, mtime);
		return path;
	}

	test("deletes logs older than the retention window", () => {
		makeLog("old-bg001.log", 30);
		makeLog("fresh-bg002.log", 1);
		sweepLogDir(logDir);
		expect(readdirSync(logDir).sort()).toEqual(["fresh-bg002.log"]);
	});

	test("keeps only the newest files when the count cap is exceeded", () => {
		for (let i = 0; i < 210; i += 1) {
			// Oldest first: bg000 is the oldest file.
			makeLog(`s-bg${String(i).padStart(3, "0")}.log`, (210 - i) / 1000);
		}
		sweepLogDir(logDir);
		const remaining = readdirSync(logDir);
		expect(remaining).toHaveLength(200);
		expect(remaining).not.toContain("s-bg000.log");
		expect(remaining).toContain("s-bg209.log");
	});

	test("a retention of zero disables the sweep", () => {
		process.env.PI_BG_BASH_LOG_RETENTION_DAYS = "0";
		makeLog("old-bg001.log", 365);
		sweepLogDir(logDir);
		expect(readdirSync(logDir)).toEqual(["old-bg001.log"]);
	});

	test("ignores non-log files and a missing directory", () => {
		writeFileSync(join(logDir, "keep.txt"), "x");
		makeLog("old-bg001.log", 30);
		sweepLogDir(logDir);
		expect(readdirSync(logDir).sort()).toEqual(["keep.txt"]);
		expect(() => sweepLogDir(join(logDir, "does-not-exist"))).not.toThrow();
	});
});
