import { describe, expect, test } from "bun:test";
import { createWorkflowsPanel } from "../src/pi/panel.ts";
import type { RunRecord } from "../src/runs/registry.ts";

const NOW = 1_700_000_000_000;

function running(patch: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "wf_a",
		name: "inline",
		status: "running",
		startedAt: NOW - 12_000,
		progress: {
			schemaVersion: 1,
			runId: "wf_a",
			name: "inline",
			status: "running",
			startedAt: NOW - 12_000,
			updatedAt: NOW - 500,
			currentPhase: "review",
			// A wide-character label: clipping by code units would cut a character
			// in half and desynchronise the terminal.
			agents: [{ id: "a1", label: "审查-plugin", status: "running", startedAt: NOW - 12_000 }],
			completedAgents: 0,
			totalAgents: 1,
			spentTokens: 10,
		},
		...patch,
	};
}

function harness(records: RunRecord[]) {
	const renders: number[] = [];
	let stopped = 0;
	let closed = 0;
	const panel = createWorkflowsPanel(
		{
			tui: { requestRender: () => renders.push(renders.length) },
			list: () => records,
			stopAll: () => {
				stopped += 1;
			},
			now: () => NOW,
			tickMs: 60_000,
		},
		() => {
			closed += 1;
		},
	);
	return { panel, renders, stopped: () => stopped, closed: () => closed };
}

describe("the live panel", () => {
	test("renders the same liveness text as the status tool, width-clipped", () => {
		const { panel } = harness([running()]);
		const lines = panel.render(80);
		const text = lines.join("\n");
		expect(text).toContain("Active workflows (1):");
		expect(text).toContain("phase: review");
		expect(text).toContain("running now:");
		expect(text).toContain("q / Esc close");

		// Every line fits: an over-long line wraps in the terminal and breaks the
		// frame the overlay is drawn in.
		for (const width of [10, 24, 40]) {
			for (const line of panel.render(width)) {
				expect(visibleColumns(line)).toBeLessThanOrEqual(width);
			}
		}
		panel.dispose?.();
	});

	test("closes on q and on Esc, and stops all runs on s", () => {
		const first = harness([running()]);
		first.panel.handleInput?.("q");
		expect(first.closed()).toBe(1);

		const second = harness([running()]);
		second.panel.handleInput?.("\x1b");
		expect(second.closed()).toBe(1);

		const third = harness([running()]);
		third.panel.handleInput?.("s");
		expect(third.stopped()).toBe(1);
		// Stopping is not closing: the panel stays up to show the run end.
		expect(third.closed()).toBe(0);
		third.panel.dispose?.();
	});

	test("ignores key-release events", () => {
		const { panel, closed, renders } = harness([running()]);
		// Kitty protocol sends release events for the same key; acting on one would
		// close the panel on key-up.
		panel.handleInput?.("\x1b[113;1:3u");
		expect(closed()).toBe(0);

		panel.handleInput?.("r");
		expect(renders.length).toBeGreaterThan(0);
		panel.dispose?.();
	});
});

/** Display width in terminal columns: CJK and other wide characters take two. */
function visibleColumns(line: string): number {
	let columns = 0;
	for (const char of stripAnsi(line)) {
		const code = char.codePointAt(0)!;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1f64f);
		columns += wide ? 2 : 1;
	}
	return columns;
}

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}
