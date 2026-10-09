import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SyncedWorkCard } from "./client/synced-work-card.tsx";
import { TaskStatusStore } from "./client/task-status-store.ts";
import { transformStatusMessage, transformStatusToolCall, transformTaskInspection } from "./client/transform-status.ts";
import { workStatusSchema } from "./shared/work-status.ts";
import { LiveScreen } from "./client/live-screen.tsx";
import { liveOutputRpc } from "./shared/live-output.ts";

// The app accepts transformers only for a closed set of item types ("notification" is not one of
// them), and a rejected target fails this whole contribution. Status arrives as assistant messages
// on hosts up to 0.11.0 and as synthetic tool rows or a running tool call on later ones; notify
// status stays a native notification row. See the notes
// 2026-10-08-paseo-notification-transformer-allowlist.md and
// 2026-10-08-paseo-status-tool-rows.md.
export default function contribute(client: PluginClientContext) {
  const statuses = new TaskStatusStore(agentId => client.paseo.agents.ref(agentId).timeline);
  const cleanups = [
    client.addTimelineTransformer({ id: "pi-work-message", query: { itemType: "assistant_message" }, transform: transformStatusMessage }),
    client.addTimelineTransformer({ id: "pi-work-status-row", query: { itemType: "tool_call" }, transform: transformStatusToolCall }),
    client.addTimelineTransformer({ id: "pi-task-inspection", query: { itemType: "tool_call" }, transform: transformTaskInspection }),
  ];
  const read = (log: string) => client.rpc(liveOutputRpc, { log });
  const disposeScreen = client.addScreen({ id: "subagent-output", title: "Subagent output", Component: props => <LiveScreen {...props} read={read} /> });
  const disposeRenderer = client.addTimelineRenderer({ kind: "pi-work-status", version: 1, schema: workStatusSchema, Component: props => <SyncedWorkCard {...props} store={statuses} onOpen={props.item.data.liveLog ? () => client.openScreen({ screenId: "subagent-output", params: { log: props.item.data.liveLog!, id: props.item.data.id, title: props.item.data.title, agentId: props.agentId } }) : undefined} /> });
  return () => { statuses.dispose(); disposeScreen(); disposeRenderer(); for (const cleanup of cleanups) cleanup(); };
}
