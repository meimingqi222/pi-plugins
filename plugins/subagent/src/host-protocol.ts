import { HostTranscript } from "./host-transcript.ts";
import { basename } from "node:path";
import { formatHostWork, type HostWork, type HostWorkContext } from "pi-run-core";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SubagentParams,
  emptySubagentUsage,
  type SubagentDetails,
  type SubagentToolParams,
  displayFailure,
} from "./tool.ts";
import type { Lane, LaneStatus } from "./lane.ts";

const { agent, task, ...options } = SubagentParams.properties;
export const HostSubagentParams = Type.Object({
  subagent_type: agent,
  prompt: task,
  ...options,
});
type HostParams = Static<typeof HostSubagentParams>;
type HostDetails = Omit<SubagentDetails, "status"> & {
  agentId: string;
  status: LaneStatus | "error";
  nativeStatus: LaneStatus;
};

interface ProgressOptions {
  hostId?: string;
  visible?: boolean;
  ctx?: HostWorkContext;
  onUpdate?: (update: AgentToolResult<SubagentDetails>) => void;
}

function laneWork(lane: Lane, id = lane.id, status = lane.status): HostWork {
  return { kind: "subagent", id, title: `${lane.alias} (${lane.agent})`, status, description: lane.task, activity: status === "running" ? progressActivity(lane) : displayFailure(lane.errorMessage ?? lane.result?.details.errorMessage ?? status), metric: `${lane.progress?.completedTools ?? 0} tools completed` };
}

function statusText(lane: Lane, id: string, status = lane.status, logPath = lane.logPath): string {
  const text = formatHostWork(laneWork(lane, id, status));
  return logPath ? `${text}\n[Pi transcript: ${basename(logPath)}]` : text;
}

interface PendingProgress {
  lane: Lane;
  options: ProgressOptions;
  nextAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

function cleanPreview(text: string, limit: number): string {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function progressActivity(lane: Lane): string {
  const progress = lane.progress;
  let activity = "working";
  if (progress?.activeTool) activity = `using ${cleanPreview(progress.activeTool, 160)}`;
  else if (progress?.phase === "starting") activity = "starting";
  else if (progress?.phase === "model") activity = "thinking";
  else if (progress?.phase === "tool") activity = "running tools";
  return activity;
}

function progressDescription(lane: Lane): string {
  return `${cleanPreview(lane.task, 160)} · ${progressActivity(lane)} · ${lane.progress?.completedTools ?? 0} tools completed`;
}

export function prepareHostArguments(value: unknown): HostParams {
  if (!value || typeof value !== "object")
    throw new Error("Subagent arguments must be an object.");
  const raw = value as Record<string, unknown>;
  const { agent: oldAgent, task: oldTask, ...rest } = raw;
  return {
    ...rest,
    subagent_type: raw.subagent_type ?? oldAgent,
    prompt: raw.prompt ?? oldTask,
  } as HostParams;
}

function internalArguments(value: HostParams): SubagentToolParams {
  const { subagent_type, prompt, ...options } = prepareHostArguments(value);
  return { ...options, agent: subagent_type, task: prompt };
}

export function hostStatus(status: LaneStatus): LaneStatus | "error" {
  return status === "failed" ? "error" : status;
}

function hostResult(
  result: AgentToolResult<SubagentDetails>,
  callId: string,
): AgentToolResult<HostDetails> {
  return {
    ...result,
    details: {
      ...result.details,
      agentId: result.details.taskId ?? callId,
      status: hostStatus(result.details.status),
      nativeStatus: result.details.status,
    },
  };
}

/** Keep the executor and native renderer independent of the host wire contract. */
export function registerHostSubagent(
  pi: ExtensionAPI,
  tool: ToolDefinition<typeof SubagentParams, SubagentDetails>,
): void {
  pi.registerTool<typeof HostSubagentParams, HostDetails>({
    ...tool,
    parameters: HostSubagentParams,
    prepareArguments: prepareHostArguments,
    async execute(id, params, signal, onUpdate, ctx) {
      const result = await tool.execute(
        id,
        internalArguments(params),
        signal,
        onUpdate ? (update) => onUpdate(hostResult(update, id)) : undefined,
        ctx,
      );
      return hostResult(result, id);
    },
    renderCall: tool.renderCall
      ? (args, theme, context) =>
          tool.renderCall!(
            internalArguments(args),
            theme,
            context
              ? { ...context, args: internalArguments(context.args) }
              : context,
          )
      : undefined,
    renderResult: tool.renderResult
      ? (result, options, theme, context) =>
          tool.renderResult!(
            {
              ...result,
              details: {
                ...result.details,
                status:
                  result.details.nativeStatus ??
                  (result.details.status as LaneStatus),
              },
            },
            options,
            theme,
            context
              ? { ...context, args: internalArguments(context.args) }
              : context,
          )
      : undefined,
  });
}

/** UI state is separate from answer delivery: consuming an answer cannot hide settlement. */
export class HostSubagentState {
  private readonly last = new Map<string, string>();
  private readonly progressUpdates = new Map<string, PendingProgress>();
  private readonly surfaces = new Map<string, ProgressOptions>();
  private readonly pendingFiles = new Map<
    string,
    { revision: string; path: string }
  >();
  private readonly transcripts = new Map<string, HostTranscript>();
  private readonly liveAnnouncements = new Map<string, string>();
  /** Attach the background spawn result before it returns, so Paseo can follow immediately. */
  liveFile(lane: Lane): string | undefined {
    const logPath = this.logPath(lane);
    if (!logPath) return;
    let transcript = this.transcripts.get(lane.id);
    if (!transcript) {
      transcript = new HostTranscript();
      this.transcripts.set(lane.id, transcript);
    }
    return transcript.startLive(logPath, lane.task);
  }
  observe(id: string, event: unknown): void {
    let transcript = this.transcripts.get(id);
    if (!transcript) {
      transcript = new HostTranscript();
      this.transcripts.set(id, transcript);
    }
    transcript.observe(event);
  }
  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly logPath: (lane: Lane) => string | undefined = (lane) =>
      lane.logPath,
    private readonly progressIntervalMs = 2_000,
  ) {}

  /** Coalesce token activity; the trailing update preserves the latest tool/phase. */
  progress(lane: Lane, options: ProgressOptions = {}): void {
    if (lane.status !== "running" || lane.idleSince !== undefined) return;
    this.surfaces.set(lane.id, options);
    let pending = this.progressUpdates.get(lane.id);
    if (!pending) {
      pending = { lane, options, nextAt: 0 };
      this.progressUpdates.set(lane.id, pending);
    }
    pending.lane = { ...lane, progress: lane.progress ? { ...lane.progress } : undefined };
    pending.options = options;
    const flush = () => {
      pending.timer = undefined;
      pending.nextAt = Date.now() + this.progressIntervalMs;
      const current = pending.lane;
      const hostId = pending.options.hostId ?? current.id;
      if (!this.publish(current, hostId, pending.options.visible)) return;
      try {
        pending.options.onUpdate?.({
          content: [{ type: "text", text: statusText(current, hostId, current.status, this.logPath(current)) }],
          details: { agent: current.agent, status: "running", usage: emptySubagentUsage(), output: "", progress: current.progress },
        });
      } catch { /* A renderer cannot fail a child run. */ }
    };
    if (pending.timer) return;
    const delay = pending.nextAt - Date.now();
    if (delay <= 0) flush();
    else {
      pending.timer = setTimeout(flush, delay);
      pending.timer.unref?.();
    }
  }

  private cancelProgress(id: string): void {
    const pending = this.progressUpdates.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    this.progressUpdates.delete(id);
  }

  publish(lane: Lane, hostId = lane.id, visible = this.surfaces.get(lane.id)?.visible ?? false): boolean {
    const nativeStatus =
      lane.status === "running" && lane.idleSince !== undefined
        ? (lane.result?.details.status ?? lane.status)
        : lane.status;
    if (nativeStatus !== "running") this.cancelProgress(lane.id);
    const ctx = this.surfaces.get(lane.id)?.ctx;
    if (nativeStatus === "running" && lane.kind === "background" && ctx?.mode === "rpc" && process.env.PI_RPC_CLIENT === "paseo") {
      const file = this.liveFile(lane);
      if (file && ctx.ui && this.liveAnnouncements.get(lane.id) !== file) {
        try {
          // Paseo's existing adapter consumes this notification without adding a visible row.
          ctx.ui.notify(`PASEO_GOTGENES_CHILD_SESSION ${JSON.stringify({ agentId: hostId, file })}`, "info");
          this.liveAnnouncements.set(lane.id, file);
        } catch { /* The spawn result also carries the initial file; a later tick can retry. */ }
      }
    }
    const description = nativeStatus === "running" ? progressDescription(lane) : lane.task;
    const revision = `${nativeStatus}:${lane.resultRevision ?? 0}:${description}`;
    if (this.last.get(lane.id) === revision) return false;
    let outputFile =
      this.pendingFiles.get(lane.id)?.revision === revision
        ? this.pendingFiles.get(lane.id)?.path
        : undefined;
    const logPath = this.logPath(lane);
    if (!outputFile && nativeStatus !== "running" && logPath) {
      let transcript = this.transcripts.get(lane.id);
      if (!transcript) {
        transcript = new HostTranscript();
        this.transcripts.set(lane.id, transcript);
      }
      outputFile = transcript.snapshot(
        logPath,
        lane.task,
        nativeStatus,
        lane.result?.details ?? { output: "", errorMessage: lane.errorMessage },
      );
      if (outputFile)
        this.pendingFiles.set(lane.id, { revision, path: outputFile });
    }
    try {
      const showStatus = visible && !(nativeStatus === "running" && this.surfaces.get(lane.id)?.onUpdate);
      const content = showStatus ? statusText(lane, hostId, nativeStatus, logPath) : "";
      const notify = showStatus && process.env.PI_RPC_PROGRESS_TRANSPORT === "notify" && ctx?.ui;
      if (notify) notify.notify(content, nativeStatus === "failed" ? "warning" : "info");
      this.pi.sendMessage(
        {
          customType: "subagent-update",
          content: notify ? "" : content,
          display: showStatus && !notify,
          details: {
            id: hostId,
            ...(outputFile ? { outputFile } : {}),
            status: hostStatus(nativeStatus),
            nativeStatus,
            description,
          },
        },
        { triggerTurn: false },
      );
      this.last.set(lane.id, revision);
      this.pendingFiles.delete(lane.id);
      if (lane.status !== "running") this.transcripts.delete(lane.id);
      return true;
    } catch {
      /* A later boundary can retry a failed host update. */
      return false;
    }
  }
  clear(): void {
    for (const id of this.progressUpdates.keys()) this.cancelProgress(id);
    this.last.clear();
    this.surfaces.clear();
    this.transcripts.clear();
    this.pendingFiles.clear();
    this.liveAnnouncements.clear();
  }
}
