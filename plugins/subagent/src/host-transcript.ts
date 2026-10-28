import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sweepSubagentLogs } from "./logs.ts";
import type { LaneStatus } from "./lane.ts";

interface Entry {
  message: Record<string, unknown>;
  timestamp: string;
}

const PREVIEW_BYTES = 1024 * 1024;
const PREVIEW_WEIGHT = 150;
// Paseo stops at 2 MiB / 200 mapped items. Leave room to drain at most
// twenty admitted calls (one text result each), an explanation and settlement.
const MAX_PENDING_TOOLS = 20;
const TOOL_RESULT_BYTES = 32 * 1024;
const LIMIT_NOTICE = "Later execution entries omitted: this native preview reached its display limit and is no longer live. This does not mean execution has stopped. For current activity and output, return to the parent task and open its output button, or ask the parent agent for status.";

/** Keep complete messages, never streaming starts/deltas or repeated end snapshots. */
export class HostTranscript {
  private entries: Entry[] = [];
  private bytes = 0;
  private weight = 0;
  private omitted = false;
  private published = false;
  private lastMessage = "";
  private lastSummary = "";
  private livePath?: string;
  private liveBytes = 0;
  private liveWeight = 0;
  private liveSealed = false;
  private liveLastText = "";
  private liveCapped = false;
  private liveLimitNotified = false;
  private readonly livePendingTools = new Map<string, string>();
  /**
   * The task text written as the live file's first user message.
   *
   * A host child page needs a prompt before the child emits anything, so the
   * task is seeded at `startLive`. The child then echoes that same prompt as
   * its own first user message (`Task: …`), which would show the task twice.
   * The seed is remembered until the first observed message so the echo can be
   * recognised and skipped.
   */
  private liveSeed?: string;

  /** A host follower reads one stable, append-only file while a background turn runs. */
  startLive(logPath: string, task: string): string | undefined {
    if (this.livePath && !this.liveSealed) return this.livePath;
    const path = `${logPath.replace(/\.jsonl$/u, "")}-host-${randomUUID()}.jsonl`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch { return undefined; }
    this.livePath = path;
    this.liveSealed = false;
    this.liveBytes = 0;
    this.liveWeight = 0;
    this.liveLastText = "";
    this.liveCapped = false;
    this.liveLimitNotified = false;
    this.livePendingTools.clear();
    this.liveSeed = undefined;
    if (this.entries[0]?.message.role !== "user") {
      this.writeLiveEntry(textEntry("user", task));
      this.liveSeed = boundText(task);
    }
    for (const entry of this.entries) this.writeLiveEntry(entry);
    this.entries = [];
    this.bytes = 0;
    this.weight = 0;
    sweepSubagentLogs(dirname(path));
    return path;
  }

  private appendLive(entry: Entry): boolean {
    const encoded = `${JSON.stringify(entry)}\n`;
    try {
      appendFileSync(this.livePath!, encoded, { encoding: "utf8", mode: 0o600 });
      this.liveBytes += Buffer.byteLength(encoded);
      this.liveWeight += messageWeight(entry.message);
      this.liveLastText = Array.isArray(entry.message.content)
        ? entry.message.content.map(part => object(part)?.text ?? "").join("") : "";
      return true;
    } catch { return false; }
  }

  private capLive(): void {
    this.liveCapped = true;
    this.omitted = true;
    if (!this.liveLimitNotified) this.liveLimitNotified = this.appendLive(textEntry("assistant", LIMIT_NOTICE));
  }

  private writeLiveEntry(entry: Entry): boolean {
    const message = entry.message;
    if (message.role === "toolResult") {
      const id = String(message.toolCallId);
      // Never send a result whose call was omitted, including during replay of
      // a bounded pre-launch buffer. The host would render an unknown JSON tool.
      if (!this.livePendingTools.has(id)) return false;
      const result = previewMessage({ ...message, toolName: this.livePendingTools.get(id) })!;
      if (!this.appendLive({ ...entry, message: result })) return false;
      this.livePendingTools.delete(id);
    } else {
      if (this.liveCapped) return false;
      const calls = toolCalls(message);
      if (this.liveBytes + Buffer.byteLength(JSON.stringify(entry)) + 1 > PREVIEW_BYTES
        || this.liveWeight + messageWeight(message) > PREVIEW_WEIGHT
        || this.livePendingTools.size + calls.length > MAX_PENDING_TOOLS
        || calls.some(call => Buffer.byteLength(JSON.stringify({ id: call.id, name: call.name })) > 8 * 1024)) {
        this.capLive();
        return false;
      }
      if (!this.appendLive(entry)) return false;
      for (const call of calls) this.livePendingTools.set(String(call.id), String(call.name));
    }
    // Results for admitted calls may use the reserved headroom even after the
    // ordinary preview closes. A lighter later message must not sneak through.
    if (this.liveWeight >= PREVIEW_WEIGHT || this.liveBytes >= PREVIEW_BYTES) this.capLive();
    return true;
  }

  observe(value: unknown): void {
    const event = object(value);
    const message = object(event?.message);
    if (
      event?.type !== "message_end" ||
      !message ||
      !["user", "assistant", "toolResult"].includes(String(message.role))
    )
      return;
    const bounded = previewMessage(message);
    if (!bounded) return;
    const encoded = JSON.stringify(bounded);
    if (encoded === this.lastMessage) return;
    if (Buffer.byteLength(encoded) > 128 * 1024) {
      this.omitted = true;
      if (this.livePath && !this.liveSealed) this.capLive();
      return;
    }
    this.lastMessage = encoded;
    if (bounded.role === "assistant" && !bounded.responseId)
      bounded.responseId = `host-${randomUUID()}`;
    const entry = { message: bounded, timestamp: new Date().toISOString() };
    if (this.livePath && !this.liveSealed) {
      // The seed is only a placeholder for the child's own prompt. Compare the
      // first message: an echo of the same task is already in the file, and a
      // second copy is what a host child page shows as two identical prompts.
      const seed = this.liveSeed;
      this.liveSeed = undefined;
      if (seed !== undefined && bounded.role === "user" && samePrompt(messageText(bounded), seed)) return;
      if (!this.writeLiveEntry(entry)) this.omitted = true;
      return;
    }
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

  /** Seal a live turn or publish an immutable delta for a completed turn. */
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
    if (this.livePath && !this.liveSealed) {
      // A cancelled child can settle before its outstanding tool returns. Close
      // the preview row explicitly instead of leaving a permanent running tool.
      for (const [id, name] of this.livePendingTools) {
        if (!this.writeLiveEntry({ timestamp: new Date().toISOString(), message: {
          role: "toolResult", toolCallId: id, toolName: name, isError: status !== "completed",
          content: [{ type: "text", text: "The task settled before this tool's result was available in the preview. See the final task status below." }],
        } })) return undefined;
      }
      if (this.omitted && !this.liveLimitNotified) this.capLive();
      if (status !== "completed" || this.liveLastText !== boundValue(summary)) {
        if (!this.appendLive(textEntry("assistant", summary))) return undefined;
      }
      this.liveSealed = true;
      this.liveSeed = undefined;
      this.published = true;
      this.lastSummary = summary;
      this.omitted = false;
      return this.livePath;
    }
    if (this.published && !this.entries.length && summary === this.lastSummary)
      return;
    const paired = pairedEntries(this.entries);
    const entries = paired.entries;
    this.omitted ||= paired.omitted;
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

function boundText(text: string): string {
  return text.length > 8000 ? text.slice(0, 8000) + "… [truncated]" : text;
}

function textEntry(role: string, text: string): Entry {
  return {
    message: { role, ...(role === "assistant" ? { responseId: `host-${randomUUID()}` } : {}), content: [{ type: "text", text: boundText(text) }] },
    timestamp: new Date().toISOString(),
  };
}

/** The text of a transcript message, whether its content is a string or parts. */
function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((part) => String(object(part)?.text ?? "")).join("")
    : "";
}

/**
 * Whether a child's user message is an echo of the seeded task.
 *
 * A spawner frames the prompt it sends (`Task: …` is pi's own subagent
 * convention), so the prefix is not part of the task and must not defeat the
 * comparison.
 */
function samePrompt(a: string, b: string): boolean {
  const body = (text: string): string => text.trim().replace(/^Task:\s*/iu, "").trim();
  return body(a) === body(b);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageWeight(message: Record<string, unknown>): number {
  return 1 + (Array.isArray(message.content) ? message.content.length : 1);
}

function toolCalls(message: Record<string, unknown>): Record<string, unknown>[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.map(object).filter((part): part is Record<string, unknown> => part?.type === "toolCall" && typeof part.id === "string");
}

function previewMessage(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const bounded = object(boundValue(message));
  if (!bounded || bounded.role !== "toolResult") return bounded;
  // Reserve a predictable result size and mapped-item cost for admitted calls.
  // The full result remains in the raw execution log used by the output screen.
  bounded.content = [{ type: "text", text: boundText(messageText(bounded)) }];
  if (Buffer.byteLength(JSON.stringify(bounded)) > TOOL_RESULT_BYTES) {
    const details = object(bounded.details);
    return {
      role: bounded.role, toolCallId: bounded.toolCallId, toolName: bounded.toolName,
      // Even control characters can occupy six bytes each in JSON. Together
      // with admitted call metadata, this fallback always fits the 32 KiB slot.
      isError: bounded.isError, content: [{ type: "text", text: messageText(bounded).slice(0, 3000) + "… [truncated]" }],
      ...(typeof details?.exitCode === "number" ? { details: { exitCode: details.exitCode } } : {}),
    };
  }
  return bounded;
}

/** A rolling completed-turn buffer may begin or end in the middle of a batch. */
function pairedEntries(entries: Entry[]): { entries: Entry[]; omitted: boolean } {
  const calls = new Set(entries.flatMap(entry => toolCalls(entry.message).map(call => String(call.id))));
  const results = new Set(entries.filter(entry => entry.message.role === "toolResult").map(entry => String(entry.message.toolCallId)));
  let omitted = false;
  const paired = entries.flatMap(entry => {
    const message = entry.message;
    if (message.role === "toolResult") {
      if (calls.has(String(message.toolCallId))) return [entry];
      omitted = true;
      // Preserve useful evidence without inventing a command or emitting an
      // orphan tool row that the host can only display as its raw JSON envelope.
      return [textEntry("assistant", `Earlier tool call omitted from this preview; retained ${String(message.toolName ?? "tool")} output:\n${messageText(message)}`)];
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [entry];
    const content = message.content.filter(part => object(part)?.type !== "toolCall" || results.has(String(object(part)?.id)));
    omitted ||= content.length !== message.content.length;
    return content.length ? [{ ...entry, message: { ...message, content } }] : [];
  });
  return { entries: paired, omitted };
}

/** Bound tool arguments/output as well as text; images are omitted from the transcript. */
function boundValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundText(value);
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
