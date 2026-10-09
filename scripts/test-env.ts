// Scheduler switches govern spawned Pi sessions, not directly constructed test plugins.
// This preload is test-only: agentChildEnv still disables schedulers in production children.
for (const name of ["PI_GOAL_DISABLE", "PI_WORKFLOW_DISABLED", "PI_SUBAGENT_DISABLE"]) {
  delete process.env[name];
}
