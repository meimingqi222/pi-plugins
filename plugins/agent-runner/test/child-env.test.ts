import { describe, expect, test } from "bun:test";
import { SCHEDULER_DISABLE_FLAGS, agentChildEnv } from "../src/index.ts";

/**
 * A spawned agent must be told it is not the user's session.
 *
 * pi core has no subagent primitive, so nothing enforces this but the spawner;
 * each owning plugin honors its own switch, and this pins that the runner sets
 * all of them. The composed check (a plugin's `*Disabled()` sees this env) lives
 * with each plugin, so the two halves cannot drift.
 */
describe("agentChildEnv", () => {
  test("sets every scheduler-disable switch", () => {
    expect(agentChildEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin", ...SCHEDULER_DISABLE_FLAGS });
  });

  test("inherits the parent environment rather than replacing it", () => {
    // A child still needs its PATH and its provider credentials.
    expect(agentChildEnv({ OPENAI_API_KEY: "k" }).OPENAI_API_KEY).toBe("k");
  });
});
