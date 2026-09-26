import { describe, expect, test } from "bun:test";
import { JobRegistry, type Job } from "../src/core/jobs.ts";
import { formatJobsListing, jobWorkItem, runningWorkItems } from "../src/pi/surface.ts";

const NOW = 1_700_000_000_000;

function job(partial: Partial<Job> = {}): Job {
	return {
		id: partial.id ?? "bg001",
		command: partial.command ?? "npm run build",
		cwd: partial.cwd ?? "/work",
		...(partial.pid !== undefined ? { pid: partial.pid } : {}),
		mode: partial.mode ?? "background",
		status: partial.status ?? "running",
		notify: partial.notify ?? "auto",
		startedAt: partial.startedAt ?? NOW - 5_000,
		...(partial.endedAt !== undefined ? { endedAt: partial.endedAt } : {}),
		exitCode: partial.exitCode !== undefined ? partial.exitCode : null,
		...(partial.logPath !== undefined ? { logPath: partial.logPath } : {}),
		output: partial.output ?? ({ text: () => "" } as Job["output"]),
		restored: partial.restored,
	} as Job;
}

describe("jobWorkItem", () => {
	test("maps every job status onto the shared work vocabulary", () => {
		expect(jobWorkItem(job({ status: "running" }), NOW).state).toBe("running");
		expect(jobWorkItem(job({ status: "exited" }), NOW).state).toBe("succeeded");
		expect(jobWorkItem(job({ status: "failed" }), NOW).state).toBe("failed");
		expect(jobWorkItem(job({ status: "timedout" }), NOW).state).toBe("failed");
		expect(jobWorkItem(job({ status: "killed" }), NOW).state).toBe("stopped");
		expect(jobWorkItem(job({ status: "interrupted" }), NOW).state).toBe("stopped");
	});

	test("kind is the mode, label is the command, metric is the pid while running", () => {
		const item = jobWorkItem(job({ command: "npm test", mode: "background", pid: 42_424 }), NOW);
		expect(item.kind).toBe("background");
		expect(item.label).toBe("npm test");
		expect(item.metric).toBe("pid 42424");
		expect(jobWorkItem(job({ status: "exited", pid: 1 }), NOW).metric).toBeUndefined();
	});
});

describe("runningWorkItems", () => {
	test("lists only live background jobs — foreground and settled stay out", () => {
		const jobs = [
			job({ id: "a", mode: "background", status: "running" }),
			job({ id: "b", mode: "foreground", status: "running" }),
			job({ id: "c", mode: "background", status: "exited", endedAt: NOW }),
		];
		expect(runningWorkItems(jobs, NOW).map((item) => item.id)).toEqual(["a"]);
	});
});

describe("formatJobsListing", () => {
	test("names id, mode, status, elapsed and the command", () => {
		const text = formatJobsListing([
			job({ id: "bg001", command: "sleep 60", status: "running", startedAt: NOW - 65_000, pid: 9 }),
			job({ id: "bg002", command: "build", status: "failed", startedAt: NOW - 90_000, endedAt: NOW - 30_000, exitCode: 1 }),
		], NOW);
		expect(text).toContain("bg001");
		expect(text).toContain("background");
		expect(text).toContain("running");
		expect(text).toContain("sleep 60");
		expect(text).toContain("bg002");
		expect(text).toContain("failed");
	});

	test("an empty registry reads as nothing to show", () => {
		expect(formatJobsListing([], NOW)).toContain("No background jobs");
	});
});

describe("JobRegistry change notification", () => {
	test("promote fires onChange: a detaching job becomes visible background work", () => {
		const registry = new JobRegistry();
		let fired = 0;
		registry.onChange(() => { fired += 1; });
		const created = registry.create({ command: "npm run build", cwd: "/work" });
		// create() already fired once.
		expect(fired).toBe(1);
		registry.promote(created.id);
		expect(fired).toBe(2);
	});
});
