/**
 * Shared, JSON-only contracts for the workflow runtime.
 *
 * Everything crossing a boundary — into the sandbox, out of a child agent, onto
 * a journal line — is JSON. Keeping that constraint at the type level is what
 * makes the journal replayable and the NDJSON bridge total: a value that cannot
 * be serialized is rejected by the compiler rather than discovered at the wire.
 */

export type WorkflowJsonPrimitive = string | number | boolean | null;
export type WorkflowJsonValue = WorkflowJsonPrimitive | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

/**
 * The JSON-Schema surface a script may declare for an agent's output.
 *
 * Deliberately a subset. A schema is a contract the model is asked to satisfy and
 * the harness then enforces, so the shape accepted here is the shape the
 * validator implements — accepting more keys would mean silently not validating
 * them. TypeBox schemas are structurally compatible.
 */
export interface WorkflowJsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, WorkflowJsonSchema>;
  items?: WorkflowJsonSchema;
  required?: string[];
  additionalProperties?: boolean | WorkflowJsonSchema;
  enum?: WorkflowJsonValue[];
  const?: WorkflowJsonValue;
  anyOf?: WorkflowJsonSchema[];
  oneOf?: WorkflowJsonSchema[];
  allOf?: WorkflowJsonSchema[];
  not?: WorkflowJsonSchema;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
}

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface WorkflowAgentOptions {
  /** Short label for the live progress row. */
  label?: string;
  phase?: string;
  /** JSON Schema the agent's reply must satisfy; a mismatch is retried with the errors fed back. */
  schema?: unknown;
  /** Named tool profile (e.g. `planner`, `qa`) or an explicit tool list. */
  toolProfile?: string | string[];
  model?: string;
  effort?: string;
  retries?: number;
}

export interface WorkflowAgentRunInput {
  prompt: string;
  options: WorkflowAgentOptions;
  cwd: string;
  signal?: AbortSignal;
  /** Stable run/agent identifiers, used for session naming and ACL binding. */
  runId: string;
  agentId: string;
  /**
   * Per-agent wall-clock cap, in milliseconds, when the run requested one.
   *
   * This is what `agentTimeoutMs` means: it bounds one child invocation, not the
   * whole script. The whole-script cap travels separately as the host's
   * `timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * File the executor appends the child's raw event stream to.
   *
   * A hung or failed agent is otherwise undiagnosable after the fact: the child
   * runs with `--no-session`, so there is no transcript to read.
   */
  evidencePath?: string;
}

export interface WorkflowAgentRunResult {
  /** Structured value when the runner already parsed one. */
  value?: unknown;
  /** Plain assistant text when no structured value was returned. */
  text?: string;
  usage?: Partial<WorkflowUsage>;
  status?: "completed" | "failed" | "aborted";
  errorMessage?: string;
  model?: string;
}

export type WorkflowAgentRunner = (input: WorkflowAgentRunInput) => Promise<WorkflowAgentRunResult>;

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases?: WorkflowPhase[];
}

export interface WorkflowProgressAgent {
  id: string;
  label: string;
  /** Bounded summary of the assigned prompt, independent of an optional short label. */
  task?: string;
  phase?: string;
  status: "queued" | "running" | "completed" | "failed" | "aborted" | "cached";
  startedAt?: number;
  finishedAt?: number;
  usageTokens?: number;
  /**
   * Why a `failed` agent stopped, bounded.
   *
   * Without it the reason lived only in the journal, so answering "what died?"
   * from a live status meant reading a second file — which is exactly the step
   * that makes a failure invisible in practice.
   */
  error?: string;
}

export interface WorkflowProgress {
  schemaVersion: 1;
  runId: string;
  name: string;
  status: "running" | "completed" | "failed" | "aborted" | "budget_exceeded";
  startedAt: number;
  updatedAt: number;
  currentPhase?: string;
  agents: WorkflowProgressAgent[];
  completedAgents: number;
  totalAgents: number;
  spentTokens: number;
  message?: string;
}

export interface WorkflowRunResult {
  schemaVersion: 1;
  runId: string;
  name: string;
  status: "completed" | "failed" | "aborted";
  value: unknown;
  meta: WorkflowMeta;
  /** Persisted copy of the executed script; edit and re-invoke with scriptPath to iterate. */
  scriptPath?: string;
  startedAt: number;
  finishedAt: number;
  spentTokens: number;
  cacheHits: number;
  agentCalls: number;
  phases: WorkflowPhase[];
  stopReason?: string;
}

export interface WorkflowJournalEntry {
  schemaVersion: 1;
  seq: number;
  callId: string;
  callHash: string;
  prompt: string;
  options: WorkflowJsonValue;
  status: "completed" | "failed" | "cached";
  result?: unknown;
  usage: WorkflowUsage;
  attempt: number;
  createdAt: number;
  error?: string;
}

export function emptyWorkflowUsage(): WorkflowUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

/**
 * Billable tokens for a usage record: input plus output.
 *
 * Cache reads and writes are excluded because they are priced separately by
 * every provider that reports them, and folding them into a token budget would
 * make a cached run look more expensive than the same run uncached. `cost` is
 * the field that accounts for them.
 */
export function workflowUsageTokens(usage: Partial<WorkflowUsage> | undefined): number {
  if (!usage) return 0;
  return nonNegative(usage.input) + nonNegative(usage.output);
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function mergeWorkflowUsage(base: WorkflowUsage, addition: Partial<WorkflowUsage> | undefined): WorkflowUsage {
  if (!addition) return { ...base };
  return {
    input: base.input + nonNegative(addition.input),
    output: base.output + nonNegative(addition.output),
    cacheRead: base.cacheRead + nonNegative(addition.cacheRead),
    cacheWrite: base.cacheWrite + nonNegative(addition.cacheWrite),
    cost: base.cost + nonNegative(addition.cost),
    contextTokens: Math.max(base.contextTokens, nonNegative(addition.contextTokens)),
    turns: base.turns + nonNegative(addition.turns),
  };
}
