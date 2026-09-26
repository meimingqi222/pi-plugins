/**
 * Model- and UI-facing strings.
 *
 * Uses pi's `truncateTail` so the context cap and the "full output" pointer
 * match the built-in bash tool, and so the native shell renderer can reuse the
 * same `truncation`/`fullOutputPath` detail fields.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type BashToolDetails, type TruncationResult } from "@earendil-works/pi-coding-agent";
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

/**
 * Elapsed time for display. A restored interrupted job has no honest end, so
 * the duration is reported as unknown instead of drifting with `now`.
 */
export function formatElapsed(job: Pick<Job, "startedAt" | "endedAt" | "status">, now = Date.now()): string {
	if (job.endedAt !== undefined) return formatDuration(Math.max(0, job.endedAt - job.startedAt));
	if (job.status === "running") return formatDuration(Math.max(0, now - job.startedAt));
	return "unknown";
}

/** End timestamp for display; never claim a still-running job has ended. */
export function formatEndedAt(job: Job): string {
	if (job.endedAt !== undefined) return new Date(job.endedAt).toISOString();
	if (job.status === "running") return "still running";
	return "unknown";
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

export function truncateOutput(text: string): {
	text: string;
	truncated: boolean;
	result: TruncationResult;
} {
	const result = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return { text: result.content, truncated: result.truncated, result };
}

/**
 * The bracketed pointer appended under truncated output.
 *
 * One builder for both readers: the model gets it appended to its result, and
 * the TUI renderer matches the same string to lift the footer out of the body
 * and show it as a warning rather than as a line of output.
 */
export function truncationNotice(result: TruncationResult, logPath: string | undefined): string {
	const startLine = result.totalLines - result.outputLines + 1;
	const reason =
		result.truncatedBy === "lines"
			? `Showing lines ${startLine}-${result.totalLines} of ${result.totalLines}.`
			: `Showing lines ${startLine}-${result.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).`;
	return logPath ? `[${reason} Full output: ${logPath}]` : `[${reason}]`;
}

function appendNotice(text: string, notice: string | undefined): string {
	return notice ? `${text}\n\n${notice}` : text;
}

/** Body of a finished foreground command, with the log pointer when truncated. */
export function formatForegroundOutput(job: Job): string {
	const { text, result } = truncateOutput(job.output.text());
	const notice = result.truncated ? truncationNotice(result, job.logPath) : undefined;
	return appendNotice(text || "(no output)", notice);
}

/** Attach a status line below output that already exists. */
export function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

/** The tool result the model sees when a command has just moved to the background. */
export function formatBackgroundNotice(job: Job): string {
	const delivery = job.notify === "always"
		? "A short completion notification will wake you. Read the result with bg_tasks result or log before summarizing."
		: job.notify === "quiet"
			? "No completion notification will be sent. Use bg_tasks result or wait when its outcome matters."
			: "Success is recorded without waking you; failures and timeouts send a short notification. Use bg_tasks result or wait before claiming this command succeeded.";
	return [
		`Bash job ${job.id} is running in the background.`,
		`Command: ${job.command}`,
		job.logPath ? `Full output: ${job.logPath}` : undefined,
		delivery,
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
	interrupted: "was interrupted",
};

/** Small model notification; stdout remains in the job log. */
export function formatCompletionNotice(jobs: Job[]): string {
	return [
		`Background bash completion${jobs.length === 1 ? "" : "s"}:`,
		...jobs.map((job) => `- ${job.id}: ${job.status}${job.exitCode === null ? "" : ` (exit ${job.exitCode})`}, ${formatDuration(durationMs(job))}`),
		"Use bg_tasks result <id> for a bounded preview or bg_tasks log <id> for more output. Do not infer the command's output from this notification.",
	].join("\n");
}

/** The status sentence a completion message opens with. */
export function completionHeader(
	id: string,
	status: JobStatus,
	exitCode: number | null,
	elapsedMs: number,
): string {
	const exit =
		status === "exited" ? `exit code 0` : exitCode === null ? "" : `exit code ${exitCode}`;
	return `Background bash job ${id} ${STATUS_LABEL[status]} after ${formatDuration(elapsedMs)}${exit ? ` (${exit})` : ""}.`;
}

/** A completion message split into the pieces the model reads and the TUI draws. */
export interface CompletionParts {
	header: string;
	commandLine: string;
	output: string;
	notice?: string;
}

export function completionParts(job: Job): CompletionParts {
	const { text, result } = truncateOutput(job.output.text());
	return {
		header: completionHeader(job.id, job.status, job.exitCode, durationMs(job)),
		commandLine: `Command: ${job.command}`,
		output: text || "(no output)",
		notice: result.truncated ? truncationNotice(result, job.logPath) : undefined,
	};
}

/** The follow-up message injected when a background job terminates. */
export function formatCompletionMessage(job: Job): string {
	const parts = completionParts(job);
	return [parts.header, parts.commandLine, appendNotice(parts.output, parts.notice)].join("\n");
}

/**
 * Recover a completion message's parts for the TUI renderer.
 *
 * The renderer only has the stored message, and the output tail lives in the
 * content rather than in `details`. The header and the footer are therefore
 * removed by exact match against the strings `formatCompletionMessage` wrote;
 * a message this version did not write falls back to showing its whole content
 * rather than being mis-split.
 */
export function splitCompletionContent(
	content: string,
	details: BgBashDetails | undefined,
): { output: string; notice?: string } {
	if (!details) return { output: content };
	const header = completionHeader(details.jobId, details.status, details.exitCode, details.durationMs);
	const prefix = `${header}\nCommand: ${details.command}\n`;
	let output = content.startsWith(prefix) ? content.slice(prefix.length) : content;
	const notice =
		details.truncation?.truncated === true
			? truncationNotice(details.truncation, details.fullOutputPath ?? details.logPath)
			: undefined;
	if (notice && output.endsWith(notice)) output = output.slice(0, -notice.length).trimEnd();
	return { output, notice };
}

/** `bg_tasks list` output. */
export function formatJobList(jobs: Job[]): string {
	if (jobs.length === 0) return "No bash jobs are tracked in this session.";
	const now = Date.now();
	const lines = jobs.map((job) => {
		const elapsed = formatElapsed(job, now);
		const exit = job.status === "exited" ? "" : job.exitCode === null ? "" : ` exit=${job.exitCode}`;
		const tail = job.logPath ? `  (log: ${job.logPath})` : "";
		return `- ${job.id} [${job.status}${exit}] (${job.mode}, ${elapsed}) ${job.command}${tail}`;
	});
	return `Tracked bash jobs (${jobs.length}):\n${lines.join("\n")}`;
}

/** `bg_tasks status <id>` output. */
export function formatJobStatus(job: Job): string {
	const elapsed = formatElapsed(job);
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

export function detailsFor(
	job: Job,
	now = Date.now(),
	truncation?: ReturnType<typeof truncateTail>,
): BgBashDetails {
	const result = truncation ?? truncateTail(job.output.text(), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
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
