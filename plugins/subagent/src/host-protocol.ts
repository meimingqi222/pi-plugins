import { HostTranscript } from "./host-transcript.ts";
import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SubagentParams,
  type SubagentDetails,
  type SubagentToolParams,
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
  private readonly pendingFiles = new Map<
    string,
    { revision: string; path: string }
  >();
  private readonly transcripts = new Map<string, HostTranscript>();
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
  ) {}
  publish(lane: Lane, hostId = lane.id): void {
    const nativeStatus =
      lane.status === "running" && lane.idleSince !== undefined
        ? (lane.result?.details.status ?? lane.status)
        : lane.status;
    const revision = `${nativeStatus}:${lane.resultRevision ?? 0}`;
    if (this.last.get(lane.id) === revision) return;
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
      this.pi.sendMessage(
        {
          customType: "subagent-update",
          content: "",
          display: false,
          details: {
            id: hostId,
            ...(outputFile ? { outputFile } : {}),
            status: hostStatus(nativeStatus),
            nativeStatus,
            description: lane.task,
          },
        },
        { triggerTurn: false },
      );
      this.last.set(lane.id, revision);
      this.pendingFiles.delete(lane.id);
      if (lane.status !== "running") this.transcripts.delete(lane.id);
    } catch {
      /* A later boundary can retry a failed host update. */
    }
  }
  clear(): void {
    this.last.clear();
    this.transcripts.clear();
    this.pendingFiles.clear();
  }
}
