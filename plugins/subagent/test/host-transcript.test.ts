import { HostSubagentState } from "../src/host-protocol.ts";
import type { Lane } from "../src/lane.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostTranscript } from "../src/host-transcript.ts";

function transcriptRows(path: string): Array<{ message: Record<string, any> }> {
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function expectPairedTools(path: string): void {
  const pending = new Set<string>();
  for (const { message } of transcriptRows(path)) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === "toolCall") pending.add(part.id);
    }
    if (message.role === "toolResult") {
      expect(pending.has(message.toolCallId)).toBe(true);
      pending.delete(message.toolCallId);
    }
  }
  expect([...pending]).toEqual([]);
}

test("a full live preview announces its limit immediately and never admits an orphan result", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-limit-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect")!;
    for (let i = 0; i < 73; i++) transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] } });
    transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "review" }, { type: "text", text: "check" }, { type: "toolCall", id: "overflow", name: "bash", arguments: { command: "true" } }] } });
    // The native page must explain the stopped preview while execution is
    // still active, instead of waiting until the child eventually settles.
    expect(readFileSync(path, "utf8")).toContain("display limit");
    transcript.observe({ type: "message_end", message: { role: "toolResult", toolCallId: "overflow", toolName: "bash", content: [{ type: "text", text: "orphan output" }] } });
    transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "lighter message after overflow" }] } });
    expect(readFileSync(path, "utf8")).not.toContain("orphan output");
    expect(readFileSync(path, "utf8")).not.toContain("lighter message after overflow");
    expectPairedTools(path);
    transcript.snapshot(join(dir, "raw.jsonl"), "inspect", "completed", { output: "final answer" });
    expect(readFileSync(path, "utf8")).toContain("final answer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["items", "bytes", "control characters"])("admitted tool batches drain bounded results and settlement within Paseo read limits (%s)", mode => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-drain-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect")!;
    for (let i = 0; i < (mode === "bytes" ? 42 : 63); i++) transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `step ${i}:` + (mode === "bytes" ? "字".repeat(8000) : "") }] } });
    const ids = Array.from({ length: 20 }, (_, i) => `call-${i}`);
    transcript.observe({ type: "message_end", message: { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "bash", arguments: { command: "true" } })) } });
    for (const id of ids) transcript.observe({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: Array.from({ length: 20 }, () => ({ type: "text", text: (mode === "control characters" ? "\0" : "字").repeat(8000) })) } });
    expect(transcriptRows(path).filter(row => row.message.role === "toolResult")).toHaveLength(20);
    expectPairedTools(path);
    expect(readFileSync(path, "utf8")).toContain("display limit");
    transcript.snapshot(join(dir, "raw.jsonl"), "inspect", "completed", { output: "done" });
    const rows = transcriptRows(path);
    expect(rows.reduce((sum, row) => sum + 1 + (Array.isArray(row.message.content) ? row.message.content.length : 1), 0)).toBeLessThan(200);
    expect(statSync(path).size).toBeLessThan(2 * 1024 * 1024);
    expect(readFileSync(path, "utf8")).toContain("done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("settlement closes an admitted tool whose result never arrived", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-pending-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect")!;
    transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "sleep 30" } }] } });
    transcript.snapshot(join(dir, "raw.jsonl"), "inspect", "aborted", { output: "cancelled" });
    expectPairedTools(path);
    const result = transcriptRows(path).find(row => row.message.role === "toolResult")!.message;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("before this tool's result was available");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bounded completed snapshots omit tool results whose calls fell out of the retained window", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-window-"));
  try {
    const transcript = new HostTranscript();
    for (let i = 0; i < 80; i++) {
      transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "review" }, { type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "src.ts" } }] } });
      transcript.observe({ type: "message_end", message: { role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: "output" }] } });
    }
    transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "tail" }] } });
    const path = transcript.snapshot(join(dir, "raw.jsonl"), "inspect", "completed", { output: "done" })!;
    expectPairedTools(path);
    expect(readFileSync(path, "utf8")).toContain("Earlier tool call omitted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a background host transcript is available before completion and appends without replacing its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-live-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect sources")!;
    expect(readFileSync(path, "utf8")).toContain("inspect sources");
    const first = readFileSync(path, "utf8");
    transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src.ts" } }] } });
    const during = readFileSync(path, "utf8");
    expect(during.startsWith(first)).toBe(true);
    expect(during).toContain("src.ts");
    expect(during).not.toContain("Subagent running");
    transcript.observe({ type: "message_end", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "source code" }] } });
    expect(transcript.snapshot(join(dir, "raw.jsonl"), "inspect sources", "completed", { output: "done" })).toBe(path);
    const settled = readFileSync(path, "utf8");
    expect(settled.startsWith(during)).toBe(true);
    expect(settled).toContain("source code");
    expect(settled).toContain("done");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const next = transcript.startLive(join(dir, "raw.jsonl"), "follow up")!;
    expect(next).not.toBe(path);
    transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second turn" }] } });
    expect(readFileSync(next, "utf8")).toContain("second turn");
    expect(readFileSync(next, "utf8")).not.toContain("source code");
    expect(readFileSync(path, "utf8")).toBe(settled);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live transcript does not repeat the task when the child echoes its prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-live-echo-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect sources")!;
    // The seed lets a host child page show the prompt before the child speaks.
    // The child then sends the same prompt itself, framed with `Task:`; appending
    // that copy is what a host renders as two identical prompt bubbles.
    transcript.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: inspect sources" }] } });
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const prompts = rows.filter((row) => row.message.role === "user");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].message.content[0].text).toBe("inspect sources");
    // A later, genuinely different user message is a new turn and is kept.
    transcript.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "retry" }] } });
    const after = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(after.filter((row) => row.message.role === "user").map((row) => row.message.content[0].text)).toEqual([
      "inspect sources",
      "retry",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live transcript keeps a first user message that is not the seeded task", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-live-other-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect sources")!;
    // Only an echo of the seeded task is a duplicate. Anything else is the
    // child's own first turn and must not be dropped.
    transcript.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "review the diff" }] } });
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.message.content[0].text)).toEqual(["inspect sources", "review the diff"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live transcripts keep the host item budget bounded and reserve settlement", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-live-cap-"));
  try {
    const transcript = new HostTranscript();
    const path = transcript.startLive(join(dir, "raw.jsonl"), "inspect")!;
    for (let i = 0; i < 300; i++) transcript.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${i}:` + "x".repeat(10000) }] } });
    transcript.snapshot(join(dir, "raw.jsonl"), "inspect", "failed", { output: "", errorMessage: "deadline" });
    const content = readFileSync(path, "utf8");
    expect(Buffer.byteLength(content)).toBeLessThan(2 * 1024 * 1024);
    expect(content.trim().split("\n").length).toBeLessThan(100);
    expect(content).toContain("deadline");
    expect(content).toContain("Later execution entries omitted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("background live notifications attach once per turn and rotate after a reply", () => {
  const oldClient = process.env.PI_RPC_CLIENT;
  process.env.PI_RPC_CLIENT = "paseo";
  const dir = mkdtempSync(join(tmpdir(), "pi-host-live-notify-"));
  const notices: string[] = [];
  const state = new HostSubagentState({ sendMessage: () => {} }, undefined, 0);
  const lane: Lane = { id: "sa-live", agent: "review", alias: "review", task: "inspect", sessionId: "session", kind: "background", status: "running", startedAt: Date.now(), logPath: join(dir, "raw.jsonl") };
  const options = { ctx: { mode: "rpc", ui: { notify: (text: string) => notices.push(text) } } };
  try {
    state.progress(lane, options);
    state.progress(lane, options);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith("PASEO_GOTGENES_CHILD_SESSION ");
    const first = JSON.parse(notices[0]!.slice(notices[0]!.indexOf(" ") + 1));
    expect(first.agentId).toBe(lane.id);
    state.publish({ ...lane, status: "completed" });
    state.progress(lane, options);
    expect(notices).toHaveLength(2);
    const second = JSON.parse(notices[1]!.slice(notices[1]!.indexOf(" ") + 1));
    expect(second.file).not.toBe(first.file);
    expect(readFileSync(first.file, "utf8")).toContain("completed");
  } finally {
    if (oldClient === undefined) delete process.env.PI_RPC_CLIENT;
    else process.env.PI_RPC_CLIENT = oldClient;
    state.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host transcript has completed messages and immutable reply deltas", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-transcript-"));
  try {
    const transcript = new HostTranscript();
    const path = join(dir, "raw.jsonl");
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect sources" },
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: "src.ts" },
        },
      ],
    };
    transcript.observe({ type: "message_start", message });
    transcript.observe({ type: "message_end", message });
    transcript.observe({ type: "message_end", message });
    transcript.observe({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "source code" }],
        isError: false,
      },
    });
    const first = transcript.snapshot(path, "inspect", "completed", {
      output: "done",
    })!;
    const original = readFileSync(first, "utf8");
    const rows = original
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(rows[1].message.content[0].thinking).toBe("inspect sources");
    expect(rows[2].message.content[0].text).toBe("source code");
    expect(
      transcript.snapshot(path, "inspect", "completed", { output: "done" }),
    ).toBeUndefined();
    transcript.observe({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "retry" }] },
    });
    const second = transcript.snapshot(path, "inspect", "failed", {
      errorMessage: "timed out",
      output: "",
    })!;
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe(original);
    const delta = readFileSync(second, "utf8");
    expect(delta).toContain("retry");
    expect(delta).toContain("timed out");
    expect(delta).not.toContain("source code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host transcript bounds text and message count while retaining settlement", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-transcript-"));
  try {
    const transcript = new HostTranscript();
    for (let i = 0; i < 300; i++)
      transcript.observe({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `${i}:` + "字".repeat(100000) }],
        },
      });
    const path = transcript.snapshot(
      join(dir, "raw.jsonl"),
      "inspect",
      "aborted",
      { output: "" },
    )!;
    const content = readFileSync(path, "utf8");
    expect(Buffer.byteLength(content)).toBeLessThan(2 * 1024 * 1024);
    expect(content.trim().split("\n").length).toBeLessThan(100);
    expect(content).toContain("aborted");
    expect(content).toContain("Earlier execution entries omitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed host send retries the same immutable transcript with execution errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-retry-"));
  const paths: string[] = [];
  const state = new HostSubagentState({
    sendMessage: (message) => {
      paths.push((message.details as { outputFile: string }).outputFile);
      if (paths.length === 1) throw new Error("host temporarily unavailable");
    },
  });
  const lane: Lane = {
    id: "lane",
    agent: "review",
    alias: "review",
    task: "inspect",
    sessionId: "session",
    kind: "background",
    status: "failed",
    startedAt: Date.now(),
    logPath: join(dir, "raw.jsonl"),
    errorMessage: "spawn failed",
  };
  try {
    state.publish(lane);
    state.publish(lane);
    state.publish(lane);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toBe(paths[0]);
    expect(readFileSync(paths[1]!, "utf8")).toContain("spawn failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
