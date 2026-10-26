// Scheduler switches govern spawned Pi sessions, not directly constructed test plugins.
// This preload is test-only: agentChildEnv still disables schedulers in production children.
for (const name of ["PI_GOAL_DISABLE", "PI_WORKFLOW_DISABLED", "PI_SUBAGENT_DISABLE"]) {
  delete process.env[name];
}

// Provider admission is process-wide by design, and test files share a process.
// A harness that leaves a fake child running keeps its ticket, so a later test
// waits on a ceiling the previous one filled. Reset before each test: this is
// test isolation for process-global state, not a production behaviour switch.
import { beforeEach } from "bun:test";
import { resetProcessAdmission } from "../plugins/run-core/src/admission.ts";
beforeEach(() => resetProcessAdmission());
