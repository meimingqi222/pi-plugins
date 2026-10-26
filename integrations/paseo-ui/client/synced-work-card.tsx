import { useCallback, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";
import { WorkCard } from "./work-card.tsx";
import type { TaskStatusStore } from "./task-status-store.ts";

export function SyncedWorkCard({ store, ...props }: ComponentProps<typeof WorkCard> & { store: TaskStatusStore }) {
  const { agentId, item } = props;
  const subscribe = useCallback((changed: () => void) => item.data.kind === "Subagent" ? store.subscribe(agentId, changed) : () => {}, [store, agentId, item.data.kind]);
  const snapshot = useCallback(() => store.get(agentId, item.data.id), [store, agentId, item.data.id]);
  const sourceSnapshot = useCallback(() => store.getCardSource(agentId, item.data.id), [store, agentId, item.data.id]);
  const latest = useSyncExternalStore(subscribe, snapshot, snapshot);
  const source = useSyncExternalStore(subscribe, sourceSnapshot, sourceSnapshot);
  if (item.data.kind === "Subagent" && item.data.source && source && item.data.source !== source) return null;
  return <WorkCard {...props} latest={latest} />;
}
