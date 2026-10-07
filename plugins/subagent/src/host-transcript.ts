import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sweepSubagentLogs } from "./logs.ts";
import type { LaneStatus } from "./lane.ts";

interface Entry {
  message: Record<string, unknown>;
  timestamp: string;
}

/** Keep complete messages, never streaming starts/deltas or repeated end snapshots. */
export class HostTranscript {
  private entries: Entry[] = [];
  private bytes = 0;
  private weight = 0;
  private omitted = false;
  private published = false;
  private lastMessage = "";
  private lastSummary = "";

  observe(value: unknown): void {
    const event = object(value);
    const message = object(event?.message);
    if (
      event?.type !== "message_end" ||
      !message ||
      !["user", "assistant", "toolResult"].includes(String(message.role))
    )
      return;
    const bounded = object(boundValue(message));
    if (!bounded) return;
    const encoded = JSON.stringify(bounded);
    if (encoded === this.lastMessage) return;
    if (Buffer.byteLength(encoded) > 128 * 1024) {
      this.omitted = true;
      return;
    }
    this.lastMessage = encoded;
    if (bounded.role === "assistant" && !bounded.responseId)
      bounded.responseId = `host-${randomUUID()}`;
    const entry = { message: bounded, timestamp: new Date().toISOString() };
    this.entries.push(entry);
    this.bytes += Buffer.byteLength(JSON.stringify(entry));
    this.weight += messageWeight(bounded);
    while (this.bytes > 1024 * 1024 || this.weight > 150) {
      const removed = this.entries.shift()!;
      this.bytes -= Buffer.byteLength(JSON.stringify(removed));
      this.weight -= messageWeight(removed.message);
      this.omitted = true;
    }
  }

  /** Each path is immutable; successive replies expose only new timeline entries. */
  snapshot(
    logPath: string,
    task: string,
    status: LaneStatus,
    result?: { output: string; errorMessage?: string },
  ): string | undefined {
    const summary =
      status === "completed"
        ? result?.output || "Subagent completed without text."
        : `Subagent ${status}: ${result?.errorMessage || result?.output || status}`;
    if (this.published && !this.entries.length && summary === this.lastSummary)
      return;
    const entries = [...this.entries];
    const textEntry = (role: string, text: string): Entry => ({
      message: {
        role,
        ...(role === "assistant" ? { responseId: `host-${randomUUID()}` } : {}),
        content: [{ type: "text", text: boundValue(text) }],
      },
      timestamp: new Date().toISOString(),
    });
    if (!this.published && entries[0]?.message.role !== "user")
      entries.unshift(textEntry("user", task));
    if (this.omitted)
      entries.unshift(
        textEntry(
          "assistant",
          "Earlier execution entries omitted by transcript limits.",
        ),
      );
    const last = entries.at(-1)?.message;
    const lastText = Array.isArray(last?.content)
      ? last.content.map((part: unknown) => object(part)?.text ?? "").join("")
      : "";
    if (status !== "completed" || lastText !== boundValue(summary))
      entries.push(textEntry("assistant", summary));
    const path = `${logPath.replace(/\.jsonl$/u, "")}-host-${randomUUID()}.jsonl`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch {
      return undefined; /* An unavailable transcript must not fail a task. */
    }
    sweepSubagentLogs(dirname(path));
    this.entries = [];
    this.bytes = 0;
    this.weight = 0;
    this.omitted = false;
    this.published = true;
    this.lastSummary = summary;
    return path;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageWeight(message: Record<string, unknown>): number {
  return 1 + (Array.isArray(message.content) ? message.content.length : 1);
}

/** Bound tool arguments/output as well as text; images are omitted from the transcript. */
function boundValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > 8000 ? value.slice(0, 8000) + "… [truncated]" : value;
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[nested data omitted]";
  if (Array.isArray(value))
    return value
      .slice(0, 20)
      .filter((item) => object(item)?.type !== "image")
      .map((item) => boundValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [key, boundValue(item, depth + 1)]),
  );
}
