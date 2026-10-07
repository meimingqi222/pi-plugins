import { expect, test } from "bun:test";
import { mapRunOutcome } from "../src/child-io.ts";
import { emptyStreamState } from "../src/executor.ts";

test("deadline failures distinguish total budget from upstream timeouts and preserve last activity", () => {
  const result = mapRunOutcome({ killedBy: "timeout", timeoutMs: 900_000, lastEventLabel: "tool_start bash", quietMs: 397_000, state: emptyStreamState() });
  expect(result.status).toBe("failed");
  expect(result.errorMessage).toContain("total task deadline, not an upstream timeout");
  expect(result.errorMessage).toContain("tool_start bash (397s ago)");
  const upstream = mapRunOutcome({ timeoutMs: 900_000, state: { ...emptyStreamState(), errorMessage: "provider request timed out" } });
  expect(upstream.errorMessage).toBe("provider request timed out");
});
