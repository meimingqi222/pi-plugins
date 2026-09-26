import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BG_BASH_COMPLETION_ENTRY, BG_BASH_STATE_ENTRY, recordsFromBranch } from "../src/pi/records.ts";

let oldDir: string | undefined;
let logDir: string;

beforeEach(() => {
	oldDir = process.env.PI_BG_BASH_LOG_DIR;
	logDir = mkdtempSync(join(tmpdir(), "pi-bg-records-"));
	process.env.PI_BG_BASH_LOG_DIR = logDir;
});

afterEach(() => {
	if (oldDir === undefined) delete process.env.PI_BG_BASH_LOG_DIR;
	else process.env.PI_BG_BASH_LOG_DIR = oldDir;
	rmSync(logDir, { recursive: true, force: true });
});

test("session record replay keeps the latest state without trusting an outside log pointer", () => {
	const base = { schema: 1, id: "bg001", mode: "background", startedAt: 1, exitCode: null };
	const records = recordsFromBranch([
		{ type: "custom", customType: BG_BASH_STATE_ENTRY, data: { ...base, status: "running", logPath: join(logDir, "s-bg001.log") } },
		{ type: "custom", customType: BG_BASH_COMPLETION_ENTRY, data: { ...base, status: "exited", endedAt: 2, exitCode: 0, logPath: "/outside/private.log" } },
		{ type: "custom", customType: BG_BASH_COMPLETION_ENTRY, data: { ...base, id: "../../bad", status: "failed" } },
	]);
	expect(records).toHaveLength(1);
	expect(records[0].status).toBe("exited");
	expect(records[0].logPath).toBeUndefined();
});
