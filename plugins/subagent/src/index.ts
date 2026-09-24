/**
 * `pi-subagent`: delegate one task to an isolated pi process.
 *
 * The plugin registers a single `subagent` tool. It is deliberately small: the
 * value is isolated single-task work. The caller chooses whether the answer
 * returns in this tool call or arrives as a background completion message.
 *
 * The child process is run by `pi-agent-runner`, which sets
 * `PI_SUBAGENT_DISABLE=1` in the child's environment — the same one-level rule
 * the workflow spawner follows. Workflow children carry the same marker, so the
 * two scheduling plugins cannot nest.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { connectGoalSpend, readTokenUsage, type GoalSpendLease } from "pi-run-core";
import { BackgroundRegistry, formatBackground } from "./background.ts";
import { discoverAgents, findAgent, formatAgentNames } from "./agents.ts";
import {
  SUBAGENT_DESCRIPTION,
  SUBAGENT_GUIDELINES,
  SubagentParams,
  executeSubagent,
  emptySubagentUsage,
  type SubagentDetails,
  type SubagentToolOptions,
} from "./tool.ts";

export interface SubagentExtensionOptions extends SubagentToolOptions {
  /** Disable registration entirely (test seam). */
  enabled?: boolean;
}

/** Whether registration is switched off by the environment. */
export function subagentsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PI_SUBAGENT_DISABLE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** Descriptor form, so a host with a test executor can build its own. */
export function subagentExtension(options: SubagentExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    if (options.enabled === false || subagentsDisabled()) return;
    const goalSpend = connectGoalSpend(pi);
    let generation = 0;
    const pending = new Map<string, { lease?: GoalSpendLease; isCurrent: () => boolean }>();
    const registry = new BackgroundRegistry((record) => {
      const launch = pending.get(record.id);
      pending.delete(record.id);
      launch?.lease?.finish(record.result ? readTokenUsage(record.result) : 0);
      if (!launch?.isCurrent()) return;
      const answer = record.result?.content.find((item) => item.type === "text");
      const summary = answer?.type === "text" ? answer.text : record.errorMessage ?? "No answer was returned.";
      if (record.status === "completed") {
        pi.sendMessage({
          customType: "subagent-result",
          content: `${formatBackground(record)}\n\n${summary}`,
          display: true,
          details: record,
        }, { triggerTurn: true, deliverAs: "followUp" });
      } else {
        pi.sendMessage({
          customType: "subagent-result",
          content: `${formatBackground(record)}\n\n${summary}`,
          display: true,
          details: record,
        });
      }
    });

    const endSession = () => {
      generation += 1;
      registry.stopAll();
    };
    pi.on("session_shutdown", endSession);

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: SUBAGENT_DESCRIPTION,
      promptSnippet: "Delegate one self-contained task to a named subagent with its own context window",
      promptGuidelines: SUBAGENT_GUIDELINES,
      parameters: SubagentParams,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (params.background) {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Subagent launch was cancelled." }], details: { agent: params.agent, status: "aborted" as const, usage: emptySubagentUsage(), output: "" } };
          }
          const cwd = options.cwd ?? ctx.cwd;
          const agents = (options.discover ?? (() => discoverAgents()))(cwd);
          if (!findAgent(agents, params.agent)) {
            return {
              content: [{ type: "text", text: `Unknown agent "${params.agent}". Available agents: ${formatAgentNames(agents)}.` }],
              details: { agent: params.agent, status: "failed" as const, usage: emptySubagentUsage(), output: "" },
            };
          }
          if (registry.atCapacity()) {
            return {
              content: [{ type: "text", text: `At most ${registry.activeLimit} background subagents may run at once. Check or cancel one with subagent_tasks.` }],
              details: { agent: params.agent, status: "failed" as const, usage: emptySubagentUsage(), output: "" },
            };
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const launchedIn = generation;
          const lease = goalSpend()?.begin(ctx, toolCallId);
          const childContext = {
            cwd: ctx.cwd,
            ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
            ...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
          };
          try {
            const record = registry.launch(params.agent, params.task, sessionId, (runSignal, id) =>
              executeSubagent(params, {
                ...childContext,
                signal: runSignal,
                onProgress: (progress) => registry.setProgress(id, progress),
              }, options),
            );
            pending.set(record.id, {
              ...(lease ? { lease } : {}),
              isCurrent: () => generation === launchedIn && ctx.sessionManager.getSessionId() === sessionId,
            });
            return {
              content: [{ type: "text", text: `Subagent ${record.id} (${record.agent}) started in the background. Continue independent work; its answer will arrive when it finishes. Use subagent_tasks to check or cancel it.` }],
              details: { agent: record.agent, status: "running" as const, taskId: record.id, usage: emptySubagentUsage(), output: "" },
            };
          } catch (error) {
            lease?.finish(0);
            throw error;
          }
        }
        const lease = goalSpend()?.begin(ctx, toolCallId);
        try {
          const result = await executeSubagent(params, {
            cwd: ctx.cwd,
            ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
            ...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
            ...(signal ? { signal } : {}),
            ...(onUpdate ? { onUpdate } : {}),
          }, options);
          lease?.finish(readTokenUsage(result));
          return result;
        } catch (error) {
          lease?.finish(0);
          throw error;
        }
      },
      renderCall(args, theme) {
        const task = preview(args.task, 100);
        const title = `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", preview(args.agent, 40))}${args.background ? theme.fg("muted", " · background") : ""}`;
        return new Text(`${title}\n  ${theme.fg("dim", task)}`, 0, 0);
      },
      renderResult(result, { expanded, isPartial }, theme) {
        const details = result.details as SubagentDetails | undefined;
        if (!details) return new Text(theme.fg("muted", "Subagent result unavailable"), 0, 0);
        const progress = details.progress;
        const status = isPartial ? "running" : details.taskId ? "launched" : details.status;
        const color = status === "completed" ? "success" : status === "running" || status === "launched" ? "accent" : "error";
        const activity = progress?.activeTool ? ` · using ${preview(progress.activeTool, 40)}` : "";
        const count = progress?.completedTools ? ` · ${progress.completedTools} tools` : "";
        let text = theme.fg(color, `${preview(details.agent, 40)} · ${status}${activity}${count}${details.taskId ? ` · ${details.taskId}` : ""}`);
        if (expanded && progress?.recentTools.length) {
          const recent = progress.recentTools.map((name) => preview(name, 60)).join(" → ");
          text += `\n  ${theme.fg("muted", `Recent: ${recent}`)}`;
        }
        if (!isPartial) {
          const output = details.status === "completed" ? details.output : details.errorMessage ?? details.output;
          if (output) text += `\n${theme.fg("toolOutput", expanded ? previewMultiline(output, 8_000) : preview(output, 240))}`;
        }
        return new Text(text, 0, 0);
      },
    });

    pi.registerTool({
      name: "subagent_tasks",
      label: "Subagent tasks",
      description: "List, inspect, or cancel background subagent tasks from this session. A finished task's answer is also delivered automatically.",
      promptSnippet: "Inspect or cancel a background subagent by task ID",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("cancel")]),
        id: Type.Optional(Type.String({ description: "Task ID returned by subagent(background=true); required for show or cancel." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        if (params.action === "list") {
          const records = registry.list(sessionId);
          return { content: [{ type: "text", text: records.length ? records.map(formatBackground).join("\n") : "No background subagent tasks in this session." }], details: records };
        }
        if (!params.id) return { content: [{ type: "text", text: `An id is required for ${params.action}.` }], details: undefined };
        const record = registry.get(sessionId, params.id);
        if (!record) return { content: [{ type: "text", text: `No subagent task ${params.id} exists in this session.` }], details: undefined };
        if (params.action === "cancel") {
          const stopped = registry.stop(sessionId, params.id);
          return { content: [{ type: "text", text: stopped ? `Stopping ${params.id}.` : `${params.id} already settled.` }], details: record };
        }
        const answer = record.result?.content.find((item) => item.type === "text");
        const text = `${formatBackground(record)}${answer?.type === "text" ? `\n\n${answer.text}` : record.errorMessage ? `\n\n${record.errorMessage}` : ""}`;
        return { content: [{ type: "text", text }], details: record };
      },
    });
  };
}

/** Keep model-provided text from injecting terminal control sequences or huge cards. */
function preview(value: string, limit: number): string {
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function previewMultiline(value: string, limit: number): string {
  const clean = value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, "");
  return clean.length > limit ? `${clean.slice(0, limit)}\n…` : clean;
}

export default function subagentPlugin(pi: ExtensionAPI): void {
  subagentExtension()(pi);
}

export {
  discoverAgents,
  findAgent,
  formatAgentNames,
  parseToolList,
  readAgentFile,
  userAgentsDir,
  type SubagentDefinition,
} from "./agents.ts";
export {
  MAX_RESULT_BYTES,
  SUBAGENT_DESCRIPTION,
  SUBAGENT_GUIDELINES,
  SubagentParams,
  emptySubagentUsage,
  executeSubagent,
  truncate,
  type SubagentCallContext,
  type SubagentDetails,
  type SubagentToolOptions,
  type SubagentToolParams,
  type SubagentUsage,
} from "./tool.ts";
// The process runner is shared, so its contract is re-exported here for callers
// that already depend on this plugin.
export {
  DEFAULT_AGENT_TIMEOUT_MS,
  SCHEDULER_DISABLE_FLAGS,
  agentChildEnv,
  createAgentExecutor,
  type AgentExecutor,
  type AgentRunInput,
  type AgentRunResult,
  type AgentUsage,
} from "pi-agent-runner";
