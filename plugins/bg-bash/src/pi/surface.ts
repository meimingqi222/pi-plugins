/**
 * `surface.ts` — the user-facing liveness surface for background bash jobs.
 *
 * `pi-bg-bash` had notifications at settlement and nothing while a job ran:
 * the same blind spot `pi-subagent` fixed with its fleet widget. Both plugins
 * draw through `pi-run-core`'s shared `work-surface` renderer, so "what is
 * still running" reads the same regardless of which plugin produced the work.
 *
 * The mapping is honest about what a job knows: a bash job has no activity
 * events, so it can never be `stalled`, and `timedout` reads as `failed`
 * rather than a kinder label — a process we killed for overrunning its budget
 * did not succeed.
 */

import { fitWorkText, formatWorkElapsed, type WorkItem, type WorkState } from "pi-run-core";
import type { Job } from "../core/jobs.ts";
import { formatDuration } from "./format.ts";

const STATUS_TO_WORK: Record<Job["status"], WorkState> = {
	running: "running",
	exited: "succeeded",
	failed: "failed",
	timedout: "failed",
	killed: "stopped",
	interrupted: "stopped",
};

/** A job as shared work: kind = mode, label = the command, metric = pid while it has one. */
export function jobWorkItem(job: Job, now: number): WorkItem {
	return {
		id: job.id,
		kind: job.mode,
		label: job.command,
		state: STATUS_TO_WORK[job.status],
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		metric: job.status === "running" && job.pid !== undefined ? `pid ${job.pid}` : undefined,
	};
}

/** The widget lists live background jobs only: foreground jobs already have a live tool card. */
export function runningWorkItems(jobs: Job[], now: number): WorkItem[] {
	return jobs.filter((job) => job.mode === "background" && job.status === "running").map((job) => jobWorkItem(job, now));
}

/** `/bg` (no args): every job this session knows, newest layout mirroring `bg_tasks list`. */
export function formatJobsListing(jobs: Job[], now: number): string {
	const listed = jobs.filter((job) => job.mode === "background" || job.status === "running");
	if (listed.length === 0) return "No background jobs in this session.";
	return listed
		.map((job) => {
			const elapsed = job.endedAt !== undefined ? formatDuration(Math.max(0, job.endedAt - job.startedAt)) : formatWorkElapsed(job, now);
			const tail = [`${job.mode}`, job.status, elapsed, job.pid !== undefined && job.status === "running" ? `pid ${job.pid}` : "", job.logPath ? job.logPath : ""]
				.filter(Boolean)
				.join(" · ");
			return `- ${job.id} · ${tail}\n  ${fitWorkText(job.command, 76)}`;
		})
		.join("\n");
}
