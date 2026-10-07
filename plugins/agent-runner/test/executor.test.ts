import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentExecutor,
  DEFAULT_STALL_MS,
  declaredToolTimeoutMs,
  describeAgentEvent,
  resolveStallMs,
  stallCheckIntervalMs,
  stallFailureMessage,
  stallThresholdMs,
  timeoutFailureMessage,
  trackDeclaredTimeouts,
  type AgentRunInput,
} from "../src/executor.ts";

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
 * fails. The one exception is "the deadline and silence bound keep the event loop
 * alive", which asserts the handles' ref state and so fails in milliseconds: a
 * hang is the one failure mode a test suite cannot report.
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

  test("a run that recovered after a terminal error is completed, not failed", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("RECOVER"));
    expect(result.status).toBe("completed");
    expect(result.text).toBe("recovered answer");
    // The stale 429 must not be handed back as this run's error.
    expect(result.errorMessage).toBeUndefined();
    expect(result.usage.totalTokens).toBe(12);
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

  test("a child that stops emitting is failed by the stall bound, naming the last event", async () => {
    const started = Date.now();
    // The wall clock is deliberately generous: only the stall bound can end this
    // run inside the assertion window, which is what makes the test about stalls.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS, stallMs: 200 });
    const result = await executor(input("STALL_TOOL:find"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("produced no output");
    // The diagnosis is the point: an operator needs to know *what* went quiet.
    expect(result.errorMessage).toContain("tool_start find");
    expect(result.errorMessage).not.toContain("timed out");
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  test("a tool that declared its own timeout outranks the silence bound while it runs", async () => {
    // The composition rule that keeps two budgets in this repository from
    // fighting: `pi-workflow`'s child guard injects a ten-minute shell budget by
    // default, and a silent legitimate command must not be killed by a bound that
    // knows less than the command does. No output at all is exactly the case —
    // pi's shell tool only emits progress when the command prints.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: 900, stallMs: 150 });
    const result = await executor(input("STALL_TOOL:bash DECLARED_TIMEOUT:5"));
    expect(result.status).toBe("failed");
    // The wall clock, not the silence bound, is what ended it.
    expect(result.errorMessage).toContain("timed out");
    expect(result.errorMessage).not.toContain("produced no output");
  }, 15_000);

  test("a parallel sibling finishing does not strip a long call's declared budget", async () => {
    // The end-to-end twin of the keying unit test: pi runs a tool batch in
    // parallel by default, so a fast `read` can finish while a silent `bash` with
    // a ten-minute budget is still in flight. Keyed bookkeeping is what keeps that
    // event from handing the long call back to the five-minute silence bound.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: 900, stallMs: 150 });
    const result = await executor(input("STALL_TOOL:bash DECLARED_TIMEOUT:5 SPLIT_BATCH"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
    expect(result.errorMessage).not.toContain("produced no output");
  }, 15_000);

  test("a tool that declared nothing is still caught by the silence bound", async () => {
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: 900, stallMs: 150 });
    const result = await executor(input("STALL_TOOL:find"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("produced no output");
  }, 15_000);

  test("the stall bound is off when stallMs is zero", async () => {
    // A disabled bound must leave the wall clock as the only limit, so this run
    // is ended by the timeout and not by the silence.
    const executor = createAgentExecutor({ invocation: injection, timeoutMs: 400, stallMs: 0 });
    const result = await executor(input("STALL_TOOL:find"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
  }, 15_000);

  test("the environment sets the stall bound, and an explicit value wins over it", () => {
    expect(resolveStallMs(undefined, {})).toBe(DEFAULT_STALL_MS);
    expect(resolveStallMs(undefined, { PI_AGENT_STALL_MS: "1500" })).toBe(1_500);
    expect(resolveStallMs(undefined, { PI_AGENT_STALL_MS: "0" })).toBe(0);
    expect(resolveStallMs(undefined, { PI_AGENT_STALL_MS: "nonsense" })).toBe(DEFAULT_STALL_MS);
    expect(resolveStallMs(50, { PI_AGENT_STALL_MS: "1500" })).toBe(50);
  });

  test("the stall label names a tool but never carries its arguments", () => {
    const label = describeAgentEvent({ type: "tool_execution_start", toolName: "grep", args: { pattern: "secret" } });
    expect(label).toBe("tool_start grep");
    expect(label).not.toContain("secret");
    expect(describeAgentEvent({ type: "message_update" })).toBe("model output");
    expect(describeAgentEvent(null)).toBe("event");
  });

  test("both transports share one sampling rule and one failure message", () => {
    // A second copy of process handling is a second place to fix the same bug;
    // this package's README records the divergence that cost last time.
    expect(stallCheckIntervalMs(1_000_000)).toBe(5_000);
    expect(stallCheckIntervalMs(200)).toBe(50);
    expect(stallCheckIntervalMs(0)).toBe(25);
    expect(stallFailureMessage({ stalledForMs: 300_000, lastEvent: "tool_start find" })).toBe(
      "The agent produced no output for 300000ms (last event: tool_start find); killed by the stall bound",
    );
    expect(timeoutFailureMessage({ timeoutMs: 900_000, evidencePath: "/tmp/a.jsonl" })).toBe(
      "The agent timed out after 900000ms; its event stream is at /tmp/a.jsonl",
    );
  });

  test("a declared timeout is tracked per call, and only its own end drops it", () => {
    // Seconds in, milliseconds out: pi's shell tools take seconds, and the guard
    // injects one.
    expect(declaredToolTimeoutMs({ type: "tool_execution_start", toolName: "bash", args: { timeout: 600 } })).toBe(600_000);
    expect(declaredToolTimeoutMs({ type: "tool_execution_start", toolName: "bash", args: {} })).toBeUndefined();
    expect(declaredToolTimeoutMs({ type: "tool_execution_start", toolName: "bash", args: { timeout: 0 } })).toBeUndefined();
    expect(declaredToolTimeoutMs({ type: "message_update" })).toBeUndefined();

    const budgets = new Map<string, number>();
    trackDeclaredTimeouts(budgets, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { timeout: 1 } });
    expect(budgets.get("t1")).toBe(1_000 + 30_000);
    // pi runs a tool batch in parallel, so a short read finishing must not strip
    // the exemption from the long silent shell still in flight.
    trackDeclaredTimeouts(budgets, { type: "tool_execution_end", toolCallId: "t2", toolName: "read" });
    expect(budgets.get("t1")).toBe(1_000 + 30_000);
    // The call that declared it ends the exemption, so the next silent call is
    // measured against the ordinary bound again.
    trackDeclaredTimeouts(budgets, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
    expect(budgets.size).toBe(0);
    // A turn boundary clears whatever never reported an end, rather than letting
    // it exempt the rest of a lane's life.
    trackDeclaredTimeouts(budgets, { type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: { timeout: 1 } });
    expect(budgets.size).toBe(1);
    trackDeclaredTimeouts(budgets, { type: "agent_end", messages: [] });
    expect(budgets.size).toBe(0);
    // The threshold in force is the longer of the two, per call.
    expect(stallThresholdMs(150, budgets)).toBe(150);
    budgets.set("t4", 630_000);
    budgets.set("t5", 30_000);
    expect(stallThresholdMs(150, budgets)).toBe(630_000);
    expect(stallThresholdMs(900_000, budgets)).toBe(900_000);
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

  test("the deadline and silence bound keep the event loop alive", async () => {
    // Both bounds are the only thing that can end a run the caller awaits, so
    // neither may be unref'd: Bun treats a loop whose only pending handle is an
    // unref'd timer as empty, then neither fires it nor exits — it spins at 100%
    // CPU. This asserts the handles' ref state instead of running a bound out, so
    // the regression fails immediately rather than hanging the file.
    const globals = globalThis as unknown as {
      setTimeout: (handler: any, timeout?: number, ...args: any[]) => any;
      setInterval: (handler: any, timeout?: number, ...args: any[]) => any;
    };
    const realSetTimeout = globals.setTimeout;
    const realSetInterval = globals.setInterval;
    const handles: Array<{ hasRef?: () => boolean }> = [];
    const wrap = (real: (handler: any, timeout?: number, ...args: any[]) => any) => (handler: any, timeout?: number, ...args: any[]) => {
      const handle = real(handler, timeout, ...args) as { hasRef?: () => boolean };
      handles.push(handle);
      return handle;
    };
    globals.setTimeout = wrap(realSetTimeout);
    globals.setInterval = wrap(realSetInterval);
    let execution: ReturnType<ReturnType<typeof createAgentExecutor>> | undefined;
    try {
      execution = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS })(input("TOOLS"));
      // The run arms its bounds after its own setup awaits, so wait for them
      // through the real timers rather than assuming they exist on return.
      const deadline = Date.now() + 2_000;
      while (handles.length < 2 && Date.now() < deadline) await new Promise((resolve) => realSetTimeout(resolve, 5));
    } finally {
      globals.setTimeout = realSetTimeout;
      globals.setInterval = realSetInterval;
    }
    // The wall clock and the silence bound are the only timers this path creates.
    expect(handles).toHaveLength(2);
    for (const created of handles) expect(created.hasRef?.()).not.toBe(false);
    expect((await execution!).status).toBe("completed");
  }, 15_000);
});


test("JSON executor forwards raw transcript events without letting observers fail the run", async () => {
  const events: unknown[] = [];
  const executor = createAgentExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
  const result = await executor(input("TOOLS", { onEvent: event => { events.push(event); throw new Error("observer failed"); } }));
  expect(result.status).toBe("completed");
  expect(events.some(event => (event as { type?: string }).type === "message_end")).toBe(true);
});
