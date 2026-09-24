import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childGuardPath, createPiExecutor } from "../src/runner/pi-executor.ts";

/**
 * Adapter tests for `createPiExecutor`.
 *
 * The process handling itself is tested in `pi-agent-runner`; what is tested
 * here is workflow policy on top of it — role resolution before the spawn, the
 * guard extension the child loads, and the per-call timeout and evidence path
 * threaded through. Those are the parts the shared runner cannot see.
 */
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-pi.mjs");
const injection = { command: process.execPath, args: [fixture] };
const TIMEOUT_MS = 8_000;

function input(prompt: string, extra: Record<string, unknown> = {}) {
  return { prompt, options: {} as never, cwd: process.cwd(), runId: "r", agentId: "a", ...extra } as never;
}

describe("workflow agent adapter", () => {
  test("a normal run returns the reply, its usage, and the model", async () => {
    const executor = createPiExecutor({ invocation: injection, timeoutMs: TIMEOUT_MS });
    const result = await executor(input("hello"));
    expect(result.status).toBe("completed");
    expect(result.text).toBe("reply:hello");
    expect(result.model).toBe("fixture/model");
    expect(result.usage?.input).toBe(11);
    expect(result.usage?.output).toBe(7);
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

  test("a per-call timeout overrides the executor's default", async () => {
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
      expect(typeof JSON.parse(lines[0]!)).toBe("object");
      expect(lines.some((entry) => entry.includes("reply:evidence probe"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("the child guard", () => {
  test("resolves to a file the child can load", () => {
    const path = childGuardPath();
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    expect(path!.endsWith("child-guard.ts")).toBe(true);
  });
});
