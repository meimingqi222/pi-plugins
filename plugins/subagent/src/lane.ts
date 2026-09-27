/**
 * `lane.ts` — a lane is one subagent execution with an identity.
 *
 * `BackgroundRecord` becomes `Lane` because a foreground call is a lane too:
 * same spawn, same settle, same observability contract — only the answer
 * path differs (the tool call returns it instead of a follow-up message).
 * Registering foreground calls closes the last blind spot the fleet had:
 * a blocking call no longer looks like the session is idle.
 *
 * `queuedPrompts` and `generation` are stored now for the reply transport
 * that follows: they are the fields a live-child continuation needs, and
 * adding them here keeps that change transport-only.
 */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails, SubagentProgress } from "./tool.ts";

export type LaneStatus = "running" | "completed" | "failed" | "aborted";
/** `foreground` lanes are observable but not addressable: no id reaches the model and stop() refuses them. */
export type LaneKind = "background" | "foreground";

/**
 * Why a cancel request did or did not stop a lane.
 *
 * `foreground` is a distinct answer rather than a `false`: a foreground call is
 * the session's own turn, so there is no child to abort behind the model's back,
 * and a caller that reports "nothing happened" is describing a broken button.
 */
export type StopOutcome = "stopped" | "settled" | "foreground";

/**
 * Why a wait returned.
 *
 * `interrupted` has to be distinguishable from `timeout`: both leave the lane
 * running, and reporting an interrupted wait as "still running after 300s" states
 * an elapsed time that never happened.
 */
export type WaitOutcome = "settled" | "timeout" | "interrupted";

/** A settled-or-not lane plus the reason the wait stopped waiting. */
export interface WaitResult {
	lane: Lane | undefined;
	outcome: WaitOutcome;
}

export interface Lane {
	id: string;
	agent: string;
	/** Human-facing display name; falls back to a task-derived slug at launch. */
	alias: string;
	task: string;
	sessionId: string;
	kind: LaneKind;
	status: LaneStatus;
	startedAt: number;
	finishedAt?: number;
	logPath?: string;
	progress?: SubagentProgress;
	result?: AgentToolResult<SubagentDetails>;
	errorMessage?: string;
	/** Prompts buffered for a live child; consumed by the reply transport. */
	queuedPrompts?: string[];
	/** The session generation the lane launched under; stale callbacks check it. */
	generation?: number;
	/**
	 * RPC lanes only: when a turn ended and the child is alive awaiting a
	 * follow-up prompt. Absent while a turn is in flight and on JSON children.
	 */
	idleSince?: number;
}

interface ActiveLane {
	lane: Lane;
	controller: AbortController;
}

/**
 * A human-facing name from a task's first line, for a launch that did not name
 * one. Keeps word characters, dashes and spaces; collapses the rest.
 */
export function deriveAlias(task: string, max = 24): string {
	const slug = (task.split("\n")[0] ?? "")
		.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
		.trim()
		.replace(/[^\p{L}\p{N} _-]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!slug) return "task";
	return slug.length > max ? `${slug.slice(0, max - 1)}…` : slug;
}

export interface LaunchOptions {
	alias?: string;
	kind?: LaneKind;
	generation?: number;
}

/** Session-local, bounded handles for delegations — background tasks and foreground calls alike. */
export class LaneRegistry {
	private readonly active = new Map<string, ActiveLane>();
	private readonly settled: Lane[] = [];
	private readonly waiters = new Set<(lane: Lane) => void>();

	constructor(
		private readonly onSettled: (lane: Lane) => void,
		private readonly maxActive = 4,
		private readonly historyLimit = 20,
	) {}

	/**
	 * Register a lane and start its work. Returns the record plus `done`, which
	 * resolves once the lane settles — the foreground path awaits it; the
	 * background path discards it.
	 */
	launch(
		agent: string,
		task: string,
		sessionId: string,
		work: (signal: AbortSignal, id: string) => Promise<AgentToolResult<SubagentDetails>>,
		options: LaunchOptions = {},
	): { record: Lane; done: Promise<void> } {
		const kind = options.kind ?? "background";
		if (kind === "background" && this.backgroundActiveCount() >= this.maxActive) {
			throw new Error(`At most ${this.maxActive} background subagents may run at once. Check or cancel one with subagent_tasks.`);
		}
		const lane: Lane = {
			id: `sa-${randomUUID()}`,
			agent,
			alias: options.alias?.trim() || deriveAlias(task),
			task,
			sessionId,
			kind,
			status: "running",
			startedAt: Date.now(),
			...(options.generation !== undefined ? { generation: options.generation } : {}),
		};
		const controller = new AbortController();
		this.active.set(lane.id, { lane, controller });
		const done = Promise.resolve()
			.then(() => work(controller.signal, lane.id))
			.then((result) => {
				lane.result = result;
				lane.status = result.details?.status === "running" ? "failed" : result.details?.status ?? "failed";
			})
			.catch((error: unknown) => {
				lane.status = controller.signal.aborted ? "aborted" : "failed";
				lane.errorMessage = error instanceof Error ? error.message : String(error);
			})
			.finally(() => this.settle(lane));
		return { record: { ...lane }, done };
	}

	get(sessionId: string, id: string): Lane | undefined {
		const lane = this.active.get(id)?.lane ?? this.settled.find((item) => item.id === id);
		return lane?.sessionId === sessionId ? publicLane(lane) : undefined;
	}

	getLogPath(sessionId: string, id: string): string | undefined {
		const lane = this.active.get(id)?.lane ?? this.settled.find((item) => item.id === id);
		return lane?.sessionId === sessionId ? lane.logPath : undefined;
	}

	list(sessionId: string): Lane[] {
		const active = [...this.active.values()].map((item) => item.lane);
		return [...active.reverse(), ...[...this.settled].reverse()]
			.filter((lane) => lane.sessionId === sessionId)
			.map(publicLane);
	}

	setProgress(id: string, progress: SubagentProgress): void {
		const lane = this.active.get(id)?.lane;
		if (lane) lane.progress = progress;
	}

	setLogPath(id: string, logPath: string): void {
		const lane = this.active.get(id)?.lane;
		if (lane) lane.logPath = logPath;
	}

	/** Mark a running lane idle-between-turns (RPC transport) or busy again. */
	setIdle(id: string, idle: boolean, now = Date.now()): void {
		const lane = this.active.get(id)?.lane;
		if (!lane) return;
		if (idle) lane.idleSince = now;
		else delete lane.idleSince;
	}

	idleSince(sessionId: string, id: string): number | undefined {
		const lane = this.active.get(id)?.lane;
		return lane?.sessionId === sessionId ? lane.idleSince : undefined;
	}

	/** Cancel a background lane. Foreground lanes are not addressable — only their own tool call may end them. */
	stop(sessionId: string, id: string): StopOutcome {
		const entry = this.active.get(id);
		if (!entry || entry.lane.sessionId !== sessionId) return "settled";
		if (entry.lane.kind !== "background") return "foreground";
		entry.controller.abort();
		return "stopped";
	}

	/** Internal abort for session teardown and tool-call signals; not gated on kind. */
	abort(id: string): void {
		this.active.get(id)?.controller.abort();
	}

	stopAll(): void {
		for (const entry of this.active.values()) entry.controller.abort();
	}

	atCapacity(): boolean {
		return this.backgroundActiveCount() >= this.maxActive;
	}

	/** Counts running lanes across sessions and kinds; the fleet ticker starts on this. */
	activeCount(): number {
		return this.active.size;
	}

	private backgroundActiveCount(): number {
		let count = 0;
		for (const entry of this.active.values()) if (entry.lane.kind === "background") count += 1;
		return count;
	}

	get activeLimit(): number {
		return this.maxActive;
	}

	/**
	 * Resolve when the lane settles, the deadline hits, or `signal` fires — the same
	 * shape `bg_tasks wait` offers, so a caller never needs a polling loop. The
	 * reason travels with the record, because "still running after 300s" is wrong
	 * for a wait that returned in a millisecond.
	 *
	 * `signal` ends the wait without ending the lane: a tool call that has been
	 * interrupted must return, or the caller waits out a deadline nobody is
	 * watching any more.
	 */
	waitFor(sessionId: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
		const existing = this.get(sessionId, id);
		if (!existing || existing.status !== "running") return Promise.resolve({ lane: existing, outcome: "settled" });
		if (signal?.aborted) return Promise.resolve({ lane: existing, outcome: "interrupted" });
		return new Promise((resolve) => {
			const done = (outcome: WaitOutcome) => resolve({ lane: this.get(sessionId, id), outcome });
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = (): void => {
				this.waiters.delete(onSettled);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onSettled = (lane: Lane): void => {
				if (lane.id !== id) return;
				cleanup();
				done("settled");
			};
			const onAbort = (): void => {
				cleanup();
				done("interrupted");
			};
			timer = setTimeout(() => {
				cleanup();
				done("timeout");
			}, Math.max(0, timeoutMs));
			(timer as { unref?: () => void }).unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.add(onSettled);
		});
	}

	private settle(lane: Lane): void {
		if (!this.active.delete(lane.id)) return;
		lane.finishedAt = Date.now();
		this.settled.push(lane);
		while (this.settled.length > this.historyLimit) this.settled.shift();
		const visible = publicLane(lane);
		for (const waiter of [...this.waiters]) {
			try {
				waiter(visible);
			} catch {
				// One waiter failing must not keep the others waiting.
			}
		}
		try {
			this.onSettled(visible);
		} catch {
			// A notification failure cannot resurrect an already settled run.
		}
	}
}

function publicLane(lane: Lane): Lane {
	const { logPath: _privateLogPath, ...visible } = lane;
	return visible;
}
