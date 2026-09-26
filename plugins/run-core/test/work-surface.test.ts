import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createWorkReporter,
	fitWorkText,
	formatWorkElapsed,
	formatWorkRow,
	formatWorkSummary,
	formatWorkTokens,
	renderWorkSurface,
	workIcon,
	type WorkItem,
	type WorkTheme,
} from "../src/work-surface.ts";

const NOW = 1_700_000_000_000;

const THEME: WorkTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function item(partial: Partial<WorkItem> = {}): WorkItem {
	return {
		id: partial.id ?? "w1",
		kind: partial.kind ?? "explore",
		label: partial.label ?? "Fit the note format",
		state: partial.state ?? "running",
		startedAt: partial.startedAt ?? NOW - 5_000,
		...(partial.endedAt !== undefined ? { endedAt: partial.endedAt } : {}),
		...(partial.metric !== undefined ? { metric: partial.metric } : {}),
	};
}

describe("the shared work row", () => {
	test("shows the stable label, kind, elapsed and metric", () => {
		const row = formatWorkRow(
			item({ kind: "explore", label: "Find the reducer", metric: "↓1.2k", startedAt: NOW - 181_000 }),
			THEME, NOW, 80,
		);
		expect(row).toContain("explore");
		expect(row).toContain("Find the reducer");
		expect(row).toContain("3m1s");
		expect(row).toContain("↓1.2k");
		expect(visibleWidth(row)).toBeLessThanOrEqual(80);
	});

	test("a settled item's elapsed is pinned to endedAt, not the clock", () => {
		const done = item({ state: "succeeded", startedAt: NOW - 60_000, endedAt: NOW - 10_000 });
		const row = formatWorkRow(done, THEME, NOW + 3_600_000, 80);
		expect(row).toContain("50s");
		expect(row).not.toContain("60m");
	});

	test("every line fits the width, including a wide-character label", () => {
		const wide = item({ label: "看看这个中文字符串有多长需要截断处理才行呢", startedAt: NOW - 5_000 });
		for (const width of [10, 24, 40, 80]) {
			expect(visibleWidth(formatWorkRow(wide, THEME, NOW, width))).toBeLessThanOrEqual(width);
		}
	});

	test("row count is bounded and the remainder is named", () => {
		const items = Array.from({ length: 9 }, (_, i) => item({ id: `w${i}` }));
		const lines = renderWorkSurface(items, THEME, NOW, 80, { title: "work", hint: "/work" });
		expect(lines.length).toBeLessThanOrEqual(1 + 6 + 1 + 1);
		expect(lines.at(-2)).toContain("… 3 more");
		expect(lines.at(-1)).toContain("/work");
	});
});

describe("the shared work summary", () => {
	test("names running, stalled and queued counts and the eldest age", () => {
		const summary = formatWorkSummary([
			item({ id: "a", state: "running", startedAt: NOW - 70_000 }),
			item({ id: "b", state: "stalled", startedAt: NOW - 300_000 }),
			item({ id: "c", state: "succeeded", startedAt: NOW - 400_000, endedAt: NOW - 350_000 }),
		], NOW, "subagents");
		expect(summary).toContain("1 running");
		expect(summary).toContain("1 stalled");
		expect(summary).toContain("subagents");
		// The eldest start is 400s ago — Math.min, not the newest.
		expect(summary).toContain("6m40s");
		expect(summary.startsWith("◉")).toBe(true);
	});

	test("the worst state marker prefers stalled over running over failed", () => {
		expect(formatWorkSummary([item({ state: "failed" }), item({ state: "stalled" })], NOW).startsWith("◉")).toBe(true);
		expect(formatWorkSummary([item({ state: "failed" }), item({ state: "succeeded" })], NOW).startsWith("×")).toBe(true);
	});
});

describe("shared text helpers", () => {
	test("workIcon colours by state", () => {
		const seen: string[] = [];
		const theme: WorkTheme = { fg: (color, text) => { seen.push(String(color)); return text; }, bold: (t) => t };
		expect(workIcon("stalled", theme)).toBe("◉");
		expect(workIcon("failed", theme)).toBe("×");
		expect(seen).toEqual(["warning", "error"]);
	});

	test("formatWorkElapsed compacts minutes and pins endedAt", () => {
		expect(formatWorkElapsed({ startedAt: NOW - 5_000 }, NOW)).toBe("5s");
		expect(formatWorkElapsed({ startedAt: NOW - 300_000 }, NOW)).toBe("5m");
		expect(formatWorkElapsed({ startedAt: NOW - 61_000, endedAt: NOW - 20_000 }, NOW + 9_999_999)).toBe("41s");
	});

	test("formatWorkTokens compacts large counts", () => {
		expect(formatWorkTokens(0)).toBe("");
		expect(formatWorkTokens(850)).toBe("850");
		expect(formatWorkTokens(201_700)).toBe("201.7k");
	});

	test("fitWorkText measures display columns and strips control characters", () => {
		expect(visibleWidth(fitWorkText("中文标题测试截断", 8))).toBeLessThanOrEqual(8);
		expect(fitWorkText("a\nb\td", 20)).toBe("a b d");
		expect(fitWorkText("hello", 40)).toBe("hello");
		expect(fitWorkText("hello", 0)).toBe("");
	});
});

describe("createWorkReporter", () => {
	function harness() {
		const calls: Array<{ key: string; defined: boolean }> = [];
		const ui = {
			setWidget(key: string, content: unknown) { calls.push({ key, defined: content !== undefined }); },
			notify() {},
		};
		const timers: Array<{ fn: () => void; unref: () => void; wasUnref: () => boolean }> = [];
		const harness = {
			ui, calls, timers,
			schedule: (fn: () => void) => {
				let flagged = false;
				const t = { fn, unref: () => { flagged = true; }, wasUnref: () => flagged };
				timers.push(t);
				return t as unknown as ReturnType<typeof setInterval>;
			},
			cancel: (t: ReturnType<typeof setInterval>) => { const i = timers.indexOf(t as unknown as { fn: () => void; unref: () => void; wasUnref: () => boolean }); if (i >= 0) timers.splice(i, 1); },
		};
		return harness;
	}

	test("claims the widget slot only while live, then hands it back", () => {
		const { ui, calls, timers, schedule, cancel } = harness();
		let live = false;
		const items: WorkItem[] = [];
		const reporter = createWorkReporter<WorkItem>({ key: "k", ui: () => ui as never, items: () => items, live: () => live, schedule, cancel });
		reporter.sync();
		expect(calls.length).toBe(0);
		live = true;
		items.push(item());
		reporter.sync();
		expect(calls.at(-1)).toEqual({ key: "k", defined: true });
		expect(timers.length).toBe(1);
		live = false;
		reporter.sync();
		expect(calls.at(-1)).toEqual({ key: "k", defined: false });
		expect(timers.length).toBe(0);
		reporter.dispose();
	});

	test("the timer is unref'd and onTick runs only while mounted", () => {
		const { ui, timers, schedule, cancel } = harness();
		let live = true;
		const ticks: number[] = [];
		const reporter = createWorkReporter<WorkItem>({
			key: "k", ui: () => ui as never, items: () => [item()], live: () => live,
			onTick: (_ui, at) => { ticks.push(at); }, now: () => 42, schedule, cancel,
		});
		reporter.sync();
		expect(timers[0].wasUnref()).toBe(true);
		timers[0].fn();
		expect(ticks).toEqual([42]);
		live = false;
		reporter.sync();
		reporter.dispose();
	});

	test("a missing UI mounts nothing and dispose is idempotent", () => {
		const { schedule, cancel } = harness();
		const reporter = createWorkReporter<WorkItem>({ key: "k", ui: () => undefined, items: () => [item()], live: () => true, schedule, cancel });
		reporter.sync();
		reporter.dispose();
		reporter.dispose();
	});
});
