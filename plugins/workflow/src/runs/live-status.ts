/**
 * A live view of workflow runs, shared by `workflow_status` and `/workflows`.
 *
 * Both surfaces render the same text: the user opening the command and the model
 * calling the tool are asking the same question, and an answer that is thin for
 * the human is not a second design, it is a worse one. A run that has been
 * silent for eight minutes is not necessarily stuck — a single agent call emits
 * no progress between its start and its finish — so the honest evidence is the
 * age of each running agent, the age of the last progress event, and whether any
 * cap bounds them.
 *
 * Pure: it renders records it is given and reads no clock, so the liveness math
 * is testable.
 */

import type { WorkflowProgressAgent } from "../core/types.ts";
import { formatRun, type RunRecord } from "./registry.ts";

/** The footer slot this plugin owns. One key, so it can only ever occupy one slot. */
export const FOOTER_STATUS_KEY = "workflow";

export interface LiveStatusOptions {
	/** Injected so "N ago" is deterministic in tests. */
	now?: number;
}

/** One decimal place below a minute, then `m s`, then `h m`. */
export function formatElapsed(ms: number): string {
	const clamped = Math.max(0, ms);
	const seconds = clamped / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	const remainder = total % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Bound the reason shown for a stopped agent, so one long error cannot dominate the view. */
const MAX_AGENT_ERROR_CHARS = 160;

function agentsWithStatus(record: RunRecord, status: WorkflowProgressAgent["status"]): WorkflowProgressAgent[] {
	return record.progress?.agents.filter((agent) => agent.status === status) ?? [];
}

function runningAgents(record: RunRecord): WorkflowProgressAgent[] {
	return agentsWithStatus(record, "running");
}

/** `a2 "review-plugins" (Connection error.)` — the id is what a resume or a stop needs. */
function describeStoppedAgent(agent: WorkflowProgressAgent): string {
	const reason = agent.error?.slice(0, MAX_AGENT_ERROR_CHARS);
	return `${agent.id} "${agent.label}"${reason ? ` (${reason})` : ""}`;
}

/**
 * Running agents that have outlived the cap the run declared for them.
 *
 * The cap is enforced in the executor with a real timer that kills the child,
 * so an agent still marked running past it is not a slow agent — the bound did
 * not fire, or the record outlived the kill. That makes this the one silence
 * that is evidence, which is why it is computed rather than left to a reader to
 * notice. Silence with no declared cap carries no such signal.
 */
function overdueAgents(record: RunRecord, now: number): WorkflowProgressAgent[] {
	const cap = record.agentTimeoutMs;
	if (cap === undefined) return [];
	return runningAgents(record).filter((agent) => now - (agent.startedAt ?? now) > cap);
}

function activeSection(record: RunRecord, now: number): string[] {
	const lines: string[] = [];
	const elapsed = formatElapsed(now - record.startedAt);
	lines.push(`- ${record.runId}  running  ${elapsed}  ${record.name}`);

	const progress = record.progress;
	if (!progress) {
		lines.push("    no progress event yet (the run has not reached its first phase or agent call)");
		return lines;
	}

	if (progress.currentPhase) lines.push(`    phase: ${progress.currentPhase}`);
	const agents = progress.agents;
	const running = runningAgents(record);
	// A failed agent was counted in `agents.length` but in no other bucket, so
	// `seen - running - completed` silently absorbed it and read as "not started
	// yet". A run that had lost half its agents looked healthy.
	const buckets = [
		`${running.length} running`,
		`${progress.completedAgents} completed`,
		...(["failed", "aborted"] as const)
			.map((status) => [status, agentsWithStatus(record, status).length] as const)
			.filter(([, count]) => count > 0)
			.map(([status, count]) => `${count} ${status}`),
	];
	lines.push(`    agents: ${agents.length} seen, ${buckets.join(", ")}`);
	lines.push(`    tokens: ${progress.spentTokens}`);

	// Named rather than only counted: the count says the run degraded, the id and
	// reason say whether to stop it, resume it, or ignore the loss.
	for (const status of ["failed", "aborted"] as const) {
		const stopped = agentsWithStatus(record, status);
		if (stopped.length === 0) continue;
		lines.push(`    ${status}: ${stopped.map(describeStoppedAgent).join("; ")}`);
	}

	if (running.length > 0) {
		const described = running
			.map((agent) => `${agent.id} "${agent.label}" ${formatElapsed(now - (agent.startedAt ?? now))}`)
			.join("; ");
		lines.push(`    running now: ${described}`);
	}

	// The liveness judgement is deliberately left to the reader: age alone cannot
	// prove a stall, because a long agent call is silent between start and finish.
	lines.push(`    last progress: ${formatElapsed(now - progress.updatedAt)} ago`);
	// The one case where silence *is* evidence — see `overdueAgents`. Plain
	// silence carries no such signal, which is why it is still left to the reader.
	const overdue = overdueAgents(record, now);
	if (overdue.length > 0) {
		lines.push(
			`    past the ${formatElapsed(record.agentTimeoutMs!)} per-agent timeout: ${overdue
				.map((agent) => `${agent.id} "${agent.label}"`)
				.join("; ")} (the cap kills the child, so a bound that has not fired is a hung executor)`,
		);
	}
	// The bound is stated after the judgement it enables: with no declared cap
	// there is nothing to compare an agent's age against.
	lines.push(
		record.agentTimeoutMs === undefined
			? "    per-agent timeout: none (a hung child is unbounded; stop it with /workflows stop, or pass agentTimeoutMs)"
			: `    per-agent timeout: ${formatElapsed(record.agentTimeoutMs)}`,
	);
	if (progress.message) lines.push(`    last event: ${progress.message}`);
	return lines;
}

/**
 * One line for the footer, or `undefined` to clear the slot.
 *
 * `/workflows` answers a question the user has to think to ask. The footer is
 * what makes a run visible from the screen they are already looking at, which is
 * the whole difference between "a workflow is running" and "nothing appears to
 * be happening". Deliberately terse: the footer is shared with the folder, the
 * model and the context gauge, so this carries liveness only — how long, how
 * many agents in flight, and whether a declared cap is being exceeded. Detail
 * stays in `/workflows`.
 */
export function formatFooterStatus(records: RunRecord[], options: LiveStatusOptions = {}): string | undefined {
	const now = options.now ?? Date.now();
	const active = records.filter((record) => record.status === "running");
	if (active.length === 0) return undefined;

	const running = active.reduce((total, record) => total + runningAgents(record).length, 0);
	const parts: string[] = [];
	if (active.length === 1) {
		const only = active[0]!;
		parts.push(`wf ${formatElapsed(now - only.startedAt)}`);
		if (only.progress?.currentPhase) parts.push(only.progress.currentPhase);
	} else {
		// The oldest run is the one worth reporting; every age would not fit.
		parts.push(`wf ${active.length} runs \u00b7 ${formatElapsed(Math.max(...active.map((record) => now - record.startedAt)))}`);
	}
	if (running > 0) parts.push(`${running} running`);
	const overdue = active.reduce((total, record) => total + overdueAgents(record, now).length, 0);
	if (overdue > 0) parts.push(`${overdue} past timeout`);
	return parts.join(" \u00b7 ");
}

/** Render active runs in full, then a compact line per settled run. */
export function renderLiveStatus(records: RunRecord[], options: LiveStatusOptions = {}): string {
	const now = options.now ?? Date.now();
	const active = records.filter((record) => record.status === "running");
	const settled = records.filter((record) => record.status !== "running");

	const lines: string[] = [];
	if (active.length === 0) {
		lines.push("Active workflows: none.");
	} else {
		lines.push(`Active workflows (${active.length}):`);
		for (const record of active) lines.push(...activeSection(record, now));
	}

	if (settled.length > 0) {
		lines.push("");
		lines.push("Settled runs:");
		for (const record of settled) lines.push(`- ${formatRun(record)}`);
	}

	if (active.length === 0 && settled.length === 0) {
		lines.push("");
		lines.push("No workflow runs in this session. Launch one with the workflow tool, or /workflows for saved workflows.");
	}

	return lines.join("\n");
}
