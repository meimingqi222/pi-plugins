/**
 * `panel.ts` — the `/subagents live` overlay: the opened, interactive surface.
 *
 * The widget answers "is anything running" without asking; this panel answers
 * "what is it doing right now" about one child — a different question, so a
 * different surface, deliberately entered.
 *
 * Row bodies carry live activity here (current tool, latest event) because the
 * panel is on-demand: the churn that made a live activity column unreadable in
 * a persistent widget is exactly what an opened viewer exists to show.
 *
 * Selection is kept by record id, not index: records reorder when one settles
 * (the registry lists active before settled), so an index pointing at "the
 * third row" silently jumps children mid-interaction, while the id stays
 * pinned. A child that disappears mid-view shows a tombstone rather than stale
 * content.
 *
 * `ctx.ui.custom` overlays clip content to `maxHeight` from the top down, and
 * the component is only ever handed a width — there is no viewport-height
 * callback. Scrolling the detail and log views is therefore self-managed: a
 * fixed row budget (`BODY_ROWS`) and a scroll offset the keys move.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { deriveChildState } from "./background.ts";
import type { Lane } from "./lane.ts";
import { formatChildDetail, formatPanelRow, type FleetTheme } from "./fleet.ts";
import { foldSubagentLog, renderTranscript } from "./transcript.ts";

/** Interior rows between header and footer hints; the overlay wraps the whole component. */
export const PANEL_BODY_ROWS = 18;
/** Raw log tail shown by `l`; the same bounded reader the model's `log` action uses. */
const LOG_TAIL_LINES = 40;

type View = { kind: "list" } | { kind: "detail" | "transcript" | "log"; id: string };

export interface PanelDeps {
	/** Only the render request is used, so a test needs no terminal. */
	tui: Pick<TUI, "requestRender">;
	theme: FleetTheme;
	/** Records for the current session, active first. Read fresh on every render. */
	list(): Lane[];
	/** Abort a running child. Returns false when the id is missing or already settled. */
	stop(id: string): boolean;
	/** Bounded raw-log tail for one child; undefined when the child wrote no log. */
	readLog(id: string): string | undefined;
	/** Bounded raw event lines for the transcript fold; same reader, a wider tail. */
	readTranscriptLines(id: string): { lines: string[]; earlierDataOmitted: boolean } | undefined;
	/** The user's "tell me when a child finishes" toggle; `n` flips it. */
	notifyDone(): boolean;
	setNotifyDone(value: boolean): void;
	tickMs?: number;
	now?(): number;
	schedule?(fn: () => void, ms: number): ReturnType<typeof setInterval>;
	cancel?(handle: ReturnType<typeof setInterval>): void;
}

export type PanelComponent = Component & { dispose?(): void };

const LIST_KEYS = "↑/↓ select · enter detail · k cancel · t transcript · l log";
const DETAIL_KEYS = "↑/↓ scroll · t transcript · l log · k cancel · Esc back";
const TRANSCRIPT_KEYS = "↑/↓ scroll · L raw log · Esc back";
const LOG_KEYS = "↑/↓ scroll · Esc back";

export function createSubagentsPanel(deps: PanelDeps, close: () => void): PanelComponent {
	const now = deps.now ?? Date.now;
	const tickMs = deps.tickMs ?? 1_000;
	const schedule = deps.schedule ?? ((fn, ms) => setInterval(fn, ms));
	const cancel = deps.cancel ?? ((handle) => clearInterval(handle));

	let view: View = { kind: "list" };
	let selectedId: string | undefined;
	let scroll = 0;
	let logCache: { id: string; text: string } | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	/** The live transcript re-folds on every render so a running child's tail grows. */
	function transcriptLines(id: string): string[] {
		const source = deps.readTranscriptLines(id);
		if (!source || source.lines.length === 0) {
			return [deps.theme.fg("dim", "  No log is available for this task yet.")];
		}
		return renderTranscript(foldSubagentLog(source.lines, source.earlierDataOmitted), deps.theme);
	}

	function records(): Lane[] {
		return deps.list();
	}

	/** Selection survives reordering because it is the record's id, not its row. */
	function selected(): Lane | undefined {
		const list = records();
		return list.find((record) => record.id === selectedId) ?? list[0];
	}

	function syncSelection(): void {
		const list = records();
		if (list.length === 0) {
			selectedId = undefined;
			return;
		}
		if (!selectedId || !list.some((record) => record.id === selectedId)) {
			// The first record is the newest active one — the row a user who just
			// opened the panel is watching.
			selectedId = list[0]!.id;
		}
	}

	function back(): void {
		// Detail is the hub: transcript and raw log return to it, it returns to the list.
		if (view.kind === "transcript" || view.kind === "log") {
			view = { kind: "detail", id: view.id };
		} else {
			view = { kind: "list" };
		}
		scroll = 0;
		logCache = undefined;
	}

	function detailBody(width: number): string[] {
		if (view.kind === "list") return [];
		const detail = view;
		const record = records().find((item) => item.id === detail.id);
		if (!record) {
			return [
				"",
				deps.theme.fg("warning", "task unavailable"),
				deps.theme.fg("dim", "The subagent list changed. Esc to return."),
			];
		}
		if (view.kind === "detail") return formatChildDetail(record, deps.theme, now());
		if (view.kind === "transcript") return transcriptLines(detail.id);
		if (logCache?.id !== detail.id) logCache = { id: detail.id, text: deps.readLog(detail.id) ?? "No raw log is available for this task." };
		return logCache.text.split("\n").map((line) => `  ${line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, " ")}`);
	}

	function header(width: number): string {
		const list = records();
		const count = (state: "running" | "stalled" | "failed") => list.filter((record) => deriveChildState(record, now()) === state).length;
		const parts = [
			`${list.length} total`,
			count("running") > 0 ? `${count("running")} running` : "",
			count("stalled") > 0 ? `${count("stalled")} stalled` : "",
			count("failed") > 0 ? `${count("failed")} failed` : "",
		].filter(Boolean);
		return truncateToWidth(` ${deps.theme.bold("subagents")} ${deps.theme.fg("dim", `· ${parts.join(" · ")}`)}`, width, "…");
	}

	function footer(): string {
		const keys = view.kind === "list" ? LIST_KEYS : view.kind === "detail" ? DETAIL_KEYS : view.kind === "transcript" ? TRANSCRIPT_KEYS : LOG_KEYS;
		const notify = deps.notifyDone() ? "notify on" : "notify off";
		return ` ${deps.theme.fg("dim", `${keys} · n ${notify} · q close`)}`;
	}

	const panel: PanelComponent = {
		render(width: number): string[] {
			if (width < 4) return [""];
			syncSelection();
			const lines: string[] = [header(width), ""];
			const body = view.kind === "list"
				? (() => {
					const list = records();
					if (list.length === 0) return [` ${deps.theme.fg("dim", "No background subagent tasks in this session.")}`];
					return list.map((record) => formatPanelRow(record, record.id === selectedId, deps.theme, now(), width));
				})()
				: detailBody(width);
			const maxScroll = Math.max(0, body.length - PANEL_BODY_ROWS);
			if (scroll > maxScroll) scroll = maxScroll;
			lines.push(...body.slice(scroll, scroll + PANEL_BODY_ROWS));
			lines.push("", footer());
			return lines.map((line) => truncateToWidth(line, width));
		},
		handleInput(data: string): void {
			// Kitty-protocol releases would otherwise double-handle every key.
			if (isKeyRelease(data)) return;
			const repainted = () => deps.tui.requestRender();
			if (data === "n" || data === "N") {
				deps.setNotifyDone(!deps.notifyDone());
				repainted();
				return;
			}
			if (data === "q" || data === "Q") {
				panel.dispose?.();
				close();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				if (view.kind !== "list") {
					back();
					repainted();
					return;
				}
				panel.dispose?.();
				close();
				return;
			}
			if (view.kind === "list") {
				const list = records();
				if (list.length === 0) return;
				syncSelection();
				const index = Math.max(0, list.findIndex((record) => record.id === selectedId));
				if (matchesKey(data, "up")) {
					selectedId = list[(index - 1 + list.length) % list.length]!.id;
					repainted();
					return;
				}
				if (matchesKey(data, "down")) {
					selectedId = list[(index + 1) % list.length]!.id;
					repainted();
					return;
				}
				if (matchesKey(data, "enter")) {
					const record = list[index]!;
					view = { kind: "detail", id: record.id };
					scroll = 0;
					repainted();
					return;
				}
					if (data === "k" || data === "K" || data === "x" || data === "X") {
					const record = list[index]!;
					if (record.status === "running") deps.stop(record.id);
					repainted();
					return;
				}
				if (data === "t" || data === "T") {
					const record = list[index]!;
					view = { kind: "transcript", id: record.id };
					scroll = 0;
					repainted();
					return;
				}
				if (data === "l" || data === "L") {
					const record = list[index]!;
					view = { kind: "log", id: record.id };
					scroll = 0;
					repainted();
					return;
				}
				if (data === "r" || data === "R") {
					repainted();
					return;
				}
				return;
			}
			// detail / log views: scroll with ↑/↓/PageUp/PageDown/Home/End.
			if (matchesKey(data, "up")) {
				scroll = Math.max(0, scroll - 1);
			} else if (matchesKey(data, "down")) {
				scroll += 1;
			} else if (matchesKey(data, "pageUp")) {
				scroll = Math.max(0, scroll - PANEL_BODY_ROWS);
			} else if (matchesKey(data, "pageDown")) {
				scroll += PANEL_BODY_ROWS;
			} else if (matchesKey(data, "home")) {
				scroll = 0;
			} else if (matchesKey(data, "end")) {
				scroll = Number.MAX_SAFE_INTEGER; // clamped in render()
			} else if ((data === "t" || data === "T") && view.kind === "detail") {
				view = { kind: "transcript", id: view.id };
				scroll = 0;
			} else if ((data === "L") && view.kind === "transcript") {
				view = { kind: "log", id: view.id };
				scroll = 0;
			} else if ((data === "l" || data === "L") && view.kind === "detail") {
				view = { kind: "log", id: view.id };
				scroll = 0;
			} else if ((data === "k" || data === "K") && view.kind === "detail") {
				const detail = view;
				const record = records().find((item) => item.id === detail.id);
				if (record?.status === "running") deps.stop(record.id);
			} else {
				return;
			}
			repainted();
		},
		invalidate(): void {},
		dispose(): void {
			if (timer !== undefined) {
				cancel(timer);
				timer = undefined;
			}
		},
	};

	// The panel reads the clock on every render (elapsed, quiet age), so it
	// repaints itself; the interval is unref'd and cleared in dispose().
	timer = schedule(() => deps.tui.requestRender(), tickMs);
	(timer as { unref?: () => void }).unref?.();
	return panel;
}
