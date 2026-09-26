/**
 * Recognising a wait-poll so the model can use the bounded wait tool instead.
 *
 * A model that launched a background job and has nothing else to do will hedge
 * with `bash: sleep 30`, then again. A default successful job does not wake
 * the model, so a blocked poll must leave the turn alive for `bg_tasks wait`.
 *
 * The signal is the poll itself: a command whose only effect is sleeping proves
 * the model has nothing else to do. `sleep 5 && npm test` has a purpose and is
 * not a poll.
 *
 * Workflow has a similar parser but still terminates a poll because its
 * completion always wakes the agent. The policies intentionally differ.
 */

/**
 * A bare `sleep <number>` — GNU suffixes (`30s`, `1m`) and a trailing comment
 * or semicolon still count as a poll; `sleep 5 && npm test` does not. In
 * PowerShell `sleep` aliases `Start-Sleep`, so one pattern covers both tools.
 */
export const PURE_WAIT_PATTERN = /^\s*(?:sleep|start-sleep)\s+\d+(?:\.\d+)?[smhd]?\s*;?\s*(?:#.*)?$/iu;

export function isPureWaitCommand(command: string): boolean {
	return PURE_WAIT_PATTERN.test(command);
}

/** The message a blocked poll carries, so the reason names the job to check. */
export function pollBlockReason(jobIds: string[]): string {
	const named = jobIds.length > 0 ? ` (${jobIds.join(", ")})` : "";
	return (
		`A background bash job is still running${named}. Do not wait with sleep. ` +
		`Use bg_tasks wait for a bounded wait, inspect it with bg_tasks status/log, or continue independent work.`
	);
}
