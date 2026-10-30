/**
 * Workflow's poll policy.
 *
 * The parser and tool-name gate live in `pi-run-core` so workflow and bg-bash
 * cannot drift on what counts as a poll. The policy stays here because their
 * delivery contracts differ: a workflow completion always wakes the model, so a
 * blocked poll terminates the batch and ends the turn.
 */

export { PURE_WAIT_PATTERN, isPureWaitCommand } from "@meimingqi222/pi-run-core";

/** The message a blocked poll carries, so the reason names the run to check. */
export function pollBlockReason(runIds: string[]): string {
	const named = runIds.length > 0 ? ` (${runIds.join(", ")})` : "";
	return (
		`A workflow is still running${named}. Do not wait with sleep — you will be woken when it settles. ` +
		`Check progress with workflow_status, do independent work, or end your turn.`
	);
}
