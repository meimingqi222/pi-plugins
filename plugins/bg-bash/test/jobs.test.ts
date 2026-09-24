import { describe, expect, test } from "bun:test";
import { JobRegistry } from "../src/core/jobs.ts";
import { statusFromOutcome, type RunOutcome } from "../src/core/types.ts";

const outcome = (patch: Partial<RunOutcome> = {}): RunOutcome => ({
	exitCode: 0,
	timedOut: false,
	aborted: false,
	killed: false,
	...patch,
});

describe("statusFromOutcome", () => {
	test("maps every terminal outcome", () => {
		expect(statusFromOutcome(outcome())).toBe("exited");
		expect(statusFromOutcome(outcome({ exitCode: 1 }))).toBe("failed");
		expect(statusFromOutcome(outcome({ exitCode: null }))).toBe("failed");
		expect(statusFromOutcome(outcome({ timedOut: true, exitCode: null }))).toBe("timedout");
		expect(statusFromOutcome(outcome({ aborted: true, exitCode: null }))).toBe("killed");
		expect(statusFromOutcome(outcome({ killed: true, exitCode: null }))).toBe("killed");
		expect(statusFromOutcome(outcome({ spawnError: "ENOENT", exitCode: null }))).toBe("failed");
	});

	test("timeout wins over the kill flag it sets internally", () => {
		expect(statusFromOutcome(outcome({ timedOut: true, killed: true, exitCode: null }))).toBe("timedout");
	});
});

describe("JobRegistry", () => {
	test("assigns zero-padded sequential ids", () => {
		const registry = new JobRegistry();
		expect(registry.create({ command: "a", cwd: "/" }).id).toBe("bg001");
		expect(registry.create({ command: "b", cwd: "/" }).id).toBe("bg002");
	});

	test("counts only running background jobs toward capacity", () => {
		const registry = new JobRegistry({ runningLimit: 2 });
		const foreground = registry.create({ command: "f", cwd: "/" });
		const first = registry.create({ command: "b1", cwd: "/", mode: "background" });
		expect(registry.atCapacity()).toBe(false);
		expect(registry.backgroundCount()).toBe(1);
		registry.finish(first.id, outcome({ exitCode: null, killed: true }));
		expect(registry.backgroundCount()).toBe(0);
		// A finished background job frees its slot, and foreground jobs never took one.
		expect(foreground.status).toBe("running");
		expect(registry.atCapacity()).toBe(false);
	});

	test("promote flips a foreground job to background", () => {
		const registry = new JobRegistry();
		const job = registry.create({ command: "x", cwd: "/" });
		expect(job.mode).toBe("foreground");
		registry.promote(job.id);
		expect(registry.get(job.id)?.mode).toBe("background");
	});

	test("kill only acts on running jobs and hands the signal to the handle", () => {
		const registry = new JobRegistry();
		const job = registry.create({ command: "x", cwd: "/" });
		const signals: Array<string | undefined> = [];
		job.kill = (signal) => signals.push(signal);
		expect(registry.kill(job.id, "SIGTERM")).toBe(true);
		expect(signals).toEqual(["SIGTERM"]);
		registry.finish(job.id, outcome({ killed: true, exitCode: null }));
		expect(registry.kill(job.id)).toBe(false);
		expect(registry.get(job.id)?.kill).toBeUndefined();
	});

	test("retains only the most recent finished jobs", () => {
		const registry = new JobRegistry({ retainFinished: 2 });
		for (let i = 0; i < 5; i += 1) {
			const job = registry.create({ command: `c${i}`, cwd: "/", now: i });
			registry.finish(job.id, outcome());
		}
		const ids = registry.list().map((job) => job.id);
		expect(ids).toEqual(["bg004", "bg005"]);
	});

	test("reset drops every job and restarts the id counter", () => {
		const registry = new JobRegistry();
		registry.create({ command: "a", cwd: "/" });
		registry.create({ command: "b", cwd: "/" });
		registry.reset();
		expect(registry.list()).toHaveLength(0);
		expect(registry.create({ command: "c", cwd: "/" }).id).toBe("bg001");
	});

	test("killAll signals every running job", () => {
		const registry = new JobRegistry();
		let killed = 0;
		for (const command of ["a", "b"]) {
			const job = registry.create({ command, cwd: "/" });
			job.kill = () => {
				killed += 1;
			};
		}
		registry.create({ command: "done", cwd: "/" });
		registry.finish("bg003", outcome());
		registry.killAll();
		expect(killed).toBe(2);
	});
});
