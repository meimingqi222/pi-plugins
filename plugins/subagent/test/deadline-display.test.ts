import { expect, test } from "bun:test";
import { executeSubagent, subagentTimeoutMs, SubagentParams } from "../src/tool.ts";
import { formatBackground } from "../src/background.ts";
import type { Lane } from "../src/lane.ts";

test("task deadline is configurable and failure display preserves tool evidence without exposing log paths", async () => {
  let timeoutMs: number | undefined;
  const reason = "The agent timed out after 900000ms (total task deadline, not an upstream timeout); last event: tool_start bash (397s ago); its event stream is at C:/private/session.jsonl";
  const result = await executeSubagent({ agent: "review", task: "check", timeout: 1800 }, { cwd: "/repo", onProgress() {} }, {
    discover: () => [{ name: "review", description: "check", systemPrompt: "", filePath: "/review.md" }],
    executor: async (input) => {
      timeoutMs = input.timeoutMs;
      input.onProgress?.({ type: "tool_start", toolName: "bash" });
      return { status: "failed", text: "", errorMessage: reason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } };
    },
  });
  expect(timeoutMs).toBe(1_800_000);
  expect(result.details.progress?.activeTool).toBe("bash");
  expect(JSON.stringify(result.content)).not.toContain("C:/private");
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("total task deadline") });
  expect(result.details.errorMessage).toBe(reason);
});

test("environment deadline has explicit precedence and rejects unbounded values", () => {
  const previous = process.env.PI_SUBAGENT_TIMEOUT_SECONDS;
  try {
    delete process.env.PI_SUBAGENT_TIMEOUT_SECONDS;
    expect(subagentTimeoutMs()).toBe(1_800_000);
    expect(subagentTimeoutMs(10_800)).toBe(10_800_000);
    expect(Reflect.get(SubagentParams.properties.timeout, "maximum")).toBe(10_800);
    process.env.PI_SUBAGENT_TIMEOUT_SECONDS = "1800";
    expect(subagentTimeoutMs()).toBe(1_800_000);
    expect(subagentTimeoutMs(60)).toBe(60_000);
    process.env.PI_SUBAGENT_TIMEOUT_SECONDS = "10800";
    expect(subagentTimeoutMs()).toBe(10_800_000);
    for (const value of ["0", "NaN", "Infinity", "10801"]) {
      process.env.PI_SUBAGENT_TIMEOUT_SECONDS = value;
      expect(() => subagentTimeoutMs()).toThrow("between 1 and 10800");
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_SECONDS;
    else process.env.PI_SUBAGENT_TIMEOUT_SECONDS = previous;
  }
});

test("inspection separates readable title and activity from the full task identity", () => {
  const now = Date.now();
  const lane = { id: "sa-full-task-id", alias: "Transport review", agent: "review", status: "failed", startedAt: now - 900_000, finishedAt: now, progress: { phase: "tool", activeTool: "bash", completedTools: 30, lastEvent: "tool_start", lastActivityAt: now - 397_000, recentActivity: [] } } as unknown as Lane;
  const text = formatBackground(lane);
  expect(text.split("\n")[0]).toBe("**Transport review · failed**");
  expect(text).toContain("15m · 30 tools");
  expect(text).toContain("Task: `sa-full-task-id`");
});
