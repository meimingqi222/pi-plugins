import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow, DEFAULT_MAX_AGENTS } from "../src/runs/orchestrator.ts";
import { createWorkflowRunPaths, readJsonLines, WorkflowJournal } from "../src/runs/journal.ts";
import type { AgentExecutor } from "../src/runner/agent-runner.ts";
import type { WorkflowAgentRunInput } from "../src/core/types.ts";

/**
 * Every test passes a short timeout through to the worker host. The host is the
 * layer that can hang, and a regression there must fail a test rather than the
 * suite.
 */
const TIMEOUT_MS = 8_000;

/** An executor that records calls and returns a scripted reply. */
function recorder(
  reply: (input: WorkflowAgentRunInput) =>
    | Partial<{ value: unknown; text: string; status: "completed" | "failed"; errorMessage: string }>
    | Promise<Partial<{ value: unknown; text: string; status: "completed" | "failed"; errorMessage: string }>>,
): { executor: AgentExecutor; inputs: WorkflowAgentRunInput[] } {
  const inputs: WorkflowAgentRunInput[] = [];
  const executor: AgentExecutor = async (input) => {
    inputs.push(input);
    const result = await reply(input);
    return { status: "completed", usage: { input: 1, output: 1 }, ...(result as object) } as never;
  };
  return { executor, inputs };
}

async function withTemp(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-orch-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("workflow orchestration", () => {
  test("runs a script and returns its value with completion status", async () => {
    const { executor } = recorder(() => ({ value: "echo" }));
    const result = await runWorkflow({
      script: "return await agent('hi', {});",
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("echo");
    expect(result.agentCalls).toBe(1);
  });

  test("a script that throws is a script failure, not a harness crash", async () => {
    const { executor } = recorder(() => ({ value: null }));
    const result = await runWorkflow({
      script: "throw new Error('script blew up');",
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.status).toBe("failed");
    expect(result.stopReason).toContain("script blew up");
  });

  test("phases and logs are reported through onProgress", async () => {
    const { executor } = recorder(() => ({ value: 1 }));
    const messages: string[] = [];
    await runWorkflow({
      script: "phase('One'); log('a log'); return 1;",
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
      onProgress: (progress) => {
        if (progress.message) messages.push(progress.message);
      },
    });
    expect(messages).toContain("phase: One");
    expect(messages).toContain("a log");
  });

  test("token spend accumulates across agent calls", async () => {
    const { executor } = recorder(() => ({ value: 1 }));
    const result = await runWorkflow({
      script: "await agent('a', {}); await agent('b', {}); return 1;",
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
    });
    // Two calls at 1 input + 1 output each.
    expect(result.spentTokens).toBe(4);
  });
});

describe("workflow enforcement", () => {
  test("a run with no budget still bounds its fan-out", async () => {
    // Concurrency and the script are capped; without a default the number of
    // calls is not, so one script could spawn an unbounded number of children.
    const { executor } = recorder(() => ({ value: 1 }));
    const width = DEFAULT_MAX_AGENTS + 5;
    const result = await runWorkflow({
      script: `return await parallel(Array.from({ length: ${width} }, () => async () => agent('x', {})));`,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.status).toBe("failed");
    expect(result.stopReason).toContain("budget");
  });

  test("a panel refused by the budget starts no child at all", async () => {
    const { executor, inputs } = recorder(() => ({ value: 1 }));
    const result = await runWorkflow({
      script: "return await parallel([async () => agent('a', {}), async () => agent('b', {}), async () => agent('c', {})]);",
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      budget: { agents: 2 },
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.status).toBe("failed");
    expect(inputs).toHaveLength(0);
  });

  test("two declared writers never hold the workspace at once", async () => {
    // `roles.ts` calls the developer the single-writer role; this is what makes
    // that true, since role isolation alone only stops planners and reviewers.
    let live = 0;
    let peak = 0;
    const { executor } = recorder(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 25));
      live -= 1;
      return { value: 1 };
    });
    await runWorkflow({
      script: `return await parallel([
        async () => agent('a', { toolProfile: 'developer' }),
        async () => agent('b', { toolProfile: 'developer' }),
      ]);`,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      maxConcurrency: 4,
      timeoutMs: TIMEOUT_MS,
    });
    expect(peak).toBe(1);
  });

  test("two declared readers still run concurrently", async () => {
    // The control for the lock above: it must serialize writers, not every agent.
    let live = 0;
    let peak = 0;
    const { executor } = recorder(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 25));
      live -= 1;
      return { value: 1 };
    });
    await runWorkflow({
      script: `return await parallel([
        async () => agent('a', { toolProfile: 'researcher' }),
        async () => agent('b', { toolProfile: 'researcher' }),
      ]);`,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      maxConcurrency: 4,
      timeoutMs: TIMEOUT_MS,
    });
    expect(peak).toBe(2);
  });
});

describe("workflow budget", () => {
  test("a token budget refuses further calls once exhausted", async () => {
    const { executor, inputs } = recorder(() => ({ value: 1 }));
    const result = await runWorkflow({
      script: `
        await agent('a', {});
        try { await agent('b', {}); return 'both ran'; } catch (error) { return 'second refused'; }
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      budget: { tokens: 2 },
      timeoutMs: TIMEOUT_MS,
    });
    // First call spends the whole budget; the second must be refused.
    expect(result.value).toBe("second refused");
    expect(inputs).toHaveLength(1);
  });

  test("an agent-count budget bounds fan-out before any child starts", async () => {
    const { executor, inputs } = recorder(() => ({ value: 1 }));
    const result = await runWorkflow({
      script: `
        try { await agent('a', {}); } catch (error) { return 'refused'; }
        return 'ran';
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      budget: { agents: 0 },
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.value).toBe("refused");
    expect(inputs).toHaveLength(0);
  });

  test("an agent-count budget admits exactly the limit, not half of it", async () => {
    // Regression: the bridge admitted once and the runner admitted again per
    // attempt, so `agents: 2` allowed a single call. Each agent() must consume
    // exactly one slot.
    const { executor, inputs } = recorder(() => ({ value: 1 }));
    const result = await runWorkflow({
      script: `
        const seen = [];
        for (const name of ['a', 'b', 'c']) {
          try { await agent(name, {}); seen.push(name); } catch (error) { seen.push('refused'); }
        }
        return seen;
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      budget: { agents: 2 },
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.value).toEqual(["a", "b", "refused"]);
    expect(inputs).toHaveLength(2);
  });

  test("a schema retry is admitted once, not twice", async () => {
    // With the double-admission bug the first call consumed two slots, so
    // `agents: 1` refused it before the executor ever ran. Now attempt 1 runs
    // and the retry — a genuinely new child invocation — is refused on the
    // agent axis.
    let calls = 0;
    const executor: AgentExecutor = async () => {
      calls += 1;
      return { status: "completed", text: "not json", usage: { input: 1, output: 1 } } as never;
    };
    const result = await runWorkflow({
      script: `
        try {
          await agent('a', { schema: { type: 'object' } });
          return 'ran';
        } catch (error) { return 'refused: ' + error.message; }
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      budget: { agents: 1 },
      timeoutMs: TIMEOUT_MS,
    });
    expect(String(result.value)).toContain("refused");
    expect(calls).toBe(1);
  });
});

describe("workflow resume", () => {
  test("a resumed run reuses the journaled prefix without calling the executor", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const script = "const a = await agent('first', {}); const b = await agent('second', {}); return [a, b];";
      const first = createWorkflowRunPaths(root, "wf_1");
      const journal1 = await WorkflowJournal.open(first, script);
      const one = recorder((input) => ({ value: `v:${input.prompt}` }));
      const r1 = await runWorkflow({
        script,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor: one.executor,
        journal: journal1,
        timeoutMs: TIMEOUT_MS,
      });
      await journal1.flush();
      expect(r1.value).toEqual(["v:first", "v:second"]);

      // Second run with the same script: everything must come from the journal.
      const second = createWorkflowRunPaths(root, "wf_2");
      const journal2 = await WorkflowJournal.open(second, script, first);
      const two = recorder((input) => ({ value: `LIVE:${input.prompt}` }));
      const r2 = await runWorkflow({
        script,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor: two.executor,
        journal: journal2,
        timeoutMs: TIMEOUT_MS,
      });
      expect(two.inputs).toHaveLength(0);
      expect(r2.cacheHits).toBe(2);
      expect(r2.value).toEqual(["v:first", "v:second"]);
    } finally {
      await cleanup();
    }
  });

  test("a resumed call served from the journal does not spend the new run's agent budget", async () => {
    // The host admits a call before the orchestrator can know it is a cache hit,
    // so without a release a resume spends agent budget on work it did not do.
    // The budget here is one call for a resume of one cached plus one live call:
    // with the release the live call is admitted, without it the run is refused.
    const { root, cleanup } = await withTemp();
    try {
      const first = createWorkflowRunPaths(root, "wf_1");
      const journal1 = await WorkflowJournal.open(first, "return await agent('first', {});");
      const one = recorder(() => ({ value: "v:first" }));
      await runWorkflow({
        script: "return await agent('first', {});",
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor: one.executor,
        journal: journal1,
        timeoutMs: TIMEOUT_MS,
      });
      await journal1.flush();

      // Same first call, so it is reusable; the second call is new work.
      const script = "await agent('first', {}); await agent('second', {}); return 1;";
      const second = createWorkflowRunPaths(root, "wf_2");
      const journal2 = await WorkflowJournal.open(second, script, first);
      const two = recorder((input) => ({ value: `LIVE:${input.prompt}` }));
      const result = await runWorkflow({
        script,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor: two.executor,
        journal: journal2,
        budget: { agents: 1 },
        timeoutMs: TIMEOUT_MS,
      });
      expect(result.cacheHits).toBe(1);
      expect(two.inputs.map((input) => input.prompt)).toEqual(["second"]);
      expect(result.status).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  test("a changed first call makes every later call run live", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const original = "const a = await agent('first', {}); const b = await agent('second', {}); return [a, b];";
      const first = createWorkflowRunPaths(root, "wf_a");
      const journal1 = await WorkflowJournal.open(first, original);
      const one = recorder(() => ({ value: "old" }));
      await runWorkflow({
        script: original,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor: one.executor,
        journal: journal1,
        timeoutMs: TIMEOUT_MS,
      });
      await journal1.flush();

      // Same call positions, different first prompt: resume must stop at the
      // divergence and not serve the second call from cache either.
      const changed = "const a = await agent('CHANGED', {}); const b = await agent('second', {}); return [a, b];";
      const second = createWorkflowRunPaths(root, "wf_b");
      const journal2 = await WorkflowJournal.open(second, changed, first);
      const two = recorder(() => ({ value: "new" }));
      const r2 = await runWorkflow({
        script: changed,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor: two.executor,
        journal: journal2,
        timeoutMs: TIMEOUT_MS,
      });
      expect(two.inputs).toHaveLength(2);
      expect(r2.cacheHits).toBe(0);
      expect(r2.value).toEqual(["new", "new"]);
    } finally {
      await cleanup();
    }
  });
});

describe("workflow concurrency", () => {
  test("a parallel panel is bounded by maxConcurrency but all tasks run", async () => {
    let active = 0;
    let peak = 0;
    const { executor } = recorder(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { value: 1 };
    });
    const result = await runWorkflow({
      script: `
        const tasks = [1,2,3,4,5,6].map((n) => async () => await agent('task ' + n, {}));
        const values = await parallel(tasks);
        return values.length;
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      maxConcurrency: 2,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.value).toBe(6);
    expect(result.agentCalls).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("the default panel is capped at four concurrent agents", async () => {
    let active = 0;
    let peak = 0;
    const { executor } = recorder(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { value: 1 };
    });
    const result = await runWorkflow({
      script: `
        const tasks = [1,2,3,4,5,6,7,8].map((n) => async () => await agent('task ' + n, {}));
        const values = await parallel(tasks);
        return values.length;
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.value).toBe(8);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("maxConcurrency above four is clamped to four", async () => {
    let active = 0;
    let peak = 0;
    const { executor } = recorder(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { value: 1 };
    });
    const result = await runWorkflow({
      script: `
        const tasks = [1,2,3,4,5,6,7,8].map((n) => async () => await agent('task ' + n, {}));
        const values = await parallel(tasks);
        return values.length;
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      maxConcurrency: 16,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.value).toBe(8);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("a throwing task becomes null without failing the panel", async () => {
    const { executor } = recorder((input) => (input.prompt.includes("bad") ? Promise.reject(new Error("nope")) : { value: input.prompt }));
    const result = await runWorkflow({
      script: `
        const values = await parallel([
          async () => await agent('good', {}),
          async () => await agent('bad', {}),
        ]);
        return values;
      `,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
    });
    expect(result.value).toEqual(["good", null]);
  });
});

/**
 * What a run leaves behind for the case where nobody was watching.
 *
 * The failure these pin is diagnosability, not correctness: a run whose calls
 * all failed used to leave the run directory holding only `script.js`, which is
 * indistinguishable from a run that never started or is still hanging.
 */
describe("workflow observability on disk", () => {
  test("a failed call is journaled, not only the successes", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const { executor } = recorder(() => ({ status: "failed", errorMessage: "provider exploded" }) as never);
      const script = "return await agent('hi', {});";
      const paths = createWorkflowRunPaths(root, "wf_test");
      const journal = await WorkflowJournal.open(paths, script);
      await runWorkflow({ script, args: null, name: "t", cwd: root, executor, journal, timeoutMs: TIMEOUT_MS });
      await journal.flush();

      const entries = await readJsonLines<{ status: string; error?: string }>(paths.journalPath);
      expect(entries.map((entry) => entry.status)).toEqual(["failed"]);
      expect(entries[0]!.error).toContain("provider exploded");
    } finally {
      await cleanup();
    }
  });

  test("a failed agent carries its reason into the live progress snapshot", async () => {
    // The renderer can only name a failure the snapshot carries. Without this the
    // reason lived only in journal.jsonl, which is the extra read that made a
    // live failure invisible in practice.
    const { executor } = recorder(() => ({ status: "failed", errorMessage: "provider exploded" }) as never);
    const snapshotAgents: Array<{ status: string; error?: string }> = [];
    await runWorkflow({
      script: "return await agent('hi', { label: 'probe' });",
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor,
      timeoutMs: TIMEOUT_MS,
      onProgress: (progress) => {
        for (const agent of progress.agents) {
          snapshotAgents.push({ status: agent.status, ...(agent.error ? { error: agent.error } : {}) });
        }
      },
    });
    expect(snapshotAgents).toContainEqual({ status: "failed", error: "provider exploded" });
  });

  test("progress.json is written and ends with the terminal status", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const { executor } = recorder(() => ({ value: "ok" }));
      const script = "return await agent('hi', {});";
      const paths = createWorkflowRunPaths(root, "wf_test");
      const journal = await WorkflowJournal.open(paths, script);
      await runWorkflow({ script, args: null, name: "t", cwd: root, executor, journal, timeoutMs: TIMEOUT_MS });

      const progress = JSON.parse(await readFile(paths.progressPath, "utf8"));
      expect(progress.status).toBe("completed");
      expect(progress.completedAgents).toBe(1);
      expect(progress.spentTokens).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("a run the budget stopped reports that, and a run that merely overspent still completed", async () => {
    // Two different facts, reported on the surfaces that can hold them without
    // contradicting each other. Without this the run reports "1 agent call(s)
    // failed" and the actual cause is only in the journal.
    const { root, cleanup } = await withTemp();
    try {
      const refusedScript = "return await parallel([async () => agent('a', {}), async () => agent('b', {})]);";
      const refusedPaths = createWorkflowRunPaths(root, "wf_refused");
      const refusedJournal = await WorkflowJournal.open(refusedPaths, refusedScript);
      const { executor } = recorder(() => ({ value: 1 }));
      const refused = await runWorkflow({
        script: refusedScript,
        args: null,
        name: "t",
        cwd: root,
        executor,
        journal: refusedJournal,
        budget: { agents: 1 },
        timeoutMs: TIMEOUT_MS,
      });
      await refusedJournal.flush();
      expect(refused.status).toBe("failed");
      expect(refused.stopReason).toContain("agent budget refused further calls");
      expect(JSON.parse(await readFile(refusedPaths.progressPath, "utf8")).status).toBe("budget_exceeded");

      const overspentScript = "return await agent('a', {});";
      const overspentPaths = createWorkflowRunPaths(root, "wf_overspent");
      const overspentJournal = await WorkflowJournal.open(overspentPaths, overspentScript);
      const spent = await runWorkflow({
        script: overspentScript,
        args: null,
        name: "t",
        cwd: root,
        executor: recorder(() => ({ value: 1, usage: { input: 90, output: 40 } })).executor,
        journal: overspentJournal,
        budget: { tokens: 100 },
        timeoutMs: TIMEOUT_MS,
      });
      // A token limit is passive: the run can cross it and still finish. The
      // status stays honest and the overspend is the reason.
      expect(spent.status).toBe("completed");
      expect(spent.stopReason).toContain("token budget exceeded (130 spent)");
    } finally {
      await cleanup();
    }
  });

  test("the run's per-agent timeout and evidence path reach the executor", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const { executor, inputs } = recorder(() => ({ value: "ok" }));
      const script = "return await agent('hi', {});";
      const paths = createWorkflowRunPaths(root, "wf_test");
      const journal = await WorkflowJournal.open(paths, script);
      await runWorkflow({
        script,
        args: null,
        name: "t",
        cwd: root,
        executor,
        journal,
        agentTimeoutMs: 1_234,
        timeoutMs: TIMEOUT_MS,
      });

      expect(inputs[0]!.timeoutMs).toBe(1_234);
      expect(inputs[0]!.evidencePath).toBe(join(paths.runDir, "agents", "a0.jsonl"));
    } finally {
      await cleanup();
    }
  });
});

describe("run status", () => {
  test("an externally stopped run is aborted, a thrown script is failed", async () => {
    // The two outcomes must not share a status: "aborted" means stopped from
    // outside (a stop request or the run timeout), "failed" means the script
    // itself threw. Conflating them makes a crashed script look cancelled.
    const controller = new AbortController();
    const hanging = runWorkflow({
      script: `await agent("never", {});`,
      args: null,
      name: "t",
      cwd: process.cwd(),
      executor: () => new Promise(() => {}),
      signal: controller.signal,
      timeoutMs: TIMEOUT_MS,
    });
    controller.abort();
    const stopped = await hanging;
    expect(stopped.status).toBe("aborted");
  });
});

/**
 * The provider ceiling.
 *
 * A fan-out is only as reliable as the provider behind it: many reject a burst
 * of concurrent sessions, and a refused call is a failed agent rather than a
 * queued one. The default therefore has to be the safe number, with an
 * explicit, tested path to raise it.
 */
describe("provider concurrency ceiling", () => {
  const KEY = "PI_WORKFLOW_MAX_CONCURRENCY";
  let saved: string | undefined;

  function withEnv(value: string | undefined): void {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
  }

  test("defaults to four and clamps the request to it", async () => {
    const { DEFAULT_MAX_CONCURRENCY, maxConcurrencyCeiling } = await import("../src/runs/orchestrator.ts");
    expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
    withEnv(undefined);
    expect(maxConcurrencyCeiling({} as NodeJS.ProcessEnv)).toBe(4);
    expect(maxConcurrencyCeiling({ PI_WORKFLOW_MAX_CONCURRENCY: "9" } as NodeJS.ProcessEnv)).toBe(9);
    expect(maxConcurrencyCeiling({ PI_WORKFLOW_MAX_CONCURRENCY: "99" } as NodeJS.ProcessEnv)).toBe(32);
    expect(maxConcurrencyCeiling({ PI_WORKFLOW_MAX_CONCURRENCY: "0" } as NodeJS.ProcessEnv)).toBe(4);
    expect(maxConcurrencyCeiling({ PI_WORKFLOW_MAX_CONCURRENCY: "soon" } as NodeJS.ProcessEnv)).toBe(4);
  });

  test("a panel is bounded by the ceiling with no request", async () => {
    saved = process.env[KEY];
    withEnv(undefined);
    try {
      let active = 0;
      let peak = 0;
      const { executor } = recorder(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { value: 1 };
      });
      const result = await runWorkflow({
        script: `
          const tasks = [1,2,3,4,5,6,7,8].map((n) => async () => await agent('task ' + n, {}));
          const values = await parallel(tasks);
          return values.length;
        `,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor,
        timeoutMs: TIMEOUT_MS,
      });
      expect(result.value).toBe(8);
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      withEnv(saved);
    }
  });

  test("a request above the ceiling is clamped, not refused", async () => {
    saved = process.env[KEY];
    withEnv("2");
    try {
      let active = 0;
      let peak = 0;
      const { executor } = recorder(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { value: 1 };
      });
      const result = await runWorkflow({
        script: `
          const tasks = [1,2,3,4,5,6].map((n) => async () => await agent('task ' + n, {}));
          const values = await parallel(tasks);
          return values.length;
        `,
        args: null,
        name: "t",
        cwd: process.cwd(),
        executor,
        maxConcurrency: 8,
        timeoutMs: TIMEOUT_MS,
      });
      expect(result.value).toBe(6);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      withEnv(saved);
    }
  });
});
