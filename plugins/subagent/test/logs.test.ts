import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagentLog, subagentLogPath, SUBAGENT_LOG_MAX_BYTES, SUBAGENT_LOG_OUTPUT_MAX_BYTES, SUBAGENT_LOG_SCAN_BYTES } from "../src/logs.ts";

describe("subagent raw logs", () => {
  test("safe-paths-and-full-log-query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagent-logs-"));
    try {
      const path = subagentLogPath("sa-abc", "../../session", dir);
      expect(path.startsWith(dir)).toBe(true);
      const filler = `${JSON.stringify({ type: "message_update", text: "ordinary" })}\n`;
      const repetitions = Math.ceil((SUBAGENT_LOG_SCAN_BYTES + 128) / Buffer.byteLength(filler));
      await writeFile(path, `${JSON.stringify({ type: "assistant_message", text: "early-needle" })}\n${filler.repeat(repetitions)}`);

      const found = readSubagentLog(path, { query: "EARLY-NEEDLE", lines: 5 });
      expect(found.text).toContain("early-needle");
      expect(found.earlierDataOmitted).toBe(false);
      expect(found.scannedBytes).toBeGreaterThan(SUBAGENT_LOG_SCAN_BYTES);

      const tail = readSubagentLog(path);
      expect(tail.earlierDataOmitted).toBe(true);
      expect(tail.scannedBytes).toBe(SUBAGENT_LOG_SCAN_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounded-output-and-unavailable-log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagent-logs-cap-"));
    try {
      const path = join(dir, "many.jsonl");
      const matchingLine = JSON.stringify({ type: "tool_result", content: "match " + "x".repeat(3_000) });
      await writeFile(path, `${matchingLine}\n`.repeat(50));
      const result = readSubagentLog(path, { query: "match", lines: 50 });
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(SUBAGENT_LOG_OUTPUT_MAX_BYTES);
      expect(result.text).toContain("line truncated");
      expect(result.matchedLines).toBe(50);
      expect(readSubagentLog(join(dir, "missing.jsonl")).text).toContain("unavailable");
      expect(SUBAGENT_LOG_MAX_BYTES).toBeGreaterThan(SUBAGENT_LOG_SCAN_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
