/**
 * Plugin entry: registers the `workflow` tool and the `/workflows` command.
 *
 * Registration is thin. Everything with logic lives in a tested module, and this
 * file's job is to connect them to pi.
 *
 * **A run is launched, not awaited.** A workflow exists for work too large for
 * one turn — the whole point is that it outlives the moment it was asked for. A
 * tool that blocked the turn would hold the conversation hostage for the entire
 * run and offer no way to do anything else meanwhile, so `execute` starts the run
 * in the `RunRegistry` and returns a handle immediately; the result is delivered
 * back into the conversation when the run settles.
 *
 * Two consequences of that shape are deliberate, not oversights:
 *
 * - **No `onUpdate` progress.** `onUpdate` is only live while `execute` runs, and
 *   `execute` returns at once, so progress streamed through it could never reach
 *   the model. `/workflows` is the progress surface instead.
 * - **No `renderShell: "self"`.** That flag declares a tool paints its own frame,
 *   which is only meaningful alongside `renderCall`/`renderResult`. With no
 *   renderers, pi's own fallback row is what should show.
 *
 * The tool is always registered. "Is this tool available" and "should the model
 * use it now" are different questions, and conflating them makes the capability
 * invisible rather than unavailable: the opt-in rule lives in the tool's
 * guidelines, where the model can read it.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectGoalSpend, type GoalSpendLease } from "pi-run-core";
import { createPiExecutor } from "../runner/pi-executor.ts";
import { listSavedWorkflows, listWorkflowRuns, formatRunSummary, formatWorkflowStatus } from "../runs/progress.ts";
import { renderLiveStatus } from "../runs/live-status.ts";
import { RunRegistry, formatRun, maxActiveRunsCeiling, type RunRecord } from "../runs/registry.ts";
import { createFooterReporter } from "./footer.ts";
import { createWorkflowsPanel } from "./panel.ts";
import { newWorkflowRunId } from "../runs/journal.ts";
import { savedWorkflowRoots, resolveWorkflowSource, promoteWorkflow } from "./script-source.ts";
import { isPureWaitCommand, pollBlockReason } from "./poll-guard.ts";
import {
  executeWorkflow,
  renderWorkflowResult,
  WorkflowParams,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_GUIDELINES,
} from "./tool.ts";

export interface WorkflowExtensionOptions {
  /** Test seam: replaces the agent executor so no subprocess is spawned. */
  executor?: ReturnType<typeof createPiExecutor>;
  /** Test seam: overrides the working directory. */
  cwd?: string;
  /** Test seam: overrides how a settled run is delivered. */
  deliver?: (pi: ExtensionAPI, record: RunRecord) => void;
  /** Disable registration entirely. */
  enabled?: boolean;
}

/** Whether registration is switched off by the environment. */
export function workflowsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PI_WORKFLOW_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

const WorkflowStatusParams = Type.Object({
  runId: Type.Optional(
    Type.String({ description: "A single run id; omit for every active run plus recent settled runs" }),
  ),
});

export default function workflowPlugin(pi: ExtensionAPI): void {
  workflowExtension()(pi);
}

/** Descriptor form, so a host with a test executor can build its own. */
export function workflowExtension(options: WorkflowExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    if (options.enabled === false || workflowsDisabled()) return;
    const goalSpend = connectGoalSpend(pi);
    const goalLeases = new Map<string, GoalSpendLease>();
    const executor = options.executor ?? createPiExecutor();
    const cwd = (ctx: ExtensionContext): string => options.cwd ?? ctx.cwd;

    const deliver =
      options.deliver ??
      ((api: ExtensionAPI, record: RunRecord): void => {
        // The result arrives as a custom message rather than a tool result,
        // because the turn that asked for the run is long over.
        api.sendMessage(
          {
            customType: "workflow-result",
            content: `${formatRun(record)}\n\n${renderWorkflowResult(record.result!)}`,
            display: true,
            details: record,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      });

    // A footer entry that outlives the notification. Both of its dependencies on
    // the registry are lazy, so it can be declared first and read the registry
    // only once something has happened. Attached lazily too, from a context that
    // has a UI, so a headless mode cannot start a timer.
    const footer = createFooterReporter({
      list: () => registry.list(),
      activeCount: () => registry.activeCount(),
    });
    const attachFooter = (ctx: ExtensionContext): void => {
      if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
      footer.attach(ctx.ui);
    };

    const registry = new RunRegistry({
      maxActiveRuns: maxActiveRunsCeiling(),
      onSettled(record) {
        goalLeases.get(record.runId)?.finish(record.result?.goalTokens ?? record.progress?.goalTokens ?? 0);
        goalLeases.delete(record.runId);
        // A run stopped by the user or ended by a failure has no result to
        // render; the notice still matters.
        if (record.result) {
          deliver(pi, record);
        } else {
          pi.sendMessage({
            customType: "workflow-result",
            content: formatRun(record),
            display: true,
            details: record,
          });
        }
        // The footer follows the registry: the last settlement is what clears
        // the slot and stops the tick.
        footer.sync();
      },
    });

    pi.registerTool<typeof WorkflowParams, RunRecord, never>({
      name: "workflow",
      label: "Workflow",
      description: WORKFLOW_DESCRIPTION,
      promptSnippet: "Run a structured multi-agent workflow",
      promptGuidelines: WORKFLOW_GUIDELINES,
      parameters: WorkflowParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
        const workDir = cwd(ctx);
        // Resolve the script before launching, so a bad name or path fails the
        // tool call where the model can see it, rather than silently in the
        // background where it cannot.
        const source = await resolveWorkflowSource(workDir, params as Record<string, never>);
        const runId = newWorkflowRunId();
        const lease = goalSpend()?.begin(ctx, runId);
        if (lease) goalLeases.set(runId, lease);
        const agentTimeoutMs = (params as { agentTimeoutMs?: number }).agentTimeoutMs;

        let record: RunRecord;
        try {
          record = registry.launch({ runId, name: source.name, agentTimeoutMs }, (runSignal) =>
          executeWorkflow(params as Record<string, never>, {
            cwd: workDir,
            executor,
            signal: runSignal,
            // Resolved once here, so the handle the tool returns is the run the
            // journal is written under.
            source,
            runId,
            // Progress is stored on the registry record rather than streamed
            // through `onUpdate`: `execute` returns at once, so an update would
            // have no reader. workflow_status is the surface for it.
            onProgress: (progress) => {
              registry.setProgress(runId, progress);
              // A phase change is news; the ticker only refreshes the clock.
              footer.sync();
            },
          }),
          );
        } catch (error) {
          goalLeases.delete(runId);
          lease?.finish(0);
          throw error;
        }
        attachFooter(ctx);
        footer.sync();

        return {
          content: [
            {
              type: "text",
              text: [
                `Workflow ${runId} started (${source.name}).`,
                "It runs in the background; the result will arrive when it settles.",
                `Use workflow_status to check progress, /workflows to list runs, or /workflows stop ${runId} to stop it.`,
              ].join(" "),
            },
          ],
          details: record,
        };
      },
    });

    // The model-facing progress surface. It is also what `/workflows` renders
    // for the user; this tool exists because the model needs an answer inside a
    // turn, without opening a dialog, and because a run's settlement is minutes
    // away at best.
    pi.registerTool<typeof WorkflowStatusParams, undefined, never>({
      name: "workflow_status",
      label: "Workflow status",
      description:
        "Report progress and liveness of workflow runs: phases reached, agents running and for how long, tokens spent, " +
        "time since the last progress event, and whether a per-agent timeout bounds them. Use this instead of polling with sleep.",
      promptSnippet: "Check progress and liveness of workflow runs",
      promptGuidelines: [
        "Use workflow_status to see what a running workflow is doing; do not poll with sleep.",
      ],
      parameters: WorkflowStatusParams,
      async execute(_toolCallId, params) {
        const records = params.runId
          ? [registry.get(params.runId)].filter((record): record is RunRecord => record !== undefined)
          : registry.list();
        const text =
          params.runId && records.length === 0
            ? `No workflow run ${params.runId} is known in this session.`
            : renderLiveStatus(records);
        return { content: [{ type: "text", text }], details: undefined };
      },
    });

    // A bare `sleep` while a run is active is a poll. Blocking it and terminating
    // the batch ends the turn cleanly instead of letting the model spin; a
    // command with a purpose (`sleep 5 && npm test`) is untouched, and the
    // batch early-termination rule means a poll batched with real work does not
    // stop that work.
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return;
      if (registry.activeCount() === 0) return;
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string" || !isPureWaitCommand(command)) return;
      const runIds = registry
        .list()
        .filter((record) => record.status === "running")
        .map((record) => record.runId);
      return { block: true, terminate: true, reason: pollBlockReason(runIds) };
    });

    pi.registerCommand("workflows", {
      description:
        "List workflow runs, or manage one: /workflows [live|<runId>|stop [<runId>]|save <name> [--user]]",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const input = args.trim();
        const [verb, target] = input.split(/\s+/u).filter(Boolean);
        // Any context the user reaches this command from has a UI, so the footer
        // is attached here too: a run launched before this session's UI existed
        // (a resumed session) still gets one.
        attachFooter(ctx);

        // Promote a run's own script, so `name` stops being read-only. Without
        // this a saved workflow can only be created outside pi.
        if (verb === "save" || verb === "promote") {
          const rest = input.split(/\s+/u).filter(Boolean).slice(1);
          const scope = rest.includes("--user") ? ("user" as const) : ("project" as const);
          const name = rest.find((token) => !token.startsWith("--"));
          if (!name) {
            ctx.ui.notify("Usage: /workflows save <name> [--user]", "warning");
            return;
          }
          try {
            const promoted = await promoteWorkflow({ cwd: cwd(ctx), name, scope });
            ctx.ui.notify(`Saved ${promoted.name} (${promoted.scope}): ${promoted.path}`, "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }

        if (verb === "stop" || verb === "cancel") {
          if (!target) {
            const active = registry.activeCount();
            if (active === 0) {
              ctx.ui.notify("No workflow runs are active.", "info");
              return;
            }
            registry.stopAll();
            ctx.ui.notify(`Stopping ${active} workflow run${active === 1 ? "" : "s"}.`, "info");
            return;
          }
          if (!registry.stop(target)) {
            ctx.ui.notify(`No active workflow run ${target}.`, "warning");
            return;
          }
          ctx.ui.notify(`Stopping workflow run ${target}.`, "info");
          return;
        }

        // A panel, because a run lasts minutes and a notification is a snapshot:
        // it is stale a second later and it scrolls away. TUI only — RPC clients
        // cannot render a component, and the listing below is already the answer
        // for them.
        if (verb === "live" || verb === "watch") {
          if (ctx.mode !== "tui") {
            ctx.ui.notify(renderLiveStatus(registry.list()), "info");
            return;
          }
          await ctx.ui.custom(
            (tui, _theme, _keybindings, done) =>
              createWorkflowsPanel(
                { tui, list: () => registry.list(), stopAll: () => registry.stopAll() },
                () => done(undefined),
              ),
            { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
          );
          return;
        }

        // One run in full. The listing is a summary of many; the question "what is
        // it doing right now" is asked about one, and the run id is already the
        // handle the user has to hand (it is what `stop` takes).
        if (verb?.startsWith("wf_")) {
          const record = registry.get(verb);
          if (record?.status === "running") {
            ctx.ui.notify(renderLiveStatus([record]), "info");
            return;
          }
          const summary = (await listWorkflowRuns(cwd(ctx))).find((run) => run.runId === verb);
          ctx.ui.notify(
            summary ? formatRunSummary(summary) : `No workflow run ${verb} in this session or on disk.`,
            summary ? "info" : "warning",
          );
          return;
        }

        // Active runs first, then the recent runs. The disk listing is not
        // skipped while something is live: a run in flight is exactly when a
        // reader also wants to know what the previous ones did.
        const sections: string[] = [];
        const active = registry.list().filter((record) => record.status === "running");
        // The live section is the same renderer the model reads through
        // `workflow_status`: phase, agent counts by status, per-agent ages,
        // tokens, and the age of the last progress event. It used to print one
        // `formatRun` line — "wf_x running name 18.8s" — which told a reader
        // that a run existed and nothing else, and that is the one question
        // `/workflows` is opened to answer. The run id stays on the first line,
        // so copying it into `/workflows stop <runId>` still works.
        if (active.length > 0) sections.push(renderLiveStatus(active));
        const activeIds = new Set(active.map((record) => record.runId));
        const [saved, runs] = await Promise.all([
          listSavedWorkflows(savedWorkflowRoots(cwd(ctx))),
          listWorkflowRuns(cwd(ctx)),
        ]);
        // A live run is not repeated below. Its disk summary comes from a journal
        // that is still being written, so it can only read as `unfinished` or
        // `empty` with a duration of 0s — a worse description of the same run
        // than the section above. A run left on disk by another process is not
        // filtered: it is not in this registry, and its summary is all there is.
        sections.push(formatWorkflowStatus(runs.filter((run) => !activeIds.has(run.runId)), saved));
        ctx.ui.notify(sections.join("\n\n"), "info");
      },
    });

    pi.on("session_shutdown", () => {
      registry.stopAll();
      // Settlement after a shutdown may never arrive, so the slot is released
      // here rather than waiting for a callback that has nowhere to go.
      footer.dispose();
    });
  };
}

export { Type };
