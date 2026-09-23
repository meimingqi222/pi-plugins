/**
 * Recognising a wait-poll, so the harness can convert it into a clean stop.
 *
 * A model that launched a background run and has nothing else to do will often
 * hedge with `bash: sleep 30`, then again, then again — polling a result that the
 * run will deliver on its own. Nothing in the tool contract prevents it, and a
 * model that does not trust "you will be woken" will keep doing it.
 *
 * The signal is the poll itself: a command whose only effect is sleeping proves
 * the model has nothing else to do, which is exactly the condition under which
 * ending the turn is correct. Blocking that command and terminating the batch
 * turns the wrong action into the right one, without touching a turn that has
 * real work left in it.
 *
 * Deliberately narrow. `sleep 5 && npm test` has a purpose, so it is not a
 * poll; only a bare sleep is.
 */

/** A bare `sleep <number>`, optionally with a trailing semicolon. */
export const PURE_WAIT_PATTERN = /^\s*sleep\s+\d+(?:\.\d+)?\s*;?\s*$/u;

export function isPureWaitCommand(command: string): boolean {
	return PURE_WAIT_PATTERN.test(command);
}

/** The message a blocked poll carries, so the reason names the run to check. */
export function pollBlockReason(runIds: string[]): string {
	const named = runIds.length > 0 ? ` (${runIds.join(", ")})` : "";
	return (
		`A workflow is still running${named}. Do not wait with sleep — you will be woken when it settles. ` +
		`Check progress with workflow_status, do independent work, or end your turn.`
	);
}
