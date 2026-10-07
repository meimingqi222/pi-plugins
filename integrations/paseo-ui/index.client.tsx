import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkCard } from "./client/work-card.tsx";
import { transformStatusMessage, transformStatusNotification, transformTaskInspection } from "./client/transform-status.ts";
import { workStatusSchema } from "./shared/work-status.ts";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({ id: "pi-work-message", query: { itemType: "assistant_message" }, transform: transformStatusMessage });
  client.addTimelineTransformer({ id: "pi-work-notification", query: { itemType: "notification" }, transform: transformStatusNotification });
  client.addTimelineTransformer({ id: "pi-task-inspection", query: { itemType: "tool_call" }, transform: transformTaskInspection });
  client.addTimelineRenderer({ kind: "pi-work-status", version: 1, schema: workStatusSchema, Component: WorkCard });
  return () => {};
}
