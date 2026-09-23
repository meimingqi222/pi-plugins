import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiArgs, childGuardPath, createPiExecutor } from "../src/runner/pi-executor.ts";

/**
 * Spawn-path tests for the agent executor, driven by a fixture that speaks pi's
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

function input(prompt: string, extra: Record<string, unknown> = {}) {
  return {
    prompt,
    options: {} as never,
    cwd: process.cwd(),
    runId: "r",
    agentId: "a",
    ...extra,
  } as never;
}

describe("pi executor spawn path", () => {
  test("a normal run returns the reply, its usage, and the model", async () => {
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("hello"));
    expect(result.status).toBe("completed");
    expect(result.text).toBe("reply:hello");
    expect(result.model).toBe("fixture/model");
    // Usage must survive the wire, or a run cannot account for its cost.
    expect(result.usage?.input).toBe(11);
    expect(result.usage?.output).toBe(7);
  });

  test("a closed stdin does not stall the child", async () => {
    // The fixture writes its reply and exits without reading anything. If the
    // executor piped stdin, this is where it would hang.
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("no input expected"));
    expect(result.status).toBe("completed");
  });

  test("many progress events are drained without stalling", async () => {
    // pi documents that a reader which stops consuming can stall it once the
    // pipe buffer fills, so the drain has to keep up. The fixture emits 500
    // updates with `input` equal to the index, so seeing 499 proves all of them
    // were read rather than just the first few.
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("CHATTER:500"));
    expect(result.status).toBe("completed");
    expect(result.usage?.input).toBe(499);
  });

  test("an assistant error is reported as a failed run", async () => {
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("ERROR:provider exploded"));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("provider exploded");
  });

  test("a hanging child is killed by the timeout instead of hanging the caller", async () => {
    const started = Date.now();
    const executor = createPiExecutor({ invocation: injection, timeoutMs: 1_200 });
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
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("HANG", { signal: controller.signal }));
    expect(result.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  test("a read-only role still completes", async () => {
    // The fixture ignores flags, so this pins that the argument path builds and
    // the process runs. The allowlist content is pinned in `roles.test.ts`.
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("planner role", { options: { toolProfile: "planner" } }));
    expect(result.status).toBe("completed");
  });

  test("an unknown role is rejected before spawning", async () => {
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    // `resolveToolProfile` throws, so no process should start at all.
    const result = await executor(input("bad role", { options: { toolProfile: "not-a-role" } }));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Unknown workflow role");
  });
});

/**
 * The two controls that make a hung or failed agent diagnosable after the run.
 */
describe("pi executor diagnostics", () => {
  test("a per-call timeout overrides the executor's default", async () => {
    // `agentTimeoutMs` is the run's per-agent cap. Before it was wired through,
    // the only per-agent bound was the executor default and this knob did
    // nothing to a hung child.
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("HANG", { timeoutMs: 250 }));
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out after 250ms");
  }, 15_000);

  test("the child's raw event stream is written to the evidence path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-evidence-"));
    try {
      const evidencePath = join(dir, "agents", "a0.jsonl");
      const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
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

  test("a timeout names the evidence file so the stream can be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wf-evidence-"));
    try {
      const evidencePath = join(dir, "agents", "a1.jsonl");
      const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
      const result = await executor(input("HANG", { timeoutMs: 250, evidencePath }));
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain(evidencePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("child argv", () => {
  test("loads the guard extension and keeps the prompt after --", () => {
    const args = buildPiArgs({
      invocation: { command: "pi", args: [] },
      prompt: "-not-a-flag",
      guardPath: "/tmp/guard.ts",
      tools: ["read", "bash"],
    });
    const index = args.indexOf("--extension");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe("/tmp/guard.ts");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("-not-a-flag");
  });

  test("omits the guard when it is unavailable", () => {
    const args = buildPiArgs({ invocation: { command: "pi", args: [] }, prompt: "hi" });
    expect(args).not.toContain("--extension");
  });

  test("the guard path resolves to a file the child can load", () => {
    const path = childGuardPath();
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    expect(path!.endsWith("child-guard.ts")).toBe(true);
  });
});
