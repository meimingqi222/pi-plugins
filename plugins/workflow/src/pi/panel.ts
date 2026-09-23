/**
 * The live panel behind `/workflows live`.
 *
 * The notification that `/workflows` produces is a snapshot: it is correct when
 * it is printed and stale a second later, and it is gone as soon as the user
 * scrolls. A run that lasts minutes is better watched than sampled, so this is a
 * component that re-renders itself while it is open.
 *
 * Deliberately not the default `/workflows` behaviour. A command that used to
 * print a listing should keep printing a listing; taking over the screen is a
 * different interaction, and one the user asks for by name.
 *
 * Interaction follows `docs/tui.md`: every line is width-clipped with the TUI's
 * own `truncateToWidth` (agent labels and phases can contain wide characters),
 * state changes call `tui.requestRender()`, and the interval is cleared in
 * `dispose()` — which the harness calls when the completion callback resolves.
 */

import {
	Key,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { renderLiveStatus } from "../runs/live-status.ts";
import type { RunRecord } from "../runs/registry.ts";

export interface PanelDeps {
	/** Only the render request is used, so a test needs no terminal. */
	tui: Pick<TUI, "requestRender">;
	list(): RunRecord[];
	stopAll(): void;
	now?(): number;
	tickMs?: number;
}

/** `ctx.ui.custom` wants a disposable component, which `Component` alone does not name. */
export type PanelComponent = Component & { dispose?(): void };

/** `q` or `Esc` closes, `s` stops everything, `r` re-renders. */
const KEYS = " q / Esc close · s stop all runs · r refresh";

export function createWorkflowsPanel(deps: PanelDeps, done: () => void): PanelComponent {
	const now = deps.now ?? Date.now;
	let handle: ReturnType<typeof setInterval> | undefined;

	function stop(): void {
		if (handle === undefined) return;
		clearInterval(handle);
		handle = undefined;
	}

	const panel: PanelComponent = {
		render(width: number): string[] {
			const body = renderLiveStatus(deps.list(), { now: now() }).split("\n");
			return [...body, KEYS].map((line) => truncateToWidth(line, width));
		},
		handleInput(data: string): void {
			// Kitty-protocol releases would otherwise double-handle every key.
			if (isKeyRelease(data)) return;
			if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
				panel.dispose?.();
				done();
				return;
			}
			if (data === "s" || data === "S") {
				deps.stopAll();
				deps.tui.requestRender();
				return;
			}
			if (data === "r" || data === "R") deps.tui.requestRender();
		},
		invalidate(): void {},
		dispose: stop,
	};

	// Repaint rather than push text: the panel reads the clock on every render,
	// so elapsed times stay honest without this owning any state of its own.
	handle = setInterval(() => deps.tui.requestRender(), deps.tickMs ?? 1_000);
	(handle as { unref?: () => void }).unref?.();
	return panel;
}
