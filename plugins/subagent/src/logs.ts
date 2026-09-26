import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUBAGENT_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const SUBAGENT_LOG_SCAN_BYTES = 2 * 1024 * 1024;
export const SUBAGENT_LOG_OUTPUT_MAX_BYTES = 32 * 1024;
export const SUBAGENT_LOG_DEFAULT_LINES = 20;
export const SUBAGENT_LOG_MAX_LINES = 50;
export const SUBAGENT_LOG_RETENTION_DAYS = 7;
export const SUBAGENT_LOG_MAX_FILES = 200;

export function defaultSubagentLogDir(): string {
  return process.env.PI_SUBAGENT_LOG_DIR || join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "subagent-logs",
  );
}

export function subagentLogPath(taskId: string, sessionId: string, dir = defaultSubagentLogDir()): string {
  return join(dir, `${safeFilePart(sessionId)}-${safeFilePart(taskId)}.jsonl`);
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 100) || "unknown";
}

/** Retain recent logs only; active logs stay newest because every event updates mtime. */
export function sweepSubagentLogs(
  dir = defaultSubagentLogDir(),
  now = Date.now(),
  retentionDays = SUBAGENT_LOG_RETENTION_DAYS,
  maxFiles = SUBAGENT_LOG_MAX_FILES,
): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return;
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const recent: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const { mtimeMs } = statSync(path);
      if (mtimeMs < cutoff) unlinkSync(path);
      else recent.push({ path, mtimeMs });
    } catch {
      // Best effort: a concurrent process may be creating or removing the file.
    }
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of recent.slice(maxFiles)) {
    try { unlinkSync(entry.path); } catch { /* Best effort. */ }
  }
}

export interface ReadSubagentLogOptions {
  query?: string;
  lines?: number;
}

export interface ReadSubagentLogResult {
  text: string;
  matchedLines: number;
  scannedBytes: number;
  earlierDataOmitted: boolean;
}

/** Read and optionally search only a bounded tail of a raw child JSONL stream. */
export function readSubagentLog(path: string, options: ReadSubagentLogOptions = {}): ReadSubagentLogResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const scanLimit = options.query?.trim() ? SUBAGENT_LOG_MAX_BYTES : SUBAGENT_LOG_SCAN_BYTES;
    const start = Math.max(0, size - scanLimit);
    const scannedBytes = size - start;
    const buffer = Buffer.alloc(scannedBytes);
    readSync(fd, buffer, 0, scannedBytes, start);
    let content = buffer.toString("utf8");
    if (start > 0) {
      const newline = content.indexOf("\n");
      content = newline < 0 ? "" : content.slice(newline + 1);
    }
    const query = options.query?.trim().toLocaleLowerCase();
    const matching = content
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && (!query || line.toLocaleLowerCase().includes(query)));
    const limit = Math.max(1, Math.min(SUBAGENT_LOG_MAX_LINES, Math.floor(options.lines ?? SUBAGENT_LOG_DEFAULT_LINES)));
    const selected = matching.slice(-limit);
    const outputLines: string[] = [];
    let outputBytes = 0;
    const outputBudgetBytes = SUBAGENT_LOG_OUTPUT_MAX_BYTES - 512;
    for (const line of selected.reverse()) {
      const bounded = truncateUtf8(line, 2_048);
      const lineBytes = Buffer.byteLength(bounded, "utf8") + (outputLines.length ? 1 : 0);
      if (outputBytes + lineBytes > outputBudgetBytes) break;
      outputLines.push(bounded);
      outputBytes += lineBytes;
    }
    outputLines.reverse();
    const earlierDataOmitted = start > 0;
    const header = matching.length === 0
      ? query ? `No log lines matched "${cleanQuery(options.query ?? "")}" in the scanned tail.` : "The subagent log is empty."
      : `Showing ${outputLines.length} of ${matching.length} matching log lines from ${earlierDataOmitted ? `the latest ${scannedBytes}` : `all ${scannedBytes}`} bytes${earlierDataOmitted ? ` (earlier data omitted; file size ${size} bytes)` : ""}.`;
    return {
      text: outputLines.length ? `${header}\n${outputLines.join("\n")}` : header,
      matchedLines: matching.length,
      scannedBytes,
      earlierDataOmitted,
    };
  } catch {
    return { text: "Subagent log is unavailable (not created or inaccessible).", matchedLines: 0, scannedBytes: 0, earlierDataOmitted: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Ignore close errors. */ }
    }
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = value;
  while (output.length > 0 && Buffer.byteLength(`${output}… [line truncated]`, "utf8") > maxBytes) {
    output = output.slice(0, -1);
  }
  return `${output}… [line truncated]`;
}

function cleanQuery(value: string): string {
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}
