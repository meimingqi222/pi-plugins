import { describe, expect, test } from "bun:test";
import { createFooterReporter, type FooterSink } from "../src/pi/footer.ts";
import { FOOTER_STATUS_KEY } from "../src/runs/live-status.ts";
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
			agents: [{ id: "a1", label: "scan", status: "running", startedAt: NOW - 12_000 }],
			completedAgents: 0,
			totalAgents: 1,
			spentTokens: 10,
		},
		...patch,
	};
}

/** Records what was written, and when the ticker was started and stopped. */
function harness(records: RunRecord[]) {
	const writes: Array<[string, string | undefined]> = [];
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	const sink: FooterSink = {
		setStatus: (key, text) => writes.push([key, text]),
	};
	const reporter = createFooterReporter({
		list: () => records,
		activeCount: () => records.filter((record) => record.status === "running").length,
		now: () => NOW,
		tickMs: 1_000,
		schedule: (fn, ms) => {
			const timer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer as never;
		},
		cancel: (handle) => {
			(handle as unknown as { cleared: boolean }).cleared = true;
		},
	});
	return {
		sink,
		reporter,
		writes,
		live: () => timers.filter((timer) => !timer.cleared),
		tick: () => {
			for (const timer of timers) if (!timer.cleared) timer.fn();
		},
	};
}

describe("the workflow footer entry", () => {
	test("stays silent until something runs, then claims the slot", () => {
		const records: RunRecord[] = [];
		const { sink, reporter, writes } = harness(records);

		// Nothing running: a fresh sink has nothing to clear, so the plugin writes
		// nothing at all rather than occupying a footer slot to say "idle".
		reporter.attach(sink);
		expect(writes).toHaveLength(0);

		records.push(running());
		reporter.sync();
		expect(writes).toEqual([[FOOTER_STATUS_KEY, "wf 12.0s · review · 1 running"]]);
	});

	test("hands the slot back when the last run settles, and stops ticking", () => {
		const records: RunRecord[] = [running()];
		const { sink, reporter, writes, live } = harness(records);
		reporter.attach(sink);
		expect(live()).toHaveLength(1);

		// Settled, and the ticker must not outlive the run. A timer with no reason
		// to exist is what keeps a one-shot mode from exiting.
		records.length = 0;
		reporter.sync();
		expect(writes.at(-1)).toEqual([FOOTER_STATUS_KEY, undefined]);
		expect(live()).toHaveLength(0);
	});

	test("writes only when the text changes", () => {
		const records: RunRecord[] = [running()];
		const { sink, reporter, writes, tick } = harness(records);
		reporter.attach(sink);
		expect(writes).toHaveLength(1);

		// The clock is injected, so a tick that cannot have changed the text must
		// not re-render the footer.
		tick();
		tick();
		expect(writes).toHaveLength(1);
	});

	test("dispose gives the slot back and is safe twice", () => {
		const records: RunRecord[] = [running()];
		const { sink, reporter, writes, live } = harness(records);
		reporter.attach(sink);
		expect(writes).toHaveLength(1);

		reporter.dispose();
		expect(writes.at(-1)).toEqual([FOOTER_STATUS_KEY, undefined]);
		expect(live()).toHaveLength(0);

		// Idempotent: shutdown can converge here after a settle already did, and a
		// second dispose must not write to a UI it has already given up.
		expect(() => reporter.dispose()).not.toThrow();
		expect(writes).toHaveLength(2);
	});

	test("a second sink is written to even if the text is unchanged", () => {
		// The suppression is per-sink: a new UI starts with an empty footer, so
		// carrying the old sink's last text over would leave it blank.
		const records: RunRecord[] = [running()];
		const first = harness(records);
		first.reporter.attach(first.sink);

		const second: Array<[string, string | undefined]> = [];
		first.reporter.attach({ setStatus: (key, text) => second.push([key, text]) });
		expect(second).toEqual([[FOOTER_STATUS_KEY, "wf 12.0s · review · 1 running"]]);
	});
});
