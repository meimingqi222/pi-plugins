/**
 * `fleet.ts` — pure rendering for the subagent liveness surfaces.
 *
 * The widget row and summary are the shared background-work surface
 * (`pi-run-core`'s `work-surface.ts`): a `Lane` maps onto a
 * `WorkItem`, and the shared renderer draws it, so `pi-subagent` and
 * `pi-bg-bash` can never drift on what "still running" looks like. What stays
 * here is the mapping — `deriveChildState` is the state oracle every surface
 * shares — plus the two renderers the shared file does not own: the opened
 * panel row (which carries live activity the stable row omits) and the detail
 * view. Nothing here touches a clock, a file, or a terminal: records and a
 * `now` go in, display columns come out.
 */

import {
	fitWorkText,
	formatWorkElapsed,
	formatWorkRow,
	formatWorkSummary,
	formatWorkTokens,
	renderWorkSurface,
	WORK_ICONS,
	workIcon,
	type WorkItem,
	type WorkState,
	type WorkTheme,
} from "pi-run-core";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { deriveChildState, formatBackground, formatDuration, type ChildState } from "./background.ts";
import type { Lane } from "./lane.ts";
import { formatActivity } from "./tool.ts";

/** The two members every formatter needs; a test supplies a plain object. */
export type FleetTheme = WorkTheme;

/** Rows the widget shows before folding the remainder into `… N more`. */
export const WIDGET_MAX_ROWS = 6;
/** Detail-view text is capped for the same reason tool output is. */
const DETAIL_OUTPUT_MAX_CHARS = 8_000;
const DETAIL_ACTIVITY_LINES = 10;

const STATE_TO_WORK: Record<ChildState, WorkState> = {
	running: "running",
	idle: "idle",
	stalled: "stalled",
	completed: "succeeded",
	failed: "failed",
	aborted: "stopped",
};

export const ICONS: Record<ChildState, string> = {
	running: WORK_ICONS.running,
	idle: WORK_ICONS.idle,
	stalled: WORK_ICONS.stalled,
	completed: WORK_ICONS.succeeded,
	failed: WORK_ICONS.failed,
	aborted: WORK_ICONS.stopped,
};

export function stateIcon(state: ChildState, theme: FleetTheme): string {
	return workIcon(STATE_TO_WORK[state], theme);
}

export const formatTokens = formatWorkTokens;
export const fit = fitWorkText;

function outputTokens(record: Lane): number {
	return record.result?.details?.usage?.output ?? 0;
}

/** A child as shared work: kind = alias (the human name), label = task, metric = output tokens. */
export function toWorkItem(record: Lane, now: number): WorkItem {
	const tokens = outputTokens(record);
	return {
		id: record.id,
		kind: record.alias || record.agent,
		label: record.task,
		state: STATE_TO_WORK[deriveChildState(record, now)],
		startedAt: record.startedAt,
		endedAt: record.finishedAt,
		metric: tokens > 0 ? `↓${formatWorkTokens(tokens)}` : undefined,
	};
}

/** One bounded summary line: `◉ subagents · 1 running · 1 stalled · 3m`. */
export function formatFleetSummary(records: Lane[], now: number): string {
	return formatWorkSummary(records.map((record) => toWorkItem(record, now)), now, "subagents");
}

/**
 * One stable row for the widget: `● explore    Fit the note format   3m01s · ↓1.2k`.
 * Live activity is deliberately absent — it belongs to the opened panel row.
 */
export function formatWidgetRow(record: Lane, theme: FleetTheme, now: number, width: number): string {
	return formatWorkRow(toWorkItem(record, now), theme, now, width);
}

/**
 * Widget body: `… N more` when there are more live children than rows, then the
 * entry hint. Callers mount this only while records is non-empty.
 */
export function renderFleetWidget(records: Lane[], theme: FleetTheme, now: number, width: number): string[] {
	const lines = renderWorkSurface(records.map((record) => toWorkItem(record, now)), theme, now, width, {
		title: "subagents",
		hint: "/subagents · ctrl+shift+a",
	});
	// Clip defensively so the component stays a thin repaint wrapper and the
	// string surface alone is what a test needs.
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

/**
 * One row for the `/subagents live` list. Unlike the widget row this surface is
 * opened deliberately, so it carries live detail — current tool or latest
 * event — that the stable row deliberately omits.
 */
export function formatPanelRow(record: Lane, selected: boolean, theme: FleetTheme, now: number, width: number): string {
	const state = deriveChildState(record, now);
	const rail = selected ? theme.bold(theme.fg("accent", "›")) : " ";
	const progress = record.progress;
	const live =
		state === "running" || state === "stalled"
			? (progress?.activeTool ? `tool ${progress.activeTool}` : progress?.lastEvent) ?? "starting"
			: state === "idle"
				? "idle — awaiting a reply"
				: undefined;
	const detail = [record.agent, live, `${formatDuration(Math.floor(((record.finishedAt ?? now) - record.startedAt) / 1_000))}`]
		.filter(Boolean)
		.join(" · ");
	const text = `${rail} ${stateIcon(state, theme)} ${theme.fg("toolOutput", fit(record.task, width - 4))} ${theme.fg("dim", detail)}`;
	return truncateToWidth(text, width, "…");
}

/** `/subagents` (no args): the model's own `formatBackground` lines, so the human and the tool read the same truth. */
export function formatFleetListing(records: Lane[]): string {
	if (records.length === 0) return "No background subagent tasks in this session.";
	return records.map((record) => `- ${formatBackground(record)}`).join("\n");
}

/**
 * The detail view for one child. Metadata only — prompt, tool arguments and
 * output stay in the raw log, which the panel opens explicitly via `l`.
 */
export function formatChildDetail(record: Lane, theme: FleetTheme, now: number): string[] {
	const state = deriveChildState(record, now);
	const lines: string[] = [
		`${stateIcon(state, theme)} ${theme.bold(record.alias || record.agent)}  ${theme.fg("muted", `${record.agent} · ${record.id}`)}`,
		"",
		theme.fg("muted", "Task"),
		...record.task.split("\n").map((line) => `  ${theme.fg("dim", line)}`),
		"",
	];
	if (record.progress?.recentActivity.length) {
		lines.push(theme.fg("muted", "Recent activity"));
		for (const event of record.progress.recentActivity.slice(-DETAIL_ACTIVITY_LINES)) {
			lines.push(`  ${theme.fg("dim", formatActivity(event))}`);
		}
		lines.push("");
	}
	const usage = record.result?.details?.usage;
	if (usage && usage.totalTokens > 0) {
		lines.push(theme.fg("muted", "Usage"), `  ${theme.fg("dim", `in:${usage.input} out:${usage.output} cache:${usage.cacheRead}+${usage.cacheWrite} $${usage.cost.toFixed(4)}`)}`, "");
	}
	const output = record.result?.details?.output ?? record.errorMessage;
	if (output) {
		lines.push(theme.fg("muted", record.errorMessage && !record.result ? "Error" : "Output"));
		const bounded = output.length > DETAIL_OUTPUT_MAX_CHARS ? `${output.slice(0, DETAIL_OUTPUT_MAX_CHARS)}\n…` : output;
		for (const line of bounded.split("\n")) lines.push(`  ${theme.fg("toolOutput", line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, " "))}`);
		lines.push("");
	}
	lines.push(theme.fg("muted", record.status === "running" ? "l raw log tail · Esc back · q close" : "Esc back · q close"));
	return lines;
}
