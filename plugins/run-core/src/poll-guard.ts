/**
 * Recognising a wait-poll, shared by the plugins that own background work.
 *
 * A model that launched a background run and has nothing else to do will often
 * hedge with `bash: sleep 30`, then again, then again — polling a result the
 * run will deliver on its own. Nothing in the tool contract prevents it, and a
 * model that does not trust "you will be woken" will keep doing it.
 *
 * The signal is the poll itself: a command whose only effect is sleeping proves
 * the model has nothing else to do. Deliberately narrow — `sleep 5 && npm test`
 * has a purpose, so it is not a poll.
 *
 * The parser and the tool-name gate live here so two plugins cannot drift on
 * what counts as a poll. The *policy* stays with the caller: workflow
 * terminates the batch because its completion always wakes the model, while
 * bg-bash leaves the turn alive because a default successful job does not.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A bare `sleep <number>` — GNU suffixes (`30s`, `1m`) and a trailing comment
 * or semicolon still count as a poll; `sleep 5 && npm test` does not. In
 * PowerShell `sleep` aliases `Start-Sleep`, so one pattern covers both tools.
 */
export const PURE_WAIT_PATTERN = /^\s*(?:sleep|start-sleep)\s+\d+(?:\.\d+)?[smhd]?\s*;?\s*(?:#.*)?$/iu;

export function isPureWaitCommand(command: string): boolean {
  return PURE_WAIT_PATTERN.test(command);
}

export interface PollGuardOptions {
  /** Live work ids; empty means nothing is running and no poll is possible. */
  active: () => string[];
  /** The block reason, naming the ids the model should inspect instead. */
  reason: (ids: string[]) => string;
  /** End the batch after blocking, when the caller's completion will wake the model. */
  terminate?: boolean;
}

/**
 * Register the poll guard for `bash` and `powershell`.
 *
 * The check order matters: no active work means a sleep is an ordinary wait and
 * must not be blocked, so the caller's `active()` is consulted before parsing.
 */
export function createPollGuard(pi: Pick<ExtensionAPI, "on">, options: PollGuardOptions): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const ids = options.active();
    if (ids.length === 0) return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !isPureWaitCommand(command)) return;
    return {
      block: true,
      ...(options.terminate ? { terminate: true } : {}),
      reason: options.reason(ids),
    };
  });
}
