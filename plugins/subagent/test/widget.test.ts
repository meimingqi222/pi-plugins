import { describe, expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import type { BackgroundRecord } from "../src/background.ts";
import { createFleetReporter, type FleetUI } from "../src/widget.ts";

interface FakeUI extends FleetUI {
	widgetCalls: Array<{ key: string; content: unknown; options?: unknown }>;
	notifications: Array<{ message: string; type?: string }>;
}

function fakeUI(): FakeUI {
	const calls: FakeUI["widgetCalls"] = [];
	const notifications: FakeUI["notifications"] = [];
	return {
		widgetCalls: calls,
		notifications,
		setWidget(key, content, options) {
			calls.push({ key, content, options });
		},
		notify(message, type) {
			notifications.push({ message, type });
		},
	};
}

function fakeTimer() {
	const callbacks = new Set<() => void>();
	return {
		callbacks,
		schedule: (fn: () => void) => {
			callbacks.add(fn);
			return fn as unknown as ReturnType<typeof setInterval>;
		},
		cancel: (handle: ReturnType<typeof setInterval>) => {
			callbacks.delete(handle as unknown as () => void);
		},
	};
}

function record(partial: Partial<BackgroundRecord>): BackgroundRecord {
	return {
		id: "sa-1",
		agent: "explore",
		alias: partial.alias ?? "explore",
		kind: partial.kind ?? "background",
		task: "Inspect",
		sessionId: "session-a",
		status: "running",
		startedAt: Date.now() - 30_000,
		...partial,
	};
}

describe("createFleetReporter", () => {
	test("mounts the widget only while children run and hands the slot back", () => {
		const ui = fakeUI();
		const timer = fakeTimer();
		let records = [record({ id: "sa-1" })];
		const reporter = createFleetReporter({
			ui: () => ui,
			list: () => records,
			activeCount: () => records.filter((item) => item.status === "running").length,
			schedule: timer.schedule,
			cancel: timer.cancel,
		});
		reporter.sync();
		expect(ui.widgetCalls).toHaveLength(1);
		expect(ui.widgetCalls[0]!.key).toBe("pi-subagent-fleet");
		expect(ui.widgetCalls[0]!.options).toEqual({ placement: "belowEditor" });
		expect(timer.callbacks.size).toBe(1);

		records = [];
		reporter.sync();
		expect(ui.widgetCalls[1]!.content).toBeUndefined();
		expect(timer.callbacks.size).toBe(0);
	});

	test("the interval is unref'd", () => {
		const ui = fakeUI();
		const unrefs: unknown[] = [];
		const reporter = createFleetReporter({
			ui: () => ui,
			list: () => [record({ id: "sa-1" })],
			activeCount: () => 1,
			schedule: (fn) => {
				const handle = setInterval(fn, 3_600_000) as unknown as ReturnType<typeof setInterval> & { unref?: () => void };
				unrefs.push(handle);
				// not actually unref'ing; the reporter calls it, we just record it.
				return handle;
			},
			cancel: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
		});
		reporter.sync();
		reporter.dispose();
		expect(unrefs).toHaveLength(1);
	});

	test("a stalled child notifies exactly once", () => {
		const ui = fakeUI();
		const timer = fakeTimer();
		const stalled = record({ id: "sa-9", startedAt: Date.now() - 200_000 });
		const reporter = createFleetReporter({
			ui: () => ui,
			list: () => [stalled],
			activeCount: () => 1,
			schedule: timer.schedule,
			cancel: timer.cancel,
		});
		reporter.sync();
		for (const callback of timer.callbacks) callback();
		for (const callback of timer.callbacks) callback();
		expect(ui.notifications).toHaveLength(1);
		expect(ui.notifications[0]!.type).toBe("warning");
		expect(ui.notifications[0]!.message).toContain("sa-9");
	});

	test("a settled child never stalls-notifies", () => {
		const ui = fakeUI();
		const timer = fakeTimer();
		const settled = record({ id: "sa-9", status: "completed", startedAt: Date.now() - 200_000 });
		// The widget stays mounted while another child runs; the settled one is quiet.
		const running = record({ id: "sa-2" });
		const reporter = createFleetReporter({
			ui: () => ui,
			list: () => [running, settled],
			activeCount: () => 1,
			schedule: timer.schedule,
			cancel: timer.cancel,
		});
		reporter.sync();
		for (const callback of timer.callbacks) callback();
		expect(ui.notifications).toHaveLength(0);
	});

	test("dispose is idempotent and safe before any mount", () => {
		const reporter = createFleetReporter({
			ui: () => undefined,
			list: () => [],
			activeCount: () => 0,
		});
		expect(() => {
			reporter.dispose();
			reporter.dispose();
		}).not.toThrow();
	});

	test("no widget is mounted when the UI context is absent (RPC/print)", () => {
		const ui = fakeUI();
		const reporter = createFleetReporter({
			ui: () => undefined,
			list: () => [record({ id: "sa-1" })],
			activeCount: () => 1,
		});
		reporter.sync();
		expect(ui.widgetCalls).toHaveLength(0);
		reporter.dispose();
	});
});
