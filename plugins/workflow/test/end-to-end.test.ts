import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "../src/runs/orchestrator.ts";
import { createPiExecutor } from "../src/runner/pi-executor.ts";
import { createWorkflowRunPaths, readJsonLines, WorkflowJournal } from "../src/runs/journal.ts";

/**
 * End-to-end: a workflow script drives the worker host, which calls the
 * orchestrator, which spawns real agent processes.
 *
 * Every other test in this package checks one layer. This one is the claim that
 * the layers compose, with a process actually spawned at the bottom — the
 * difference between "the parts pass their tests" and "a workflow runs".
 *
 * The spawned process is a fixture that speaks pi's JSON event stream, so the
 * test needs no provider, no network, and no model. Spawns are the part that
 * deadlocked a real session, so every test here also passes a short timeout.
 */
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-pi.mjs");
const AGENT_TIMEOUT_MS = 8_000;

async function withTemp(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-e2e-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function fixtureExecutor() {
  return createPiExecutor({ invocation: { command: process.execPath, args: [fixture] }, timeoutMs: AGENT_TIMEOUT_MS });
}

describe("workflow end to end", () => {
  test("a script's agent calls spawn real processes and return their replies", async () => {
    const result = await runWorkflow({
      script: `
        const a = await agent("one", {});
        const b = await agent("two", {});
        return [a, b];
      `,
      args: null,
      name: "e2e",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual(["reply:one", "reply:two"]);
    expect(result.agentCalls).toBe(2);
  });

  test("a parallel panel spawns concurrently and collects every result", async () => {
    const result = await runWorkflow({
      script: `
        const values = await parallel([
          async () => await agent("alpha", {}),
          async () => await agent("beta", {}),
          async () => await agent("gamma", {}),
        ]);
        return values;
      `,
      args: null,
      name: "e2e-parallel",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
      maxConcurrency: 3,
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual(["reply:alpha", "reply:beta", "reply:gamma"]);
  });

  test("token spend from spawned agents reaches the run total", async () => {
    const result = await runWorkflow({
      script: `await agent("x", {}); await agent("y", {}); return "done";`,
      args: null,
      name: "e2e-usage",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    // The fixture reports input 11 + output 7 per agent, twice.
    expect(result.spentTokens).toBe(36);
  });

  test("an agent failure surfaces as a failed script, not a harness crash", async () => {
    const result = await runWorkflow({
      script: `
        try { await agent("ERROR:downstream said no", {}); return "no"; }
        catch (error) { return "caught"; }
      `,
      args: null,
      name: "e2e-error",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("caught");
  });

  test("a resumed run reuses a journaled call instead of spawning again", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const script = `return await agent("reusable", {});`;
      const first = createWorkflowRunPaths(root, "wf_e2e_1");
      const journal1 = await WorkflowJournal.open(first, script);
      const r1 = await runWorkflow({
        script,
        args: null,
        name: "e2e-resume",
        cwd: process.cwd(),
        executor: fixtureExecutor(),
        journal: journal1,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      await journal1.flush();
      expect(r1.value).toBe("reply:reusable");

      // Second run: the journal must satisfy the call with no process spawned.
      const second = createWorkflowRunPaths(root, "wf_e2e_2");
      const journal2 = await WorkflowJournal.open(second, script, first);
      const r2 = await runWorkflow({
        script,
        args: null,
        name: "e2e-resume",
        cwd: process.cwd(),
        executor: fixtureExecutor(),
        journal: journal2,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      expect(r2.cacheHits).toBe(1);
      expect(r2.spentTokens).toBe(0);
      expect(r2.value).toBe("reply:reusable");
    } finally {
      await cleanup();
    }
  });

  test("the worker is terminated even when an agent hangs, so the run ends", async () => {
    // The script never resolves because the agent never answers. The host's own
    // timeout is the only thing that ends it, which is the property that keeps a
    // runaway script from taking the session with it.
    const started = Date.now();
    const result = await runWorkflow({
      script: `return await agent("HANG", {});`,
      args: null,
      name: "e2e-hang",
      cwd: process.cwd(),
      executor: createPiExecutor({
        invocation: { command: process.execPath, args: [fixture] },
        timeoutMs: 1_200,
      }),
      timeoutMs: 3_000,
    });
    expect(result.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe("the documented script contract", () => {
  test("every documented global works together, through a real spawned agent", async () => {
    // The tool's guidelines are the only place a model is told what a script is.
    // If any of it were wrong — a name that does not exist, a barrier that does
    // not behave, `budget` that never syncs — a first use would fail in a way no
    // unit test notices. This exercises the whole documented surface at once, at
    // the layer a user meets it, with processes actually spawned.
    const { root, cleanup } = await withTemp();
    try {
      const result = await runWorkflow({
        script: `
          meta = {
            name: "panel",
            description: "review each file",
            phases: [{ title: "review" }, { title: "digest" }],
          };
          phase("review");
          log("fanning out over " + args.files.length + " files");
          const schema = {
            type: "object",
            properties: { file: { type: "string" }, verdict: { type: "string" } },
            required: ["file", "verdict"],
          };
          const reviews = await parallel(args.files.map((file) => async () =>
            agent("JSONREPLY:" + JSON.stringify({ file: file, verdict: "ok" }), {
              schema: schema,
              label: "review-" + file,
              phase: "review",
              toolProfile: "reviewer",
            })));
          phase("digest");
          const digests = await pipeline(reviews, async (entry) =>
            entry === null ? null : "digest:" + entry.file);
          return {
            digests: digests,
            budgetTotal: budget.total,
            remaining: budget.remaining(),
          };
        `,
        args: { files: ["a.ts", "b.ts"] },
        name: "panel",
        cwd: root,
        executor: fixtureExecutor(),
        budget: { tokens: 100_000 },
        timeoutMs: AGENT_TIMEOUT_MS,
      });

      expect(result.status).toBe("completed");
      const value = result.value as { digests: unknown[]; budgetTotal: number | null; remaining: number | null };
      expect(value.digests).toEqual(["digest:a.ts", "digest:b.ts"]);
      expect(value.budgetTotal).toBe(100_000);
      expect(result.spentTokens).toBeGreaterThan(0);
      // `budget` is a synchronous global over state the parent owns, so what it
      // reports depends on the refresh that rides back with each settled call —
      // it must show real spend by the time the script reads it, not the value
      // captured before the first agent ran.
      expect(value.remaining).toBe(100_000 - result.spentTokens);
      expect(result.meta).toEqual({
        name: "panel",
        description: "review each file",
        phases: [{ title: "review" }, { title: "digest" }],
      });
      expect(result.phases.map((entry) => entry.title)).toEqual(["review", "digest"]);
      expect(result.agentCalls).toBe(2);
      expect(result.spentTokens).toBeGreaterThan(0);
      expect(result.stopReason).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("chained resume", () => {
  test("a second resume chained off the first reuses the prefix again", async () => {
    // Regression: a cache hit was not written to the new run's journal, so the
    // chained journal had a gap at the cached call and a further resume stopped
    // there and re-ran the work it had already paid for.
    const { root, cleanup } = await withTemp();
    try {
      const script = `return await agent("reusable", {});`;
      const runOnce = async (runId: string, previous?: ReturnType<typeof createWorkflowRunPaths>) => {
        const paths = createWorkflowRunPaths(root, runId);
        const journal = await WorkflowJournal.open(paths, script, previous);
        const result = await runWorkflow({
          script,
          args: null,
          name: "e2e-chain",
          cwd: process.cwd(),
          executor: fixtureExecutor(),
          journal,
          timeoutMs: AGENT_TIMEOUT_MS,
        });
        await journal.flush();
        return { paths, result };
      };

      const first = await runOnce("wf_chain_1");
      const second = await runOnce("wf_chain_2", first.paths);
      expect(second.result.cacheHits).toBe(1);

      const third = await runOnce("wf_chain_3", second.paths);
      // Reusing the prefix through the middle run is the property: the third run
      // inherits the cache the second one recorded, not just the first one's.
      expect(third.result.cacheHits).toBe(1);
      expect(third.result.spentTokens).toBe(0);

      const chained = await readJsonLines<{ status: string }>(second.paths.journalPath);
      expect(chained.map((entry) => entry.status)).toEqual(["cached"]);
    } finally {
      await cleanup();
    }
  });
});

/**
 * The structured-reply path, driven through the real executor.
 *
 * Every other test of the schema retry uses a fake executor that returns an
 * already-parsed `value`, which is why a bug that made the real executor never
 * parse survived them: the production path set `value` to the raw reply text, so
 * the reply was handed to the validator as a string and a valid JSON object in a
 * Markdown fence was rejected with `$ must be object`. Only a real spawn can
 * check the wiring between the two.
 */
describe("structured replies", () => {
  const STRICT_SCHEMA = `{
    type: "object",
    properties: { project: { type: "string" }, n: { type: "number" } },
    required: ["project", "n"],
    additionalProperties: false,
  }`;

  test("a bare JSON reply is parsed and validated", async () => {
    const result = await runWorkflow({
      script: `
        const value = await agent('JSONREPLY:{"project":"x","n":1}', { schema: ${STRICT_SCHEMA} });
        return value;
      `,
      args: null,
      name: "structured",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ project: "x", n: 1 });
  }, 20_000);

  test("a fenced JSON reply is unwrapped rather than rejected as a string", async () => {
    const result = await runWorkflow({
      script: `
        const value = await agent('FENCED:{"project":"x","n":2}', { schema: ${STRICT_SCHEMA} });
        return value;
      `,
      args: null,
      name: "fenced",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ project: "x", n: 2 });
  }, 20_000);

  test("a malformed reply is reported as not-JSON, not as a type error", async () => {
    const result = await runWorkflow({
      script: `
        await agent('BROKEN:{"project":"x","n":3}', { schema: ${STRICT_SCHEMA}, retries: 1 });
      `,
      args: null,
      name: "malformed",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(result.status).toBe("failed");
    expect(result.stopReason).toContain("not JSON");
    expect(result.stopReason).not.toContain("must be object");
  }, 20_000);

  test("a failed call still reports the tokens it spent", async () => {
    // A schema-repair attempt is a real, often expensive, model call — and it is
    // the one that fails. Dropping its usage made a fully failed run report zero
    // tokens, so the budget could not see money already lost.
    const result = await runWorkflow({
      script: `
        await agent('BROKEN:{"project":"x","n":4}', { schema: ${STRICT_SCHEMA}, retries: 1 });
      `,
      args: null,
      name: "spend",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(result.status).toBe("failed");
    expect(result.spentTokens).toBeGreaterThan(0);
  }, 20_000);
});

/**
 * The failure asymmetry a script has to know about.
 *
 * `parallel()` degrades a failure to null so siblings keep their work; a directly
 * awaited `agent()` throws. A synthesis step written outside the barrier therefore
 * aborts a run that every other phase degraded cleanly — which is how a real run
 * ended `aborted` with all data collected and nothing returned. Both halves are
 * behaviours; the test keeps the pair honest as a pair.
 */
describe("failure asymmetry", () => {
  test("a barrier keeps the run alive while a direct call ends it", async () => {
    const insideBarrier = await runWorkflow({
      script: `
        const values = await parallel([
          async () => await agent("ERROR:inside", {}),
          async () => await agent("outside-ok", {}),
        ]);
        return values;
      `,
      args: null,
      name: "barrier",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(insideBarrier.status).toBe("completed");
    const values = insideBarrier.value as Array<unknown>;
    expect(values[0]).toBeNull();
    expect(values[1]).toBe("reply:outside-ok");

    const direct = await runWorkflow({
      script: `
        await agent("ERROR:direct", {});
      `,
      args: null,
      name: "direct",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(direct.status).toBe("failed");
  }, 20_000);
});

describe("no-schema replies", () => {
  test("a JSON-shaped reply still arrives as text when no schema was declared", async () => {
    // The contract for a schema-less call is "the reply text is the value".
    // Parsing it would hand the script an object where it asked for a string.
    const result = await runWorkflow({
      script: `
        const value = await agent('JSONREPLY:{"a":1}', {});
        return typeof value === "string" ? value : "NOT-STRING";
      `,
      args: null,
      name: "no-schema",
      cwd: process.cwd(),
      executor: fixtureExecutor(),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe('{"a":1}');
  }, 20_000);
});
