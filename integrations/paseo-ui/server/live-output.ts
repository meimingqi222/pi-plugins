import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultSubagentLogDir } from "pi-subagent/logs";
import { foldSubagentLog } from "pi-subagent/transcript";
import { liveLogSchema } from "../shared/work-status.ts";
import type { LiveOutput } from "../shared/live-output.ts";

const SCAN_BYTES = 2 * 1024 * 1024;
const RESPONSE_CHARS = 256 * 1024;

export async function readLiveOutput(input: { log: string }, root = defaultSubagentLogDir()): Promise<LiveOutput> {
  const log = liveLogSchema.parse(input.log);
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
    const start = Math.max(0, stat.size - SCAN_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, SCAN_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
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
    let size = 0;
    const blocks = [];
    for (const block of folded.blocks.slice().reverse()) {
      size += JSON.stringify(block).length;
      if (blocks.length >= 120 || size > RESPONSE_CHARS) break;
      blocks.push({ ...block, id: block.id! });
    }
    return { state: "available", revision: `${stat.size}:${stat.mtimeMs}`, earlierDataOmitted: folded.earlierDataOmitted || blocks.length < folded.blocks.length, blocks: blocks.reverse() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return waiting;
    throw error;
  } finally { await handle?.close(); }
}
