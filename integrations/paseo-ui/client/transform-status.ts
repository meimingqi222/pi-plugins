import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { WorkStatus } from "../shared/work-status.ts";
import { liveLogSchema, parseWorkStatus, workStatusSchema } from "../shared/work-status.ts";

function replacement(text: string, snapshot = false) {
  const data = parseWorkStatus(text);
  if (!data) return;
  // Progress snapshots replay after the turn; only the live tool row should show running state.
  if (snapshot && data.kind === "Subagent" && data.status === "running") return { items: [] };
  return { items: [{ type: "plugin" as const, kind: "pi-work-status", version: 1, data }] };
}

export const transformStatusMessage: PluginTimelineTransformerContribution<"assistant_message">["transform"] = ({ item, phase }) => {
  if (phase !== "complete") return;
  return replacement(item.text, true);
};

/**
 * Status rows reach a host in two shapes. Up to Paseo 0.11.0 a Pi custom message
 * became an `assistant_message`; 0.11.1 renders it as a synthetic completed
 * `tool_call` whose name is the custom type (provider/pi/agent.ts,
 * mapCustomMessageToToolCall). A blocking subagent call streams the same five
 * lines as its partial result, which Paseo's pi subagent adapter puts in
 * `detail.log` (extensions/pi-subagents, mapSpawn) while the child works. That is
 * the only status a host can render mid-run: Pi defers passive custom messages to
 * a turn boundary.
 */
const STATUS_CUSTOM_TYPES = new Set(["pi-work-status", "subagent-update"]);
/** Tool calls whose log carries the status protocol. */
const STATUS_TOOL_NAMES = new Set(["subagent"]);

/** Text a row may carry the status protocol in; other rows keep their native renderer. */
function rowText(item: { name: string; detail: { type: string } & Record<string, unknown>; metadata?: Record<string, unknown> }): string | undefined {
  const customType = item.metadata?.customType;
  if (typeof customType === "string") {
    if (!STATUS_CUSTOM_TYPES.has(customType) || item.detail.type !== "plain_text") return;
    const text = item.detail.text;
    return typeof text === "string" ? text : undefined;
  }
  if (!STATUS_TOOL_NAMES.has(item.name) || item.detail.type !== "sub_agent") return;
  const log = item.detail.log;
  return typeof log === "string" ? log : undefined;
}

/** Cards for published states, including the live card a running child streams. */
export const transformStatusToolCall: PluginTimelineTransformerContribution<"tool_call">["transform"] = ({ item }) => {
  const text = rowText(item);
  if (text && item.name === "subagent") {
    const spawn = /^Subagent ([A-Za-z0-9-]+) \(([^\n]+)\) started in the background\./u.exec(text);
    const reference = /\n\[Pi transcript: ([^\]\n]+)\]$/u.exec(text);
    const log = liveLogSchema.safeParse(reference?.[1]);
    if (spawn && log.success) {
      const prompt = item.detail.type === "sub_agent" ? item.detail.description ?? "" : "";
      return { items: [{ type: "plugin" as const, kind: "pi-work-status", version: 1, data: { kind: "Subagent", id: spawn[1]!, title: spawn[2]!, status: "running", description: prompt.slice(0, 240), activity: "Background", metric: "", liveLog: log.data } }] };
    }
  }
  return text === undefined ? undefined : replacement(text, typeof item.metadata?.customType === "string");
};

const laneSchema = z.object({
  id: z.string(), alias: z.string().optional(), agent: z.string(), task: z.string(),
  status: z.enum(["running", "failed", "aborted"]),
  errorMessage: z.string().optional(),
  result: z.object({ details: z.object({ status: z.string(), errorMessage: z.string().optional() }) }).optional(),
  progress: z.object({ completedTools: z.number(), activeTool: z.string().optional(), phase: z.string() }).optional(),
});

/** Failed task inspection has no answer to preserve; successful answers stay native. */
export const transformTaskInspection: PluginTimelineTransformerContribution<"tool_call">["transform"] = ({ item, phase }) => {
  if (phase !== "complete" || item.name !== "subagent_tasks" || item.detail.type !== "unknown") return;
  const input = z.object({ action: z.enum(["list", "show", "wait"]) }).safeParse(item.detail.input);
  if (!input.success) return;
  const output = item.detail.output;
  if (!output || typeof output !== "object") return;
  const details = Reflect.get(output, "details");
  const lanes = z.array(laneSchema).safeParse(Array.isArray(details) ? details : [details]);
  if (!lanes.success || lanes.data.length === 0) return;
  const items = [];
  for (const lane of lanes.data) {
    if (lane.result?.details.status === "completed") return;
    if (input.data.action === "wait" && lane.status === "running" && !lane.result) return;
    const reason = lane.errorMessage ?? lane.result?.details.errorMessage ?? lane.progress?.activeTool ?? lane.progress?.phase ?? "";
    const data = workStatusSchema.safeParse({ kind: "Subagent", id: lane.id, title: lane.alias ?? lane.agent, status: lane.result?.details.status ?? lane.status, description: lane.task.slice(0, 240), activity: reason.replace(/; its event stream is at [\s\S]*$/u, "").slice(0, 240), metric: `${lane.progress?.completedTools ?? 0} tools completed` });
    if (!data.success) return;
    items.push({ type: "plugin" as const, kind: "pi-work-status", version: 1, data: data.data });
  }
  return { items };
};

/** Read status evidence even when replayed progress is intentionally hidden. */
export function subagentStatuses(item: AgentTimelineItem): WorkStatus[] {
  let data: WorkStatus | undefined;
  if (item.type === "assistant_message") data = parseWorkStatus(item.text);
  else if (item.type === "tool_call") {
    const text = rowText(item);
    data = text ? parseWorkStatus(text) : undefined;
    if (!data) {
      const transformed = transformStatusToolCall({ item, phase: "complete" });
      const first = transformed?.items[0];
      if (first?.type === "plugin") {
        const parsed = workStatusSchema.safeParse(first.data);
        if (parsed.success) data = parsed.data;
      }
    }
    // The notify transport keeps the host update but omits visible status text.
    if (!data && item.metadata?.customType === "subagent-update") {
      const details = z.object({ id: z.string(), nativeStatus: z.enum(["running", "completed", "failed", "aborted"]) }).safeParse(item.metadata.details);
      if (details.success) data = { kind: "Subagent" as const, id: details.data.id, status: details.data.nativeStatus, title: "", description: "", activity: details.data.nativeStatus, metric: "" };
    }
    if (!data) {
      const transformed = transformTaskInspection({ item, phase: "complete" });
      return (transformed?.items ?? []).flatMap(row => {
        const parsed = row.type === "plugin" ? workStatusSchema.safeParse(row.data) : undefined;
        return parsed?.success && parsed.data.kind === "Subagent" ? [parsed.data] : [];
      });
    }
  }
  return data?.kind === "Subagent" ? [data] : [];
}
