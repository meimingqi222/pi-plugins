/**
 * Snapshot persistence for a run-oriented extension.
 *
 * Run state is stored as a `custom` session entry, which keeps it out of the
 * model's context while still following the active branch: an abandoned branch
 * must not resurrect the run it recorded. Restoration therefore walks the branch
 * newest-first and takes the first entry that validates, and a snapshot that
 * fails validation is treated as absent rather than skipped over — falling back
 * to an older snapshot would silently restore a state the session had already
 * moved past.
 *
 * `pi.appendEntry` needs the session bound; `session_start` and `session_tree`
 * are the boundaries to restore on, and neither may assume a runtime instance
 * survived the boundary.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A persisted run snapshot must carry a schema so a future format can be rejected. */
export interface RunSnapshotBase {
  schema: number;
}

/** Structural check for a candidate snapshot. Returning false means "not this format". */
export type SnapshotValidator<T> = (value: unknown) => value is T;

/** Append a snapshot. Deep-cloned so a later mutation cannot rewrite what was written. */
export function appendRunSnapshot<T>(pi: ExtensionAPI, entryType: string, snapshot: T): void {
  pi.appendEntry(entryType, structuredClone(snapshot));
}

/**
 * Restore the newest valid snapshot of `entryType` on the active branch.
 *
 * `undefined` when the branch holds none, which is the correct answer for a new
 * session and for a branch that predates the feature. A malformed newest entry
 * returns `undefined` rather than an older entry: see the module note.
 */
export function restoreLatestRun<T extends RunSnapshotBase>(
  ctx: Pick<ExtensionContext, "sessionManager">,
  entryType: string,
  validate: SnapshotValidator<T>,
): T | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== entryType) continue;
    return validate(entry.data) ? structuredClone(entry.data) : undefined;
  }
  return undefined;
}
