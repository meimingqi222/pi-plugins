/**
 * `background.ts` — compatibility shim.
 *
 * The lane entity and registry moved to `lane.ts` (a foreground call is a
 * lane too). This file keeps the pre-refactor import surface working: the
 * type aliases so older imports still type-check, plus the two things that
 * were always about *displaying* a lane rather than owning one —
 * `deriveChildState`, `formatBackground`, `formatDuration`.
 */

import type { SubagentProgress } from "./tool.ts";
import type { Lane } from "./lane.ts";

export {
	LaneRegistry,
	deriveAlias,
	type Lane,
	type LaneKind,
	type LaneStatus,
	type LaunchOptions,
} from "./lane.ts";

/** Pre-refactor name; a lane and a background record are the same object. */
export type BackgroundRecord = Lane;
export type BackgroundRegistry = InstanceType<typeof import("./lane.ts").LaneRegistry>;
export type BackgroundStatus = Lane["status"];

export const QUIET_ACTIVITY_WARNING_MS = 90_000;

/**
 * Observability states: `stalled` is `running` plus quiet past the warning
 * threshold; `idle` is an RPC lane between turns — alive, awaiting a reply.
 * `idle` wins over `stalled`: a child waiting for its owner is not stuck.
 */
export type ChildState = Lane["status"] | "stalled" | "idle";

/**
 * The single place a running lane becomes `stalled`.
 *
 * The widget, the fleet panel and `formatBackground` all answer "is this child
 * stuck" from here, so the surfaces cannot disagree. A child that has emitted
 * no progress event yet is quiet since its start time: `progress` is absent,
 * which is a spawn, not silence inside the run — it is still `stalled` when the
 * age alone exceeds the threshold.
 */
export function deriveChildState(lane: Pick<Lane, "status" | "startedAt" | "progress" | "idleSince">, now: number): ChildState {
	if (lane.status !== "running") return lane.status;
	if (lane.idleSince !== undefined) return "idle";
	const lastActivityAt = lane.progress?.lastActivityAt ?? lane.startedAt;
	return now - lastActivityAt >= QUIET_ACTIVITY_WARNING_MS ? "stalled" : "running";
}

export function formatBackground(lane: Lane): string {
	const now = Date.now();
	const elapsed = Math.round(((lane.finishedAt ?? now) - lane.startedAt) / 1000);
	const tools = lane.progress?.completedTools ? ` · ${lane.progress.completedTools} tools` : "";
	// A refused stdin command (a reply pi rejected) must not die in the child's
	// output stream — show it on every rendering of the lane.
	const commandError = lane.lastCommandError ? ` · command error: ${lane.lastCommandError}` : "";
	const progress = lane.progress;
	// A child that has never emitted an event still derives `stalled` from its
	// start time; the flag belongs on the plain line rather than being hidden.
	if (!progress) {
		const stall = deriveChildState(lane, now) === "stalled"
			? ` · no child event for ${formatDuration(Math.floor((now - lane.startedAt) / 1_000))} (possible stall)`
			: "";
		return `**${lane.alias || lane.agent} · ${lane.status}**\n${formatDuration(elapsed)}${tools}${stall}${commandError}\nTask: \`${lane.id}\``;
	}

	const quietMs = Math.max(0, now - progress.lastActivityAt);
	const quiet = formatDuration(Math.floor(quietMs / 1_000));
	const latest = progress.recentActivity.at(-1);
	const activeTool = progress.activeTool ?? [latest?.toolName, latest?.target].filter(Boolean).join(" ");
	const phase = progress.phase === "tool"
		? `tool ${activeTool || "execution"}`
		: progress.phase;
	const childState = deriveChildState(lane, now);
	const idleAge = formatDuration(Math.floor((now - (lane.idleSince ?? now)) / 1_000));
	const activity = childState === "stalled"
		? ` · no child event for ${quiet} (possible stall)`
		: childState === "idle"
			? lane.result
				? ` · answered ${idleAge} ago — awaiting a reply`
				: ` · idle for ${idleAge} — awaiting a reply`
			: ` · last ${progress.lastEvent} ${quiet} ago`;
	return `**${lane.alias || lane.agent} · ${lane.status}**\n${formatDuration(elapsed)}${tools} · ${phase}${activity}${commandError}\nTask: \`${lane.id}\``;
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}

export type { SubagentProgress };
