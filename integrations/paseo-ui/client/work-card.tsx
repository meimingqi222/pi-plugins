import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { WorkStatus } from "../shared/work-status.ts";

export function WorkCard({ item, theme }: PluginTimelineItemProps<WorkStatus>) {
  const work = item.data;
  const failed = ["failed", "timedout", "blocked", "no_progress"].includes(work.status);
  const complete = ["completed", "complete", "exited"].includes(work.status);
  let statusColor = theme.colors.foregroundMuted;
  if (failed) statusColor = theme.colors.statusDanger;
  else if (complete) statusColor = theme.colors.statusSuccess;
  else if (["running", "active", "verifying"].includes(work.status)) statusColor = theme.colors.accent;
  return (
    <View accessibilityLabel={`${work.kind} ${work.status}`} style={{ gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, backgroundColor: theme.colors.surface1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <Text accessibilityLabel={work.id} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{work.kind} · {work.id.length > 24 ? `${work.id.slice(0, 11)}…` : work.id}</Text>
        <Text style={{ color: statusColor, fontWeight: "600", fontSize: 12 }}>{work.status.replaceAll("_", " ")}</Text>
      </View>
      <Text selectable style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{work.title}</Text>
      {work.description && work.description !== work.title ? <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{work.description}</Text> : null}
      {work.activity ? <Text selectable style={{ color: failed ? statusColor : theme.colors.foreground, fontSize: 13 }}>{work.activity}</Text> : null}
      {work.metric ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{work.metric}</Text> : null}
    </View>
  );
}
