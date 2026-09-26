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
import { createAgentExecutor, type AgentActivity, type AgentExecutor, type AgentUsage } from "pi-agent-runner";
import { discoverAgents, findAgent, formatAgentNames, type SubagentDefinition } from "./agents.ts";

export const SubagentParams = Type.Object({
  agent: Type.String({ description: "Agent name. Built-in: explore (read-only codebase inspection). User definitions may add names or replace explore." }),
  task: Type.String({
    description:
      "The task for the subagent. It starts with a fresh context, so state the goal, the relevant paths, and what a good answer looks like.",
  }),
  model: Type.Optional(
    Type.String({ description: "Model override as provider/modelId. Omit to inherit the current session's model." }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Return a task ID immediately and continue independent work. Omit or false to wait for the answer in this call." }),
  ),
});

export type SubagentToolParams = Static<typeof SubagentParams>;

export const SUBAGENT_DESCRIPTION = [
  "Delegate one task to a named subagent running in its own pi process with its own context window.",
  "The built-in explore agent searches and reads code without editing; user-defined agents can be added in ~/.pi/agent/agents/.",
  "By default the call waits for the answer. Set background=true for independent work; a task ID returns immediately and the answer arrives when it finishes.",
  "Use it for a self-contained piece of work that would otherwise fill this conversation with material you do not need to keep.",
  "Do not use it for a lookup a grep or read answers, and do not chain many of them by hand — `pi-workflow` is the tool for structured fan-out.",
].join(" ");

export const SUBAGENT_GUIDELINES: string[] = [
  "Use `subagent` for a single self-contained task that benefits from its own context window.",
  "Omit `background` when the next step needs the answer. Set `background=true` when you can continue independent work; use `subagent_tasks` to inspect or cancel it.",
  "A subagent starts fresh: include the goal, the relevant paths, and the shape of the answer you want. It cannot see this conversation.",
  "Agents are named definitions on disk; an unknown name lists the available ones.",
  "Use `explore` for a bounded read-only codebase investigation.",
];

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
  onProgress?: (progress: SubagentProgress) => void;
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
  const cwd = options.cwd ?? ctx.cwd;
  const agents = (options.discover ?? (() => discoverAgents()))(cwd);
  const agent = findAgent(agents, params.agent);

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
  const result = await executor({
    // The `Task:` prefix is what pi's own subagent example sends, so a child sees
    // the same framing whichever tool spawned it.
    prompt: `Task: ${params.task}`,
    systemPrompt: agent.systemPrompt,
    cwd,
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(model ? { model } : {}),
    ...(!params.model && !agent.model && ctx.effort ? { effort: ctx.effort } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.evidencePath ? { evidencePath: ctx.evidencePath } : {}),
    ...(ctx.evidenceMaxBytes ? { evidenceMaxBytes: ctx.evidenceMaxBytes } : {}),
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

  delete progress.activeTool;

  const details: SubagentDetails = {
    agent: agent.name,
    status: result.status,
    ...(result.model ? { model: result.model } : {}),
    usage: result.usage,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    output: result.text ?? "",
    progress,
  };

  const text =
    result.status === "completed"
      ? truncate(result.text || "(the agent returned no text)")
      : `Agent "${agent.name}" ${result.status}: ${result.errorMessage ?? "no error message"}`;

  return {
    content: [{ type: "text", text }],
    details,
    usage: toPiUsage(result.usage),
  };
}
