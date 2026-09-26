import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentExecutor, type AgentRunInput } from "../src/executor.ts";

/**
 * Spawn-path tests for the shared executor, driven by a fixture that speaks pi's
 * JSON event stream.
 *
 * `applyEvent` is unit-tested on its own. These tests cover everything *around*
 * the parser — spawn, a closed stdin, draining stdout, the timeout kill, and the
 * abort path. Those are the parts that deadlocked a real session three times, and
 * they cannot be checked by calling the parser directly.
 *
 * Every test passes a short timeout, because a regression here hangs rather than
 * fails.
 */
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-pi.mjs");
const injection = { command: process.execPath, args: [fixture] };
const TIMEOUT_MS = 8_000;

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt, cwd: process.cwd(), ...extra };
}

describe("agent executor spawn path", () => {
  test("forwards child tool activity with a bounded path but no search pattern or output", async () => {
    const progress: unknown[] = [];
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("TOOLS", { onProgress: (event) => progress.push(event) }));
    expect(result.status).toBe("completed");
    expect(progress).toEqual([
      { type: "tool_start", toolName: "grep", target: "src/workflow.ts" },
      { type: "tool_end", toolName: "grep" },
    ]);
  });

  test("reports-allowlisted-lifecycle-metadata-without-copying-tool-inputs", async () => {
    const activity: unknown[] = [];
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("TOOLS", { onActivity: (event) => activity.push(event) }));
    expect(result.status).toBe("completed");
    const started = activity.find((event) => (event as { event?: string }).event === "tool_start") as Record<string, unknown>;
    expect(started).toMatchObject({ phase: "tool", toolName: "grep", target: "src/workflow.ts" });
    expect(started).not.toHaveProperty("args");
    expect(started).not.toHaveProperty("output");
    expect(JSON.stringify(activity)).not.toContain("secret");
  });
  test("a normal run returns the reply, its usage, and the model", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("hello"));
    expect(result.status).toBe("completed");
    expect(result.text).toBe("reply:hello");
    expect(result.model).toBe("fixture/model");
    // Usage must survive the wire, or a run cannot account for its cost.
    expect(result.usage.input).toBe(11);
    expect(result.usage.output).toBe(7);
    expect(result.usage.totalTokens).toBe(18);
  });

  test("counts a final assistant reply present only in agent_end", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("FINAL_IN_AGENT_END"));
    expect(result.text).toBe("final reply");
    expect(result.usage.totalTokens).toBe(30);
  });

  test("a closed stdin does not stall the child", async () => {
    // The fixture writes its reply and exits without reading anything. If the
    // executor piped stdin, this is where it would hang.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("no input expected"));
    expect(result.status).toBe("completed");
  });

  test("many progress events are drained without stalling", async () => {
    // pi documents that a reader which stops consuming can stall it once the
    // pipe buffer fills, so the drain has to keep up. The fixture emits 500
    // updates with `input` equal to the index, so seeing 499 proves all of them
    // were read rather than just the first few.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("CHATTER:500"));
    expect(result.status).toBe("completed");
    expect(result.usage.input).toBe(499);
  });

  test("an assistant error is reported as a failed run", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("ERROR:provider exploded"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("provider exploded");
  });

  test("a non-zero exit with no error event is a failure, not an empty success", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("SILENTFAIL:3"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("exited with code 3");
  });

  test("a hanging child is killed by the timeout instead of hanging the caller", async () => {
    const started = Date.now();
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: 1_200 });
    const result = await executor(input("HANG"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
    // The kill is what makes this bound meaningful.
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  test("an abort signal kills a hanging child", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("HANG", { signal: controller.signal }));
    expect(result.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  test("a delegated system prompt is written and cleaned up", async () => {
    // The fixture ignores `--append-system-prompt`, so this only proves the temp
    // file is created, passed, and removed without failing the call.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("hello", { systemPrompt: "You are a scout." }));
    expect(result.status).toBe("completed");
  });

  test("a delegated prompt preparation failure refuses the child", async () => {
    const executor = createAgentExecutor({ invocation: injection, systemPromptRoot: join(tmpdir(), "missing-pi-agent-root", "nested") });
    const result = await executor(input("hello", { systemPrompt: "You are a scout." }));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Could not prepare delegated system prompt");
  });

  test("parses a structured reply only when the caller asks for a value", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const withParse = await executor(
      input('JSONREPLY:{"file":"a.ts","verdict":"ok"}', { parse: (text) => JSON.parse(text) }),
    );
    expect(withParse.value).toEqual({ file: "a.ts", verdict: "ok" });

    // Without `parse`, a JSON-shaped reply must stay text: parsing it would hand
    // the caller an object where it asked for a string.
    const withoutParse = await executor(input('JSONREPLY:{"file":"a.ts"}'));
    expect(withoutParse.value).toBeUndefined();
    expect(withoutParse.text).toBe('{"file":"a.ts"}');
  });

  test("a throwing parse callback leaves the text and no value", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(
      input("not json", {
        parse: (text) => {
          throw new Error(`not JSON: ${text}`);
        },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.value).toBeUndefined();
    expect(result.text).toBe("reply:not json");
  });
});

/**
 * The two controls that make a hung or failed agent diagnosable after the run.
 */
describe("agent executor diagnostics", () => {
  test("a per-call timeout overrides the executor's default", async () => {
    // `agentTimeoutMs` is the run's per-agent cap. Before it was wired through,
    // the only per-agent bound was the executor default and this knob did
    // nothing to a hung child.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("HANG", { timeoutMs: 250 }));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out after 250ms");
  }, 15_000);

  test("the child's raw event stream is written to the evidence path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-evidence-"));
    try {
      const evidencePath = join(dir, "agents", "a0.jsonl");
      const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
      const result = await executor(input("evidence probe", { evidencePath }));
      expect(result.status).toBe("completed");

      const lines = (await readFile(evidencePath, "utf8")).trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      // Each line is the child's own event, so the file is a real transcript.
      expect(typeof JSON.parse(lines[0]!)).toBe("object");
      expect(lines.some((entry) => entry.includes("reply:evidence probe"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("evidenceMaxBytes-bounds-the-raw-stream-and-records-truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-evidence-cap-"));
    try {
      const evidencePath = join(dir, "agents", "capped.jsonl");
      const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
      const result = await executor(input("CHATTER:500", { evidencePath, evidenceMaxBytes: 512 }));
      expect(result.status).toBe("completed");
      const evidence = await readFile(evidencePath, "utf8");
      expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(512);
      expect(evidence).toContain('"type":"evidence_truncated"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a timeout names the evidence file so the stream can be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-evidence-"));
    try {
      const evidencePath = join(dir, "agents", "a1.jsonl");
      const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
      const result = await executor(input("HANG", { timeoutMs: 250, evidencePath }));
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain(evidencePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
