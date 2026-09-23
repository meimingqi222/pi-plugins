/**
 * The footer entry that says a workflow is running.
 *
 * `/workflows` answers a question the user has to think to ask, and its answer
 * arrives as a notification that scrolls away. A run lasts minutes, so the
 * normal way this is experienced is a session that looks idle while four agents
 * are in flight. The footer is the surface the user is already looking at, so
 * that is where liveness belongs.
 *
 * Two rules follow from being a guest in someone else's footer:
 *
 * - **One slot, cleared when nothing runs.** `setStatus(key, undefined)` is what
 *   gives the slot back, so a settled session looks exactly as it did before the
 *   plugin was installed.
 * - **Ticking only while something is live.** A permanent interval is a timer
 *   that outlives its reason, and in a one-shot mode it is a process that will
 *   not exit. The interval exists only between the first launch and the last
 *   settlement.
 *
 * The rendered text itself lives in `runs/live-status.ts`, next to the other
 * liveness surface: the footer and `/workflows` disagreeing about the same run
 * would be worse than either being terse.
 */

import { FOOTER_STATUS_KEY, formatFooterStatus } from "../runs/live-status.ts";
import type { RunRecord } from "../runs/registry.ts";

/** The part of `ctx.ui` this needs. Kept structural so a test needs no TUI. */
export interface FooterSink {
	setStatus(key: string, text: string | undefined): void;
}

export interface FooterReporterDeps {
	/** Newest first, active runs included. */
	list(): RunRecord[];
	/** How many runs have not settled. */
	activeCount(): number;
	/** Refresh period. A second is below the granularity the text shows. */
	tickMs?: number;
	now?(): number;
	/** Test seams; the real ones are the globals. */
	schedule?(fn: () => void, ms: number): ReturnType<typeof setInterval>;
	cancel?(handle: ReturnType<typeof setInterval>): void;
}

export interface FooterReporter {
	/** Adopt a UI sink and bring the tick in line with what is running. */
	attach(sink: FooterSink): void;
	/** Recompute after a launch, a settlement, or a stop. */
	sync(): void;
	/** Stop ticking and give the slot back. Safe to call twice. */
	dispose(): void;
}

const DEFAULT_TICK_MS = 1_000;

export function createFooterReporter(deps: FooterReporterDeps): FooterReporter {
	const schedule = deps.schedule ?? ((fn, ms) => setInterval(fn, ms));
	const cancel = deps.cancel ?? ((handle) => clearInterval(handle));
	const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
	const now = deps.now ?? Date.now;

	let sink: FooterSink | undefined;
	let handle: ReturnType<typeof setInterval> | undefined;
	let published: string | undefined;

	/** Write only when the text changed: the footer is re-rendered on every write. */
	function publish(): void {
		if (!sink) return;
		const text = formatFooterStatus(deps.list(), { now: now() });
		if (text === published) return;
		published = text;
		sink.setStatus(FOOTER_STATUS_KEY, text);
	}

	function stop(): void {
		if (handle === undefined) return;
		cancel(handle);
		handle = undefined;
	}

	function reconcile(): void {
		publish();
		if (deps.activeCount() > 0) {
			if (handle === undefined) {
				handle = schedule(publish, tickMs);
				// A one-shot mode must not be held open by a footer nobody can see.
				(handle as { unref?: () => void }).unref?.();
			}
			return;
		}
		stop();
	}

	return {
		attach(next) {
			sink = next;
			// A new sink starts empty, so what was published to the previous one
			// must not suppress the first write to this one.
			published = undefined;
			reconcile();
		},
		sync: reconcile,
		dispose() {
			stop();
			sink?.setStatus(FOOTER_STATUS_KEY, undefined);
			published = undefined;
			sink = undefined;
		},
	};
}
