import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultSubagentLogDir } from "pi-subagent/logs";
import { foldSubagentLog } from "pi-subagent/transcript";
import { liveLogSchema } from "../shared/work-status.ts";
import type { LiveOutput } from "../shared/live-output.ts";

const SCAN_BYTES = 2 * 1024 * 1024;
const RESPONSE_CHARS = 256 * 1024;
const ALL_SCAN_BYTES = 16 * 1024 * 1024;
const ALL_RESPONSE_CHARS = 2 * 1024 * 1024;
const PROMPT_PREVIEW_CHARS = 16_000;

function extractPrompt(buffer: Buffer, bytesRead: number): string | undefined {
  let offset = 0;
  while (offset < bytesRead) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) break;
    const line = buffer.subarray(offset, end).toString("utf8");
    offset = end + 1;
    try {
      const event = JSON.parse(line);
      if (typeof event === "object" && event !== null) {
        const msg = event.message ?? (event.type === "message" ? event.message : undefined);
        if (msg && typeof msg === "object" && msg.role === "user") {
          const content = msg.content;
          if (typeof content === "string") return content.trim();
          if (Array.isArray(content)) {
            const text = content
              .map(p => typeof p === "object" && p !== null && p.type === "text" && typeof p.text === "string" ? p.text : "")
              .filter(Boolean)
              .join("\n")
              .trim();
            if (text) return text;
          }
        }
      }
    } catch { /* skip non-json */ }
  }
  return undefined;
}

export async function readLiveOutput(input: { log: string; all?: boolean }, root = defaultSubagentLogDir()): Promise<LiveOutput> {
  const log = liveLogSchema.parse(input.log);
  const showAll = Boolean(input.all);
  const waiting: LiveOutput = { state: "waiting", revision: "", earlierDataOmitted: false, blocks: [] };
  let handle;
  try {
    const directory = await realpath(root);
    const path = join(directory, log);
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Transcript cannot be a symlink.");
    if (dirname(await realpath(path)) !== directory) throw new Error("Transcript is outside the subagent log directory.");
    // Refuse symlinks even when the target remains inside the configured directory.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Transcript is not a regular file.");
    const scanBytes = showAll ? Math.min(stat.size, ALL_SCAN_BYTES) : SCAN_BYTES;
    const start = Math.max(0, stat.size - scanBytes);
    const buffer = Buffer.alloc(Math.min(stat.size, scanBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);

    let prompt: string | undefined;
    if (start > 0) {
      const headSize = Math.min(stat.size, 256 * 1024);
      const headBuffer = Buffer.alloc(headSize);
      const { bytesRead: headBytes } = await handle.read(headBuffer, 0, headSize, 0);
      prompt = extractPrompt(headBuffer, headBytes);
    }

    // Use byte positions from the file, not decoded lengths or tail-local indices.
    // UTF-8 boundaries and a moving 2 MiB scan must not change an event's ID.
    const lines: string[] = [];
    const eventIds: string[] = [];
    let offset = start ? buffer.indexOf(10, 0) + 1 : 0;
    if (start && offset === 0) offset = bytesRead;
    while (offset < bytesRead) {
      const end = buffer.indexOf(10, offset);
      if (end < 0 || end >= bytesRead) break; // Defer incomplete writes.
      lines.push(buffer.subarray(offset, end).toString("utf8"));
      eventIds.push(`byte:${start + offset}`);
      offset = end + 1;
    }
    const folded = foldSubagentLog(lines, start > 0, { text: 16_000, result: 8_000, thinking: 4_000, args: 4_000 }, eventIds);
    prompt = prompt ?? folded.prompt ?? extractPrompt(buffer, bytesRead);
    const promptTruncated = (prompt?.length ?? 0) > PROMPT_PREVIEW_CHARS;
    if (promptTruncated) {
      const marker = "… [truncated]";
      prompt = prompt!.slice(0, PROMPT_PREVIEW_CHARS - marker.length) + marker;
    }

    const maxBlocks = showAll ? 2000 : 120;
    const maxChars = showAll ? ALL_RESPONSE_CHARS : RESPONSE_CHARS;
    const output: LiveOutput = {
      state: "available",
      revision: `${stat.size}:${stat.mtimeMs}:${showAll ? "all" : "recent"}`,
      prompt,
      ...(promptTruncated ? { promptTruncated: true } : {}),
      earlierDataOmitted: folded.earlierDataOmitted,
      totalBlocks: folded.blocks.length,
      blocks: [],
    };
    // Count the whole JSON envelope, including escaped prompt text, field
    // names and array separators. The prompt is not an unbudgeted side channel.
    let size = JSON.stringify(output).length;
    for (const block of folded.blocks.slice().reverse()) {
      const entry = { ...block, id: block.id! };
      const cost = JSON.stringify(entry).length + (output.blocks.length ? 1 : 0);
      if (output.blocks.length >= maxBlocks || size + cost > maxChars) break;
      size += cost;
      output.blocks.push(entry);
    }
    output.earlierDataOmitted ||= output.blocks.length < folded.blocks.length;
    output.blocks.reverse();
    return output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return waiting;
    throw error;
  } finally { await handle?.close(); }
}
