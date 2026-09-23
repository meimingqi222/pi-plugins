/**
 * Workflow module boundaries for pi.
 *
 * `core/` is pure: types, schema validation, hashing, and the resume rule, with
 * no filesystem, no process, and no `pi` import. That constraint is what lets the
 * parts with real logic be tested directly, and it is why the run's disk format
 * lives in `runs/` instead.
 *
 * `host/` runs a script in a worker that can be terminated.
 * `runner/` executes one agent and enforces role isolation.
 * `runs/` owns the on-disk journal and ties a run together.
 * `pi/` is the thin layer that registers the tool and command with pi.
 *
 * The default export is the plugin entry, because `package.json` names this file
 * as the extension.
 */

export { default } from "./pi/index.ts";
export { workflowExtension, workflowsDisabled, type WorkflowExtensionOptions } from "./pi/index.ts";

export * from "./core/types.ts";
export { validateWorkflowSchema, type WorkflowSchemaResult } from "./core/schema.ts";
export { stableJson, workflowHash, workflowJsonValue } from "./core/hash.ts";
export { isJournalEntry, isReusable, ResumeLog } from "./core/journal.ts";
export { installDeterminismGuards, GUARD_ERROR_PREFIX } from "./host/sandbox.ts";
export { runScriptHost, type ScriptHostCallbacks, type ScriptHostResult } from "./host/bridge.ts";
export { resolveToolProfile, canWrite, ROLE_PROFILES } from "./runner/roles.ts";
export { runAgent, type AgentExecutor } from "./runner/agent-runner.ts";
export { createPiExecutor } from "./runner/pi-executor.ts";
export { resolveWorkflowSource, type WorkflowSource } from "./pi/script-source.ts";
export { runWorkflow, type WorkflowRunOptions } from "./runs/orchestrator.ts";
export { listSavedWorkflows, listWorkflowRuns, formatWorkflowStatus } from "./runs/progress.ts";
