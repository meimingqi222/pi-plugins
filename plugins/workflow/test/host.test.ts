import { describe, expect, test } from "bun:test";
import { runScriptHost } from "../src/host/bridge.ts";

/**
 * Every test passes a short timeout. A regression in the host's shutdown path
 * deadlocks the child, and an un-timed-out test would hang the suite instead of
 * failing it — which is exactly the bug these tests exist to catch.
 */
const TEST_TIMEOUT_MS = 8_000;

interface Harness {
  result: Awaited<ReturnType<typeof runScriptHost>>;
  phases: string[];
  logs: string[];
  agents: Array<{ prompt: string; options: Record<string, unknown> }>;
}

async function run(
  script: string,
  options: {
    timeoutMs?: number;
    admit?: (calls: number) => void;
    check?: (calls: number) => void;
    signal?: AbortSignal;
    agent?: (prompt: string, options: Record<string, unknown>) => Promise<{ value: unknown; tokens: number }>;
  } = {},
): Promise<Harness> {
  const phases: string[] = [];
  const logs: string[] = [];
  const agents: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const result = await runScriptHost({
    script,
    args: { seed: 7 },
    name: "test",
    timeoutMs: options.timeoutMs ?? TEST_TIMEOUT_MS,
    signal: options.signal,
    callbacks: {
      async agent(prompt, agentOptions) {
        agents.push({ prompt, options: agentOptions as Record<string, unknown> });
        if (options.agent) return options.agent(prompt, agentOptions as Record<string, unknown>);
        return { value: `echo:${prompt}`, tokens: 3 };
      },
      phase(title) {
        phases.push(title);
      },
      log(message) {
        logs.push(message);
      },
      budget() {
        return { total: 50, spent: agents.length * 3 };
      },
      admit: options.admit,
      check: options.check,
    },
  });
  return { result, phases, logs, agents };
}

describe("script host lifecycle", () => {
  test("returns the script's value and reports completion", async () => {
    const { result } = await run("return 42;");
    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.value).toBe(42);
  });

  test("an async body is awaited, so a returned promise is the value", async () => {
    const { result } = await run("const v = await agent('a', {}); return v;");
    expect(result.value).toBe("echo:a");
  });

  test("a script that throws fails the run with its message", async () => {
    const { result } = await run("throw new Error('deliberate failure');");
    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe("failed");
    expect(result.errorMessage).toContain("deliberate failure");
  });

  test("a thrown non-Error is still reported", async () => {
    const { result } = await run("throw 'plain string';");
    expect(result.stopReason).toBe("failed");
    expect(result.errorMessage).toContain("plain string");
  });

  test("meta declared by the script reaches the result", async () => {
    const { result } = await run("meta = { name: 'demo' }; return 1;");
    expect(result.meta).toEqual({ name: "demo" });
  });

  test("non-JSON result and meta fail before the run is marked complete", async () => {
    for (const script of ["return 1n;", "meta = { value: 1n }; return 1;", "return new Map([['key', 1]]);"]) {
      const { result } = await run(script);
      expect(result.completed).toBe(false);
      expect(result.stopReason).toBe("failed");
      expect(result.errorMessage).toContain("JSON");
    }
  });
});

describe("script host agent bridge", () => {
  test("agent() forwards the prompt and options and returns the value", async () => {
    const { result, agents } = await run("return await agent('do it', { label: 'x', schema: { type: 'object' } });");
    expect(result.value).toBe("echo:do it");
    expect(agents[0].prompt).toBe("do it");
    expect(agents[0].options.label).toBe("x");
    expect(result.agentCalls).toBe(1);
  });

  test("a rejecting agent surfaces as a throw inside the script", async () => {
    const { result } = await run(
      "try { await agent('boom', {}); return 'no'; } catch (error) { return 'caught:' + error.message; }",
      { agent: async () => { throw new Error("agent exploded"); } },
    );
    expect(result.value).toContain("agent exploded");
  });

  test("admission refusal throws before the agent starts", async () => {
    const { result, agents } = await run(
      "try { await agent('x', {}); return 'no'; } catch (error) { return 'refused'; }",
      { admit: () => { throw new Error("budget exhausted"); } },
    );
    expect(result.value).toBe("refused");
    expect(agents).toHaveLength(0);
  });
});

describe("script host concurrency", () => {
  test("a panel wider than the remaining budget is refused before any child starts", async () => {
    // "Refused whole": the preview reaches the parent before a task runs, so the
    // panel throws instead of running the prefix the budget would have allowed.
    const seen: number[] = [];
    const { result, agents } = await run(
      `const values = await parallel([
         async () => agent('a', {}),
         async () => agent('b', {}),
         async () => agent('c', {}),
       ]);
       return values;`,
      {
        check(calls) {
          seen.push(calls);
          throw new Error("Run agent budget exhausted (1/1)");
        },
      },
    );
    expect(seen).toEqual([3]);
    expect(agents).toHaveLength(0);
    expect(result.completed).toBe(false);
    expect(result.errorMessage).toContain("budget exhausted");
  });

  test("a panel the budget can afford is previewed once and then runs", async () => {
    const seen: number[] = [];
    const { result } = await run(
      `return await parallel([async () => agent('a', {}), async () => agent('b', {})]);`,
      {
        check(calls) {
          seen.push(calls);
        },
      },
    );
    expect(seen).toEqual([2]);
    expect(result.value).toEqual(["echo:a", "echo:b"]);
  });

  test("parallel awaits every task, and a throwing task becomes null", async () => {
    const { result } = await run(`
      const values = await parallel([
        async () => 1,
        async () => 2,
        async () => { throw new Error("x"); },
      ]);
      return values;
    `);
    expect(result.value).toEqual([1, 2, null]);
  });

  test("pipeline runs stages per item with no barrier and passes (value, item, index)", async () => {
    const { result } = await run(`
      const seeds = ['a', 'b'];
      const values = await pipeline(seeds,
        async (value, item, index) => value + item + index,
        async (value) => value.toUpperCase(),
      );
      return values;
    `);
    expect(result.value).toEqual(["AA0", "BB1"]);
  });

  test("a throwing pipeline stage drops only that item", async () => {
    const { result } = await run(`
      return await pipeline([1, 2, 3], async (n) => { if (n === 2) throw new Error("x"); return n * 10; });
    `);
    expect(result.value).toEqual([10, null, 30]);
  });

  test("a pipeline with no agents does not preview or consume agent budget", async () => {
    const { result, agents } = await run("return await pipeline([1, 2], n => n + 1);", {
      check: () => { throw new Error("no agent budget"); },
      admit: () => { throw new Error("no agent budget"); },
    });
    expect(result.completed).toBe(true);
    expect(result.value).toEqual([2, 3]);
    expect(agents).toHaveLength(0);
  });

  test("pipeline admits actual agent calls rather than previewing its item count", async () => {
    let admitted = 0;
    const { result, agents } = await run(
      "return await pipeline([1, 2], n => agent('stage-' + n, {}));",
      {
        check: () => { throw new Error("not a static panel"); },
        admit: () => { if (++admitted > 1) throw new Error("agent cap"); },
      },
    );
    expect(result.completed).toBe(true);
    expect(result.value).toEqual(["echo:stage-1", null]);
    expect(agents).toHaveLength(1);
  });

  test("phase and log are delivered in order", async () => {
    const { phases, logs } = await run("phase('One'); log('hello'); phase('Two'); return 1;");
    expect(phases).toEqual(["One", "Two"]);
    expect(logs).toEqual(["hello"]);
  });

  test("budget reports the host's totals", async () => {
    const { result } = await run("return { total: budget.total, spent: budget.spent, remaining: budget.remaining() };");
    expect(result.value).toEqual({ total: 50, spent: 0, remaining: 50 });
  });

  test("budget.spent moves as agent calls settle", async () => {
    // Regression: the agent-result reply never carried `spent`, so the
    // worker's budget global stayed at its initial value forever and a script
    // reading budget.spent saw 0 no matter how much had run.
    const { result } = await run(
      "const before = budget.spent; await agent('a', {}); await agent('b', {}); return { before: before, after: budget.spent };",
    );
    expect(result.value).toEqual({ before: 0, after: 6 });
  });
});

describe("script host determinism guards", () => {
  test("Date, Math.random and the capability globals are unavailable", async () => {
    // The guards are what make a resumed run replay the same calls.
    const { result } = await run(`
      const probe = (fn) => { try { fn(); return 'allowed'; } catch (error) { return 'blocked'; } };
      return {
        date: probe(() => new Date()),
        now: probe(() => Date.now()),
        random: probe(() => Math.random()),
        globals: [typeof process, typeof require, typeof fetch].join(','),
      };
    `);
    expect(result.value).toEqual({ date: "blocked", now: "blocked", random: "blocked", globals: "undefined,undefined,undefined" });
  });

  test("the second clock and the second randomness source are unavailable too", async () => {
    // `crypto` and `performance` each break replay on their own, and the worker's
    // own terminal flush still has to run: `setImmediate` is removed from the
    // global, so the host captures the real one before the guards are installed.
    const { result } = await run(`
      const probe = (fn) => { try { return String(fn()); } catch (error) { return 'blocked'; } };
      return {
        randomUUID: probe(() => crypto.randomUUID()),
        now: probe(() => performance.now()),
        immediate: typeof setImmediate,
        crypto: typeof crypto,
        performance: typeof performance,
      };
    `);
    expect(result.completed).toBe(true);
    expect(result.value).toEqual({
      randomUUID: "blocked",
      now: "blocked",
      immediate: "undefined",
      crypto: "undefined",
      performance: "undefined",
    });
  });

  test("a guard cannot be undone from the script", async () => {
    const { result } = await run(`
      let reassigned = 'not attempted';
      try { Date = function () { return 'restored'; }; reassigned = 'succeeded'; }
      catch (error) { reassigned = 'rejected'; }
      let usable = 'unknown';
      try { new Date(); usable = 'yes'; } catch (error) { usable = 'no'; }
      return { reassigned, usable };
    `);
    expect(result.value).toEqual({ reassigned: "rejected", usable: "no" });
  });
});

describe("script host shutdown", () => {
  test("a runaway script is killed by the timeout instead of hanging the run", async () => {
    // The failure this pins: the child holds the event loop open on stdin after
    // it finishes, so the parent waits for a stdout end that never comes. The
    // timeout must actually kill the child, not just set a flag.
    const started = Date.now();
    const { result } = await run("while (true) {}", { timeoutMs: 1_500 });
    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("a blocked child that never writes is killed by the timeout", async () => {
    // A script awaiting an agent that never resolves must also be stoppable.
    const { result } = await run("await agent('never', {}); return 1;", {
      timeoutMs: 1_500,
      agent: () => new Promise(() => {}),
    });
    expect(result.stopReason).toBe("timeout");
  });

  test("an external abort signal kills the run", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("user cancelled")), 300);
    const { result } = await run("while (true) {}", { timeoutMs: TEST_TIMEOUT_MS, signal: controller.signal });
    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe("timeout");
    expect(result.errorMessage).toContain("user cancelled");
  });

  test("the host returns rather than hanging when the script is empty", async () => {
    const { result } = await run("");
    expect(result.completed).toBe(true);
    expect(result.value).toBeNull();
  });
});
