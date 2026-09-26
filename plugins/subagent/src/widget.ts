/**
 * `widget.ts` — the fleet's persistent surface: `createFleetReporter` adapts
 * `BackgroundRecord`s onto `pi-run-core`'s `createWorkReporter`, which owns the
 * mount/tick/teardown lifecycle this file used to own.
 *
 * What stays here is the part that is subagent-specific: the stall
 * notification. On each live tick, `deriveChildState` promotes a newly-quiet
 * child to `stalled` exactly once per record id — the same function the widget
 * icon and `subagent_tasks` use, so the three cannot disagree.
 */

import type { Component } from "@earendil-works/pi-tui";
import { createWorkReporter, type WorkReporterDeps, type WorkSurfaceUI } from "pi-run-core";
import { deriveChildState, type BackgroundRecord } from "./background.ts";
import { renderFleetWidget } from "./fleet.ts";

const WIDGET_KEY = "pi-subagent-fleet";

/** The part of `ctx.ui` this needs. Structural, so a test needs no real UI. */
export type FleetUI = WorkSurfaceUI;

export type FleetComponent = Component & { dispose?(): void };

export interface FleetReporterDeps {
	/** UI for the session that owns the fleet; `undefined` outside TUI mode or before any session context exists. */
	ui(): FleetUI | undefined;
	/** Records for the current session, active first (the registry's order). */
	list(): BackgroundRecord[];
	/** Running children across sessions: the tick lives only while this is non-zero. */
	activeCount(): number;
	tickMs?: number;
	now?(): number;
	/** Test seams; the real ones are the globals. */
	schedule?(fn: () => void, ms: number): ReturnType<typeof setInterval>;
	cancel?(handle: ReturnType<typeof setInterval>): void;
}

export interface FleetReporter {
	/** Mount/unmount the widget and start/stop the tick to match `activeCount()`. */
	sync(): void;
	/** Unmount and stop. Safe to call twice, and safe before any mount. */
	dispose(): void;
}

export function createFleetReporter(deps: FleetReporterDeps): FleetReporter {
	const now = deps.now ?? Date.now;
	// Stall notifications are once per record id; settled ids stay in the set
	// harmlessly and are pruned when the tick next sees them gone.
	const notifiedStalls = new Set<string>();

	const reporterDeps: WorkReporterDeps<BackgroundRecord> = {
		key: WIDGET_KEY,
		ui: deps.ui,
		items: deps.list,
		live: () => deps.activeCount() > 0,
		render: (records, theme, at, width) => renderFleetWidget(records, theme, at, width),
		tickMs: deps.tickMs,
		now,
		...(deps.schedule ? { schedule: deps.schedule } : {}),
		...(deps.cancel ? { cancel: deps.cancel } : {}),
		onTick(ui, at) {
			const records = deps.list();
			const ids = new Set(records.map((record) => record.id));
			for (const id of notifiedStalls) if (!ids.has(id)) notifiedStalls.delete(id);
			for (const record of records) {
				if (notifiedStalls.has(record.id)) continue;
				if (deriveChildState(record, at) !== "stalled") continue;
				notifiedStalls.add(record.id);
				try {
					ui.notify(`subagent ${record.id} (${record.agent}) has been quiet for 90s — /subagents live to inspect`, "warning");
				} catch {
					// A notification failure cannot resurrect the record it describes.
				}
			}
		},
	};
	const reporter = createWorkReporter(reporterDeps);
	return { sync: () => reporter.sync(), dispose: () => reporter.dispose() };
}
