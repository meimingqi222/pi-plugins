import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { startCommand, waitForTermination } from "../src/runner/run.ts";

describe("startCommand", () => {
	test("captures output and a zero exit code", async () => {
		const chunks: string[] = [];
		const running = startCommand({
			command: "echo hello-bg-bash",
			cwd: process.cwd(),
			onData: (chunk) => chunks.push(chunk),
		});
		const outcome = await running.result;
		expect(outcome.exitCode).toBe(0);
		expect(outcome.spawnError).toBeUndefined();
		expect(chunks.join("")).toContain("hello-bg-bash");
	});

	test("reports a non-zero exit code", async () => {
		const running = startCommand({ command: "exit 3", cwd: process.cwd() });
		const outcome = await running.result;
		expect(outcome.exitCode).toBe(3);
		expect(outcome.timedOut).toBe(false);
	});

	test("kills the process tree when the timeout elapses", async () => {
		const running = startCommand({ command: "sleep 30", cwd: process.cwd(), timeoutMs: 300 });
		const outcome = await running.result;
		expect(outcome.timedOut).toBe(true);
		expect(outcome.exitCode).toBeNull();
	}, 15000);

	test("an explicit kill is recorded as killed, not timed out", async () => {
		const running = startCommand({ command: "sleep 30", cwd: process.cwd() });
		running.kill();
		const outcome = await running.result;
		expect(outcome.killed).toBe(true);
		expect(outcome.timedOut).toBe(false);
	}, 15000);

	test("detach stops a later abort from killing the command", async () => {
		const controller = new AbortController();
		const running = startCommand({ command: "sleep 0.4; echo survived", cwd: process.cwd(), signal: controller.signal });
		running.detach();
		controller.abort();
		const outcome = await running.result;
		expect(outcome.aborted).toBe(false);
		expect(outcome.exitCode).toBe(0);
	}, 15000);

	test("decodes a multi-byte character split across chunks", async () => {
		// '中' is E4 B8 AD in UTF-8. Writing the bytes in two flushes forces the
		// pipe to deliver them as separate chunks; a per-chunk decode would emit
		// U+FFFD for each half.
		const chunks: string[] = [];
		const running = startCommand({
			command: "printf '\\344'; sleep 0.3; printf '\\270\\255'",
			cwd: process.cwd(),
			onData: (chunk) => chunks.push(chunk),
		});
		const outcome = await running.result;
		expect(outcome.exitCode).toBe(0);
		expect(chunks.join("")).toBe("中");
	}, 15000);

	test("a descendant that never stops writing cannot outlive the grace deadline", async () => {
		// Deterministic form of the hang: the child has exited but a detached
		// descendant keeps the stdout pipe open and writes faster than the
		// quiet-grace, re-arming it forever. The deadline must still settle.
		const child = new EventEmitter() as ChildProcess;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdout = stdout;
		child.stderr = stderr;
		const result = waitForTermination(child, 300);
		const writer = setInterval(() => stdout.write("tick\n"), 30);
		try {
			child.emit("exit", 0);
			const code = await result;
			expect(code).toBe(0);
		} finally {
			clearInterval(writer);
			stdout.destroy();
			stderr.destroy();
		}
	}, 15000);

	test("a descendant holding the pipe cannot hold the run open forever", async () => {
		// The shell exits immediately but a detached child keeps writing to the
		// inherited stdout pipe. Ticks every 50ms stay under the 100ms
		// quiet-grace, so without a deadline the outcome only resolves when the
		// outer timeout kills the tree — this test asserts it resolves first.
		const running = startCommand({
			command: "bash -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo tick; sleep 0.05; done' &",
			cwd: process.cwd(),
			timeoutMs: 3000,
			exitGraceDeadlineMs: 400,
		});
		const outcome = await running.result;
		expect(outcome.timedOut).toBe(false);
		expect(outcome.exitCode).toBe(0);
	}, 15000);
});
