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
	test("foreground lanes appear in list() but never occupy a background slot", async () => {
		const settled: string[] = [];
		const registry = new LaneRegistry((lane) => settled.push(lane.id), 1);
		const fg = pendingWork();
		const launched = registry.launch("explore", "fg task", SESSION, fg.work, { kind: "foreground" });
		expect(launched.record.kind).toBe("foreground");
		expect(registry.list(SESSION).map((lane) => lane.id)).toContain(launched.record.id);
		// The single background slot is still free: capacity counts only background lanes.
		expect(registry.atCapacity()).toBe(false);
		const bg = pendingWork();
		registry.launch("explore", "bg task", SESSION, bg.work);
		expect(registry.atCapacity()).toBe(true);
		fg.finish();
		await launched.done;
		expect(settled).toContain(launched.record.id);
		bg.finish();
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
});
