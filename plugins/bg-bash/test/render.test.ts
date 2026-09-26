/**
 * Presentation of the completion follow-up.
 *
 * The model-facing content is deliberately *not* restructured: these tests pin
 * both halves at once — that the message the model reads still says exactly what
 * it always said, and that the terminal view is no longer that message. The
 * messages here are built through the real `formatCompletionMessage` and
 * `detailsFor`, so a change to either side of that format fails here rather than
 * silently falling back to the raw report.
 */

import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { JobRegistry, type Job } from "../src/core/jobs.ts";
import type { RunOutcome } from "../src/core/types.ts";
import { detailsFor, formatCompletionMessage, formatForegroundOutput } from "../src/pi/format.ts";
import { COMPLETION_PREVIEW_LINES, renderCompletion, renderStatusEntry } from "../src/pi/render.ts";

type RendererMessage = Parameters<typeof renderCompletion>[0];

/** The renderer only reads `fg`/`bg`/`bold`; the real Theme adds nothing here. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const SUCCESS: RunOutcome = { exitCode: 0, timedOut: false, aborted: false, killed: false };

function finishedJob(output: string, outcome: RunOutcome = SUCCESS, command = "echo hello"): Job {
	const registry = new JobRegistry();
	const job = registry.create({ command, cwd: "/tmp", mode: "background", now: 1_000 });
	job.output.append(output);
	registry.finish(job.id, outcome);
	// Pin the duration; `finish` stamps the wall clock, which is not under test.
	job.endedAt = job.startedAt + 1_200;
	return job;
}

function messageFor(job: Job): RendererMessage {
	return {
		role: "custom",
		customType: "bg_bash_result",
		content: formatCompletionMessage(job),
		display: true,
		details: detailsFor(job),
		timestamp: 0,
	} as RendererMessage;
}

function render(message: RendererMessage, expanded = false, width = 120): string {
	const component = renderCompletion(message, { expanded, outputPad: 1 }, theme);
	if (!component) throw new Error("the renderer declined a message it wrote");
	return component.render(width).join("\n");
}

describe("model-facing text", () => {
	test("a truncated foreground result keeps the log pointer on the result itself", () => {
		const lines = Array.from({ length: 2_100 }, (_, i) => `line-${String(i + 1).padStart(4, "0")}`);
		const job = finishedJob(lines.join("\n"));
		job.logPath = "/tmp/bg001.log";
		const tail = lines.slice(100).join("\n");
		expect(formatForegroundOutput(job)).toBe(
			`${tail}\n\n[Showing lines 101-2100 of 2100. Full output: /tmp/bg001.log]`,
		);
	});
});

describe("completion rendering", () => {
	test("an interrupted record without an end renders unknown duration", () => {
		const view = renderStatusEntry({
			type: "custom", customType: "bg_bash_completion",
			data: { schema: 1, id: "bg004", mode: "background", status: "interrupted", startedAt: 1_000, exitCode: null },
		} as any, { expanded: false }, theme)?.render(120).join("\n");
		expect(view).toContain("tracking interrupted · bg004 · unknown");
		expect(view).not.toContain("0.0s");
	});

	test("the terminal view is a status line, a command, and the output — not the report", () => {
		const job = finishedJob("one\ntwo\nthree\n", SUCCESS, "echo one");
		const message = messageFor(job);

		const view = render(message);
		expect(view).toContain("finished");
		expect(view).toContain("bg001");
		expect(view).toContain("1.2s");
		expect(view).toContain("exit 0");
		expect(view).toContain("$ echo one");
		expect(view).toContain("three");
		// The status sentence and the `Command:` label are replaced, not echoed.
		expect(view).not.toContain("Background bash job");
		expect(view).not.toContain("Command: echo one");

		// The model still reads the sentence and the label.
		expect(String(message.content)).toContain(
			"Background bash job bg001 finished after 1.2s (exit code 0).\nCommand: echo one\n",
		);
	});

	test("output past the preview is hidden behind an expand hint and shown when expanded", () => {
		const lines = Array.from({ length: COMPLETION_PREVIEW_LINES + 10 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`);
		const message = messageFor(finishedJob(`${lines.join("\n")}\n`));

		const collapsed = render(message);
		expect(collapsed).toContain("line-30");
		expect(collapsed).not.toContain("line-01");
		expect(collapsed).toContain("10 earlier lines hidden");

		const expanded = render(message, true);
		expect(expanded).toContain("line-01");
		expect(expanded).toContain("line-30");
		expect(expanded).not.toContain("earlier lines hidden");
	});

	test("a truncated result shows the log pointer once, as a warning instead of as output", () => {
		const lines = Array.from({ length: 2_100 }, (_, i) => `line-${String(i + 1).padStart(4, "0")}`);
		const job = finishedJob(lines.join("\n"));
		job.logPath = "/tmp/bg001.log";
		const message = messageFor(job);

		// The model's report is byte-for-byte the flat string it always was.
		const tail = lines.slice(100).join("\n");
		expect(String(message.content)).toBe(
			[
				"Background bash job bg001 finished after 1.2s (exit code 0).",
				"Command: echo hello",
				`${tail}\n\n[Showing lines 101-2100 of 2100. Full output: /tmp/bg001.log]`,
			].join("\n"),
		);

		const view = render(message);
		expect(view.match(/Showing lines/g)).toHaveLength(1);
		expect(view).toContain("Full output: /tmp/bg001.log");
		// The preview keeps the tail, like pi's own bash view.
		expect(view).toContain("line-2100");
		expect(view).not.toContain("line-0101");
	});

	test("each terminal status reads as a word a person recognises", () => {
		const killed = render(messageFor(finishedJob("", { exitCode: null, timedOut: false, aborted: false, killed: true })));
		expect(killed).toContain("stopped");

		const timedOut = render(messageFor(finishedJob("", { exitCode: null, timedOut: true, aborted: false, killed: false })));
		expect(timedOut).toContain("timed out");

		const failed = render(messageFor(finishedJob("boom\n", { exitCode: 3, timedOut: false, aborted: false, killed: false })));
		expect(failed).toContain("failed");
		expect(failed).toContain("exit 3");
	});

	test("a message without usable details falls back to pi's default rendering", () => {
		const message = messageFor(finishedJob("hello\n"));
		expect(renderCompletion({ ...message, details: undefined } as RendererMessage, { expanded: false, outputPad: 1 }, theme)).toBeUndefined();
		expect(
			renderCompletion({ ...message, details: { jobId: "bg001" } } as unknown as RendererMessage, { expanded: false, outputPad: 1 }, theme),
		).toBeUndefined();
	});

	test("content this plugin did not write is shown whole rather than mis-split", () => {
		const message = messageFor(finishedJob("hello\n"));
		const foreign = { ...message, content: "some other extension's text" } as RendererMessage;
		expect(render(foreign)).toContain("some other extension's text");
	});
});
