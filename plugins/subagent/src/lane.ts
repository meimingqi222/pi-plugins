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
	resultRevision?: number;
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
	/** How many turn results this lane produced while staying alive (RPC lanes). */
	turnsAnswered?: number;
	/** The last stdin command pi refused, short enough for a status line. */
	lastCommandError?: string;
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
	/**
	 * The caller already holds a slot claimed through `acquireSlot` — the
	 * reservation becomes this lane instead of being released.
	 */
	slotHeld?: boolean;
}

/** Session-local, bounded handles for delegations — background tasks and foreground calls alike. */
export class LaneRegistry {
	private readonly active = new Map<string, ActiveLane>();
	private readonly settled: Lane[] = [];
	private readonly waiters = new Set<(lane: Lane) => void>();
	/**
	 * Slots a queued foreground call has been granted but not yet turned into a
	 * lane. Counted as busy so two calls waking in the same tick cannot both
	 * see a free slot.
	 */
	private reservedSlots = 0;
	/** FIFO queue of foreground calls parked on a full fleet. */
	private readonly slotWaiters: Array<{ grant: () => void }> = [];

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
		// A background launch is refused when the fleet is busy. A foreground
		// call never reaches here without a slot: it parked on `acquireSlot`
		// first, because pi runs a tool batch in parallel and N blocking calls
		// would otherwise spawn N children at once.
		if (kind === "background" && this.busyCount() >= this.maxActive) {
			throw new Error(`At most ${this.maxActive} subagents may run at once. Check or cancel one with subagent_tasks.`);
		}
		if (options.slotHeld) this.reservedSlots = Math.max(0, this.reservedSlots - 1);
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
				const previous = lane.result?.details;
				lane.status = result.details?.status === "running" ? "failed" : result.details?.status ?? "failed";
				const completedTurnReported = lane.status === "completed" && previous?.status === "completed" && (lane.turnsAnswered ?? 0) > 0;
				const repeatsSettledOutcome = lane.idleSince !== undefined && previous !== undefined
					&& previous.status === result.details?.status && previous.output === result.details?.output
					&& previous.errorMessage === result.details?.errorMessage;
				if (!completedTurnReported && !repeatsSettledOutcome) {
					lane.resultRevision = (lane.resultRevision ?? 0) + 1;
				}
				lane.result = result;
			})
			.catch((error: unknown) => {
				lane.status = controller.signal.aborted ? "aborted" : "failed";
				lane.result = undefined;
				lane.errorMessage = error instanceof Error ? error.message : String(error);
				lane.resultRevision = (lane.resultRevision ?? 0) + 1;
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
		if (idle) {
			lane.idleSince = now;
			// An idle lane frees its concurrency slot: it is parked awaiting a
			// reply, not doing work.
			this.wakeSlotWaiter();
		} else {
			delete lane.idleSince;
		}
	}

	/**
	 * Record a settled *turn* on a lane that is still running: the RPC child
	 * answers once per turn while staying alive for replies. Waiters are
	 * notified the same way a final settle notifies them, so a `wait` parked on
	 * the lane returns the answer instead of sitting out its deadline.
	 */
	setTurnResult(id: string, result: AgentToolResult<SubagentDetails>): void {
		const lane = this.active.get(id)?.lane;
		if (!lane) return;
		lane.result = result;
		lane.resultRevision = (lane.resultRevision ?? 0) + 1;
		lane.turnsAnswered = (lane.turnsAnswered ?? 0) + 1;
		const visible = publicLane(lane);
		for (const waiter of [...this.waiters]) {
			try {
				waiter(visible);
			} catch {
				// One waiter failing must not keep the others waiting.
			}
		}
	}

	/** Record a refused stdin command so `show` can report what pi rejected. */
	setCommandError(id: string, error: string): void {
		const lane = this.active.get(id)?.lane;
		if (lane) lane.lastCommandError = error;
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
		return this.busyCount() >= this.maxActive;
	}

	/** Counts running lanes across sessions and kinds; the fleet ticker starts on this. */
	activeCount(): number {
		return this.active.size;
	}

	/**
	 * Lanes holding a concurrency slot — running and not idle — of either kind,
	 * plus reservations a queued foreground call has been granted but not yet
	 * launched. An idle lane (`idleSince` set) is parked awaiting a reply on
	 * the caller's keepalive, not doing work: charging it a slot would let four
	 * answered lanes block every launch, and a reply re-activating one is
	 * always allowed even past the cap.
	 */
	busyCount(): number {
		let count = this.reservedSlots;
		for (const entry of this.active.values()) {
			if (entry.lane.status === "running" && entry.lane.idleSince === undefined) count += 1;
		}
		return count;
	}

	/**
	 * Claim a concurrency slot for a launch that must wait rather than refuse —
	 * the foreground path. The claim is a reservation counted as busy
	 * immediately, so calls racing in the same tick cannot both observe a free
	 * slot; `launch` with `slotHeld` turns the reservation into the lane.
	 * FIFO: each freed slot wakes exactly one waiter. Resolves `false` when
	 * `signal` fires while queued — the caller then aborts having spawned
	 * nothing.
	 */
	acquireSlot(signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(false);
		if (this.slotWaiters.length === 0 && this.busyCount() < this.maxActive) {
			this.reservedSlots += 1;
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			const waiter = { grant: (): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve(true);
			} };
			const onAbort = (): void => {
				const index = this.slotWaiters.indexOf(waiter);
				if (index < 0) return;
				this.slotWaiters.splice(index, 1);
				resolve(false);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.slotWaiters.push(waiter);
		});
	}

	/** Drop a granted-but-unused reservation (the call was interrupted before it launched). */
	releaseSlot(): void {
		if (this.reservedSlots === 0) return;
		this.reservedSlots -= 1;
		this.wakeSlotWaiter();
	}

	private wakeSlotWaiter(): void {
		// Wake only the head: a freed slot admits exactly one waiting call.
		if (this.busyCount() >= this.maxActive) return;
		const next = this.slotWaiters.shift();
		if (!next) return;
		this.reservedSlots += 1;
		next.grant();
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
	 *
	 * The deadline timer is deliberately **not** unref'd. It is the only thing that
	 * can end a wait on a lane that never settles, so unref'ing it let the process
	 * decide the loop had nothing left to do — and Bun then neither ran the timer
	 * nor exited: it spun at 100% CPU, which is how `plugins/subagent/test/plugin.test.ts`
	 * stopped finishing on Windows. A caller blocked on this promise is a reason to
	 * stay alive; a wait nobody is watching is already bounded by the tool call's
	 * own signal, and `cleanup` clears the timer either way.
	 */
	waitFor(sessionId: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
		const existing = this.get(sessionId, id);
		// A lane that produced a turn answer AND went idle has something to
		// return: "running" only means the process survives for a reply. A busy
		// lane still holds the *previous* turn's result, so result alone is not
		// grounds to stop waiting — that would hand back a stale answer.
		if (!existing || existing.status !== "running" || (existing.result !== undefined && existing.idleSince !== undefined)) {
			return Promise.resolve({ lane: existing, outcome: "settled" });
		}
		if (signal?.aborted) return Promise.resolve({ lane: existing, outcome: "interrupted" });
		const turnsAtStart = existing.turnsAnswered ?? 0;
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
				// A running lane is only done waiting when a *new* turn result
				// landed after this wait started.
				if (lane.status === "running" && (lane.turnsAnswered ?? 0) <= turnsAtStart) return;
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
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.add(onSettled);
		});
	}

	private settle(lane: Lane): void {
		if (!this.active.delete(lane.id)) return;
		lane.finishedAt = Date.now();
		// The freed slot may admit a queued foreground call.
		this.wakeSlotWaiter();
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
