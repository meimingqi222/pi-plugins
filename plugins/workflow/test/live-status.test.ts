import { describe, expect, test } from "bun:test";
import { formatElapsed, formatFooterStatus, renderLiveStatus } from "../src/runs/live-status.ts";
import type { RunRecord } from "../src/runs/registry.ts";
import type { WorkflowProgress } from "../src/core/types.ts";

const NOW = 1_700_000_000_000;

function progress(patch: Partial<WorkflowProgress> = {}): WorkflowProgress {
  return {
    schemaVersion: 1,
    runId: "wf_a",
    name: "inline",
    status: "running",
    startedAt: NOW - 192_000,
    updatedAt: NOW - 8_300,
    currentPhase: "review",
    agents: [
      { id: "a1", label: "scan", status: "completed", startedAt: NOW - 190_000, finishedAt: NOW - 185_000 },
      { id: "a2", label: "review-plugins", status: "running", startedAt: NOW - 8_300 },
    ],
    completedAgents: 1,
    totalAgents: 2,
    spentTokens: 5120,
    message: "phase: review",
    ...patch,
  };
}

function record(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "wf_a",
    name: "inline",
    status: "running",
    startedAt: NOW - 192_000,
    progress: progress(),
    ...patch,
  };
}

describe("formatElapsed", () => {
  test("scales from seconds to minutes to hours", () => {
    expect(formatElapsed(8_300)).toBe("8.3s");
    expect(formatElapsed(192_000)).toBe("3m 12s");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
    expect(formatElapsed(-5)).toBe("0.0s");
  });
});

describe("formatFooterStatus", () => {
	test("is undefined with nothing to report", () => {
		expect(formatFooterStatus([], { now: NOW })).toBeUndefined();
		expect(formatFooterStatus([record({ status: "completed", finishedAt: NOW })], { now: NOW })).toBeUndefined();
	});

	test("carries liveness only: how long, what phase, how many in flight", () => {
		expect(formatFooterStatus([record()], { now: NOW })).toBe("wf 3m 12s · review · 1 running");
	});

	test("names the count when more than one run is live", () => {
		const second = record({ runId: "wf_b", startedAt: NOW - 5_000, progress: progress({ runId: "wf_b", currentPhase: undefined }) });
		// The oldest run is the age worth reporting: every age does not fit.
		expect(formatFooterStatus([record(), second], { now: NOW })).toBe("wf 2 runs · 3m 12s · 2 running");
	});

	test("reports an exceeded cap, because that is the one silence that means something", () => {
		expect(formatFooterStatus([record({ agentTimeoutMs: 5_000 })], { now: NOW })).toBe(
			"wf 3m 12s · review · 1 running · 1 past timeout",
		);
	});

	test("drops the phase and the agent count when neither is known", () => {
		const text = formatFooterStatus([record({ progress: progress({ currentPhase: undefined, agents: [] }) })], { now: NOW });
		expect(text).toBe("wf 3m 12s");
	});
});

describe("renderLiveStatus", () => {
  test("describes what a running run is doing", () => {
    const text = renderLiveStatus([record()], { now: NOW });
    expect(text).toContain("Active workflows (1):");
    expect(text).toContain("wf_a  running  3m 12s  inline");
    expect(text).toContain("phase: review");
    expect(text).toContain("agents: 2 seen, 1 running, 1 completed");
    expect(text).toContain("running now: a2 \"review-plugins\" 8.3s");
    expect(text).toContain("tokens: 5120");
    expect(text).toContain("last progress: 8.3s ago");
  });

  test("states whether a hung child is bounded", () => {
    const unbounded = renderLiveStatus([record()], { now: NOW });
    expect(unbounded).toContain("per-agent timeout: none");

    const bounded = renderLiveStatus([record({ agentTimeoutMs: 120_000 })], { now: NOW });
    expect(bounded).toContain("per-agent timeout: 2m 0s");
  });

  test("flags an agent that outlived its own timeout", () => {
    // Silence alone proves nothing, so it is reported and left to the reader.
    // Exceeding a declared cap is different: the executor enforces it with a
    // timer that kills the child, so this is the one silence that is evidence.
    const text = renderLiveStatus([record({ agentTimeoutMs: 5_000 })], { now: NOW });
    expect(text).toContain('past the 5.0s per-agent timeout: a2 "review-plugins"');

    // An agent inside its cap is not flagged, and without a declared cap there is
    // nothing to compare against.
    const withinCap = renderLiveStatus([record({ agentTimeoutMs: 60_000 })], { now: NOW });
    expect(withinCap).not.toContain("past the");
    expect(renderLiveStatus([record()], { now: NOW })).not.toContain("past the");
  });

  test("names a failed agent instead of folding it into the pending remainder", () => {
    // `N seen, R running, C completed` left a failed agent accounted for by
    // nobody, so the reader had to infer it from the remainder and read the
    // remainder as "not started yet". A degraded run then looked healthy.
    const text = renderLiveStatus(
      [
        record({
          progress: progress({
            agents: [
              { id: "a1", label: "scan", status: "completed", startedAt: NOW - 190_000, finishedAt: NOW - 185_000 },
              {
                id: "a2",
                label: "review-plugins",
                status: "failed",
                startedAt: NOW - 8_300,
                finishedAt: NOW - 1_000,
                error: "Connection error.",
              },
              { id: "a3", label: "review-more", status: "running", startedAt: NOW - 500 },
            ],
            completedAgents: 1,
            totalAgents: 3,
          }),
        }),
      ],
      { now: NOW },
    );
    expect(text).toContain("agents: 3 seen, 1 running, 1 completed, 1 failed");
    expect(text).toContain('failed: a2 "review-plugins" (Connection error.)');
  });

  test("counts an aborted agent separately from a failed one", () => {
    const text = renderLiveStatus(
      [
        record({
          progress: progress({
            agents: [
              { id: "a1", label: "scan", status: "aborted", startedAt: NOW - 190_000, finishedAt: NOW - 185_000 },
            ],
            completedAgents: 0,
            totalAgents: 1,
          }),
        }),
      ],
      { now: NOW },
    );
    expect(text).toContain("agents: 1 seen, 0 running, 0 completed, 1 aborted");
    expect(text).toContain('aborted: a1 "scan"');
  });

  test("says so when a run has not emitted progress yet", () => {
    const text = renderLiveStatus([record({ progress: undefined })], { now: NOW });
    expect(text).toContain("no progress event yet");
  });

  test("lists settled runs compactly", () => {
    const settled: RunRecord = {
      runId: "wf_b",
      name: "inline",
      status: "completed",
      startedAt: NOW - 60_000,
      finishedAt: NOW - 20_000,
      result: {
        schemaVersion: 1,
        runId: "wf_b",
        name: "inline",
        status: "completed",
        value: null,
        meta: {},
        startedAt: NOW - 60_000,
        finishedAt: NOW - 20_000,
        spentTokens: 10,
        cacheHits: 0,
        agentCalls: 1,
        phases: [],
      },
    };
    const text = renderLiveStatus([settled], { now: NOW });
    expect(text).toContain("Active workflows: none.");
    expect(text).toContain("Settled runs:");
    expect(text).toContain("wf_b  completed  inline");
  });

  test("explains an empty registry", () => {
    const text = renderLiveStatus([], { now: NOW });
    expect(text).toContain("Active workflows: none.");
    expect(text).toContain("No workflow runs in this session.");
  });
});
