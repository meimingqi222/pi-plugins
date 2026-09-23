import { describe, expect, test } from "bun:test";
import { RunRegistry, formatRun, maxActiveRunsCeiling, DEFAULT_MAX_ACTIVE_RUNS, type RunRecord } from "../src/runs/registry.ts";
import type { WorkflowRunResult } from "../src/core/types.ts";

function result(overrides: Partial<WorkflowRunResult> = {}): WorkflowRunResult {
  return {
    schemaVersion: 1,
    runId: "wf_1",
    name: "t",
    status: "completed",
    value: null,
    meta: {},
    startedAt: 0,
    finishedAt: 1,
    spentTokens: 0,
    cacheHits: 0,
    agentCalls: 0,
    phases: [],
    ...overrides,
  };
}

/**
 * Wait for the run to settle.
 *
 * Settlement happens in a `.then().catch().finally()` chain, all microtasks, so a
 * macrotask boundary is what guarantees the whole chain has run. Two
 * `await Promise.resolve()` calls are not enough and made these tests flaky.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A work function whose settlement the test controls. */
function deferred() {
  let resolve!: (value: WorkflowRunResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<WorkflowRunResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RunRegistry launch", () => {
  test("returns a running handle immediately, without awaiting the work", () => {
    const registry = new RunRegistry();
    const gate = deferred();
    const record = registry.launch({ runId: "wf_1", name: "t" }, () => gate.promise);
    // The handle is usable before the run settles: that is what makes a long
    // workflow non-blocking.
    expect(record.status).toBe("running");
    expect(record.runId).toBe("wf_1");
    expect(registry.activeCount()).toBe(1);
    gate.resolve(result());
  });

  test("a settled run records its result and leaves the active set", async () => {
    const settled: RunRecord[] = [];
    const registry = new RunRegistry({ onSettled: (record) => settled.push(record) });
    const gate = deferred();
    registry.launch({ runId: "wf_1", name: "t" }, () => gate.promise);
    gate.resolve(result({ agentCalls: 3, spentTokens: 42 }));
    await flush();

    const record = registry.get("wf_1");
    expect(record?.status).toBe("completed");
    expect(record?.result?.agentCalls).toBe(3);
    expect(registry.activeCount()).toBe(0);
    expect(settled).toHaveLength(1);
  });

  test("a run whose result is aborted is recorded as aborted", async () => {
    const registry = new RunRegistry();
    const gate = deferred();
    registry.launch({ runId: "wf_1", name: "t" }, () => gate.promise);
    gate.resolve(result({ status: "aborted", stopReason: "stopped" }));
    await flush();
    expect(registry.get("wf_1")?.status).toBe("aborted");
    expect(registry.get("wf_1")?.message).toBe("stopped");
  });

  test("a work function that throws is a failed run, not an unhandled rejection", async () => {
    // The orchestrator returns a result rather than throwing for a script
    // failure, so a throw here is unexpected — and must still settle.
    const registry = new RunRegistry();
    const gate = deferred();
    registry.launch({ runId: "wf_1", name: "t" }, () => gate.promise);
    gate.reject(new Error("harness exploded"));
    await flush();
    const record = registry.get("wf_1");
    expect(record?.status).toBe("failed");
    expect(record?.message).toContain("harness exploded");
  });

  test("onSettled fires exactly once per run", async () => {
    // A double delivery would post the same result twice into the conversation.
    let calls = 0;
    const registry = new RunRegistry({ onSettled: () => { calls += 1; } });
    registry.launch({ runId: "wf_1", name: "t" }, async () => result());
    await flush();
    expect(calls).toBe(1);
  });

  test("a throwing onSettled does not prevent settlement or crash", async () => {
    const registry = new RunRegistry({ onSettled: () => { throw new Error("delivery failed"); } });
    registry.launch({ runId: "wf_1", name: "t" }, async () => result());
    await flush();
    expect(registry.get("wf_1")?.status).toBe("completed");
    expect(registry.activeCount()).toBe(0);
  });

  test("launching the same run id twice is refused", () => {
    const registry = new RunRegistry();
    registry.launch({ runId: "wf_1", name: "t" }, () => new Promise(() => {}));
    expect(() => registry.launch({ runId: "wf_1", name: "t" }, () => new Promise(() => {}))).toThrow(/already active/);
  });

  test("refuses a run once the active limit is reached", () => {
    // Each active run holds up to a full panel of live agents, so an unbounded
    // number of runs is an unbounded number of child sessions.
    const registry = new RunRegistry({ maxActiveRuns: 2 });
    registry.launch({ runId: "wf_1", name: "t" }, () => new Promise(() => {}));
    registry.launch({ runId: "wf_2", name: "t" }, () => new Promise(() => {}));
    expect(() => registry.launch({ runId: "wf_3", name: "t" }, () => new Promise(() => {}))).toThrow(/already active/);
    expect(registry.activeCount()).toBe(2);
  });

  test("the limit frees up as runs settle", async () => {
    const registry = new RunRegistry({ maxActiveRuns: 1 });
    const first = deferred();
    registry.launch({ runId: "wf_1", name: "t" }, () => first.promise);
    expect(() => registry.launch({ runId: "wf_2", name: "t" }, () => new Promise(() => {}))).toThrow(
      /already active/,
    );
    first.resolve(result());
    await flush();
    expect(() => registry.launch({ runId: "wf_2", name: "t" }, () => new Promise(() => {}))).not.toThrow();
  });

  test("the ceiling honours the environment override and falls back on a bad one", () => {
    expect(maxActiveRunsCeiling({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_ACTIVE_RUNS);
    expect(maxActiveRunsCeiling({ PI_WORKFLOW_MAX_ACTIVE_RUNS: "8" } as NodeJS.ProcessEnv)).toBe(8);
    expect(maxActiveRunsCeiling({ PI_WORKFLOW_MAX_ACTIVE_RUNS: "0" } as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_ACTIVE_RUNS);
    expect(maxActiveRunsCeiling({ PI_WORKFLOW_MAX_ACTIVE_RUNS: "nope" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MAX_ACTIVE_RUNS,
    );
  });
});

describe("RunRegistry stop", () => {
  test("stop aborts the run's own signal", () => {
    const registry = new RunRegistry();
    let observed: AbortSignal | undefined;
    registry.launch({ runId: "wf_1", name: "t" }, (signal) => {
      observed = signal;
      return new Promise(() => {});
    });
    expect(observed?.aborted).toBe(false);
    expect(registry.stop("wf_1")).toBe(true);
    expect(observed?.aborted).toBe(true);
  });

  test("stopping an unknown or settled run is a no-op", async () => {
    const registry = new RunRegistry();
    expect(registry.stop("nope")).toBe(false);
    registry.launch({ runId: "wf_1", name: "t" }, async () => result());
    await flush();
    expect(registry.stop("wf_1")).toBe(false);
  });

  test("stopAll aborts every active run", () => {
    const registry = new RunRegistry();
    const signals: AbortSignal[] = [];
    for (const id of ["a", "b"]) {
      registry.launch({ runId: id, name: id }, (signal) => {
        signals.push(signal);
        return new Promise(() => {});
      });
    }
    registry.stopAll();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("RunRegistry history", () => {
  test("list puts active runs before settled ones", async () => {
    const registry = new RunRegistry();
    registry.launch({ runId: "done", name: "done" }, async () => result());
    await flush();
    registry.launch({ runId: "live", name: "live" }, () => new Promise(() => {}));
    const ids = registry.list().map((record) => record.runId);
    expect(ids).toEqual(["live", "done"]);
  });

  test("history is bounded, so listing cannot grow without limit", async () => {
    const registry = new RunRegistry({ historyLimit: 2 });
    for (const id of ["a", "b", "c"]) {
      registry.launch({ runId: id, name: id }, async () => result());
      await flush();
    }
    const ids = registry.list().map((record) => record.runId);
    expect(ids).toEqual(["c", "b"]);
  });

  test("get returns a copy, so a caller cannot mutate registry state", () => {
    const registry = new RunRegistry();
    registry.launch({ runId: "wf_1", name: "t" }, () => new Promise(() => {}));
    const record = registry.get("wf_1");
    record!.status = "completed";
    expect(registry.get("wf_1")?.status).toBe("running");
  });
});

describe("formatRun", () => {
  test("summarizes a settled run", () => {
    const text = formatRun({
      runId: "wf_1",
      name: "review",
      status: "completed",
      startedAt: 0,
      finishedAt: 2_500,
      result: result({ agentCalls: 4, spentTokens: 90, cacheHits: 1 }),
    });
    expect(text).toContain("wf_1");
    expect(text).toContain("completed");
    expect(text).toContain("4 agents");
    expect(text).toContain("90 tokens");
    expect(text).toContain("1 cached");
  });

  test("summarizes a run that has no result yet", () => {
    const text = formatRun({ runId: "wf_1", name: "review", status: "running", startedAt: 0 });
    expect(text).toContain("running");
  });
});

describe("RunRegistry progress", () => {
  test("stores the latest progress and exposes the requested agent timeout", async () => {
    const gate = deferred();
    const registry = new RunRegistry();
    registry.launch({ runId: "wf_1", name: "t", agentTimeoutMs: 30_000 }, () => gate.promise);

    expect(registry.get("wf_1")?.agentTimeoutMs).toBe(30_000);
    expect(registry.get("wf_1")?.progress).toBeUndefined();

    const snapshot = { schemaVersion: 1 as const, runId: "wf_1", name: "t", status: "running" as const, startedAt: 0, updatedAt: 5, agents: [], completedAgents: 0, totalAgents: 0, spentTokens: 0 };
    registry.setProgress("wf_1", snapshot);
    expect(registry.get("wf_1")?.progress?.updatedAt).toBe(5);

    // A settled run ignores later updates, so a straggling progress event cannot
    // resurrect it or contradict its result.
    gate.resolve(result());
    await flush();
    registry.setProgress("wf_1", { ...snapshot, updatedAt: 9 });
    expect(registry.get("wf_1")?.progress?.updatedAt).toBe(5);
    expect(registry.get("wf_1")?.status).toBe("completed");
  });
});
