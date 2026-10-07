import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import { parseWorkStatus, workStatusSchema } from "../shared/work-status.ts";

function replacement(text: string) {
  const data = parseWorkStatus(text);
  if (!data) return;
  return { items: [{ type: "plugin" as const, kind: "pi-work-status", version: 1, data }] };
}

export const transformStatusMessage: PluginTimelineTransformerContribution<"assistant_message">["transform"] = ({ item, phase }) => {
  if (phase !== "complete") return;
  return replacement(item.text);
};

export const transformStatusNotification: PluginTimelineTransformerContribution<"notification">["transform"] = ({ item }) => replacement(item.message);

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
