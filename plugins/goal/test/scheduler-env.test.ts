import { expect, test } from "bun:test";
test("test harness clears inherited scheduler switches", () => {
  for (const name of ["PI_GOAL_DISABLE", "PI_WORKFLOW_DISABLED", "PI_SUBAGENT_DISABLE"]) expect(process.env[name]).toBeUndefined();
});
