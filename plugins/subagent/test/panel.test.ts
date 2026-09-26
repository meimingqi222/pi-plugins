import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundRecord } from "../src/background.ts";
import { createSubagentsPanel, PANEL_BODY_ROWS, type PanelDeps } from "../src/panel.ts";
import type { FleetTheme } from "../src/fleet.ts";

const theme: FleetTheme = { fg: (_color, text) => text, bold: (text) => text };

// Legacy terminal byte sequences the parser recognises.
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const KITTY_Q_RELEASE = "\x1b[113;1:3u";
const END = "\x1b[F";

function record(partial: Partial<BackgroundRecord> = {}): BackgroundRecord {
	return {
		id: "sa-1",
		agent: "explore",
		task: "Inspect the runner",
		sessionId: "session-a",
		status: "running",
		startedAt: Date.now() - 30_000,
		...partial,
	};
}

function fakePanel(list: () => BackgroundRecord[]) {
	let renders = 0;
	const stopped: string[] = [];
	const closed = { value: false };
	const timers = new Set<() => void>();
	let notifyFlag = false;
	const deps: PanelDeps = {
		tui: { requestRender: () => { renders += 1; } },
		theme,
		list,
		stop: (id) => { stopped.push(id); return true; },
		readLog: (id) => (id === "sa-1" ? "log line one\nlog line two" : undefined),
		readTranscriptLines: (id) => (id === "sa-1"
			? { lines: [JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "folded reply" }] } })], earlierDataOmitted: false }
			: undefined),
		notifyDone: () => notifyFlag,
		setNotifyDone: (value) => { notifyFlag = value; },
		schedule: (fn) => {
			timers.add(fn);
			return fn as unknown as ReturnType<typeof setInterval>;
		},
		cancel: (handle) => {
			timers.delete(handle as unknown as () => void);
		},
	};
	const panel = createSubagentsPanel(deps, () => { closed.value = true; });
	return { panel, stopped, closed, timers, renders: () => renders, notify: () => notifyFlag };
}

describe("the fleet panel", () => {
	test("lists children with live detail and a bounded body", () => {
		const records = [record({ id: "sa-1", task: "one" }), record({ id: "sa-2", task: "two" })];
		const { panel } = fakePanel(() => records);
		const lines = panel.render(80);
		expect(lines.join("\n")).toContain("subagents");
		expect(lines.join("\n")).toContain("2 total");
		expect(lines.join("\n")).toContain("one");
		expect(lines.join("\n")).toContain("two");
	});

	test("selection moves on up/down and is pinned to the record, not the row", () => {
		const records = [record({ id: "sa-1", task: "first" }), record({ id: "sa-2", task: "second" })];
		const { panel } = fakePanel(() => records);
		panel.render(80);
		panel.handleInput?.(DOWN);
		expect(panel.render(80).join("\n")).toContain("› ● second");
		// Reorder (a settle moves a record between active and settled groups):
		// selection stays on the same child, not the same index.
		records.reverse();
		panel.render(80);
		panel.handleInput?.(DOWN);
		expect(panel.render(80).join("\n")).toContain("› ● first");
	});

	test("enter opens the detail, Esc returns to the list, Esc again closes", () => {
		const { panel, closed } = fakePanel(() => [record({ id: "sa-1", task: "the task body" })]);
		panel.render(80);
		panel.handleInput?.(ENTER);
		const detail = panel.render(80).join("\n");
		expect(detail).toContain("Task");
		expect(detail).toContain("the task body");
		expect(detail).toContain("Esc back");
		panel.handleInput?.(ESC);
		expect(closed.value).toBe(false);
		expect(panel.render(80).join("\n")).toContain("the task body");
		panel.handleInput?.(ESC);
		expect(closed.value).toBe(true);
	});

	test("a detail for a vanished child shows a tombstone, not stale data", () => {
		const records = [record({ id: "sa-1" })];
		const { panel } = fakePanel(() => records);
		panel.render(80);
		panel.handleInput?.(ENTER);
		records.length = 0;
		const detail = panel.render(80).join("\n");
		expect(detail).toContain("task unavailable");
		expect(detail).toContain("Esc to return");
	});

	test("k cancels a running child", () => {
		const { panel, stopped } = fakePanel(() => [record({ id: "sa-7" })]);
		panel.render(80);
		panel.handleInput?.("k");
		expect(stopped).toEqual(["sa-7"]);
	});

	test("k does not cancel a settled child", () => {
		const { panel, stopped } = fakePanel(() => [record({ id: "sa-7", status: "completed", finishedAt: Date.now() })]);
		panel.render(80);
		panel.handleInput?.("k");
		expect(stopped).toEqual([]);
	});

	test("l shows a bounded raw log tail for the selected child", () => {
		const { panel } = fakePanel(() => [record({ id: "sa-1" })]);
		panel.render(80);
		panel.handleInput?.("l");
		const detail = panel.render(80).join("\n");
		expect(detail).toContain("log line one");
		panel.handleInput?.(ESC);
		expect(panel.render(80).join("\n")).toContain("Inspect the runner");
	});

	test("detail scrolls and clamps", () => {
		const big = record({
			id: "sa-1",
			status: "completed",
			task: "t",
			finishedAt: Date.now(),
			result: {
				content: [{ type: "text", text: "x" }],
				details: {
					agent: "explore",
					status: "completed",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 },
					output: Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"),
				},
			},
		});
		const { panel } = fakePanel(() => [big]);
		panel.render(80);
		panel.handleInput?.(ENTER);
		const first = panel.render(80).join("\n");
		expect(first).toContain("line 0");
		expect(first).not.toContain("line 59");
		panel.handleInput?.(END);
		expect(panel.render(80).join("\n")).toContain("line 59");
		// Clamped: scrolling past the end cannot move past the final line.
		for (let index = 0; index < PANEL_BODY_ROWS; index += 1) panel.handleInput?.(DOWN);
		expect(panel.render(80).join("\n")).toContain("Esc back");
	});

	test("a key release does not close the panel", () => {
		const { panel, closed } = fakePanel(() => [record({ id: "sa-1" })]);
		panel.handleInput?.(KITTY_Q_RELEASE);
		expect(closed.value).toBe(false);
	});

	test("every rendered line fits the width", () => {
		const { panel } = fakePanel(() => [record({ id: "sa-1", task: "修复中文标题很长的任务超过宽度时应当裁剪" })]);
		for (const width of [10, 24, 40, 80]) {
			for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("t opens the folded transcript and L drills into the raw log", () => {
		const { panel } = fakePanel(() => [record({ id: "sa-1" })]);
		panel.handleInput?.("t");
		expect(panel.render(80).join("\n")).toContain("folded reply");
		expect(panel.render(80).join("\n")).toContain("L raw log");
		panel.handleInput?.("L");
		expect(panel.render(80).join("\n")).toContain("log line one");
		panel.handleInput?.(ESC);
		// Esc from the raw log returns to the detail, not the list.
		expect(panel.render(80).join("\n")).toContain("Task");
	});

	test("n toggles completion notifications from every view", () => {
		const { panel, notify } = fakePanel(() => [record({ id: "sa-1" })]);
		expect(notify()).toBe(false);
		panel.handleInput?.("n");
		expect(notify()).toBe(true);
		panel.handleInput?.(ENTER);
		panel.handleInput?.("n");
		expect(notify()).toBe(false);
		expect(panel.render(80).join("\n")).toContain("notify off");
	});

	test("dispose stops the ticker and is idempotent", () => {
		const { panel, timers } = fakePanel(() => [record({ id: "sa-1" })]);
		expect(timers.size).toBe(1);
		panel.dispose?.();
		expect(timers.size).toBe(0);
		panel.dispose?.();
	});
});
