import { HostSubagentState } from "../src/host-protocol.ts";
import type { Lane } from "../src/lane.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostTranscript } from "../src/host-transcript.ts";

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
