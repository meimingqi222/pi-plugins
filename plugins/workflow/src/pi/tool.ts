/**
 * The `workflow` tool: the model-facing surface.
 *
 * The description and guidelines are load-bearing, not decoration. The engine can
 * only be as useful as the model's decision to use it, and the failure mode of a
 * bad description is expensive: a model that infers a workflow from a task that
 * merely *looks* large fans out a hundred agents, spends a real budget, and
 * returns something worse than a direct answer would have been.
 *
 * So the guidance states an explicit opt-in rule, names the cheaper alternatives,
 * and warns against stacking primitives. That is the cheapest possible defence
 * against the most expensive mistake.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newWorkflowRunId, createWorkflowRunPaths, WorkflowJournal } from "../runs/journal.ts";
import { runWorkflow } from "../runs/orchestrator.ts";
import { createPiExecutor } from "../runner/pi-executor.ts";
import { resolveWorkflowSource, type WorkflowSource } from "./script-source.ts";
import type { WorkflowProgress, WorkflowRunResult } from "../core/types.ts";

export const WorkflowParams = Type.Object({
  script: Type.Optional(Type.String({ description: "Inline JavaScript workflow script" })),
  scriptPath: Type.Optional(Type.String({ description: "Path to a JavaScript workflow script, inside the project" })),
  name: Type.Optional(Type.String({ description: "Saved workflow name from .pi/workflows/saved" })),
  args: Type.Optional(Type.Unknown({ description: "JSON arguments exposed as the script's args global" })),
  resumeFromRunId: Type.Optional(Type.String({ description: "Resume the cached prefix of a previous run" })),
  budget: Type.Optional(Type.Integer({ minimum: 0, description: "Input+output token budget for this run (a resume is a new run)" })),
  maxAgents: Type.Optional(Type.Integer({ minimum: 1, description: "Cap on child-agent calls (default 64)" })),
  maxConcurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 32,
      description:
        "Live child agents. Clamped to the provider ceiling (default 4, PI_WORKFLOW_MAX_CONCURRENCY); a higher request is clamped, not refused, and this can only lower the ceiling.",
    }),
  ),
  agentTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: "Per-agent wall-clock cap" })),
  runTimeoutMs: Type.Optional(
    Type.Integer({ minimum: 1_000, description: "Wall-clock cap for the whole run (default 30 minutes)" }),
  ),
});

export const WORKFLOW_DESCRIPTION = [
  "Run a workflow: one JavaScript script that coordinates many isolated agents through agent(), parallel(), pipeline(), and phase().",
  "Each agent() is a separate pi session with its own context window, so fan-out does not fill the main conversation.",
  "Scripts run in a worker with no wall clock, no randomness, no network, and no filesystem; every agent call is journaled under .pi/workflows/runs so a run can resume instead of paying twice.",
  "Provide exactly one of script, scriptPath, or name.",
].join(" ");

/**
 * The guidance appended to the system prompt while this tool is active.
 *
 * Kept as an exported constant so the wording is reviewable in one place and
 * testable without registering a tool.
 */
export const WORKFLOW_GUIDELINES: string[] = [
  "Use `workflow` only when the user has opted in: the keyword \"ultraloop\" in the current message, an explicit request (use a workflow / fan out agents / orchestrate this with subagents), a saved workflow invoked by name, or a skill that instructs it.",
  "Never infer opt-in from task shape or size. A large or parallel-looking task is not consent, and an opt-in from an earlier turn does not carry forward.",
  "Without an opt-in, prefer the targeted tool: a single subagent for one delegated task, `grep`/`read` for a lookup, or a direct edit.",
  // The script contract, stated where the model reads it. Step-Code teaches this
  // in its tool description; without it an author has to read the source to learn
  // what a script is, which is the difference between a tool and a framework.
  "A `script` is the **body of an async function**: `return` is the run's value, and `args` is the tool call's `args`. Available: `agent(prompt, options)`, `parallel(tasks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, and `budget` (`{total, spent, remaining()}`). Set `meta = { name, description, phases }` to describe the run.",
  "`agent()` options: `schema` (JSON Schema the reply must satisfy; a mismatch is retried with the errors fed back, up to `retries`), `toolProfile` (`planner`/`reviewer`/`researcher` are read-only, `qa` adds `bash`, `developer`/`worker` may edit), `label`, `phase`, `model`, `effort`. An agent with no `toolProfile` is unrestricted.",
  "`parallel(tasks)` is a barrier and `pipeline(items, ...stages)` has none; in both, a throwing task becomes `null` so siblings keep their work — filter or check rather than assuming a value.",
  "Prefer `JSON.stringify` on `agent()` results when a later stage consumes them, and keep the workflow under a few dozen agent calls unless the user asked for scale.",
  "Save a script you will run again by promoting the run: `/workflows save <name>` copies the most recent run's script into `.pi/workflows/saved/`, after which `workflow({ name })` runs it.",
  "A workflow is worth its cost only when the work is both wide and structured: reviewing many files, migrating many call sites, or running several independent checks whose results must be compared. For one file or a few lookups it is strictly worse.",
  "Give each `agent()` a short label and, when a later stage consumes the result, a `schema`. A schema mismatch is retried with the errors fed back, so declaring the shape is cheaper than hoping.",
  "Prefer `pipeline()` for per-item flows: it has no barrier between stages, so a stage sees only its own item. Use `parallel()` when every result must be available before the next step.",
  "Spend agents on verification, not only generation: adversarially check findings, and log anything dropped so a truncation is never silent.",
  "When a run is active, do not poll it with `sleep`: a bare sleep is blocked, and the settled result will wake you. Use `workflow_status` to see phases, running agents, and their elapsed time before then.",
  "A failing `agent()` inside parallel() or pipeline() becomes null and the run continues; a directly awaited `agent()` that fails throws and aborts the run. Keep a final synthesis step inside the barrier, or catch it, so earlier degradations do not cost the whole result.",
  "Keep a run under about 15 agents unless the user asked for scale.",
  "A run with no explicit budget is still capped at 64 agent calls, and at most 4 runs may be live at once; a `parallel()` or `pipeline()` wider than the remaining agent budget is refused whole, before any child starts.",
  "Concurrency is capped by the provider ceiling — default 4 live agents, raisable with PI_WORKFLOW_MAX_CONCURRENCY. maxConcurrency can only lower it; a burst beyond what the provider tolerates becomes failed agents, not queued ones.",
  "`Date`, `Math.random()`, and `Intl.DateTimeFormat` throw inside a script, and `process`, `require`, `fetch`, and timers are unavailable. Pass timestamps through `args` and vary prompts by index.",
];

export interface WorkflowToolOptions {
  /** Test seam: replaces the agent executor so no subprocess is spawned. */
  executor?: ReturnType<typeof createPiExecutor>;
  cwd?: string;
}

/**
 * Execute one workflow tool call.
 *
 * Extracted from the tool definition so it can be tested directly, and so the
 * registration stays a thin wiring step.
 */
export async function executeWorkflow(
  params: {
    script?: string;
    scriptPath?: string;
    name?: string;
    args?: unknown;
    resumeFromRunId?: string;
    budget?: number;
    maxAgents?: number;
    maxConcurrency?: number;
    agentTimeoutMs?: number;
    runTimeoutMs?: number;
  },
  options: {
    cwd: string;
    executor: ReturnType<typeof createPiExecutor>;
    onProgress?: (progress: WorkflowProgress) => void;
    signal?: AbortSignal;
    /**
     * A pre-resolved source and run id. The tool resolves both before
     * launching so the handle it returns names the same run the journal is
     * written under — resolving twice would hand the caller an id that
     * `resumeFromRunId` cannot find.
     */
    source?: WorkflowSource;
    runId?: string;
  },
): Promise<WorkflowRunResult> {
  const source = options.source ?? (await resolveWorkflowSource(options.cwd, params));
  const runId = options.runId ?? newWorkflowRunId();
  const paths = createWorkflowRunPaths(options.cwd, runId);

  // Resume reads the previous run's journal; a new journal is always written for
  // this run so its own results are reusable in turn.
  let previous: Parameters<typeof WorkflowJournal.open>[2];
  if (params.resumeFromRunId?.trim()) {
    previous = createWorkflowRunPaths(options.cwd, params.resumeFromRunId.trim());
  }
  const journal = await WorkflowJournal.open(paths, source.script, previous);

  const result = await runWorkflow({
    script: source.script,
    args: params.args ?? null,
    name: source.name,
    cwd: options.cwd,
    executor: options.executor,
    journal,
    ...(params.budget === undefined ? {} : { budget: { tokens: params.budget, agents: params.maxAgents } }),
    ...(params.maxAgents !== undefined && params.budget === undefined ? { budget: { agents: params.maxAgents } } : {}),
    ...(params.maxConcurrency === undefined ? {} : { maxConcurrency: params.maxConcurrency }),
    // `agentTimeoutMs` bounds one child invocation; `runTimeoutMs` bounds the
    // whole script. They were the same knob once, so the per-agent cap could not
    // actually be set and a hung child was only bounded by the executor default.
    ...(params.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: params.agentTimeoutMs }),
    ...(params.runTimeoutMs === undefined ? {} : { timeoutMs: params.runTimeoutMs }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    runId,
  });
  await journal.flush();
  return result;
}

/** Render a completed run for the model, bounded so a result cannot flood context. */
export function renderWorkflowResult(result: WorkflowRunResult): string {
  const summary = {
    runId: result.runId,
    status: result.status,
    value: result.value,
    phases: result.phases.map((phase) => phase.title),
    agentCalls: result.agentCalls,
    cacheHits: result.cacheHits,
    spentTokens: result.spentTokens,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result.scriptPath ? { scriptPath: result.scriptPath } : {}),
  };
  return JSON.stringify(summary, null, 2);
}

export type { ExtensionContext };
