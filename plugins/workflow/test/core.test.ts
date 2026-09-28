import { describe, expect, test } from "bun:test";
import { stableJson, workflowHash, workflowJsonValue } from "../src/core/hash.ts";
import { isJournalEntry, isReusable, ResumeLog } from "../src/core/journal.ts";
import { emptyWorkflowUsage, mergeWorkflowUsage, workflowUsageTokens } from "../src/core/types.ts";
import type { WorkflowJournalEntry } from "../src/core/types.ts";

function entry(overrides: Partial<WorkflowJournalEntry> = {}): WorkflowJournalEntry {
	return {
		schemaVersion: 1,
		seq: 0,
		callId: "call-0",
		callHash: "hash-0",
		prompt: "p",
		options: {},
		status: "completed",
		result: { ok: true },
		usage: emptyWorkflowUsage(),
		attempt: 1,
		createdAt: 1_000,
		...overrides,
	};
}

describe("stableJson", () => {
	test("is independent of object key order", () => {
		// The property that makes a hash a call identity: two objects differing
		// only in key order are the same call.
		expect(stableJson({ a: 1, b: 2 })).toBe(stableJson({ b: 2, a: 1 }));
		expect(workflowHash({ a: 1, b: 2 })).toBe(workflowHash({ b: 2, a: 1 }));
	});
	test("preserves array order, which is meaningful", () => {
		expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
	});
	test("encodes non-finite numbers as null rather than failing", () => {
		expect(stableJson({ n: Number.POSITIVE_INFINITY })).toBe('{"n":null}');
		expect(stableJson({ n: Number.NaN })).toBe('{"n":null}');
	});
	test("distinguishes a number from its string form", () => {
		expect(stableJson({ v: 1 })).not.toBe(stableJson({ v: "1" }));
	});
});

describe("workflowJsonValue", () => {
	test("returns a null-prototype record so an injected key cannot be inherited", () => {
		// Assigning `__proto__` on a plain object makes it the prototype instead of
		// an own key, so a downstream read sees the injected value through the
		// chain. A null-prototype record keeps it a plain own key.
		const value = workflowJsonValue(JSON.parse('{"__proto__":{"polluted":true},"safe":1}'));
		expect(Object.getPrototypeOf(value)).toBeNull();
		expect((value as any).polluted).toBeUndefined();
		expect((value as any).safe).toBe(1);
	});
	test("coerces non-finite numbers to null and functions to text", () => {
		expect(workflowJsonValue({ a: Infinity, b: () => 1 })).toEqual({ a: null, b: "() => 1" });
	});
});

describe("ResumeLog", () => {
	test("serves a previous run's calls when every hash matches", () => {
		const log = new ResumeLog([entry({ seq: 0, callHash: "a" }), entry({ seq: 1, callHash: "b" })]);
		expect(log.cached(0, "a")).toBeDefined();
		expect(log.cached(1, "b")).toBeDefined();
		expect(log.active).toBe(true);
	});
	test("reuse is keyed by content, not request order", () => {
		// Parallel calls reach the journal in completion order; a resume
		// observes a different order and must still hit.
		const log = new ResumeLog([entry({ seq: 0, callHash: "a" }), entry({ seq: 1, callHash: "b" })]);
		expect(log.cached(0, "b")).toBeDefined();
		expect(log.cached(1, "a")).toBeDefined();
	});
	test("a miss disables nothing: later calls still reuse", () => {
		// A call whose prompt depends on earlier output hashes differently and
		// runs live; the independent calls around it are still reusable.
		const log = new ResumeLog([entry({ seq: 0, callHash: "a" }), entry({ seq: 1, callHash: "b" })]);
		expect(log.cached(0, "a")).toBeDefined();
		expect(log.cached(1, "changed")).toBeUndefined();
		expect(log.cached(2, "b")).toBeDefined();
	});
	test("identical calls are consumed in order: the nth call gets the nth entry", () => {
		const log = new ResumeLog([
			entry({ seq: 0, callHash: "same", callId: "first", result: 1 }),
			entry({ seq: 1, callHash: "same", callId: "second", result: 2 }),
		]);
		expect(log.cached(0, "same")?.callId).toBe("first");
		expect(log.cached(1, "same")?.callId).toBe("second");
		// A third identical call has no third entry: it runs live.
		expect(log.cached(2, "same")).toBeUndefined();
	});
	test("a cached entry is reusable, a failed one is not", () => {
		const log = new ResumeLog([
			entry({ seq: 0, callHash: "a", status: "cached" }),
			entry({ seq: 1, callHash: "b", status: "failed" }),
		]);
		expect(log.cached(0, "a")).toBeDefined();
		// A resumed run must not inherit a failure it never re-attempted.
		expect(log.cached(1, "b")).toBeUndefined();
	});
	test("an empty previous run never activates resume", () => {
		const log = new ResumeLog([]);
		expect(log.active).toBe(false);
		expect(log.cached(0, "a")).toBeUndefined();
	});
	test("malformed entries are not loaded", () => {
		const log = new ResumeLog([
			{ schemaVersion: 1, seq: 0, callId: "c", status: "completed" } as any,
			entry({ seq: 1, callHash: "b" }),
		]);
		expect(log.size).toBe(1);
		expect(log.cached(0, "b")).toBeDefined();
	});
});

describe("isJournalEntry", () => {
	test("accepts a failed status so the failure is visible in the sequence", () => {
		// A failed call is not reusable (`isReusable` handles that), but it is a
		// real journal line: dropping it made a run whose calls all failed look
		// like a run that never started.
		expect(isJournalEntry(entry({ status: "failed" }))).toBe(true);
	});
	test("rejects a negative or non-integer sequence", () => {
		expect(isJournalEntry(entry({ seq: -1 }))).toBe(false);
		expect(isJournalEntry(entry({ seq: 1.5 }))).toBe(false);
	});
	test("rejects a wrong schema version", () => {
		expect(isJournalEntry({ ...entry(), schemaVersion: 2 })).toBe(false);
	});
});

describe("isReusable", () => {
	test("requires both a hash match and a terminal-success status", () => {
		expect(isReusable(entry({ callHash: "a" }), "a")).toBe(true);
		expect(isReusable(entry({ callHash: "a" }), "b")).toBe(false);
		expect(isReusable(entry({ status: "failed", callHash: "a" }), "a")).toBe(false);
		expect(isReusable(undefined, "a")).toBe(false);
	});
});

describe("workflow usage", () => {
	test("bills input plus output and excludes cache traffic", () => {
		// Cache reads are priced separately; folding them into a token budget
		// would make a cached run look more expensive than an uncached one.
		expect(workflowUsageTokens({ input: 10, output: 5, cacheRead: 1_000, cacheWrite: 500 })).toBe(15);
	});
	test("merge keeps contextTokens a high-water mark", () => {
		const merged = mergeWorkflowUsage(
			{ ...emptyWorkflowUsage(), contextTokens: 100 },
			{ contextTokens: 40, input: 1 },
		);
		expect(merged.contextTokens).toBe(100);
		expect(merged.input).toBe(1);
	});
	test("merge counts turns additively", () => {
		expect(mergeWorkflowUsage({ ...emptyWorkflowUsage(), turns: 2 }, { turns: 3 }).turns).toBe(5);
	});
});
