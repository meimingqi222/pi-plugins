/**
 * Incremental `bg_tasks output`.
 *
 * `log` always returns a tail; `output` is the polling-friendly action: each
 * call returns only the bytes appended since the previous call for that job,
 * capped like every other surface.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRegistry } from "../src/core/jobs.ts";
import { createBgTasksTool } from "../src/pi/tasks-tool.ts";
import type { Runtime } from "../src/pi/runtime.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(registry: JobRegistry): Runtime {
	return {
		pi: {} as Runtime["pi"],
		registry,
		autoBackgroundSeconds: () => 30,
		backgroundLimit: () => 20,
		captureOrigin: () => () => true,
		started: () => {},
		deliver: () => {},
		consumeResult: () => {},
	};
}

function textOf(result: any): string {
	return result.content.map((part: any) => part.text ?? "").join("\n");
}

/** A job whose log file already holds the runner's two-line header. */
function jobWithLog(registry: JobRegistry, initial: string): { id: string; logPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "bg-tasks-"));
	dirs.push(dir);
	const logPath = join(dir, "job.log");
	writeFileSync(logPath, `# job bg-test\n# command probe\n${initial}`);
	const job = registry.create({ command: "probe", cwd: "/", mode: "background", logPath });
	return { id: job.id, logPath };
}

function outputCall(tool: any, id: string, n: number) {
	return tool.execute(`out${n}`, { action: "output", id }, undefined, undefined, {});
}

describe("bg_tasks output", () => {
	test("successive calls return disjoint chunks, starting after the log header", async () => {
		const registry = new JobRegistry();
		const tool = createBgTasksTool(runtimeWith(registry));
		const { id, logPath } = jobWithLog(registry, "chunk-one\n");

		const first = textOf(await outputCall(tool, id, 1));
		expect(first).toContain("chunk-one");
		expect(first).not.toContain("# job");
		expect(first).not.toContain("# command");

		appendFileSync(logPath, "chunk-two\n");
		const second = textOf(await outputCall(tool, id, 2));
		expect(second).toContain("chunk-two");
		expect(second).not.toContain("chunk-one");

		const third = textOf(await outputCall(tool, id, 3));
		expect(third).toContain("no new output");
	});

	test("data beyond the cap returns a tail with an earlier-bytes marker and the cursor reaches the end", async () => {
		const registry = new JobRegistry();
		const tool = createBgTasksTool(runtimeWith(registry));
		const lines = `${"x".repeat(100)}\n`;
		const { id, logPath } = jobWithLog(registry, lines.repeat(1000)); // ~101KB > 50KB cap

		const first = textOf(await outputCall(tool, id, 1));
		expect(first).toMatch(/\[\d+ earlier bytes skipped\]/);
		expect(first).toContain(`${id}: running`);

		appendFileSync(logPath, "after-cap\n");
		const second = textOf(await outputCall(tool, id, 2));
		expect(second).toContain("after-cap");
		expect(second).not.toMatch(/earlier bytes skipped/);
	});

	test("a job without a readable log reports unavailable output", async () => {
		const registry = new JobRegistry();
		const tool = createBgTasksTool(runtimeWith(registry));
		const job = registry.create({ command: "no-log", cwd: "/", mode: "background" });

		const text = textOf(await outputCall(tool, job.id, 1));
		expect(text).toContain("output unavailable");
	});
});
