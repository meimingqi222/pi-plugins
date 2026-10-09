/**
 * The `subagent` tool: the model-facing surface.
 *
 * The description is load-bearing. A subagent is the right tool for one
 * delegated task that needs its own context window, and the wrong one for a
 * lookup a `grep` answers. It is deliberately *not* gated behind an opt-in the
 * way `pi-workflow` is: one delegated task is ordinary work, while a workflow
 * fan-out is a spend decision. Keeping the two tools separate is what lets the
 * consent models differ.
 *
 * The child process itself is run by `pi-agent-runner`; this file only forms the
 * input (the `Task:` prompt and the agent's system prompt and tools) and turns
 * the result into a tool result.
 */

import { Type, type Static } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  createAgentExecutor,
  spawnRpcChild,
  type AgentActivity,
  type AgentExecutor,
  type AgentRunResult,
  type AgentUsage,
  type RpcChild,
  type SpawnRpcChildOptions,
} from "pi-agent-runner";
import { discoverAgents, formatAgentNames, type SubagentDefinition } from "./agents.ts";
import { resolveAgent } from "./catalog.ts";
import {
  AGENT_PARAM_DESCRIPTION,
  ALIAS_PARAM_DESCRIPTION,
  SUBAGENT_DESCRIPTION,
  SUBAGENT_GUIDELINES,
  TASK_PARAM_DESCRIPTION,
} from "./contract.ts";

const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 30 * 60;
const MAX_SUBAGENT_TIMEOUT_SECONDS = 3 * 60 * 60;

export const SubagentParams = Type.Object({
  agent: Type.String({ description: AGENT_PARAM_DESCRIPTION }),
  task: Type.String({
    description: TASK_PARAM_DESCRIPTION,
  }),
  model: Type.Optional(
    Type.String({ description: "Model override as provider/modelId. Omit to inherit the current session's model." }),
  ),
  background: Type.Optional(
    Type.Boolean({ default: true, description: "Defaults to true: return a task ID immediately and continue independent work. Set false explicitly to block this call until the answer is ready." }),
  ),
  alias: Type.Optional(Type.String({ description: ALIAS_PARAM_DESCRIPTION })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_SUBAGENT_TIMEOUT_SECONDS, description: `Total task deadline in seconds (1–${MAX_SUBAGENT_TIMEOUT_SECONDS}, default ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS} or PI_SUBAGENT_TIMEOUT_SECONDS). Includes all model and tool time; activity does not reset it. Split broad reviews into focused tasks, or explicitly budget a longer task.` })),
});

export type SubagentToolParams = Static<typeof SubagentParams>;

export function subagentTimeoutMs(seconds?: number): number {
  const configured = seconds ?? (process.env.PI_SUBAGENT_TIMEOUT_SECONDS === undefined
    ? DEFAULT_SUBAGENT_TIMEOUT_SECONDS
    : Number(process.env.PI_SUBAGENT_TIMEOUT_SECONDS));
  if (!Number.isFinite(configured) || configured < 1 || configured > MAX_SUBAGENT_TIMEOUT_SECONDS)
    throw new Error(`Subagent timeout must be between 1 and ${MAX_SUBAGENT_TIMEOUT_SECONDS} seconds.`);
  return configured * 1_000;
}

// The description/guideline text lives in contract.ts; re-exported so callers
// importing from tool.ts keep working.
export { SUBAGENT_DESCRIPTION, SUBAGENT_GUIDELINES };

/** Maximum bytes returned to the model per subagent. The full text stays in details. */
export const MAX_RESULT_BYTES = 50 * 1024;

export function truncate(text: string, maxBytes: number = MAX_RESULT_BYTES): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  // Slice by characters, then verify the byte budget; a multi-byte character
  // straddling the boundary is dropped rather than split.
  let truncated = text.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  const omitted = bytes - Buffer.byteLength(truncated, "utf8");
  return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

/** The usage shape this tool reports; the runner's, so the two cannot drift. */
export type SubagentUsage = AgentUsage;

export function emptySubagentUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };
}

/** pi's `Usage` shape, built from the runner's flat one. */
function toPiUsage(usage: SubagentUsage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
  };
}

export interface SubagentDetails {
  agent: string;
  status: "running" | "completed" | "failed" | "aborted";
  /** Present only on the immediate handle returned by a background launch. */
  taskId?: string;
  model?: string;
  usage: SubagentUsage;
  errorMessage?: string;
  /** The full, untruncated reply. */
  output: string;
  progress?: SubagentProgress;
}

export interface SubagentProgress {
  completedTools: number;
  activeTool?: string;
  recentTools: string[];
  phase: AgentActivity["phase"];
  lastActivityAt: number;
  lastEvent: string;
  recentActivity: Array<Pick<AgentActivity, "event" | "phase" | "at" | "toolName" | "target">>;
}

/** Render a safe activity record for an explicit, bounded task inspection. */
export function formatActivity(event: SubagentProgress["recentActivity"][number]): string {
  const age = Math.max(0, Math.floor((Date.now() - event.at) / 1_000));
  const minutes = Math.floor(age / 60);
  const remainder = age % 60;
  const ago = minutes === 0 ? `${remainder}s` : remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
  const detail = [event.toolName, event.target].filter(Boolean).map((value) => cleanActivityField(value!, 160)).join(" ");
  return `${ago} ago · ${cleanActivityField(event.event, 40)}${detail ? ` · ${detail}` : ""}`;
}

function cleanActivityField(value: string, limit: number): string {
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export interface SubagentToolOptions {
  /** Test seam: replaces the executor so no subprocess is spawned. */
  executor?: AgentExecutor;
  /** Test seam: replaces spawnRpcChild for the live-child transport. */
  spawnRpcChild?: typeof spawnRpcChild;
  /** Forwarded to spawnRpcChild (invocation/extraArgs overrides). */
  rpcSpawn?: SpawnRpcChildOptions;
  /** Test seam: overrides agent discovery. */
  discover?: (cwd: string) => SubagentDefinition[];
  /** Test seam: overrides the working directory. */
  cwd?: string;
}

export interface SubagentCallContext {
  cwd: string;
  evidencePath?: string;
  evidenceMaxBytes?: number;
  model?: string;
  effort?: string;
  /** The tool call's abort signal, when the harness provides one. */
  signal?: AbortSignal;
  onUpdate?: (update: AgentToolResult<SubagentDetails>) => void;
  onEvent?: (event: unknown) => void;
  onProgress?: (progress: SubagentProgress) => void;
  /**
   * Run the child on the live-RPC transport instead of the one-shot JSON pipe.
   * `onChild` receives the handle once spawned — the caller keeps it to send
   * `steer`/`follow_up`/`prompt` follow-ups and to `end` the lane at keepAlive
   * expiry. `onIdleChange` marks turn boundaries: true on `agent_settled`,
   * false on `agent_start`. `onTurnSettled` carries each turn's raw result as
   * the turn finishes, while the process is still alive; `onCommandError`
   * reports a stdin command pi refused.
   */
  rpc?: {
    onChild: (child: RpcChild) => void;
    onIdleChange?: (idle: boolean) => void;
    onTurnSettled?: (result: AgentRunResult) => void;
    onCommandError?: (info: { command: string; error: string }) => void;
  };
}

/**
 * Map a child run's raw outcome — a whole run or a single settled turn — to the
 * tool result shape the model sees. One mapping for both: a background lane
 * reports each turn through `onTurnSettled` long before its process exits.
 */
export function toSubagentToolResult(
  result: AgentRunResult,
  agentName: string,
  progress?: SubagentProgress,
): AgentToolResult<SubagentDetails> {
  const details: SubagentDetails = {
    agent: agentName,
    status: result.status,
    ...(result.model ? { model: result.model } : {}),
    usage: result.usage,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    output: result.text ?? "",
    ...(progress ? { progress } : {}),
  };

  const text =
    result.status === "completed"
      ? truncate(result.text || "(the agent returned no text)")
      : `Agent "${agentName}" ${result.status}: ${displayFailure(result.errorMessage ?? "no error message")}`;

  return {
    content: [{ type: "text", text }],
    details,
    usage: toPiUsage(result.usage),
  };
}

/** Diagnostic locations stay in details and explicit log inspection. */
export function displayFailure(message: string): string {
  return message.replace(/; its event stream is at [\s\S]*$/u, "");
}

/**
 * Execute one `subagent` tool call.
 *
 * Extracted from the tool definition so it can be tested directly, and so the
 * registration stays a thin wiring step. `ctx` is narrowed to the fields
 * this needs, so a test does not have to build a whole `ExtensionContext`.
 */
export async function executeSubagent(
  params: SubagentToolParams,
  ctx: SubagentCallContext,
  options: SubagentToolOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
  const executor = options.executor ?? createAgentExecutor();
  // An injected `executor` seam always wins (tests); otherwise `ctx.rpc`
  // selects the live-child transport. Both return the same `AgentRunResult`
  // contract, so everything below — progress recording, details mapping — is
  // shared.
  const runChild: AgentExecutor = ctx.rpc && !options.executor
    ? async (input) => {
        const child = await (options.spawnRpcChild ?? spawnRpcChild)({
          prompt: input.prompt,
          cwd: input.cwd,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
          ...(input.evidenceMaxBytes !== undefined ? { evidenceMaxBytes: input.evidenceMaxBytes } : {}),
          ...(input.onEvent ? { onEvent: input.onEvent } : {}),
          ...(input.onActivity ? { onActivity: input.onActivity } : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          ...(ctx.rpc?.onIdleChange ? { onIdleChange: ctx.rpc.onIdleChange } : {}),
          ...(ctx.rpc?.onTurnSettled ? { onTurnSettled: ctx.rpc.onTurnSettled } : {}),
          ...(ctx.rpc?.onCommandError ? { onCommandError: ctx.rpc.onCommandError } : {}),
        }, options.rpcSpawn);
        ctx.rpc?.onChild(child);
        return child.done;
      }
    : executor;
  const cwd = options.cwd ?? ctx.cwd;
  const agents = (options.discover ?? (() => discoverAgents()))(cwd);
  const agent = resolveAgent(agents, params.agent);

  if (!agent) {
    return {
      content: [
        { type: "text", text: `Unknown agent "${params.agent}". Available agents: ${formatAgentNames(agents)}.` },
      ],
      details: { agent: params.agent, status: "failed", usage: emptySubagentUsage(), output: "" },
    };
  }

  const model = params.model ?? agent.model ?? ctx.model;
  const progress: SubagentProgress = {
    completedTools: 0,
    recentTools: [],
    phase: "starting",
    lastActivityAt: Date.now(),
    lastEvent: "spawned",
    recentActivity: [],
  };
  const emitProgress = (renderUpdate = true) => {
    const snapshot = {
      ...progress,
      recentTools: [...progress.recentTools],
      recentActivity: progress.recentActivity.map((event) => ({ ...event })),
    };
    try { ctx.onProgress?.(snapshot); } catch { /* Observers cannot fail a child run. */ }
    if (renderUpdate) {
      try {
        ctx.onUpdate?.({
          content: [{ type: "text", text: `${agent.name} is ${progress.activeTool ? `using ${progress.activeTool}` : "working"}` }],
          details: { agent: agent.name, status: "running", usage: emptySubagentUsage(), output: "", progress: snapshot },
        });
      } catch { /* TUI failures do not change the delegated result. */ }
    }
  };
  const recordActivity = (activity: AgentActivity) => {
    progress.phase = activity.phase;
    progress.lastActivityAt = activity.at;
    progress.lastEvent = activity.event;
    const event = {
      event: activity.event,
      phase: activity.phase,
      at: activity.at,
      ...(activity.toolName ? { toolName: activity.toolName } : {}),
      ...(activity.target ? { target: activity.target } : {}),
    };
    const previous = progress.recentActivity.at(-1);
    if (previous?.event === event.event && previous.phase === event.phase && event.event === "message_update") {
      progress.recentActivity[progress.recentActivity.length - 1] = event;
    } else {
      progress.recentActivity.push(event);
      if (progress.recentActivity.length > 10) progress.recentActivity.shift();
    }
    // Model deltas refresh the registry's liveness clock without repainting the
    // TUI for every token. Tool boundaries still update the card below.
    emitProgress(false);
  };
  emitProgress();
  const result = await runChild({
    // The `Task:` prefix is what pi's own subagent example sends, so a child sees
    // the same framing whichever tool spawned it.
    prompt: `Task: ${params.task}`,
    timeoutMs: subagentTimeoutMs(params.timeout),
    systemPrompt: agent.systemPrompt,
    cwd,
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(model ? { model } : {}),
    ...(!params.model && !agent.model && ctx.effort ? { effort: ctx.effort } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.evidencePath ? { evidencePath: ctx.evidencePath } : {}),
    ...(ctx.evidenceMaxBytes ? { evidenceMaxBytes: ctx.evidenceMaxBytes } : {}),
    ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}),
    onActivity: recordActivity,
    ...(ctx.onUpdate || ctx.onProgress ? { onProgress: (event) => {
      progress.phase = event.type === "tool_start" ? "tool" : "model";
      progress.lastActivityAt = Date.now();
      progress.lastEvent = event.type;
      if (event.type === "tool_start") {
        const activity = event.target ? `${event.toolName} ${event.target}` : event.toolName;
        progress.activeTool = activity;
        progress.recentTools.push(activity);
        if (progress.recentTools.length > 5) progress.recentTools.shift();
      } else {
        progress.completedTools += 1;
        delete progress.activeTool;
      }
      emitProgress();
    } } : {}),
  });

  if (result.status === "completed") delete progress.activeTool;

  return toSubagentToolResult(result, agent.name, progress);
}
