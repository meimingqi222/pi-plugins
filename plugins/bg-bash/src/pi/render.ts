/**
 * TUI presentation of the completion follow-up.
 *
 * The follow-up *content* is deliberately untouched: the model still reads the
 * same flat report. Only the terminal view is reshaped, because that report is
 * a poor thing to look at — a status sentence, a `Command:` label, raw output
 * run through the markdown renderer, and the truncation footer inline. A person
 * sees the same facts as a status line, a `$ command` line, a bounded preview,
 * and a warning that points at the log.
 *
 * `details` carries everything except the output tail; the tail is recovered
 * from the content by the exact prefix `formatCompletionMessage` wrote. When the
 * message does not look like one this plugin wrote, the renderer declines and
 * pi falls back to its default custom-message view.
 */

import {
	keyText,
	truncateToVisualLines,
	type MessageRenderer,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { JobStatus } from "../core/types.ts";
import { formatDuration, splitCompletionContent, type BgBashDetails } from "./format.ts";

/** Output lines kept in the collapsed view, matching pi's own bash-execution view. */
export const COMPLETION_PREVIEW_LINES = 20;

const STATUS: Record<JobStatus, { label: string; color: ThemeColor }> = {
	running: { label: "still running", color: "accent" },
	exited: { label: "finished", color: "success" },
	failed: { label: "failed", color: "error" },
	killed: { label: "stopped", color: "warning" },
	timedout: { label: "timed out", color: "warning" },
};

export const renderCompletion: MessageRenderer<BgBashDetails> = (message, { expanded, outputPad }, theme) => {
	const details = message.details;
	if (!renderable(details)) return undefined;
	const status = STATUS[details.status];
	const { output: body, notice } = splitCompletionContent(contentText(message.content), details);
	// Command output almost always ends in a newline; keeping it would put a
	// blank line under every preview and count a phantom line as hidden.
	const output = body.trimEnd();

	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(headerLine(details, status, theme), 0, 0));
	box.addChild(new Text(theme.fg("bashMode", theme.bold(`$ ${details.command}`)), 0, 0));
	if (output) {
		box.addChild(
			expanded
				? new Text(`\n${styleLines(output, theme)}`, 0, 0)
				: new OutputPreview(output, theme),
		);
	}
	if (notice) box.addChild(new Text(`\n${theme.fg("warning", notice)}`, 0, 0));
	return box;
};

/**
 * A message is only rendered when its details still describe a job.
 *
 * Details are persisted with the message and read back on session reload, so
 * they can predate a field or come from another extension entirely; anything
 * unrecognised is left to pi's default rendering instead of being guessed at.
 */
function renderable(details: BgBashDetails | undefined): details is BgBashDetails {
	return Boolean(
		details &&
			typeof details.jobId === "string" &&
			typeof details.command === "string" &&
			typeof details.status === "string" &&
			details.status in STATUS &&
			typeof details.durationMs === "number" &&
			Number.isFinite(details.durationMs),
	);
}

/** `finished · bg001 · 1.2s · exit 1` — the facts the model's sentence carries. */
function headerLine(
	details: BgBashDetails,
	status: { label: string; color: ThemeColor },
	theme: Theme,
): string {
	const meta = [details.jobId, formatDuration(details.durationMs)];
	if (typeof details.exitCode === "number") meta.push(`exit ${details.exitCode}`);
	return theme.fg(status.color, status.label) + theme.fg("muted", ` · ${meta.join(" · ")}`);
}

function styleLines(text: string, theme: Theme): string {
	return text
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
}

/**
 * Width-aware preview of the output tail.
 *
 * Rendering is cached per width: pi re-renders the transcript on every
 * keystroke, and re-wrapping a 2000-line tail each time is what makes a long
 * completion feel like a frozen terminal.
 */
class OutputPreview implements Component {
	private width: number | undefined;
	private lines: string[] | undefined;

	constructor(
		private readonly output: string,
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		this.width = undefined;
		this.lines = undefined;
	}

	render(width: number): string[] {
		if (this.lines === undefined || this.width !== width) {
			const { visualLines, skippedCount } = truncateToVisualLines(
				styleLines(this.output, this.theme),
				COMPLETION_PREVIEW_LINES,
				width,
			);
			const hint = skippedCount > 0 ? [truncateToWidth(this.hint(skippedCount), width, "…")] : [];
			this.lines = [...hint, ...visualLines];
			this.width = width;
		}
		return this.lines;
	}

	private hint(skipped: number): string {
		const keys = keyText("app.tools.expand");
		const how = keys ? `${keys} to expand` : "expand to see all";
		return this.theme.fg(
			"muted",
			`… ${skipped} earlier ${skipped === 1 ? "line" : "lines"} hidden · ${how}`,
		);
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				Boolean(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
