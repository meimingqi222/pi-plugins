/**
 * bg-bash's poll policy.
 *
 * The parser lives in `pi-run-core`. The policy differs from workflow: a default
 * successful job does not wake the model, so a blocked poll must leave the turn
 * alive for `bg_tasks wait`.
 */

export { PURE_WAIT_PATTERN, isPureWaitCommand } from "pi-run-core";

/** The message a blocked poll carries, so the reason names the job to check. */
export function pollBlockReason(jobIds: string[]): string {
	const named = jobIds.length > 0 ? ` (${jobIds.join(", ")})` : "";
	return (
		`A background bash job is still running${named}. Do not wait with sleep. ` +
		`Use bg_tasks wait for a bounded wait, inspect it with bg_tasks status/log, or continue independent work.`
	);
}
