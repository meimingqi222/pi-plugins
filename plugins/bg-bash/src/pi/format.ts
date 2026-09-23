/**
 * Model- and UI-facing strings.
 *
 * Uses pi's `truncateTail` so the context cap and the "full output" pointer
 * match the built-in bash tool, and so the native shell renderer can reuse the
 * same `truncation`/`fullOutputPath` detail fields.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type BashToolDetails } from "@earendil-works/pi-coding-agent";
import type { Job } from "../core/jobs.ts";
import type { JobMode, JobStatus, RunOutcome } from "../core/types.ts";

export interface BgBashDetails extends BashToolDetails {
	jobId: string;
	command: string;
	mode: JobMode;
	status: JobStatus;
	exitCode: number | null;
	durationMs: number;
	logPath?: string;
}

export function durationMs(job: Job, now = Date.now()): number {
	return (job.endedAt ?? now) - job.startedAt;
}

/** Format milliseconds the way the built-in bash renderer does. */
export function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function truncateOutput(text: string): { text: string; truncated: boolean; notice?: string } {
	const result = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!result.truncated) return { text: result.content, truncated: false };
	const startLine = result.totalLines - result.outputLines + 1;
	const endLine = result.totalLines;
	const reason =
		result.truncatedBy === "lines"
			? `[Showing lines ${startLine}-${endLine} of ${result.totalLines}.`
			: `[Showing lines ${startLine}-${endLine} of ${result.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).`;
	return { text: result.content, truncated: true, notice: reason };
}

function appendNotice(text: string, notice: string | undefined, logPath: string | undefined): string {
	if (!notice) return text;
	const full = logPath ? ` Full output: ${logPath}]` : "]";
	return `${text}\n\n${notice}${full}`;
}

/** Body of a finished foreground command, with the log pointer when truncated. */
export function formatForegroundOutput(job: Job): string {
	const { text, notice } = truncateOutput(job.output.text());
	const body = text || "(no output)";
	return appendNotice(body, notice, job.logPath);
}

/** Attach a status line below output that already exists. */
export function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

/** The tool result the model sees when a command has just moved to the background. */
export function formatBackgroundNotice(job: Job): string {
	return [
		`Bash job ${job.id} is running in the background.`,
		`Command: ${job.command}`,
		job.logPath ? `Full output: ${job.logPath}` : undefined,
		`You will receive a follow-up with the result when it finishes. Continue with independent work, or use bg_tasks to inspect or stop it.`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

const STATUS_LABEL: Record<JobStatus, string> = {
	running: "is still running",
	exited: "finished",
	failed: "failed",
	killed: "was stopped",
	timedout: "timed out",
};

/** The follow-up message injected when a background job terminates. */
export function formatCompletionMessage(job: Job): string {
	const elapsed = formatDuration(durationMs(job));
	const exit =
		job.status === "exited"
			? `exit code 0`
			: job.exitCode === null
				? ""
				: `exit code ${job.exitCode}`;
	const header = `Background bash job ${job.id} ${STATUS_LABEL[job.status]} after ${elapsed}${exit ? ` (${exit})` : ""}.`;
	const { text, notice } = truncateOutput(job.output.text());
	return [
		header,
		`Command: ${job.command}`,
		appendNotice(text || "(no output)", notice, job.logPath),
	]
		.filter(Boolean)
		.join("\n");
}

/** `bg_tasks list` output. */
export function formatJobList(jobs: Job[]): string {
	if (jobs.length === 0) return "No bash jobs are tracked in this session.";
	const now = Date.now();
	const lines = jobs.map((job) => {
		const elapsed = formatDuration(durationMs(job, now));
		const exit = job.status === "exited" ? "" : job.exitCode === null ? "" : ` exit=${job.exitCode}`;
		const tail = job.logPath ? `  (log: ${job.logPath})` : "";
		return `- ${job.id} [${job.status}${exit}] (${job.mode}, ${elapsed}) ${job.command}${tail}`;
	});
	return `Tracked bash jobs (${jobs.length}):\n${lines.join("\n")}`;
}

/** `bg_tasks status <id>` output. */
export function formatJobStatus(job: Job): string {
	const elapsed = formatDuration(durationMs(job));
	return [
		`Job ${job.id}: ${job.status}`,
		`Mode: ${job.mode}`,
		`Command: ${job.command}`,
		`Directory: ${job.cwd}`,
		`PID: ${job.pid ?? "unknown"}`,
		`Elapsed: ${elapsed}`,
		job.exitCode === null ? undefined : `Exit code: ${job.exitCode}`,
		job.logPath ? `Log: ${job.logPath}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function detailsFor(job: Job, now = Date.now()): BgBashDetails {
	const result = truncateTail(job.output.text(), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return {
		jobId: job.id,
		command: job.command,
		mode: job.mode,
		status: job.status,
		exitCode: job.exitCode,
		durationMs: durationMs(job, now),
		logPath: job.logPath,
		fullOutputPath: result.truncated ? job.logPath : undefined,
		truncation: result.truncated ? result : undefined,
	};
}

/** Reason a command ended, for the foreground error path. */
export function outcomeReason(outcome: RunOutcome, timeoutSeconds: number | undefined): string | undefined {
	if (outcome.spawnError) return `Failed to run command: ${outcome.spawnError}`;
	if (outcome.timedOut) return `Command timed out after ${timeoutSeconds} seconds`;
	if (outcome.aborted) return "Command aborted";
	if (outcome.killed) return "Command stopped";
	if (outcome.exitCode === null) return "Command terminated without an exit code";
	if (outcome.exitCode !== 0) return `Command exited with code ${outcome.exitCode}`;
	return undefined;
}
