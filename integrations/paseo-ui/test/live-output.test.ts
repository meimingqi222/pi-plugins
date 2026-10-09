import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkStatus } from "../shared/work-status.ts";
import { readLiveOutput } from "../server/live-output.ts";
import { pollLiveOutput } from "../client/live-poll.ts";

test("a bounded transcript reference survives the native subagent text protocol", () => {
  const text = "[Subagent call-1] running\nExplore\nReview transport\nthinking\n0 tools completed";
  expect(parseWorkStatus(`${text}\n[Pi transcript: session-sa001.jsonl]`)?.liveLog).toBe("session-sa001.jsonl");
  expect(parseWorkStatus(text)).toBeDefined();
  expect(parseWorkStatus(`${text}\n[Pi transcript: ../secret.jsonl]`)).toBeUndefined();
});

test("polling retries failures without overlapping and drops in-flight updates after navigation", async () => {
  const value = { state: "available" as const, revision: "1", earlierDataOmitted: false, blocks: [] };
  let count = 0;
  const updates: unknown[] = [];
  const errors: unknown[] = [];
  let finish!: (output: typeof value) => void;
  const stop = pollLiveOutput(async () => {
    count++;
    if (count === 1) throw new Error("offline");
    return new Promise<typeof value>(resolve => { finish = resolve; });
  }, output => updates.push(output), error => errors.push(error), 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(count).toBe(2);
  expect(errors).toHaveLength(1);
  stop();
  finish(value);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(updates).toHaveLength(0);
  expect(count).toBe(2);
});

test("tail and response limits are explicit and incomplete writes are deferred", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-live-"));
  const log = "session-sa003.jsonl";
  try {
    writeFileSync(join(root, log), " ".repeat(2 * 1024 * 1024) + "\n" + Array.from({ length: 130 }, (_, i) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String(i) }] } })).join("\n") + '\n{"type":');
    const output = await readLiveOutput({ log }, root);
    expect(output.earlierDataOmitted).toBe(true);
    expect(output.blocks).toHaveLength(120);
    expect(output.blocks.at(-1)?.text).toBe("129");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live reader shows unfinished deltas, tool output and authoritative completion without duplicates", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-live-"));
  const log = "session-sa001.jsonl";
  const put = (event: unknown) => appendFileSync(join(root, log), JSON.stringify(event) + "\n");
  try {
    put({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reading sources" } });
    const live = await readLiveOutput({ log }, root);
    expect(live.blocks).toEqual([{ id: expect.any(String), kind: "assistant", text: "Reading sources", live: true }]);
    put({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Reading sources" }] } });
    put({ type: "tool_execution_start", toolCallId: "one", toolName: "bash", args: { command: "bun test" } });
    put({ type: "tool_execution_update", toolCallId: "one", partialResult: { content: [{ type: "text", text: "test running" }] } });
    const running = await readLiveOutput({ log }, root);
    expect(running.blocks.filter(b => b.kind === "assistant")).toHaveLength(1);
    expect(running.blocks.at(-1)?.result).toBe("test running");
    put({ type: "tool_execution_end", toolCallId: "one", result: { content: [{ type: "text", text: "All passed" }] }, isError: false });
    expect((await readLiveOutput({ log }, root)).blocks.at(-1)?.result).toBe("All passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live reader denies traversal, native-session logs and symlinks outside its root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-live-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-outside-"));
  try {
    writeFileSync(join(outside, "secret.jsonl"), "{}\n");
    symlinkSync(join(outside, "secret.jsonl"), join(root, "session-sa001.jsonl"));
    writeFileSync(join(root, "session-sa004.jsonl"), "{}\n");
    symlinkSync(join(root, "session-sa004.jsonl"), join(root, "session-sa005.jsonl"));
    for (const log of ["../secret.jsonl", "/tmp/secret.jsonl", "session-host.jsonl", "session-sa001.jsonl"]) {
      await expect(readLiveOutput({ log }, root)).rejects.toThrow();
    }
    expect((await readLiveOutput({ log: "session-sa002.jsonl" }, root)).state).toBe("waiting");
    await expect(readLiveOutput({ log: "session-sa005.jsonl" }, root)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});


test("activity identities survive bounded-tail shifts, repeated commands and completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-live-ids-"));
  const log = "session-sa006.jsonl";
  const put = (event: unknown) => appendFileSync(join(root, log), JSON.stringify(event) + "\n");
  try {
    // Make the byte scan itself slide, including non-ASCII UTF-8 bytes.
    writeFileSync(join(root, log), " ".repeat(2 * 1024 * 1024) + "\n");
    for (let i = 0; i < 120; i++) put({ type: "tool_execution_start", toolCallId: String(i), toolName: "bash", args: { command: "echo 同样" } });
    const before = await readLiveOutput({ log }, root);
    const ids = before.blocks.map(block => block.id);
    expect(ids.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(120);
    put({ type: "tool_execution_start", toolCallId: "next", toolName: "bash", args: { command: "echo 同样" } });
    put({ type: "tool_execution_end", toolCallId: "119", result: "done" });
    const after = await readLiveOutput({ log }, root);
    expect(after.blocks.map(block => block.id).slice(0, 119)).toEqual(ids.slice(1));
    expect(after.blocks[118]?.result).toBe("done");
    put({ type: "message_start", message: { role: "assistant", timestamp: 987 } });
    put({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "first" } });
    const thinking = (await readLiveOutput({ log }, root)).blocks.at(-1)!;
    put({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " second" } });
    expect(((await readLiveOutput({ log }, root)).blocks.at(-1)!).id).toBe(thinking.id);
    put({ type: "message_end", message: { role: "assistant", timestamp: 987, content: [{ type: "thinking", thinking: "first second" }] } });
    expect(((await readLiveOutput({ log }, root)).blocks.at(-1)!).id).toBe(thinking.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("identical text blocks retain absolute byte identities as the scan and response windows slide", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-live-text-ids-"));
  const log = "session-sa007.jsonl";
  const path = join(root, log);
  const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "重复输出" }] } }) + "\n";
  try {
    writeFileSync(path, " ".repeat(2 * 1024 * 1024) + "\n" + line.repeat(120));
    const before = await readLiveOutput({ log }, root);
    appendFileSync(path, line);
    const after = await readLiveOutput({ log }, root);
    expect(new Set(before.blocks.map(b => b.id)).size).toBe(120);
    expect(after.blocks.slice(0, 119).map(b => b.id)).toEqual(before.blocks.slice(1).map(b => b.id));
    expect(after.blocks.at(-1)?.id).not.toBe(before.blocks.at(-1)?.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
