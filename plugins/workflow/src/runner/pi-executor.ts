/**
 * The production agent executor: runs one agent as a pi subprocess.
 *
 * This is the only module that spawns, so it is the only one that can hang, and
 * it is written as if that were true. Three rules, each from a real failure:
 *
 * 1. **stdin is `"ignore"`, never piped.** A piped stdin left open is a handle
 *    the child can wait on forever, and the parent then waits on the child. pi's
 *    own subagent example uses `"ignore"` for exactly this reason.
 * 2. **A wall-clock timer kills the process.** An agent that ignores its abort
 *    signal must still die. The timeout resolves the run rather than being
 *    recorded and ignored.
 * 3. **stdout is drained continuously and stderr is bounded.** pi documents that
 *    a reader which stops consuming can stall it once the pipe buffer fills, and
 *    a chatty child must not grow the parent's memory.
 *
 * The event stream is parsed here rather than with `readline`: pi explicitly
 * warns that `readline` treats Unicode line separators inside JSON strings as
 * record boundaries.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStructuredReply } from "./agent-runner.ts";
import { jsonRunArgs, resolvePiInvocation, type PiInvocation } from "./spawn.ts";
import { resolveToolProfile } from "./roles.ts";
import type { AgentExecutor } from "./agent-runner.ts";
import type { WorkflowAgentRunInput, WorkflowAgentRunResult } from "../core/types.ts";

export interface PiExecutorOptions {
  /** Wall-clock cap for one agent. The process is killed when it expires. */
  timeoutMs?: number;
  /** Override for tests; defaults to the resolved pi invocation. */
  invocation?: { command: string; args: string[] };
  /** Extra flags appended before the prompt. */
  extraArgs?: string[];
}

const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_STDERR_CHARS = 8_000;
/** Bounded so a runaway agent cannot grow the parent's heap through its own output. */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/**
 * Accumulated state from one JSON event stream.
 *
 * `final` is filled from `message_end` because that event is documented as
 * authoritative; deltas are scratch for a live view and are discarded.
 */
export interface StreamState {
  finalText: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; totalTokens: number };
  errorMessage?: string;
  stopReason?: string;
  model?: string;
}

export function emptyStreamState(): StreamState {
  return { finalText: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } };
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
 * Split out from the process handling so the whole parser is testable against
 * recorded events, which is the only way to check the many event shapes pi can
 * emit without paying for a model call per case.
 */
export function applyEvent(state: StreamState, event: unknown): void {
  if (!isRecord(event)) return;
  const type = event.type;
  if (type === "message_update") {
    // The top-level usage is cumulative for the current assistant response.
    if (isRecord(event.usage)) state.usage = readUsage(event.usage, state.usage);
    return;
  }
  if (type === "message_end") {
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return;
    if (isRecord(message.usage)) state.usage = readUsage(message.usage, state.usage);
    if (typeof message.model === "string") state.model = message.model;
    if (typeof message.stopReason === "string") state.stopReason = message.stopReason;
    if (typeof message.errorMessage === "string" && message.errorMessage) state.errorMessage = message.errorMessage;
    // `message_end` is authoritative; replace rather than append.
    state.finalText = readText(message.content) || state.finalText;
    return;
  }
  if (type === "agent_end") {
    // A run can end with an error before any assistant message.
    const messages = Array.isArray(event.messages) ? event.messages : [];
    for (const message of messages) applyEvent(state, { type: "message_end", message });
    return;
  }
  if (type === "error" && typeof event.message === "string") {
    state.errorMessage = event.message;
  }
}

function readUsage(usage: Record<string, unknown>, previous: StreamState["usage"]): StreamState["usage"] {
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
/** Concatenate the text blocks of an assistant message. */
function readText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * Parse the final reply as a structured value, or return undefined when it is
 * not one.
 *
 * The value must not fall back to the raw text. `runAgent` prefers
 * `result.value` over `result.text`, so handing the text through as a value
 * hands the validator a string where the script declared an object: a reply
 * that is valid JSON inside a Markdown fence — the most common model habit — is
 * then rejected with `$ must be object`, because nothing ever unwraps it.
 * Returning undefined instead puts the reply back on the `text` path, where
 * `parseStructuredReply` unwraps fences and a genuinely malformed reply is
 * reported as "not JSON" rather than as a type error.
 */
function readStructuredReply(text: string): unknown {
  try {
    return parseStructuredReply(text);
  } catch {
    return undefined;
  }
}

/**
 * Build the executor that runs agents as pi subprocesses.
 *
 * The prompt is passed as a trailing argument rather than through stdin, because
 * stdin is closed. A prompt starting with `-` would be read as a flag, so a `--`
 * separator precedes it.
 */

/**
 * Build the child's argv.
 *
 * Extracted so the guard flag and the `--` separator can be asserted without
 * spawning anything.
 */
export function buildPiArgs(input: {
  invocation: PiInvocation;
  extraArgs?: string[];
  tools?: string[];
  model?: string;
  effort?: string;
  prompt: string;
  /** Path to the child guard extension, when it is available. */
  guardPath?: string;
}): string[] {
  const args = [...input.invocation.args, ...jsonRunArgs(), ...(input.extraArgs ?? [])];
  // Loaded explicitly so a child always has a bounded shell even though
  // `--no-extensions` is not used and ambient extensions still load.
  if (input.guardPath) args.push("--extension", input.guardPath);
  if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--thinking", input.effort);
  // `--` so a prompt beginning with `-` is not parsed as a flag.
  args.push("--", input.prompt);
  return args;
}

/**
 * The path to the child guard extension, or undefined when it is not on disk.
 *
 * Guarded by `existsSync`: passing `--extension` for a missing file would fail
 * every child, which is worse than leaving the shell unbounded.
 */
export function childGuardPath(): string | undefined {
  try {
    const path = fileURLToPath(new URL("./child-guard.ts", import.meta.url));
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Environment for a workflow child.
 *
 * Ambient extensions load in the child — the spawn deliberately does not pass
 * `--no-extensions`, because a child may be asked to use one — so a plugin that
 * schedules work for the *user's* session has to be told this is not one. The
 * goal plugin owns the switch (`PI_GOAL_DISABLE`), the same shape Step-Code uses
 * for its own subagents (`STEP_DISABLE_GOAL`); a child has no user, no goal of
 * its own, and no business resuming the parent's while billing it for the
 * tokens.
 *
 * A function rather than an inline literal, so the contract is asserted by a test
 * instead of by reading the spawn call.
 */
export function workflowChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PI_GOAL_DISABLE: "1" };
}

/**
 * Build the executor that runs agents as pi subprocesses.
 */
export function createPiExecutor(options: PiExecutorOptions = {}): AgentExecutor {
  return async (input: WorkflowAgentRunInput) => {
    const invocation = options.invocation ?? resolvePiInvocation();
    // Resolve the role before spawning, and report a bad role as a failed result
    // rather than throwing out of the executor. Every other failure path returns
    // one, and a caller that wraps `agent()` in try/catch inside a script would
    // otherwise see an exception that bypasses the run's accounting entirely.
    let tools: string[] | undefined;
    try {
      tools = resolveToolProfile(input.options.toolProfile);
    } catch (error) {
      return {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    const guardPath = childGuardPath();
    const args = buildPiArgs({
      invocation,
      ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(input.options.model ? { model: input.options.model } : {}),
      ...(input.options.effort ? { effort: input.options.effort } : {}),
      prompt: input.prompt,
      ...(guardPath ? { guardPath } : {}),
    });

    return new Promise((resolve) => {
      const child = spawn(invocation.command, args, {
        cwd: input.cwd,
        // Rule 1: never piped. A piped stdin is a handle the child can wait on.
        stdio: ["ignore", "pipe", "pipe"],
        env: workflowChildEnv(),
      });

      const state = emptyStreamState();
      let buffer = "";
      let stderr = "";
      let settled = false;
      let killedBy: "timeout" | "abort" | undefined;

      // Evidence sink: the child's raw event stream, one JSON object per line.
      // The child runs with `--no-session`, so without this a hung or failed
      // agent leaves nothing to read afterwards. Appends are ordered through one
      // queue and best-effort, so a write failure never fails the run.
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

      // The run's per-agent cap wins over the executor's default, so
      // `agentTimeoutMs` bounds one child rather than the whole script.
      const timeoutMs = input.timeoutMs ?? options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        killedBy = "timeout";
        kill();
      }, timeoutMs);

      const onAbort = (): void => {
        killedBy = "abort";
        kill();
      };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }

      function kill(): void {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }

      function finish(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        kill();

        let outcome: WorkflowAgentRunResult;
        if (killedBy) {
          outcome = {
            status: killedBy === "abort" ? "aborted" : "failed",
            errorMessage:
              killedBy === "timeout"
                ? `The agent timed out after ${timeoutMs}ms${evidencePath ? `; its event stream is at ${evidencePath}` : ""}`
                : "The agent was aborted",
            usage: state.usage,
          };
        } else if (state.errorMessage) {
          outcome = { status: "failed", errorMessage: state.errorMessage, usage: state.usage };
        } else {
          // Only parse when the caller declared a schema. Without one the
          // contract is "the reply text is the value", and a reply that happens
          // to be JSON-shaped must still arrive as text — parsing it would hand
          // the script an object where it asked for a string.
          const parsed = input.options.schema ? readStructuredReply(state.finalText) : undefined;
          outcome = {
            ...(parsed === undefined ? {} : { value: parsed }),
            text: state.finalText,
            status: "completed",
            usage: state.usage,
            ...(state.model ? { model: state.model } : {}),
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
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
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
            applyEvent(state, JSON.parse(text));
          } catch {
            // A non-JSON line is diagnostics, not an event.
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
      });

      child.on("error", (error) => {
        state.errorMessage = error instanceof Error ? error.message : String(error);
        finish();
      });
      child.on("close", () => {
        if (state.errorMessage === undefined && stderr.trim()) state.errorMessage = stderr.trim().slice(0, 2_000);
        finish();
      });
    });
  };
}
