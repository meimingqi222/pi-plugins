import { expect, test } from "bun:test";
import { boundedTranscript, verifyGoal } from "../src/verifier.ts";
import { installRedactBridge } from "../src/redact.ts";
import type { Goal } from "../src/state.ts";

const goal: Goal = { schema: 1, id: "test", objective: "check task", status: "active", used: 0, elapsedMs: 0, workRuns: 1, blockerRuns: 0 };

test("verifier uses redacted transcript with no tools and includes summaries", async () => {
 let captured: any;
 const ctx: any = {
  model: { id: "test", contextWindow: 32000 },
  modelRegistry: { hasConfiguredAuth: () => true, complete: async (_model: any, context: any) => { captured = context; return {}; } },
  sessionManager: { getBranch: () => [{ type: "compaction", summary: "prior tests passed" }, { type: "custom", customType: "goal-state", data: goal }] },
 };
 let raw: any;
 await verifyGoal(ctx, goal, new AbortController(), {
  version: 1, redactString: value => value,
  redactJson(value) { raw = value; return { sanitized: true }; },
 }, undefined, ctx.model);
 expect(raw.transcript).toContain("prior tests passed");
 expect(raw.transcript).not.toContain("goal-state");
 expect(captured.tools).toEqual([]);
 expect(captured.messages[0].content[0].text).toBe('{"sanitized":true}');
});

test("redaction failure prevents provider request", async () => {
 let called = false;
 const ctx: any = {
  model: { id: "test" }, sessionManager: { getBranch: () => [] },
  modelRegistry: { hasConfiguredAuth: () => true, complete: async () => { called = true; } },
 };
 await expect(verifyGoal(ctx, goal, new AbortController(), {
  version: 1, redactString: value => value, redactJson() { throw new Error("redactor broken"); },
 }, undefined, ctx.model)).rejects.toThrow("redactor broken");
 expect(called).toBe(false);
});

test("redaction bridge supports either extension load order", () => {
 for (const loadedFirst of [false, true]) {
  const listeners = new Map<string, (value: any) => void>();
  const service = { version: 1, redactJson: (v: any) => v, redactString: (v: string) => v };
  const pi: any = { events: {
   on: (name: string, fn: (value: any) => void) => listeners.set(name, fn),
   emit: () => { if (loadedFirst) listeners.get("pi-redact:service")?.(service); },
  } };
  const get = installRedactBridge(pi);
  if (!loadedFirst) listeners.get("pi-redact:service")?.(service);
  expect(get()).toBe(service);
 }
});


test("bounded transcript keeps whole entries and elides the oldest", () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ type: "message", body: `entry-${i}-${"x".repeat(200)}` }));
  const { text, truncated } = boundedTranscript(entries, 1_000);
  expect(truncated).toBe(true);
  // Newest evidence survives; the oldest is what gets elided.
  expect(text).toContain("entry-19");
  expect(text).not.toContain("entry-0");
  // Every kept line is a complete JSON document — the cut never lands inside one.
  for (const line of text.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  // Chronological order, not the reverse-walk order.
  const order = text.split("\n").map((line) => /entry-(\d+)/.exec(line)![1]).map(Number);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("bounded transcript reports no truncation when everything fits", () => {
  const entries = [{ type: "message", a: 1 }, { type: "compaction", summary: "prior tests passed" }];
  const { text, truncated } = boundedTranscript(entries, 10_000);
  expect(truncated).toBe(false);
  expect(text.split("\n").map((line) => JSON.parse(line))).toEqual(entries);
});

test("an oversized oldest entry is elided rather than clipped", () => {
  // The ordinary case: the newest entries fit, the walk stops when the next one
  // would not, so the oversized entry is dropped whole.
  const entries = [{ type: "message", body: "y".repeat(5_000) }, { type: "message", body: "small" }];
  const { text, truncated } = boundedTranscript(entries, 500);
  expect(truncated).toBe(true);
  expect(text).toContain("small");
  expect(text.length).toBeLessThanOrEqual(500);
});

test("an oversized newest entry is clipped rather than dropped", () => {
  // The oversized entry has to be the *newest* for this branch to run: with it
  // first, the walk fills the budget from the end and stops before reaching it,
  // so the previous version of this test never exercised the clip at all. An
  // empty transcript would leave the verifier nothing to judge, which is why the
  // one partial document the module sends is this one.
  const newest = { type: "message", body: "y".repeat(5_000) };
  const { text, truncated } = boundedTranscript([{ type: "message", body: "small" }, newest], 500);
  expect(truncated).toBe(true);
  // Exactly the budget, and the tail of the newest entry — a partial JSON
  // document, which is the one documented exception to "whole entries only".
  expect(text.length).toBe(500);
  expect(JSON.stringify(newest).endsWith(text)).toBe(true);
  expect(text).not.toContain("small");
});

test("verifier payload keeps whole entries under a tight context window", async () => {
  let captured: any;
  const entries = Array.from({ length: 30 }, (_, i) => ({ type: "message", body: `entry-${i}-${"z".repeat(300)}` }));
  const ctx: any = {
    model: { id: "test", contextWindow: 2000 },
    modelRegistry: { hasConfiguredAuth: () => true, complete: async (_model: any, context: any) => { captured = context; return {}; } },
    sessionManager: { getBranch: () => entries },
  };
  await verifyGoal(ctx, goal, new AbortController(), undefined, undefined, ctx.model);
  const transcript = JSON.parse(captured.messages[0].content[0].text).transcript;
  expect(transcript).toContain("entry-29");
  expect(transcript).not.toContain("entry-0");
  for (const line of transcript.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
});
