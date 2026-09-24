/**
 * Recognising a wait-poll, so the harness can turn it into a clean stop.
 *
 * A model that launched a background job and has nothing else to do will hedge
 * with `bash: sleep 30`, then again — polling a result the job will deliver on
 * its own. Blocking that command and terminating the batch ends the turn, and
 * the job's completion wakes the model.
 *
 * The signal is the poll itself: a command whose only effect is sleeping proves
 * the model has nothing else to do, which is exactly when ending the turn is
 * correct. `sleep 5 && npm test` has a purpose and is not a poll.
 *
 * This is deliberately a copy of the same rule in `pi-workflow`: the two plugins
 * install independently and neither may depend on the other, and the rule is a
 * few stable lines rather than shared machinery. If you change it here, change
 * `plugins/workflow/src/pi/poll-guard.ts` too.
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
		`A background bash job is still running${named}. Do not wait with sleep — you will be woken when it finishes. ` +
		`Check it with bg_tasks, do independent work, or end your turn.`
	);
}
