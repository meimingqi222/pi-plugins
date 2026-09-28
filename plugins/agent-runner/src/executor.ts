/**
 * The shared agent executor: run one agent as a pi subprocess.
 *
 * Extracted from `pi-workflow` and `pi-subagent`, which carried the same
 * process handling twice. A fix here fixes both, which is the point: this code
 * has hung a real session, and two copies would drift silently.
 *
 * Three rules, each from a real failure:
 *
 * 1. **stdin is `"ignore"`, never piped.** A piped stdin left open is a handle
 *    the child can wait on forever, and the parent then waits on the child.
 * 2. **A wall-clock timer kills the process.** An agent that ignores its abort
 *    signal must still die.
 * 3. **stdout is drained continuously and stderr is bounded.** A reader that
 *    stops consuming can stall pi once the pipe buffer fills, and a chatty child
 *    must not grow the parent's heap.
 *
 * The event stream is parsed here rather than with `readline`, which treats
 * Unicode line separators inside JSON strings as record boundaries.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { jsonRunArgs, resolvePiInvocation, type PiInvocation } from "./spawn.ts";
import { killAgentTree } from "./process.ts";
import {
  createEvidenceWriter,
  createJsonLineReader,
  mapRunOutcome,
  MAX_STDERR_CHARS,
  writeSystemPromptFile,
} from "./child-io.ts";

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
}

export interface AgentRunInput {
  /** The prompt, appended as the last argument after `--`. */
  prompt: string;
  /** Working directory for the child. */
  cwd: string;
  /**
   * Delegated system prompt. Written to a private temp file and passed as
   * `--append-system-prompt`. Unset means the child keeps pi's own prompt.
   */
  systemPrompt?: string;
  /** Tool allowlist passed to pi; `undefined` leaves pi's default set. */
  tools?: string[];
  /** Model override; `undefined` lets the child Pi process choose its default. */
  model?: string;
  /** Thinking level, when the caller has one. */
  effort?: string;
  /** Abort signal from the tool call. */
  signal?: AbortSignal;
  /**
   * Per-call wall-clock cap in milliseconds. Wins over the executor default, so
   * a run's `agentTimeoutMs` bounds one child rather than the whole script.
   */
  timeoutMs?: number;
  /**
   * Per-call silence cap in milliseconds: how long the child may emit nothing
   * before the run is failed. Unset reads `PI_AGENT_STALL_MS`, then
   * `DEFAULT_STALL_MS`; `0` disables the bound.
   */
  stallMs?: number;
  /**
   * File the child's raw event stream is appended to.
   *
   * A hung or failed agent is otherwise undiagnosable after the fact: the child
   * runs with `--no-session`, so there is no transcript to read.
   */
  evidencePath?: string;
  /** Optional cap for raw evidence files; after the cap a truncation marker is written when space allows. */
  evidenceMaxBytes?: number;
  /** Extra `--extension` paths to load in the child. */
  extensionPaths?: string[];
  /**
   * Parse the final text into a structured value. A throw means "no value"; the
   * text is still returned. Unset means the caller wants only text.
   */
  parse?: (text: string) => unknown;
  /** Optional, bounded UI progress. Only a file path may accompany a tool name. */
  onProgress?: (event: AgentProgress) => void;
  /** Allowlisted child lifecycle events for status displays; never includes content or tool arguments. */
  onActivity?: (event: AgentActivity) => void;
}

export interface AgentProgress {
  type: "tool_start" | "tool_end";
  toolName: string;
  target?: string;
}

export type AgentActivityPhase = "starting" | "model" | "tool" | "finishing";

/** Safe lifecycle metadata for liveness displays; child text and tool inputs are excluded. */
export interface AgentActivity {
  event: string;
  phase: AgentActivityPhase;
  at: number;
  toolName?: string;
  target?: string;
}

/** Project only safe event metadata from Pi's JSON stream. */
export function readAgentActivity(event: unknown, at = Date.now()): AgentActivity | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  const args = isRecord(event.args) ? event.args : undefined;
  const toolName = typeof event.toolName === "string"
    ? event.toolName.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 80)
    : undefined;
  const safeTarget =
    ["read", "grep", "find", "ls"].includes(String(event.toolName)) &&
    typeof args?.path === "string"
      ? args.path.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 160)
      : undefined;

  switch (event.type) {
    case "agent_start":
      return { event: event.type, phase: "starting", at };
    case "message_start":
    case "message_update":
    case "message_end":
      return { event: event.type, phase: "model", at };
    case "tool_execution_start":
      return {
        event: "tool_start",
        phase: "tool",
        at,
        ...(toolName ? { toolName } : {}),
        ...(safeTarget ? { target: safeTarget } : {}),
      };
    case "tool_execution_end":
      return {
        event: "tool_end",
        phase: "model",
        at,
        ...(toolName ? { toolName } : {}),
      };
    case "agent_end":
      return { event: event.type, phase: "finishing", at };
    case "error":
      return { event: event.type, phase: "model", at };
    default:
      return undefined;
  }
}

/** Pick only the activity needed by a parent UI from Pi's JSON event stream. */
export function readAgentProgress(event: unknown): AgentProgress | undefined {
  if (!isRecord(event) || (event.type !== "tool_execution_start" && event.type !== "tool_execution_end")) return undefined;
  if (typeof event.toolName !== "string" || !event.toolName) return undefined;
  const args = isRecord(event.args) ? event.args : undefined;
  const target = event.type === "tool_execution_start"
    && ["read", "grep", "find", "ls"].includes(event.toolName)
    && typeof args?.path === "string"
    ? args.path.slice(0, 160)
    : undefined;
  return {
    type: event.type === "tool_execution_start" ? "tool_start" : "tool_end",
    toolName: event.toolName,
    ...(target ? { target } : {}),
  };
}

export interface AgentRunResult {
  status: "completed" | "failed" | "aborted";
  /** The child's final assistant text. */
  text?: string;
  /** The parsed structured value, when the caller supplied `parse`. */
  value?: unknown;
  usage: AgentUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Child exit code when it exited; absent when it was killed. */
  exitCode?: number;
}

/** Executes one agent and returns its raw result. Injected by the caller. */
export type AgentExecutor = (input: AgentRunInput) => Promise<AgentRunResult>;

export interface AgentExecutorOptions {
  /** Wall-clock cap for one agent when the input does not set one. */
  timeoutMs?: number;
  /** Silence cap for one agent when the input does not set one. */
  stallMs?: number;
  /** Override for tests; defaults to the resolved pi invocation. */
  invocation?: PiInvocation;
  /** Extra flags appended before the prompt. */
  extraArgs?: string[];
  /** Temp root override for testing prompt preparation failures. */
  systemPromptRoot?: string;
}

/** Fifteen minutes: long enough for a real delegated task, short enough to bound a hung child. */
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1_000;
/**
 * Five minutes in which the child emitted nothing at all.
 *
 * The wall clock alone is a poor bound on a wedged child: it fails the run at
 * the deadline with no diagnosis, having spent the whole budget. A stall is the
 * same failure one step earlier and with the fact that matters attached — the
 * last event the child produced. A single tool call that runs silently for
 * longer than this is already an outlier against a fifteen-minute run budget,
 * so `PI_AGENT_STALL_MS` is the escape hatch for a deliberately long one, and
 * `0` turns the bound off.
 */
export const DEFAULT_STALL_MS = 5 * 60 * 1_000;
/**
 * How often the stall bound is sampled. Sampling rather than re-arming a timer
 * per event keeps a streaming child from paying for a timer per token, and the
 * floor keeps a short test threshold firing promptly.
 */
const STALL_CHECK_INTERVAL_MS = 5_000;
/** The floor under `stallCheckIntervalMs`, so a short test threshold still fires. */
const MIN_STALL_CHECK_MS = 25;
/**
 * Grace added to a tool's own declared timeout before the silence bound applies.
 *
 * `pi-workflow`'s child guard injects a ten-minute shell budget by default, and
 * a command may declare its own; the tool's timeout must be the one that reports.
 */
const STALL_DECLARED_SLACK_MS = 30_000;
/**
 * A descendant must not keep the result pending through an inherited pipe.
 *
 * Exported so both transports share one value and one meaning; a test seam can
 * shorten it per spawn (`SpawnRpcChildOptions.stdioGraceMs`), because a child
 * that never exits spends the whole window waiting rather than observing it.
 */
export const STDIO_GRACE_MS = 200;
/**
 * Give Pi time to abort detached tools before enforcing a hard stop.
 *
 * This is the window a test pays in full whenever it drives a kill path against
 * a child that does not exit on SIGTERM, which is most of the RPC transport's
 * tests. `SpawnRpcChildOptions.terminationGraceMs` shortens it there; the
 * production value is verified against real children in `process-tree.test.ts`.
 */
export const TERMINATION_GRACE_MS = 1000;

export function emptyAgentUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };
}

/**
 * The silence cap to use, with the environment as the middle precedence.
 *
 * The environment is read here rather than by each caller so `pi-subagent` and
 * `pi-workflow` cannot drift on what a stalled child means, and so a user has
 * one switch. An explicit value wins, because a caller that measured its own
 * budget knows better than an ambient variable.
 */
export function resolveStallMs(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicit !== undefined) return explicit;
  const raw = Number(env.PI_AGENT_STALL_MS);
  return env.PI_AGENT_STALL_MS !== undefined && env.PI_AGENT_STALL_MS !== "" && Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_STALL_MS;
}

/**
 * How often the stall bound is sampled for a given threshold. Sampling rather
 * than re-arming a timer per event keeps a streaming child from paying for a
 * timer per token; the floor keeps a short test threshold firing promptly.
 *
 * Exported because both transports must sample identically. This package's
 * README records what a second copy of process handling cost the last time.
 */
export function stallCheckIntervalMs(stallMs: number): number {
  return Math.max(MIN_STALL_CHECK_MS, Math.min(STALL_CHECK_INTERVAL_MS, Math.floor(stallMs / 4)));
}

/** The failure message for a run the wall clock ended. */
export function timeoutFailureMessage(input: { timeoutMs: number; evidencePath?: string }): string {
  return `The agent timed out after ${input.timeoutMs}ms${
    input.evidencePath ? `; its event stream is at ${input.evidencePath}` : ""
  }`;
}

/**
 * The failure message for a run the silence bound ended.
 *
 * One constructor rather than two template literals: the two transports must
 * report the same thing, and a divergence on exactly this kind of message is
 * already recorded in this package's README.
 */
export function stallFailureMessage(input: { stalledForMs: number; lastEvent: string; evidencePath?: string }): string {
  return `The agent produced no output for ${input.stalledForMs}ms (last event: ${input.lastEvent}); killed by the stall bound${
    input.evidencePath ? `; its event stream is at ${input.evidencePath}` : ""
  }`;
}

/**
 * The timeout a tool call declared for itself, in milliseconds.
 *
 * pi's shell tools take `timeout` in **seconds**, and an extension may inject
 * one (see `pi-workflow`'s child guard). A call that named its own budget has
 * already decided how long it may run, so the silence bound must not preempt it.
 */
export function declaredToolTimeoutMs(event: unknown): number | undefined {
  if (!isRecord(event) || event.type !== "tool_execution_start") return undefined;
  const args = isRecord(event.args) ? event.args : undefined;
  const seconds = args?.timeout;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1_000;
}

/**
 * Fold one event into the declared-timeout budgets in force, keyed by tool call id.
 *
 * Keyed rather than one slot, because pi runs a tool batch in parallel by default:
 * a `read` that finishes while a long silent `bash` is still in flight must not
 * strip the exemption from the call that declared a budget. The map is mutated in
 * place so a streaming child pays no allocation per event.
 *
 * `STALL_DECLARED_SLACK_MS` lets the tool's own timeout fire and report before this
 * bound gives up on it — otherwise the two would race and the tool's message, which
 * is the one the command's author wrote, would lose.
 *
 * A turn boundary drops every budget: a call that never reported an end must not
 * exempt the rest of a lane's life from a bound it was meant to be under.
 */
export function trackDeclaredTimeouts(budgets: Map<string, number>, event: unknown): Map<string, number> {
  if (!isRecord(event)) return budgets;
  if (event.type === "agent_start" || event.type === "agent_end") budgets.clear();
  else if (typeof event.toolCallId === "string") {
    if (event.type === "tool_execution_end") budgets.delete(event.toolCallId);
    else {
      const declared = declaredToolTimeoutMs(event);
      if (declared !== undefined) budgets.set(event.toolCallId, declared + STALL_DECLARED_SLACK_MS);
    }
  }
  return budgets;
}

/**
 * The silence threshold in force: the ordinary bound, or a running call's own
 * budget where that is longer. Both transports ask this question, so both ask it
 * here rather than restating the rule.
 */
export function stallThresholdMs(stallMs: number, budgets: Map<string, number>): number {
  let threshold = stallMs;
  for (const budget of budgets.values()) if (budget > threshold) threshold = budget;
  return threshold;
}

/**
 * One bounded label for the last event a child emitted.
 *
 * A stall report is only actionable if it names what went quiet: "no output for
 * 300s" is a mystery, "no output for 300s (last event: tool_start find)" points
 * straight at the tool call that is not coming back.
 */
export function describeAgentEvent(event: unknown): string {
  if (!isRecord(event) || typeof event.type !== "string") return "event";
  const toolName = typeof event.toolName === "string"
    ? event.toolName.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 40)
    : undefined;
  switch (event.type) {
    case "tool_execution_start":
      return toolName ? `tool_start ${toolName}` : "tool_start";
    case "tool_execution_end":
      return toolName ? `tool_end ${toolName}` : "tool_end";
    case "message_update":
      return "model output";
    case "message_start":
      return "model start";
    case "message_end":
      return "model end";
    case "agent_start":
      return "turn start";
    case "agent_end":
      return "turn end";
    default:
      return event.type.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 40);
  }
}

/**
 * Accumulated state from one JSON event stream.
 *
 * `finalText` is filled from `message_end` because that event is documented as
 * authoritative; deltas are scratch and are discarded.
 */
export interface StreamState {
  finalText: string;
  usage: AgentUsage;
  settledUsage: AgentUsage;
  inFlightUsage: AgentUsage;
  endedAssistantMessages: number;
  errorMessage?: string;
  stopReason?: string;
  model?: string;
}

export function emptyStreamState(): StreamState {
  return { finalText: "", usage: emptyAgentUsage(), settledUsage: emptyAgentUsage(), inFlightUsage: emptyAgentUsage(), endedAssistantMessages: 0 };
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Fold one parsed JSON-mode event into the stream state.
 *
 * Split out from the process handling so the parser is testable against recorded
 * events, which is the only way to check the many event shapes pi can emit
 * without paying for a model call per case.
 */
export function applyEvent(state: StreamState, event: unknown): void {
  if (!isRecord(event)) return;
  const type = event.type;
  if (type === "message_update") {
    // Updates are cumulative within one response, not across the child run.
    if (isRecord(event.usage)) state.inFlightUsage = readUsage(event.usage, state.inFlightUsage);
    state.usage = addUsage(state.settledUsage, state.inFlightUsage);
    return;
  }
  if (type === "message_end") {
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return;
    state.endedAssistantMessages += 1;
    const finalized = isRecord(message.usage) ? readUsage(message.usage, state.inFlightUsage) : state.inFlightUsage;
    state.settledUsage = addUsage(state.settledUsage, finalized);
    state.inFlightUsage = emptyAgentUsage();
    state.usage = state.settledUsage;
    if (typeof message.model === "string") state.model = message.model;
    if (typeof message.stopReason === "string") state.stopReason = message.stopReason;
    // An error belongs to the message that carried it, not to the run: a later
    // reply that succeeded clears it, exactly as it replaces `finalText` and
    // `stopReason`. pi's own retries never surface a failed attempt here at all —
    // `retryAssistantCall` consumes them and returns only the final response — so
    // this only matters for a lane that recovered after a terminal error, which
    // must not be reported as failed with a stale message.
    if (typeof message.errorMessage === "string" && message.errorMessage) state.errorMessage = message.errorMessage;
    else delete state.errorMessage;
    // `message_end` is authoritative; replace rather than append.
    state.finalText = readText(message.content) || state.finalText;
    return;
  }
  if (type === "agent_end") {
    // The transcript replays completed messages and may also contain a final
    // assistant reply whose message_end never arrived. Skip the replayed prefix,
    // then account for any remaining replies.
    const messages = (Array.isArray(event.messages) ? event.messages : [])
      .filter((message) => isRecord(message) && message.role === "assistant");
    for (const message of messages.slice(state.endedAssistantMessages)) {
      applyEvent(state, { type: "message_end", message });
    }
    return;
  }
  if (type === "error" && typeof event.message === "string") {
    state.errorMessage = event.message;
  }
}

function readUsage(usage: Record<string, unknown>, previous: AgentUsage): AgentUsage {
  const cost = isRecord(usage.cost) ? number(usage.cost.total) : number(usage.cost);
  const next = {
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    cost,
    totalTokens: number(usage.totalTokens),
  };
  // Usage is cumulative on the wire, so a zeroed later event must not erase a
  // known total; take the max per field instead of the latest.
  return {
    input: Math.max(previous.input, next.input),
    output: Math.max(previous.output, next.output),
    cacheRead: Math.max(previous.cacheRead, next.cacheRead),
    cacheWrite: Math.max(previous.cacheWrite, next.cacheWrite),
    cost: Math.max(previous.cost, next.cost),
    totalTokens: Math.max(previous.totalTokens, next.totalTokens),
  };
}

/** Concatenate the text blocks of an assistant message. */
export function readText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * Build the child's argv.
 *
 * Extracted so the flags and the `--` separator can be asserted without spawning
 * anything. `--` matters: the prompt is the last argument and may begin with `-`.
 */
export function buildAgentArgs(input: {
  invocation: PiInvocation;
  extraArgs?: string[];
  extensionPaths?: string[];
  tools?: string[];
  model?: string;
  effort?: string;
  systemPromptPath?: string;
  prompt: string;
}): string[] {
  const args = [...input.invocation.args, ...jsonRunArgs(), ...(input.extraArgs ?? [])];
  for (const path of input.extensionPaths ?? []) args.push("--extension", path);
  if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--thinking", input.effort);
  if (input.systemPromptPath) args.push("--append-system-prompt", input.systemPromptPath);
  // `--` so a prompt beginning with `-` is not parsed as a flag.
  args.push("--", input.prompt);
  return args;
}

/**
 * The environment for a spawned agent.
 *
 * Ambient extensions load in the child — the spawn deliberately does not pass
 * `--no-extensions`, because a child may be asked to use one — so every plugin
 * that schedules work for the *user's* session has to be told this is not one.
 * The three switches are the one-level fan-out rule: a delegated process neither
 * resumes the parent's goal, nor starts a workflow, nor delegates again. They
 * live in one constant so adding a fourth scheduler means editing one place, not
 * every spawner.
 */
export const SCHEDULER_DISABLE_FLAGS = {
  PI_GOAL_DISABLE: "1",
  PI_WORKFLOW_DISABLED: "1",
  PI_SUBAGENT_DISABLE: "1",
} as const;

/**
 * Ambient-extension settings a *headless* child needs — not scheduler flags.
 *
 * `PI_BG_BASH_THRESHOLD: "0"` disables pi-bg-bash's automatic backgrounding:
 * the plugin's env override has the highest precedence, and a `-p`/rpc child
 * has no live session for a backgrounded job to wake — a long command would
 * return a job id whose result never arrives and then die with the process.
 *
 * `PI_AGENT_CHILD: "1"` marks the process as a delegated child: approval
 * plugins (pi-permissions) must not open dialogs in it — there is nobody to
 * answer — so anything needing approval is denied outright instead.
 */
export const HEADLESS_CHILD_ENV = {
  PI_BG_BASH_THRESHOLD: "0",
  PI_AGENT_CHILD: "1",
} as const;

/** Merge the scheduler-disable contract and headless-child settings into an environment. */
export function agentChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...SCHEDULER_DISABLE_FLAGS, ...HEADLESS_CHILD_ENV };
}

/**
 * Build the executor that runs agents as pi subprocesses.
 *
 * The prompt is passed as a trailing argument rather than through stdin, because
 * stdin is closed. A prompt starting with `-` is protected by the `--` separator
 * `buildAgentArgs` inserts.
 */
export function createAgentExecutor(options: AgentExecutorOptions = {}): AgentExecutor {
  return async (input: AgentRunInput): Promise<AgentRunResult> => {
    const invocation = options.invocation ?? resolvePiInvocation();
    let systemPrompt: Awaited<ReturnType<typeof writeSystemPromptFile>>;
    try {
      systemPrompt = await writeSystemPromptFile(input.systemPrompt, options.systemPromptRoot);
    } catch (error) {
      return { status: "failed", usage: emptyAgentUsage(), errorMessage: error instanceof Error ? error.message : String(error) };
    }
    try {
      const args = buildAgentArgs({
        invocation,
        ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
        ...(input.extensionPaths && input.extensionPaths.length > 0 ? { extensionPaths: input.extensionPaths } : {}),
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(systemPrompt ? { systemPromptPath: systemPrompt.file } : {}),
        prompt: input.prompt,
      });

      return await new Promise<AgentRunResult>((resolve) => {
        const child = spawn(invocation.command, args, {
          cwd: input.cwd,
          // Rule 1: never piped. A piped stdin is a handle the child can wait on.
          stdio: ["ignore", "pipe", "pipe"],
          env: agentChildEnv(),
          detached: process.platform !== "win32",
          windowsHide: true,
        });

        const state = emptyStreamState();
        let stderr = "";
        let settled = false;
        let killedBy: "timeout" | "abort" | "stalled" | undefined;
        /** How quiet the child was when the stall bound fired; only meaningful with `killedBy === "stalled"`. */
        let stalledForMs = 0;
        /** The liveness clock: any parsed event moves it, so silence is measured in child output, not in wall time. */
        let lastEventAt = Date.now();
        let lastEventLabel = "spawn";
        /** Declared budgets of the tool calls in flight, keyed by call id; see `trackDeclaredTimeouts`. */
        const declaredBudgets = new Map<string, number>();
        let terminationRequested = false;
        let forceKilled = false;
        let terminationTimer: ReturnType<typeof setTimeout> | undefined;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        let exitCode: number | null = null;

        // Evidence sink: the child's raw event stream, one JSON object per
        // line, written owner-only and bounded by the caller's cap.
        const evidencePath = input.evidencePath;
        const evidence = createEvidenceWriter({
          path: evidencePath,
          ...(input.evidenceMaxBytes !== undefined ? { maxBytes: input.evidenceMaxBytes } : {}),
        });

        // The call's cap wins over the executor's default, so a run's
        // `agentTimeoutMs` bounds one child rather than the whole script.
        const timeoutMs = input.timeoutMs ?? options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
        // The first reason to end the run owns the label. Without the guard the wall
        // clock relabels a run the silence bound (or a caller's abort) already ended,
        // because termination has a grace period and the deadline can expire inside
        // it — which reported a stalled child as "timed out".
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                if (settled || killedBy) return;
                killedBy = "timeout";
                terminate();
              }, timeoutMs)
            : undefined;
        // `unref` so a one-shot run is not held open by a timer nobody can see.
        timer?.unref?.();

        // The silence bound runs alongside the wall clock rather than replacing
        // it: a child that streams nothing for `stallMs` is already wedged, and
        // failing it there leaves the caller a diagnosis instead of a deadline.
        // A tool that declared its own timeout is exempt up to that budget, so a
        // legitimate long shell command is not killed by a bound that knows less
        // than the command does.
        const stallMs = resolveStallMs(input.stallMs ?? options.stallMs);
        const stallTimer =
          stallMs > 0
            ? setInterval(() => {
                if (settled || killedBy) return;
                const quiet = Date.now() - lastEventAt;
                if (quiet < stallThresholdMs(stallMs, declaredBudgets)) return;
                stalledForMs = quiet;
                killedBy = "stalled";
                terminate();
              }, stallCheckIntervalMs(stallMs))
            : undefined;
        stallTimer?.unref?.();

        const onAbort = (): void => {
          if (!killedBy) killedBy = "abort";
          terminate();
        };
        if (input.signal) {
          if (input.signal.aborted) onAbort();
          else input.signal.addEventListener("abort", onAbort, { once: true });
        }

        function terminate(): void {
          if (terminationRequested) return;
          terminationRequested = true;
          if (process.platform === "win32") {
            kill();
            boundDrain();
            return;
          }
          // Pi's print-mode SIGTERM handler cleans up shell process groups and
          // shuts down extensions. SIGKILL would bypass both cleanup paths.
          try { child.kill("SIGTERM"); } catch { /* Hard stop below is the fallback. */ }
          terminationTimer = setTimeout(() => {
            kill();
            boundDrain();
          }, TERMINATION_GRACE_MS);
        }

        function kill(): void {
          if (forceKilled) return;
          forceKilled = true;
          killAgentTree(child.pid);
        }

        function boundDrain(): void {
          if (!drainTimer && !settled) drainTimer = setTimeout(finish, STDIO_GRACE_MS);
        }

        function finish(): void {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (stallTimer) clearInterval(stallTimer);
          if (terminationTimer) clearTimeout(terminationTimer);
          if (drainTimer) clearTimeout(drainTimer);
          input.signal?.removeEventListener("abort", onAbort);
          kill();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();

          const outcome = mapRunOutcome({
            killedBy,
            stalledForMs,
            lastEventLabel,
            timeoutMs,
            stderr,
            exitCode,
            state,
            ...(evidencePath ? { evidencePath } : {}),
            ...(input.parse ? { parse: input.parse } : {}),
          });

          // Flush the evidence sink before reporting, so a caller that reads the
          // file after the result arrives sees every line.
          void evidence.flush().then(
            () => resolve(outcome),
            () => resolve(outcome),
          );
        }

        // Rule 3: drain stdout continuously.
        const readChunk = createJsonLineReader((line, event) => {
          evidence.write(line);
          if (event === undefined) return;
          lastEventAt = Date.now();
          lastEventLabel = describeAgentEvent(event);
          trackDeclaredTimeouts(declaredBudgets, event);
          applyEvent(state, event);
          const activity = readAgentActivity(event);
          if (activity) {
            try {
              input.onActivity?.(activity);
            } catch {
              // Status observers cannot fail the child run.
            }
          }
          const progress = readAgentProgress(event);
          if (progress) {
            try {
              input.onProgress?.(progress);
            } catch {
              // UI updates cannot fail the child run.
            }
          }
        });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", readChunk);
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
        });

        child.on("error", (error) => {
          state.errorMessage = error instanceof Error ? error.message : String(error);
          finish();
        });
        child.on("exit", (code) => {
          exitCode = code;
          if (timer) clearTimeout(timer);
          // Drain already-buffered events, but do not wait for a descendant's EOF.
          boundDrain();
        });
        child.on("close", (code) => {
          exitCode = code;
          finish();
        });
      });
    } finally {
      if (systemPrompt) await rm(systemPrompt.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
