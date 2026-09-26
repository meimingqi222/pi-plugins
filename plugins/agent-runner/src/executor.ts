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
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jsonRunArgs, resolvePiInvocation, type PiInvocation } from "./spawn.ts";
import { killAgentTree } from "./process.ts";

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
   * File the child's raw event stream is appended to.
   *
   * A hung or failed agent is otherwise undiagnosable after the fact: the child
   * runs with `--no-session`, so there is no transcript to read.
   */
  evidencePath?: string;
  /** Extra `--extension` paths to load in the child. */
  extensionPaths?: string[];
  /**
   * Parse the final text into a structured value. A throw means "no value"; the
   * text is still returned. Unset means the caller wants only text.
   */
  parse?: (text: string) => unknown;
  /** Optional, bounded UI progress. Only a file path may accompany a tool name. */
  onProgress?: (event: AgentProgress) => void;
}

export interface AgentProgress {
  type: "tool_start" | "tool_end";
  toolName: string;
  target?: string;
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
  /** Override for tests; defaults to the resolved pi invocation. */
  invocation?: PiInvocation;
  /** Extra flags appended before the prompt. */
  extraArgs?: string[];
  /** Temp root override for testing prompt preparation failures. */
  systemPromptRoot?: string;
}

/** Fifteen minutes: long enough for a real delegated task, short enough to bound a hung child. */
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_STDERR_CHARS = 8_000;
/** Bounded so a runaway child cannot grow the parent's heap through its own output. */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
/** A descendant must not keep the result pending through an inherited pipe. */
const STDIO_GRACE_MS = 200;
/** Give Pi time to abort detached tools before enforcing a hard stop. */
const TERMINATION_GRACE_MS = 1000;

export function emptyAgentUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };
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
    if (typeof message.errorMessage === "string" && message.errorMessage) state.errorMessage = message.errorMessage;
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

/** Merge the scheduler-disable contract into an environment. */
export function agentChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...SCHEDULER_DISABLE_FLAGS };
}

/** Write the delegated system prompt to a private temp file, or return undefined. */
async function writeSystemPrompt(systemPrompt: string | undefined, root = tmpdir()): Promise<{ dir: string; file: string } | undefined> {
  if (!systemPrompt || !systemPrompt.trim()) return undefined;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(root, "pi-agent-"));
    const file = join(dir, "system-prompt.md");
    await writeFile(file, systemPrompt, { encoding: "utf-8", mode: 0o600 });
    return { dir, file };
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Could not prepare delegated system prompt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tryParse(parse: ((text: string) => unknown) | undefined, text: string): unknown {
  if (!parse) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
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
    let systemPrompt: Awaited<ReturnType<typeof writeSystemPrompt>>;
    try {
      systemPrompt = await writeSystemPrompt(input.systemPrompt, options.systemPromptRoot);
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
        let buffer = "";
        let stderr = "";
        let settled = false;
        let killedBy: "timeout" | "abort" | undefined;
        let terminationRequested = false;
        let forceKilled = false;
        let terminationTimer: ReturnType<typeof setTimeout> | undefined;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        let exitCode: number | null = null;

        // Evidence sink: the child's raw event stream, one JSON object per line.
        // Appends are ordered through one queue and best-effort, so a write
        // failure never fails the run.
        const evidencePath = input.evidencePath;
        let evidenceQueue: Promise<void> = evidencePath
          ? mkdir(dirname(evidencePath), { recursive: true })
              .then(() => undefined)
              .catch(() => undefined)
          : Promise.resolve();
        function writeEvidence(line: string): void {
          if (!evidencePath) return;
          evidenceQueue = evidenceQueue
            .then(() => appendFile(evidencePath!, `${line}\n`, { encoding: "utf8", mode: 0o600 }))
            .catch(() => undefined);
        }

        // The call's cap wins over the executor's default, so a run's
        // `agentTimeoutMs` bounds one child rather than the whole script.
        const timeoutMs = input.timeoutMs ?? options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                killedBy = "timeout";
                terminate();
              }, timeoutMs)
            : undefined;
        // `unref` so a one-shot run is not held open by a timer nobody can see.
        timer?.unref?.();

        const onAbort = (): void => {
          killedBy = "abort";
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
          if (terminationTimer) clearTimeout(terminationTimer);
          if (drainTimer) clearTimeout(drainTimer);
          input.signal?.removeEventListener("abort", onAbort);
          kill();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();

          if (state.errorMessage === undefined && stderr.trim()) state.errorMessage = stderr.trim().slice(0, 2_000);
          if (state.errorMessage === undefined && exitCode !== null && exitCode !== 0) {
            state.errorMessage = `The agent exited with code ${exitCode}.`;
          }

          let outcome: AgentRunResult;
          if (killedBy) {
            outcome =
              killedBy === "abort"
                ? { status: "aborted", stopReason: "aborted", text: state.finalText, usage: state.usage }
                : {
                    status: "failed",
                    text: state.finalText,
                    errorMessage: `The agent timed out after ${timeoutMs}ms${
                      evidencePath ? `; its event stream is at ${evidencePath}` : ""
                    }`,
                    usage: state.usage,
                  };
          } else if (state.errorMessage) {
            outcome = { status: "failed", errorMessage: state.errorMessage, text: state.finalText, usage: state.usage };
          } else {
            // Only parse when the caller asked for a value. Without `parse` the
            // contract is "the reply text is the value", and a reply that happens
            // to be JSON-shaped must still arrive as text.
            const parsed = tryParse(input.parse, state.finalText);
            outcome = {
              status: "completed",
              text: state.finalText,
              ...(parsed === undefined ? {} : { value: parsed }),
              usage: state.usage,
              ...(state.model ? { model: state.model } : {}),
              ...(state.stopReason ? { stopReason: state.stopReason } : {}),
            };
          }

          // Flush the evidence sink before reporting, so a caller that reads the
          // file after the result arrives sees every line.
          void evidenceQueue.then(
            () => resolve(outcome),
            () => resolve(outcome),
          );
        }

        // Rule 3: drain stdout continuously, splitting only on LF.
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > MAX_BUFFER_CHARS) {
            // Keep the tail; a partial record at the head is unusable anyway.
            buffer = buffer.slice(-MAX_BUFFER_CHARS / 2);
          }
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            writeEvidence(line.replace(/\r$/u, ""));
            const text = line.replace(/\r$/u, "").trim();
            if (!text) continue;
            try {
              const event = JSON.parse(text);
              applyEvent(state, event);
              const progress = readAgentProgress(event);
              if (progress) {
                try {
                  input.onProgress?.(progress);
                } catch {
                  // UI updates cannot fail the child run.
                }
              }
            } catch {
              // A non-JSON line is diagnostics, not an event.
            }
          }
        });
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
