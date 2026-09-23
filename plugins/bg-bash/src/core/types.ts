/**
 * Shared job vocabulary.
 *
 * Deliberately free of `pi` and `node:child_process` imports so the state
 * machine and the formatting rules can be exercised without spawning anything.
 */

/** Lifecycle of one shell invocation tracked by the registry. */
export type JobStatus = "running" | "exited" | "failed" | "killed" | "timedout";

/** How the command got registered. */
export type JobMode = "foreground" | "background";

/** Result of a finished command, independent of how it was started. */
export interface RunOutcome {
	/** Process exit code, or null when the process was signalled or never started. */
	exitCode: number | null;
	/** True when our own timeout timer killed the process. */
	timedOut: boolean;
	/** True when the caller's abort signal killed the process. */
	aborted: boolean;
	/** True when something called `kill()` explicitly (for example `bg_tasks kill`). */
	killed: boolean;
	/** Spawn/IO error message when the process could not be run or waited on. */
	spawnError?: string;
}

/** Handle to a spawned command: observe it, kill it, or stop honouring abort. */
export interface RunningCommand {
	/** Child process id, available immediately after spawn. */
	readonly pid: number | undefined;
	/** Resolves exactly once when the process has terminated and output drained. */
	readonly result: Promise<RunOutcome>;
	/** Kill the process tree. */
	kill(signal?: NodeJS.Signals): void;
	/** Stop forwarding the abort signal to this command (used when it backgrounds). */
	detach(): void;
}

/** Map a finished run onto the job status the model will read. */
export function statusFromOutcome(outcome: RunOutcome): JobStatus {
	if (outcome.spawnError) return "failed";
	if (outcome.timedOut) return "timedout";
	if (outcome.aborted || outcome.killed) return "killed";
	return outcome.exitCode === 0 ? "exited" : "failed";
}
