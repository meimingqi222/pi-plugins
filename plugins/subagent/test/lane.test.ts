import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { LaneRegistry, deriveAlias } from "../src/lane.ts";
import type { SubagentDetails } from "../src/tool.ts";

const SESSION = "session-a";

function result(status: SubagentDetails["status"] = "completed"): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text: "done" }],
		details: { agent: "explore", status, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 }, output: "done" },
	};
}

function pendingWork() {
	let finish: ((value: AgentToolResult<SubagentDetails>) => void) | undefined;
	// The promise is created now so `finish` is usable before the lane's
	// microtask invokes `work` — a synchronous finish() must not be a race.
	let aborted: (() => void) | undefined;
	const promise = new Promise<AgentToolResult<SubagentDetails>>((resolve, reject) => {
		finish = resolve;
		aborted = () => reject(new Error("aborted"));
	});
	const work = (signal: AbortSignal) => {
		// An already-aborted signal dispatches no later event — mirror the real
		// executor's synchronous check so an early stop still settles the lane.
		if (signal.aborted) aborted?.();
		else signal.addEventListener("abort", () => aborted?.(), { once: true });
		return promise;
	};
	return { work, finish: () => finish!(result()) };
}

describe("the lane registry", () => {
	test("foreground lanes appear in list() and hold a concurrency slot like any busy lane", async () => {
		const settled: string[] = [];
		const registry = new LaneRegistry((lane) => settled.push(lane.id), 1);
		const fg = pendingWork();
		const launched = registry.launch("explore", "fg task", SESSION, fg.work, { kind: "foreground", slotHeld: true });
		expect(launched.record.kind).toBe("foreground");
		expect(registry.list(SESSION).map((lane) => lane.id)).toContain(launched.record.id);
		// A busy foreground call fills the fleet: pi runs a tool batch in
		// parallel, so an uncapped blocking call would bypass the cap entirely.
		expect(registry.atCapacity()).toBe(true);
		const bg = pendingWork();
		expect(() => registry.launch("explore", "bg task", SESSION, bg.work)).toThrow("At most 1 subagents");
		fg.finish();
		await launched.done;
		expect(settled).toContain(launched.record.id);
		expect(registry.atCapacity()).toBe(false);
	});

	test("acquireSlot parks a caller FIFO until a busy lane settles or goes idle", async () => {
		const registry = new LaneRegistry(() => {}, 1);
		const a = pendingWork();
		registry.launch("explore", "a", SESSION, a.work, { kind: "foreground" });
		const first = registry.acquireSlot();
		let granted = false;
		void first.then((ok) => { granted = ok; });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(granted).toBe(false);
		// Settle frees the slot; the queued caller is granted it.
		a.finish();
		expect(await first).toBe(true);
		// The reservation already counts as busy — a second caller still waits
		// even though the granted lane has not launched yet.
		expect(registry.busyCount()).toBe(1);
		const bg = pendingWork();
		expect(() => registry.launch("explore", "b", SESSION, bg.work)).toThrow("At most 1 subagents");
		// The granted reservation becomes the lane.
		const launched = registry.launch("explore", "fg", SESSION, pendingWork().work, { kind: "foreground", slotHeld: true });
		expect(registry.busyCount()).toBe(1);
		// An idle lane frees its slot without settling.
		const second = registry.acquireSlot();
		let secondGranted = false;
		void second.then((ok) => { secondGranted = ok; });
		registry.setIdle(launched.record.id, true);
		expect(await second).toBe(true);
		registry.releaseSlot();
	});

	test("a queued acquireSlot resolves false on abort and spawns nothing", async () => {
		const registry = new LaneRegistry(() => {}, 1);
		const a = pendingWork();
		registry.launch("explore", "a", SESSION, a.work, { kind: "foreground" });
		const controller = new AbortController();
		const queued = registry.acquireSlot(controller.signal);
		controller.abort();
		expect(await queued).toBe(false);
		expect(registry.busyCount()).toBe(1);
		a.finish();
	});

	test("stop refuses a foreground lane but abort() reaches it internally", async () => {
		const registry = new LaneRegistry(() => {});
		const fg = pendingWork();
		const launched = registry.launch("explore", "fg", SESSION, fg.work, { kind: "foreground" });
		// A distinct answer, not `false`: the caller has to be able to say why.
		expect(registry.stop(SESSION, launched.record.id)).toBe("foreground");
		registry.abort(launched.record.id);
		await launched.done;
		expect(registry.get(SESSION, launched.record.id)!.status).toBe("aborted");
	});

	test("stop still cancels a background lane", async () => {
		const registry = new LaneRegistry(() => {});
		const bg = pendingWork();
		const launched = registry.launch("explore", "bg", SESSION, bg.work);
		expect(registry.stop(SESSION, launched.record.id)).toBe("stopped");
		await launched.done;
		expect(registry.get(SESSION, launched.record.id)!.status).toBe("aborted");
	});

	test("stop reports a settled lane rather than pretending it cancelled one", async () => {
		const registry = new LaneRegistry(() => {});
		const bg = pendingWork();
		const launched = registry.launch("explore", "bg", SESSION, bg.work);
		bg.finish();
		await launched.done;
		expect(registry.stop(SESSION, launched.record.id)).toBe("settled");
	});

	test("the fifth launch slot, alias fallback and generation are carried", () => {
		const registry = new LaneRegistry(() => {});
		const fg = pendingWork();
		const launched = registry.launch("explore", "Map the retry path", SESSION, fg.work, { kind: "foreground", generation: 7 });
		expect(launched.record.alias).toBe("Map the retry path");
		expect(launched.record.generation).toBe(7);
		fg.finish();
	});

	test("deriveAlias strips control characters after splitting the first line", () => {
		expect(deriveAlias("first\nsecond")).toBe("first");
		expect(deriveAlias("\x07ring bell")).toBe("ring bell");
	});

	test("the wait deadline's timer keeps the event loop alive", async () => {
		// A wait is ended by its deadline timer, and that timer must not be unref'd.
		// When it was, Bun saw a loop with nothing to keep it alive and neither ran
		// the timer nor exited: it spun at 100% CPU, so
		// `plugins/subagent/test/plugin.test.ts` never finished on Windows. The test
		// reads the handle's ref state instead of waiting for the deadline, because a
		// ref'd timer anywhere else in the test would schedule the loop and mask the
		// bug — that is exactly how it stayed hidden.
		const registry = new LaneRegistry(() => {});
		const pending = pendingWork();
		const launched = registry.launch("explore", "bg", SESSION, pending.work);
		const globals = globalThis as unknown as { setTimeout: (handler: any, timeout?: number, ...args: any[]) => any };
		const realSetTimeout = globals.setTimeout;
		const handles: Array<{ hasRef?: () => boolean }> = [];
		globals.setTimeout = (handler: any, timeout?: number, ...args: any[]) => {
			const handle = realSetTimeout(handler, timeout, ...args) as { hasRef?: () => boolean };
			handles.push(handle);
			return handle;
		};
		try {
			const waiting = registry.waitFor(SESSION, launched.record.id, 60_000);
			// The deadline timer is the only timer this path creates.
			expect(handles).toHaveLength(1);
			expect(handles[0]?.hasRef?.()).not.toBe(false);
			// Settle the lane rather than waiting out the deadline: this test pins the
			// handle, not the clock.
			pending.finish();
			expect((await waiting).outcome).toBe("settled");
		} finally {
			globals.setTimeout = realSetTimeout;
		}
	});
});
