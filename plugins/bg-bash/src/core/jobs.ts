/**
 * In-memory registry of shell jobs.
 *
 * Pure bookkeeping: no spawning, no filesystem, no `pi`. The runner attaches a
 * `kill` handle once the process exists and the tool layer decides which jobs
 * survive past their foreground phase.
 */

import { TailBuffer } from "./output.ts";
import { statusFromOutcome, type JobMode, type JobStatus, type RunOutcome } from "./types.ts";

export interface Job {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	mode: JobMode;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	logPath?: string;
	output: TailBuffer;
	/** Kills the process tree; set by the runner once the child exists. */
	kill?: (signal?: NodeJS.Signals) => void;
}

export interface CreateJobInput {
	command: string;
	cwd: string;
	mode?: JobMode;
	logPath?: string;
	/** Injectable clock for tests. */
	now?: number;
}

export interface JobRegistryOptions {
	/** Maximum concurrently running background jobs. */
	runningLimit?: number;
	/** Finished jobs retained for inspection before the oldest are dropped. */
	retainFinished?: number;
}

export class JobRegistry {
	private readonly jobs = new Map<string, Job>();
	private next = 1;

	constructor(private readonly options: JobRegistryOptions = {}) {}

	private get runningLimit(): number {
		return this.options.runningLimit ?? 20;
	}

	private get retainFinished(): number {
		return this.options.retainFinished ?? 20;
	}

	/** Number of jobs currently running in the background. */
	backgroundCount(): number {
		let count = 0;
		for (const job of this.jobs.values()) {
			if (job.status === "running" && job.mode === "background") count += 1;
		}
		return count;
	}

	/** True when another command must not be backgrounded. */
	atCapacity(): boolean {
		return this.backgroundCount() >= this.runningLimit;
	}

	create(input: CreateJobInput): Job {
		const id = `bg${String(this.next).padStart(3, "0")}`;
		this.next += 1;
		const job: Job = {
			id,
			command: input.command,
			cwd: input.cwd,
			mode: input.mode ?? "foreground",
			status: "running",
			startedAt: input.now ?? Date.now(),
			exitCode: null,
			logPath: input.logPath,
			output: new TailBuffer(),
		};
		this.jobs.set(id, job);
		this.reapFinished();
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	list(): Job[] {
		return [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	/** Mark a job as detached from its foreground tool call. */
	promote(id: string): void {
		const job = this.jobs.get(id);
		if (job) job.mode = "background";
	}

	/** Record the terminal state of a job. */
	finish(id: string, outcome: RunOutcome): void {
		const job = this.jobs.get(id);
		if (!job) return;
		job.status = statusFromOutcome(outcome);
		job.exitCode = outcome.exitCode;
		job.endedAt = Date.now();
		job.kill = undefined;
		this.reapFinished();
	}

	kill(id: string, signal?: NodeJS.Signals): boolean {
		const job = this.jobs.get(id);
		if (!job || job.status !== "running") return false;
		job.kill?.(signal);
		return true;
	}

	killAll(): void {
		for (const job of this.jobs.values()) {
			if (job.status === "running") job.kill?.();
		}
	}

	remove(id: string): void {
		this.jobs.delete(id);
	}

	clear(): void {
		this.jobs.clear();
	}

	private reapFinished(): void {
		const finished = this.list().filter((job) => job.status !== "running");
		for (const job of finished.slice(0, Math.max(0, finished.length - this.retainFinished))) {
			this.jobs.delete(job.id);
		}
	}
}
