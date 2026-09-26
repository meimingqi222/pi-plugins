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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { connectGoalSpend, readTokenUsage, SettledDeliveryQueue, type GoalSpendLease } from "pi-run-core";
import { BackgroundRegistry, formatBackground } from "./background.ts";
import { formatFleetListing } from "./fleet.ts";
import { createSubagentsPanel } from "./panel.ts";
import { createFleetReporter } from "./widget.ts";
import { discoverAgents, formatAgentNames } from "./agents.ts";
import { resolveAgent } from "./catalog.ts";
import { WAIT_TIMEOUT_DEFAULT_SECONDS, WAIT_TIMEOUT_MAX_SECONDS } from "./contract.ts";
import { readSubagentLog, subagentLogPath, SUBAGENT_LOG_MAX_BYTES, SUBAGENT_LOG_MAX_LINES, sweepSubagentLogs } from "./logs.ts";
import {
  SUBAGENT_DESCRIPTION,
  SUBAGENT_GUIDELINES,
  SubagentParams,
  executeSubagent,
  emptySubagentUsage,
  formatActivity,
  type SubagentDetails,
  type SubagentToolOptions,
} from "./tool.ts";

export interface SubagentExtensionOptions extends SubagentToolOptions {
  /** Disable registration entirely (test seam). */
  enabled?: boolean;
  /** Open the fleet panel on `down` at an empty editor; defaults to PI_SUBAGENT_DOWN_INSPECT. */
  downInspect?: boolean;
  /** Notify the user when a child settles; defaults to PI_SUBAGENT_NOTIFY_DONE, toggled by `n` or `/subagents notify`. */
  notifyDone?: boolean;
}

/** Raw-log tail rows shown by the panel's `l` key; same bound as the tool's log action. */
const LOG_TAIL_LINES = 40;
/** A transcript fold needs more of the tail than the raw viewer shows. */
const TRANSCRIPT_TAIL_LINES = SUBAGENT_LOG_MAX_LINES;

/** Opt-in: `down` at an empty editor opens the fleet panel (costs history browsing on that key). */
export function downInspectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PI_SUBAGENT_DOWN_INSPECT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** Opt-in: notify the user (not only the model) when a child settles. */
export function notifyDoneDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PI_SUBAGENT_NOTIFY_DONE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
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
    sweepSubagentLogs();
    const goalSpend = connectGoalSpend(pi);
    let generation = 0;
    const delivery = new SettledDeliveryQueue(pi);
    const pending = new Map<string, { lease?: GoalSpendLease; isCurrent: () => boolean; isIdle: () => boolean }>();

    // The fleet surfaces need the session's UI context: widgets are scoped to
    // the `ctx` they were mounted on, and the registry is keyed to the session
    // id. `session_start` refreshes the reference; a lazy refresh at launch
    // covers a plugin /reload mid-session.
    let uiCtx: ExtensionContext | undefined;
    let panelOpen = false;
    let activePanel: { dispose?(): void } | undefined;
    let downUnsubscribe: (() => void) | undefined;
    let notifyDone = options.notifyDone ?? notifyDoneDefault();
    const downInspect = options.downInspect ?? downInspectEnabled();

    const reporter = createFleetReporter({
      ui: () => (uiCtx?.mode === "tui" && uiCtx.hasUI && typeof uiCtx.ui?.setWidget === "function" ? uiCtx.ui : undefined),
      list: () => (uiCtx ? registry.list(uiCtx.sessionManager.getSessionId()) : []),
      activeCount: () => registry.activeCount(),
    });

    async function openFleetPanel(source: ExtensionContext): Promise<void> {
      if (panelOpen || source.mode !== "tui" || !source.hasUI || typeof source.ui?.custom !== "function") return;
      if (uiCtx === undefined) uiCtx = source;
      const sessionId = uiCtx.sessionManager.getSessionId();
      const records = registry.list(sessionId);
      if (records.length === 0) return;
      panelOpen = true;
      try {
        await source.ui.custom(
          (tui, theme, _keybindings, done) =>
            (activePanel = createSubagentsPanel(
              {
                tui,
                theme,
                list: () => registry.list(sessionId),
                stop: (id) => registry.stop(sessionId, id),
                readLog: (id) => {
                  const path = registry.getLogPath(sessionId, id);
                  return path ? readSubagentLog(path, { lines: LOG_TAIL_LINES }).text : undefined;
                },
                readTranscriptLines: (id) => {
                  const path = registry.getLogPath(sessionId, id);
                  if (!path) return undefined;
                  const read = readSubagentLog(path, { lines: TRANSCRIPT_TAIL_LINES });
                  return { lines: read.text.split("\n").filter((line) => line.length > 0), earlierDataOmitted: read.earlierDataOmitted };
                },
                notifyDone: () => notifyDone,
                setNotifyDone: (value) => { notifyDone = value; },
              },
              () => done(undefined),
            )),
          { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
        );
      } finally {
        panelOpen = false;
        activePanel = undefined;
      }
    }

    const registry = new BackgroundRegistry((record) => {
      reporter.sync();
      const launch = pending.get(record.id);
      pending.delete(record.id);
      launch?.lease?.finish(record.result ? readTokenUsage(record.result) : 0);
      if (notifyDone && record.status !== "aborted") {
        const ui = uiCtx?.ui;
        if (ui) {
          try {
            const icon = record.status === "completed" ? "✓" : "×";
            ui.notify(`${icon} subagent ${record.id} (${record.agent}) ${record.status} — /subagents live`, record.status === "completed" ? "info" : "warning");
          } catch { /* The settled result still reaches the model. */ }
        }
      }
      if (!launch?.isCurrent()) return;
      const answer = record.result?.content.find((item) => item.type === "text");
      const summary = answer?.type === "text" ? answer.text : record.errorMessage ?? "No answer was returned.";
      delivery.deliver(launch.isIdle, () => {
        if (!launch.isCurrent()) return;
        try {
          pi.sendMessage({
            customType: "subagent-result",
            content: `${formatBackground(record)}\n\n${summary}`,
            display: true,
            details: record,
          }, record.status === "completed" ? { triggerTurn: true, deliverAs: "followUp" } : undefined);
        } catch { /* The settled task remains available through subagent_tasks. */ }
      });
    });

    const endSession = () => {
      generation += 1;
      delivery.clear();
      registry.stopAll();
      uiCtx = undefined;
      downUnsubscribe?.();
      downUnsubscribe = undefined;
      // The host removes overlays without disposing them, so the panel would
      // keep its interval alive across a session switch if left to the host.
      activePanel?.dispose?.();
      activePanel = undefined;
      panelOpen = false;
      reporter.dispose();
    };
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode === "tui") uiCtx = ctx;
      attachDownInspect(ctx);
    });
    pi.on("session_before_tree", endSession);
    pi.on("session_before_fork", endSession);
    pi.on("session_before_switch", endSession);
    pi.on("session_shutdown", endSession);

    // Registered defensively: a host that embeds the extension without command
    // or shortcut surfaces (tests, RPC drivers) still gets both tools.
    pi.registerCommand?.("subagents", {
      description: "List background subagents, or watch them live: /subagents [live|stop [id]|notify [on|off]|<id>]",
      async handler(args: string, ctx) {
        if (ctx.mode === "tui" && ctx.hasUI) uiCtx = ctx;
        const sessionId = ctx.sessionManager.getSessionId();
        const input = args.trim();
        const [verb, target] = input.split(/\s+/u).filter(Boolean);

        if (verb === "live" || verb === "watch") {
          if (ctx.mode !== "tui") {
            ctx.ui.notify(formatFleetListing(registry.list(sessionId)), "info");
            return;
          }
          if (registry.list(sessionId).length === 0) {
            ctx.ui.notify("No background subagent tasks in this session.", "info");
            return;
          }
          await openFleetPanel(ctx);
          return;
        }

        if (verb === "stop" || verb === "cancel") {
          const records = registry.list(sessionId);
          const running = records.filter((record) => record.status === "running");
          if (!target) {
            if (running.length === 0) {
              ctx.ui.notify("No running subagents.", "info");
              return;
            }
            for (const record of running) registry.stop(sessionId, record.id);
            ctx.ui.notify(`Stopping ${running.length} subagent${running.length === 1 ? "" : "s"}.`, "info");
            return;
          }
          const record = records.find((item) => item.id === target);
          if (!record || record.status !== "running") {
            ctx.ui.notify(`No running subagent ${target}.`, "warning");
            return;
          }
          registry.stop(sessionId, record.id);
          ctx.ui.notify(`Stopping ${record.id}.`, "info");
          return;
        }

        if (verb === "notify") {
          if (target === "on") notifyDone = true;
          else if (target === "off") notifyDone = false;
          else notifyDone = !notifyDone;
          ctx.ui.notify(`subagent completion notifications ${notifyDone ? "on" : "off"}.`, "info");
          return;
        }

        if (verb?.startsWith("sa-")) {
          const record = registry.get(sessionId, verb);
          if (!record) {
            ctx.ui.notify(`No subagent task ${verb} in this session.`, "warning");
            return;
          }
          ctx.ui.notify(formatBackground(record), "info");
          return;
        }

        ctx.ui.notify(formatFleetListing(registry.list(sessionId)), "info");
      },
    });

    pi.registerShortcut?.(Key.ctrlShift("a"), {
      description: "Open the background subagent panel",
      handler: (ctx) => {
        uiCtx ??= ctx;
        return openFleetPanel(ctx);
      },
    });

    /**
     * Down at an empty editor opens the fleet — flag-gated, because it swallows
     * history browsing at an empty editor and can eat `down` aimed at an open
     * dialog (the input listener runs before the focused component).
     */
    function attachDownInspect(ctx: ExtensionContext): void {
      downUnsubscribe?.();
      downUnsubscribe = undefined;
      if (!downInspect || ctx.mode !== "tui" || typeof ctx.ui?.onTerminalInput !== "function") return;
      downUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (isKeyRelease(data) || !matchesKey(data, "down")) return undefined;
        if (panelOpen) return undefined;
        const current = uiCtx;
        if (!current) return undefined;
        const sessionId = current.sessionManager.getSessionId();
        if (registry.list(sessionId).length === 0) return undefined;
        let editorText = "";
        try {
          editorText = current.ui.getEditorText();
        } catch {
          return undefined;
        }
        if (editorText.length > 0) return undefined;
        // Async open: the listener is synchronous, and a consumed key is already
        // swallowed by the time the panel mounts.
        void openFleetPanel(current);
        return { consume: true };
      });
    }

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
          if (!resolveAgent(agents, params.agent)) {
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
            const resolved = resolveAgent(agents, params.agent);
            const record = registry.launch(resolved?.name ?? params.agent, params.task, sessionId, (runSignal, id) => {
              const logPath = subagentLogPath(id, sessionId);
              registry.setLogPath(id, logPath);
              return executeSubagent(params, {
                ...childContext,
                signal: runSignal,
                evidencePath: logPath,
                evidenceMaxBytes: SUBAGENT_LOG_MAX_BYTES,
                onProgress: (progress) => registry.setProgress(id, progress),
              }, options);
            }, params.alias);
            pending.set(record.id, {
              ...(lease ? { lease } : {}),
              isCurrent: () => generation === launchedIn && ctx.sessionManager.getSessionId() === sessionId,
              isIdle: () => ctx.isIdle(),
            });
            // The fleet widget mounts on the first live child: session_start is
            // the usual source of `uiCtx`, and this lazy refresh covers a /reload
            // that swapped the extension in mid-session.
            if (ctx.mode === "tui" && ctx.hasUI) uiCtx = ctx;
            reporter.sync();
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
      description: "List background subagent tasks, inspect status, recent activity, or explicitly read/search the raw event log, or cancel a task from this session. Raw logs include prompts and tool data; request them only for debugging. A finished task's answer is also delivered automatically.",
      promptSnippet: "Inspect a background subagent's status, recent events, or diagnostic log; cancel by task ID",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("events"), Type.Literal("log"), Type.Literal("cancel"), Type.Literal("wait")]),
        id: Type.Optional(Type.String({ description: "Task ID returned by subagent(background=true); required for show, events, log, cancel, or wait." })),
        timeout: Type.Optional(Type.Number({ minimum: 0, maximum: WAIT_TIMEOUT_MAX_SECONDS, description: `Seconds to wait for the task to settle (0–${WAIT_TIMEOUT_MAX_SECONDS}, default ${WAIT_TIMEOUT_DEFAULT_SECONDS}).` })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum recent activity events to return (1–10)." })),
        query: Type.Optional(Type.String({ maxLength: 200, description: "Optional case-insensitive substring to search in raw JSONL log lines." })),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum matching log lines to return (1–50, default 20)." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        if (params.action === "list") {
          const records = registry.list(sessionId);
          return { content: [{ type: "text", text: records.length ? records.map(formatBackground).join("\n") : "No background subagent tasks in this session." }], details: records };
        }
        if (!params.id) return { content: [{ type: "text", text: `An id is required for ${params.action}.` }], details: undefined };
        if (params.action === "wait") {
          const seconds = Math.min(WAIT_TIMEOUT_MAX_SECONDS, Math.max(0, params.timeout ?? WAIT_TIMEOUT_DEFAULT_SECONDS));
          const record = await registry.waitFor(sessionId, params.id, seconds * 1_000);
          if (!record) return { content: [{ type: "text", text: `No subagent task ${params.id} exists in this session.` }], details: undefined };
          const tail = record.status === "running" ? ` Still running after ${seconds}s — its answer will arrive when it finishes.` : "";
          return { content: [{ type: "text", text: `${formatBackground(record)}.${tail}` }], details: record };
        }
        const record = registry.get(sessionId, params.id);
        if (!record) return { content: [{ type: "text", text: `No subagent task ${params.id} exists in this session.` }], details: undefined };
        if (params.action === "cancel") {
          const stopped = registry.stop(sessionId, params.id);
          return { content: [{ type: "text", text: stopped ? `Stopping ${params.id}.` : `${params.id} already settled.` }], details: record };
        }
        if (params.action === "log") {
          const logPath = registry.getLogPath(sessionId, params.id);
          if (!logPath) {
            return { content: [{ type: "text", text: "No raw log is available for this task." }], details: { id: record.id } };
          }
          const result = readSubagentLog(logPath, { query: params.query, lines: params.lines });
          return {
            content: [{ type: "text", text: result.text }],
            details: {
              id: record.id,
              matchedLines: result.matchedLines,
              scannedBytes: result.scannedBytes,
              earlierDataOmitted: result.earlierDataOmitted,
            },
          };
        }
        if (params.action === "events") {
          const recent = record.progress?.recentActivity ?? [];
          const limit = Math.max(1, Math.min(10, params.limit ?? 10));
          const events = recent.slice(-limit);
          const text = events.length
            ? events.map((event) => formatActivity(event)).join("\n")
            : "No child activity events recorded.";
          return { content: [{ type: "text", text }], details: { id: record.id, events } };
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
