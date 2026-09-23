import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWorkflowStatus, listWorkflowRuns } from "../src/runs/progress.ts";

/**
 * The on-disk summary is the only view that survives the session that launched
 * the run, so it has to distinguish "ran and failed" from "never ran".
 */

function line(seq: number, status: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    seq,
    callId: `c${seq}`,
    callHash: `h${seq}`,
    prompt: "p",
    options: {},
    status,
    usage: { input: 1, output: 1 },
    attempt: 1,
    createdAt: 1_000 + seq,
    ...extra,
  })}\n`;
}

async function withRun(journal: string, snapshot?: Record<string, unknown>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-progress-"));
  const runDir = join(root, ".pi", "workflows", "runs", "wf_x");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "script.js"), "// a workflow\nreturn 1;\n");
  await writeFile(join(runDir, "journal.jsonl"), journal);
  if (snapshot) await writeFile(join(runDir, "progress.json"), JSON.stringify(snapshot));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("workflow run summary", () => {
  test("a completed run that lost one call is completed, not partial", async () => {
    // `partial` described the ledger, not the run: the script had finished and
    // returned its value, the user had already been handed a result, and the
    // listing called it a partial failure. Every run that lost a single agent
    // read the same way, so no run ever looked successful.
    const { root, cleanup } = await withRun(
      line(0, "completed") + line(1, "failed", { error: "Upstream stream ended before terminal chunk" }),
      { status: "completed", startedAt: 1_000, updatedAt: 2_000, completedAgents: 1, totalAgents: 2, spentTokens: 4 },
    );
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("completed");
      // The loss is not hidden — it is a count, where it belongs.
      expect(summary!.okCalls).toBe(1);
      expect(summary!.failedCalls).toBe(1);
      expect(summary!.lastError).toContain("Upstream stream ended");
    } finally {
      await cleanup();
    }
  });

  test("a completed verdict with nothing produced is a failure", async () => {
    // The script caught every failure and returned, so it is `completed` by its
    // own account. Reporting that as success would hide a total loss behind a
    // status word, which is the opposite mistake.
    const { root, cleanup } = await withRun(
      line(0, "failed", { error: "429: no available route" }) + line(1, "failed", { error: "429: no available route" }),
      { status: "completed", startedAt: 1_000, updatedAt: 2_000, completedAgents: 0, totalAgents: 2 },
    );
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("failed");
    } finally {
      await cleanup();
    }
  });

  test("a run killed mid-flight is unfinished, whatever its journal says", async () => {
    const { root, cleanup } = await withRun(line(0, "completed"), {
      status: "running",
      startedAt: 1_000,
      updatedAt: 2_000,
      completedAgents: 1,
      totalAgents: 3,
    });
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("unfinished");
    } finally {
      await cleanup();
    }
  });

  test("reports failures alongside successes and the last error", async () => {
    const { root, cleanup } = await withRun(line(0, "completed") + line(1, "failed", { error: "schema mismatch" }));
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("partial");
      expect(summary!.okCalls).toBe(1);
      expect(summary!.failedCalls).toBe(1);
      expect(summary!.lastError).toBe("schema mismatch");
      // A failure still proves the run was alive, so its timestamp counts.
      expect(summary!.finishedAt).toBe(1_001);
    } finally {
      await cleanup();
    }
  });

  test("zero successes with failures reads as failed, not empty", async () => {
    const { root, cleanup } = await withRun(line(0, "failed", { error: "provider exploded" }));
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("failed");
      // Zero successes is the case that reads as "failed" rather than "empty":
      // the run did something, and what it did was fail.
      expect(summary!.okCalls).toBeUndefined();
      expect(summary!.failedCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("a run with no journal is empty", async () => {
    const { root, cleanup } = await withRun("");
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("empty");
      expect(summary!.failedCalls).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("failed-call spend", () => {
  test("a failed call's tokens count toward the run's spend", async () => {
    // A failed entry carries real usage; skipping it would report a run that
    // cost money as costing nothing — the same undercount the journal fix
    // removed from the live path.
    const { root, cleanup } = await withRun(
      line(0, "failed", { error: "x", usage: { input: 40, output: 2 } }),
    );
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("failed");
      expect(summary!.spentTokens).toBe(42);
    } finally {
      await cleanup();
    }
  });
});

describe("run listing format", () => {
  test("names the outcome and splits successes from failures", () => {
    const at = new Date("2026-09-23T06:31:00Z").getTime();
    const text = formatWorkflowStatus(
      [
        {
          runId: "wf_abc123",
          dir: "/tmp/x",
          status: "partial",
          okCalls: 1,
          failedCalls: 2,
          spentTokens: 419209,
          startedAt: at,
          durationMs: 592_000,
          lastError: "The agent was aborted",
        },
      ],
      [],
    );
    // The outcome is a word, not "recorded"; the split is explicit; the magnitude
    // has separators; and the duration tells a long run from a quick one.
    expect(text).toContain("partial");
    expect(text).not.toContain("recorded");
    expect(text).toContain("1 ok, 2 failed");
    expect(text).toContain("419,209 tok");
    expect(text).toContain("9m 52s");
    expect(text).toContain("error: The agent was aborted");
  });

  test("an unjournaled run is reported from its progress snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-wf-progress-"));
    const runDir = join(root, ".pi", "workflows", "runs", "wf_y");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "progress.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: "wf_y",
        status: "aborted",
        startedAt: 5_000,
        updatedAt: 11_000,
        completedAgents: 1,
        totalAgents: 3,
        spentTokens: 42,
        agents: [],
      })}\n`,
    );
    try {
      const [summary] = await listWorkflowRuns(root);
      expect(summary!.status).toBe("aborted");
      expect(summary!.okCalls).toBe(1);
      expect(summary!.failedCalls).toBe(2);
      expect(summary!.spentTokens).toBe(42);
      expect(summary!.durationMs).toBe(6_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("run listing details", () => {
  test("a long error is cut at a word boundary and marked", () => {
    // A provider rate-limit body is JSON after the useful part. Cutting it raw
    // leaves a dangling brace that reads like a truncation bug rather than like
    // a deliberate bound.
    const error = `429: {"message":"No available route for model \"step-5-preview\": all providers are temporarily rate-limited","type":"rate_limit_exceeded","param":null,"code":"rate_limit_exceeded"}`;
    const run = [
      {
        runId: "wf_rl",
        dir: "/tmp/x",
        status: "failed" as const,
        failedCalls: 6,
        startedAt: Date.now() - 35_000,
        durationMs: 35_000,
        lastError: error,
      },
    ];
    const text = formatWorkflowStatus(run, []);
    expect(text).toContain("0 ok, 6 failed");
    expect(text).toContain("all providers are temporarily");
    // The head carries the useful part; the trailing JSON body is dropped whole,
    // so no dangling brace and no mid-token cut.
    expect(text).not.toContain("rate_limit_exceeded\"");
    expect(text).toContain("…");
    expect(text.endsWith("…")).toBe(true);
  });

  test("an inline task description is not printed as a run name", () => {
    // The script's first comment usually describes the task, which competes with
    // the run id rather than naming the run.
    const text = formatWorkflowStatus(
      [{ runId: "wf_a", dir: "/tmp", status: "completed", okCalls: 3, name: "Analyze the plugins and review pi-workflow" }],
      [],
    );
    expect(text).not.toContain("Analyze the plugins");
    expect(text).toContain("completed");
  });

  test("unjournaled runs are explained once, as a legend", () => {
    const empty = { runId: "wf_e", dir: "/tmp", status: "empty" as const };
    const text = formatWorkflowStatus([empty, { ...empty, runId: "wf_f" }], []);
    expect(text).toContain("no journal");
    // Once as a legend, not once per run.
    expect(text.split("no journal").length - 1).toBe(1);
    expect(text).toContain("2 runs");
  });
});
