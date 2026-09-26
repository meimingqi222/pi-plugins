/**
 * In-memory registry of shell jobs.
 *
 * Pure bookkeeping: no spawning, no filesystem, no `pi`. The runner attaches a
 * `kill` handle once the process exists and the tool layer decides which jobs
 * survive past their foreground phase.
 */

import { TailBuffer } from "./output.ts";
import { statusFromOutcome, type JobMode, type JobNotification, type JobStatus, type RunOutcome } from "./types.ts";

export interface JobRecord {
	schema: 1;
	id: string;
	mode: JobMode;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	logPath?: string;
}

export interface Job {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	mode: JobMode;
	status: JobStatus;
	notify: JobNotification;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	logPath?: string;
	output: TailBuffer;
	/** Kills the process tree; set by the runner once the child exists. */
	kill?: (signal?: NodeJS.Signals) => void;
	/** Restored metadata has no live process or in-memory output. */
	restored?: boolean;
}

export interface CreateJobInput {
	command: string;
	cwd: string;
	mode?: JobMode;
	logPath?: string;
	notify?: JobNotification;
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
	private readonly listeners = new Set<() => void>();
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
			notify: input.notify ?? "auto",
			startedAt: input.now ?? Date.now(),
			exitCode: null,
			logPath: input.logPath,
			output: new TailBuffer(),
		};
		this.jobs.set(id, job);
		this.reapFinished();
		this.changed();
		return job;
	}

	/** Restore a session record without treating its old process as live. */
	restore(record: JobRecord): void {
		const sequence = /^bg(\d+)$/.exec(record.id);
		if (sequence) this.next = Math.max(this.next, Number(sequence[1]) + 1);
		this.jobs.set(record.id, {
			id: record.id,
			command: "(restored job)",
			cwd: "",
			mode: record.mode,
			status: record.status === "running" ? "interrupted" : record.status,
			notify: "quiet",
			startedAt: record.startedAt,
			// A running record has no end time; inventing one would report the
			// idle gap since the crash as if the process had still been working.
			endedAt: record.endedAt,
			exitCode: record.exitCode,
			logPath: record.logPath,
			output: new TailBuffer(),
			restored: true,
		});
		this.reapFinished();
		this.changed();
	}

	/** One-shot waiters subscribe to terminal state changes without polling. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
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
		this.changed();
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
		this.changed();
	}

	clear(): void {
		this.jobs.clear();
		this.changed();
	}

	/** Drop all bookkeeping; a new session starts ids from bg001 again. */
	reset(): void {
		this.jobs.clear();
		this.next = 1;
		this.changed();
	}

	private reapFinished(): void {
		const finished = this.list().filter((job) => job.status !== "running");
		for (const job of finished.slice(0, Math.max(0, finished.length - this.retainFinished))) {
			this.jobs.delete(job.id);
		}
	}
}
