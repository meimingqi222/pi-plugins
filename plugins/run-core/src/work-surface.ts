/**
 * `work-surface.ts` — one shape and one renderer for "work that is still
 * running somewhere", shared by every run-oriented plugin.
 *
 * Before this file each plugin drew its own live surface — or none:
 * `pi-bg-bash` ran invisibly, `pi-subagent` drew a below-editor widget,
 * `pi-workflow` drew a footer. Three vocabularies for the same question the
 * user asks ("is anything still running?"). This file is the unified
 * presentation contract:
 *
 * - `WorkItem` is the row vocabulary. Each plugin maps its records onto it and
 *   keeps its own state names internally; `WorkState` is the superset the
 *   renderer understands.
 * - `formatWorkRow` / `formatWorkSummary` / `renderWorkSurface` are the single
 *   renderer: a row is icon · kind · label · elapsed · optional metric, a
 *   summary is the worst state plus running counts. Two renderers for one
 *   truth is how they drift apart.
 * - `createWorkReporter` owns the mount/tick lifecycle: claim a below-editor
 *   widget slot only while `live()`, repaint on a bounded `unref`'d interval
 *   because `render()` reads the clock, hand the slot back on the last
 *   settle, and never keep a timer across a dispose.
 *
 * Row stability is deliberate, learned from Step-Code's widget notes: a row
 * that republishes on every stream delta churns faster than a reader can
 * parse. The label is the stable task; live activity belongs in an opened
 * surface, not a persistent one.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** States the shared renderer understands; plugins map their own vocabulary onto it. */
export type WorkState = "queued" | "running" | "stalled" | "succeeded" | "failed" | "stopped";

/** One row of background work, whatever produced it. */
export interface WorkItem {
	/** The surface's selection identity; stable across the item's whole life. */
	readonly id: string;
	/** What produced the work: `"explore"`, `"bash"`, `"workflow"`. Shown as the row's kind column. */
	readonly kind: string;
	/** The stable task label — command preview or task title; never the live tool call. */
	readonly label: string;
	readonly state: WorkState;
	readonly startedAt: number;
	readonly endedAt?: number;
	/** Extra metric rendered after elapsed, e.g. `"↓1.2k"`; absent for most kinds. */
	readonly metric?: string;
}

/** The two theme members every formatter needs; a test supplies a plain object. */
export type WorkTheme = Pick<Theme, "fg" | "bold">;

/** Rows shown before the remainder folds into `… N more`. */
export const WORK_SURFACE_MAX_ROWS = 6;
/** Width of the fixed right-hand metric column; content-sized columns jump between renders. */
const METRIC_WIDTH = 16;
/** Kind column width; longer names truncate instead of shifting the row. */
const KIND_WIDTH = 12;

export const WORK_ICONS: Record<WorkState, string> = {
	queued: "·",
	running: "●",
	stalled: "◉",
	succeeded: "✓",
	failed: "×",
	stopped: "■",
};

const ICON_COLOR: Record<WorkState, ThemeColor> = {
	queued: "muted",
	running: "accent",
	stalled: "warning",
	succeeded: "success",
	failed: "error",
	stopped: "muted",
};

export function workIcon(state: WorkState, theme: WorkTheme): string {
	return theme.fg(ICON_COLOR[state], WORK_ICONS[state]);
}

/** 201700 -> "201.7k"; the same compact readout the working indicator uses. */
export function formatWorkTokens(value: number): string {
	if (value <= 0) return "";
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * Fit `value` into `width` display columns, ending in a plain `…`.
 *
 * Deliberately not `truncateToWidth`: that helper wraps its ellipsis in ANSI
 * resets, which would clear a title's own colour mid-row on text that carries
 * no escapes of its own. And not a "…[truncated]" suffix either — a suffix is
 * a second line of text on a surface that has exactly one.
 */
export function fitWorkText(value: string, width: number): string {
	const flat = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
	if (width <= 0) return "";
	if (visibleWidth(flat) <= width) return flat;
	if (width === 1) return "…";
	let used = 0;
	const kept: string[] = [];
	for (const character of Array.from(flat)) {
		const next = visibleWidth(character);
		if (used + next > width - 1) break;
		used += next;
		kept.push(character);
	}
	return `${kept.join("")}…`;
}

/** "12s" / "5m" / "3m01s"; `endedAt` pins a settled item so the clock does not keep running. */
export function formatWorkElapsed(item: Pick<WorkItem, "startedAt" | "endedAt">, now: number): string {
	const seconds = Math.max(0, Math.floor(((item.endedAt ?? now) - item.startedAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}

/** `"12s"` or `"12s · ↓1.2k"`, padded for the fixed right-hand column. */
function metricColumn(item: WorkItem, now: number): string {
	const elapsed = formatWorkElapsed(item, now);
	return item.metric ? `${elapsed} · ${item.metric}` : elapsed;
}

/**
 * One bounded summary line: `● work · 2 running · 1 stalled · 3m`.
 * `worst` prefers running-kind states — a stalled item is more urgent than a
 * failed one, which is already terminal.
 */
export function formatWorkSummary(items: WorkItem[], now: number, title = "work"): string {
	const count = (state: WorkState) => items.filter((item) => item.state === state).length;
	const parts = [
		count("running") > 0 ? `${count("running")} running` : "",
		count("stalled") > 0 ? `${count("stalled")} stalled` : "",
		count("queued") > 0 ? `${count("queued")} queued` : "",
	].filter(Boolean);
	const worst: WorkState =
		count("stalled") > 0 ? "stalled"
		: count("running") > 0 ? "running"
		: items.some((item) => item.state === "failed") ? "failed"
		: items.every((item) => item.state === "queued") ? "queued"
		: "succeeded";
	const eldest = items.reduce((min, item) => Math.min(min, item.startedAt), now);
	return `${WORK_ICONS[worst]} ${title}${parts.length ? ` · ${parts.join(" · ")}` : ""} · ${formatWorkElapsed({ startedAt: eldest }, now)}`;
}

/**
 * One stable row: `● explore      Fit the note format    3m01s · ↓1.2k`.
 * The label column gets what the fixed columns leave; a terminal too narrow
 * for a label drops the label rather than the metric.
 */
export function formatWorkRow(item: WorkItem, theme: WorkTheme, now: number, width: number): string {
	const icon = workIcon(item.state, theme);
	const kind = fitWorkText(item.kind, KIND_WIDTH).padEnd(KIND_WIDTH, " ");
	const metric = metricColumn(item, now).padStart(METRIC_WIDTH, " ");
	const fixed = 1 + visibleWidth(WORK_ICONS[item.state]) + 1 + KIND_WIDTH + 1 + METRIC_WIDTH;
	const label = fitWorkText(item.label, width - fixed - 1);
	const gap = " ".repeat(Math.max(1, width - fixed - visibleWidth(label)));
	const row = ` ${icon} ${theme.fg("accent", kind)} ${theme.fg("toolOutput", label)}${gap}${theme.fg("dim", metric)}`;
	return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
}

/**
 * Widget body: a summary line, up to `WORK_SURFACE_MAX_ROWS` rows, `… N more`
 * for the remainder, then the entry hint. Callers mount this only while items
 * is non-empty.
 */
export function renderWorkSurface(items: WorkItem[], theme: WorkTheme, now: number, width: number, options: { title?: string; hint?: string } = {}): string[] {
	// The summary indents to sit above the icon column, not left of it.
	const lines: string[] = [` ${formatWorkSummary(items, now, options.title ?? "work")}`];
	const shown = items.slice(0, WORK_SURFACE_MAX_ROWS);
	for (const item of shown) lines.push(formatWorkRow(item, theme, now, width));
	if (items.length > shown.length) lines.push(`   … ${items.length - shown.length} more`);
	if (options.hint) lines.push(`   ${options.hint}`);
	return lines;
}

// ---------------------------------------------------------------------------
// Shared reporter: the mount/tick/teardown lifecycle every plugin's widget needs.

/** The part of `ctx.ui` the reporter needs. Structural, so a test needs no real UI. */
export interface WorkSurfaceUI {
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => WorkSurfaceComponent) | undefined,
		options?: { placement?: "belowEditor" },
	): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export type WorkSurfaceComponent = Component & { dispose?(): void };

export interface WorkReporterDeps<T> {
	/** Widget slot key; plugin-namespaced (`"pi-subagent-fleet"`, `"pi-bg-bash"`). */
	readonly key: string;
	/** UI for the session that owns the surface; `undefined` outside TUI mode. */
	ui(): WorkSurfaceUI | undefined;
	/** Items to draw right now, display order. */
	items(): T[];
	/** True while the surface should exist — typically "any running item". */
	live(): boolean;
	/** Summary title ("subagents", "bg jobs") and entry hint for the default renderer. */
	title?: string;
	hint?: string;
	/** Items + theme + clock + width → lines; defaults to `renderWorkSurface` over `WorkItem`s. */
	render?(items: T[], theme: WorkTheme, now: number, width: number): string[];
	/** Per-tick side effects (stall notifications). Runs only while mounted. */
	onTick?(ui: WorkSurfaceUI, now: number): void;
	tickMs?: number;
	now?(): number;
	/** Test seams; the real ones are the globals. */
	schedule?(fn: () => void, ms: number): ReturnType<typeof setInterval>;
	cancel?(handle: ReturnType<typeof setInterval>): void;
}

export interface WorkReporter {
	/** Mount/unmount the widget and start/stop the tick to match `live()`. */
	sync(): void;
	/** Unmount and stop. Safe to call twice, and safe before any mount. */
	dispose(): void;
}

/**
 * The mount/tick lifecycle behind a below-editor widget.
 *
 * The tick does one thing — `tui.requestRender()` — because `render()` reads
 * the clock itself and item state is already kept fresh by whatever updates
 * the records; repainting the mounted component is cheap, so no republish
 * dedupe is needed. Slot claim, interval, and unmount all follow `live()`.
 */
export function createWorkReporter<T>(deps: WorkReporterDeps<T>): WorkReporter {
	const schedule = deps.schedule ?? ((fn, ms) => setInterval(fn, ms));
	const cancel = deps.cancel ?? ((handle) => clearInterval(handle));
	const tickMs = deps.tickMs ?? 1_000;
	const now = deps.now ?? Date.now;
	const renderItems = deps.render ?? ((items, theme, at, width) =>
		renderWorkSurface(items as unknown as WorkItem[], theme, at, width, {
			...(deps.title ? { title: deps.title } : {}),
			...(deps.hint ? { hint: deps.hint } : {}),
		}));

	let timer: ReturnType<typeof setInterval> | undefined;
	let mountedOn: WorkSurfaceUI | undefined;
	let component: WorkSurfaceComponent | undefined;
	let tui: Pick<TUI, "requestRender"> | undefined;
	let theme: WorkTheme | undefined;

	function unmount(): void {
		if (!mountedOn) return;
		try {
			mountedOn.setWidget(deps.key, undefined);
		} catch {
			// A host may tear its UI down mid-settlement; the widget is best-effort.
		}
		mountedOn = undefined;
		component = undefined;
		tui = undefined;
		theme = undefined;
	}

	function mount(ui: WorkSurfaceUI): void {
		if (mountedOn) return;
		component = {
			render(width: number): string[] {
				const items = deps.items();
				// `theme` arrives with the factory call, which precedes any render.
				if (items.length === 0 || !theme) return [];
				return renderItems(items, theme, now(), width).map((line) => truncateToWidth(line, width));
			},
			invalidate(): void {},
			dispose(): void {},
		};
		try {
			ui.setWidget(
				deps.key,
				(tuiInstance, themeInstance) => {
					tui = tuiInstance;
					theme = themeInstance;
					return component!;
				},
				{ placement: "belowEditor" },
			);
			mountedOn = ui;
		} catch {
			component = undefined;
		}
	}

	function tick(): void {
		try {
			tui?.requestRender();
		} catch {
			// Rendering must never stop the clock or the work it watches.
		}
		if (mountedOn && deps.onTick) {
			try {
				deps.onTick(mountedOn, now());
			} catch {
				// A side effect (notify) must never take the ticker down with it.
			}
		}
	}

	return {
		sync(): void {
			const ui = deps.ui();
			if (deps.live() && ui) {
				mount(ui);
				if (timer === undefined) {
					timer = schedule(tick, tickMs);
					(timer as { unref?: () => void }).unref?.();
				}
			} else {
				if (timer !== undefined) {
					cancel(timer);
					timer = undefined;
				}
				unmount();
			}
		},
		dispose(): void {
			if (timer !== undefined) {
				cancel(timer);
				timer = undefined;
			}
			unmount();
		},
	};
}
