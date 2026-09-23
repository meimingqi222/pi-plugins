import { describe, expect, test } from "bun:test";
import { startCommand } from "../src/runner/run.ts";

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
});
