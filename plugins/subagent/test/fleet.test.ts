import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { deriveChildState, formatBackground, QUIET_ACTIVITY_WARNING_MS, type BackgroundRecord } from "../src/background.ts";
import {
	fit,
	formatChildDetail,
	formatFleetSummary,
	formatPanelRow,
	formatTokens,
	renderFleetWidget,
	type FleetTheme,
} from "../src/fleet.ts";

const theme: FleetTheme = { fg: (_color, text) => text, bold: (text) => text };
const NOW = 1_000_000;

function record(partial: Partial<BackgroundRecord> = {}): BackgroundRecord {
	return {
		id: "sa-1",
		agent: "explore",
		task: "Inspect the runner",
		sessionId: "session-a",
		status: "running",
		startedAt: NOW - 30_000,
		...partial,
	};
}

describe("deriveChildState", () => {
	test("settled statuses pass through unchanged", () => {
		for (const status of ["completed", "failed", "aborted"] as const) {
			expect(deriveChildState(record({ status }), NOW)).toBe(status);
		}
	});

	test("a running child is stalled only at the threshold", () => {
		const progress = { completedTools: 1, recentTools: [], phase: "tool" as const, lastActivityAt: NOW - QUIET_ACTIVITY_WARNING_MS + 1, lastEvent: "tool_end", recentActivity: [] };
		expect(deriveChildState(record({ progress }), NOW)).toBe("running");
		progress.lastActivityAt = NOW - QUIET_ACTIVITY_WARNING_MS;
		expect(deriveChildState(record({ progress }), NOW)).toBe("stalled");
	});

	test("a child that never emitted progress is quiet since its start", () => {
		expect(deriveChildState(record({ startedAt: NOW - 10_000 }), NOW)).toBe("running");
		expect(deriveChildState(record({ startedAt: NOW - QUIET_ACTIVITY_WARNING_MS }), NOW)).toBe("stalled");
	});
});

describe("formatBackground shares the stall derivation", () => {
	test("the model-facing line and the widget state agree on a stalled child", () => {
		const stalled = record({ startedAt: NOW - QUIET_ACTIVITY_WARNING_MS });
		expect(formatBackground(stalled)).toContain("possible stall");
		expect(deriveChildState(stalled, Date.now())).toBe("stalled");

		const fresh = record({ startedAt: Date.now() });
		expect(formatBackground(fresh)).not.toContain("possible stall");
	});
});

describe("fit", () => {
	test("measures display columns, not string length", () => {
		// Each CJK glyph occupies two columns: five glyphs do not fit width 6.
		expect(fit("一二三四五", 6)).toBe("一二…");
		expect(fit("ab", 4)).toBe("ab");
		expect(fit("abcdef", 4)).toBe("abc…");
	});

	test("strips control characters and never emits ANSI", () => {
		expect(fit("a\tb\rc", 10)).toBe("a b c");
		expect(fit("a [31mx", 20)).toContain("[31m");
	});
});

describe("widget rows", () => {
	test("shows the task, not the live tool call", () => {
		const progress = {
			completedTools: 2,
			recentTools: ["grep"],
			phase: "tool" as const,
			lastActivityAt: NOW - 500,
			lastEvent: "tool_start",
			recentActivity: [],
			activeTool: "grep src/auth.ts",
		};
		const line = renderFleetWidget([record({ progress })], theme, NOW, 80).join("\n");
		expect(line).toContain("Inspect the runner");
		expect(line).not.toContain("grep src/auth.ts");
	});

	test("row count is bounded and the remainder is named", () => {
		const records = Array.from({ length: 9 }, (_, index) => record({ id: `sa-${index}`, task: `task ${index}` }));
		const lines = renderFleetWidget(records, theme, NOW, 80);
		// summary + 6 rows + "… 3 more" + hint = 9 lines for 9 records.
		expect(lines).toHaveLength(9);
		expect(lines.at(-2)).toContain("… 3 more");
		expect(lines.at(-1)).toContain("/subagents");
	});

	test("every line fits the width, including a wide-character task", () => {
		for (const width of [10, 24, 40]) {
			const lines = renderFleetWidget([record({ task: "修复中文标题很长的任务超过宽度时应当裁剪" })], theme, NOW, width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("panel rows", () => {
	test("show live activity the stable row omits", () => {
		const progress = {
			completedTools: 2,
			recentTools: ["grep"],
			phase: "tool" as const,
			lastActivityAt: NOW - 500,
			lastEvent: "tool_start",
			recentActivity: [],
			activeTool: "grep src/auth.ts",
		};
		const line = formatPanelRow(record({ progress }), false, theme, NOW, 80);
		expect(line).toContain("tool grep src/auth.ts");
		expect(line).toContain("Inspect the runner");
	});

	test("the rail marks the selected row", () => {
		const selected = formatPanelRow(record(), true, theme, NOW, 80);
		const idle = formatPanelRow(record(), false, theme, NOW, 80);
		expect(selected).toContain("›");
		expect(idle).not.toContain("›");
	});
});

describe("formatFleetSummary", () => {
	test("names running and stalled counts and the eldest age", () => {
		const records = [
			record({ id: "sa-a", startedAt: NOW - 70_000 }),
			record({ id: "sa-b", startedAt: NOW - 200_000 }),
			record({ id: "sa-c", status: "completed", startedAt: NOW - 300_000, finishedAt: NOW - 250_000 }),
		];
		const summary = formatFleetSummary(records, NOW);
		expect(summary).toContain("1 running");
		expect(summary).toContain("1 stalled");
		expect(summary).toContain("5m");
	});
});

describe("formatTokens", () => {
	test("compacts large counts", () => {
		expect(formatTokens(0)).toBe("");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(201_700)).toBe("201.7k");
		expect(formatTokens(2_500_000)).toBe("2.5m");
	});
});

describe("formatChildDetail", () => {
	test("shows the task and the metadata trail, never raw output rows", () => {
		const progress = {
			completedTools: 1,
			recentTools: ["grep"],
			phase: "tool" as const,
			lastActivityAt: NOW - 1_000,
			lastEvent: "tool_start",
			recentActivity: [{ event: "tool_start", phase: "tool" as const, at: NOW - 1_000, toolName: "read", target: "src/index.ts" }],
		};
		const lines = formatChildDetail(
			record({
				progress,
				status: "completed",
				finishedAt: NOW - 500,
				result: {
					content: [{ type: "text", text: "answer" }],
					details: {
						agent: "explore",
						status: "completed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, totalTokens: 15 },
						output: "answer text",
					},
				},
			}),
			theme,
			NOW,
		).join("\n");
		expect(lines).toContain("Inspect the runner");
		expect(lines).toContain("Recent activity");
		expect(lines).toContain("answer text");
		expect(lines).not.toContain("prompts");
	});

	test("bounds a huge result body", () => {
		const lines = formatChildDetail(
			record({
				status: "completed",
				result: {
					content: [{ type: "text", text: "x" }],
					details: { agent: "explore", status: "completed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 }, output: "y".repeat(50_000) },
				},
			}),
			theme,
			NOW,
		).join("\n");
		expect(lines.length).toBeLessThan(100_000);
		expect(lines).toContain("…");
	});
});
