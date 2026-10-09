import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkStatus } from "../shared/work-status.ts";
import { nativeTimelineStyle as styles } from "./native-timeline-style.ts";

const statusLabels: Record<WorkStatus["status"], string> = {
  running: "Running", completed: "Completed", failed: "Failed", aborted: "Cancelled",
  exited: "Completed", timedout: "Timed out", killed: "Stopped", interrupted: "Interrupted",
  active: "Active", paused: "Paused", verifying: "Verifying", complete: "Completed",
  budget_limited: "Budget reached", blocked: "Blocked", no_progress: "No progress",
};
const tools: Record<WorkStatus["kind"], { label: string; icon: string }> = {
  Bash: { label: "Shell", icon: "SquareTerminal" },
  Subagent: { label: "Subagent", icon: "Wrench" },
  Workflow: { label: "Workflow", icon: "Wrench" },
  Goal: { label: "Goal", icon: "Wrench" },
};

export function WorkCard({ item, theme, onOpen, latest }: PluginTimelineItemProps<WorkStatus> & { onOpen?: () => void; latest?: WorkStatus }) {
  const original = item.data;
  const work = original.kind === "Subagent" && latest?.kind === "Subagent" && latest.id === original.id
    ? { ...original, status: latest.status, activity: latest.activity, metric: latest.metric, liveLog: latest.liveLog ?? original.liveLog }
    : original;
  const failed = ["failed", "timedout", "blocked", "no_progress"].includes(work.status);
  const [override, setOverride] = useState<boolean>();
  const expanded = override ?? failed;
  const { colors } = theme;
  const active = ["running", "active", "verifying"].includes(work.status);
  const color = failed ? colors.statusDanger : expanded || active ? colors.foreground : colors.foregroundMuted;
  const bash = work.kind === "Bash";
  const title = bash && work.title === "(restored job)" ? "Background job" : work.title;
  const description = bash && work.description === "Background command" ? "" : work.description;
  let activity = work.activity;
  if (bash) {
    if (activity === "exit unknown" || activity === "running" || (["completed", "exited"].includes(work.status) && activity === "exit 0")) activity = "";
    else activity = activity.replace(/^exit (-?\d+)$/u, "Exit code $1");
  }
  const tool = tools[work.kind];
  const canOpen = Boolean(work.liveLog && onOpen);
  return <View style={styles.activity}>
    <View style={{ ...styles.header, ...(expanded ? { backgroundColor: colors.surface1, borderColor: colors.border, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {}) }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${tool.label}: ${title}`} accessibilityState={{ expanded }} onPress={() => setOverride(!expanded)} style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
        <View style={styles.iconBadge}><View style={styles.icon}><Icon name={expanded ? "ChevronDown" : failed ? "CircleAlert" : tool.icon} size={12} color={color} /></View></View>
        <Text style={{ ...styles.label, color, ...(active ? { opacity: 0.72 } : {}) }}>{tool.label}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{ ...styles.secondary, color }}>{title.replace(/\s+/gu, " ")}</Text>
        <Text style={{ fontSize: 12, fontWeight: "normal", color: failed ? colors.statusDanger : colors.foregroundMuted, marginLeft: 8, flexShrink: 0 }}>{statusLabels[work.status]}</Text>
      </Pressable>
      {canOpen ? <Pressable accessibilityRole="button" accessibilityLabel={`Open subagent output: ${title}`} onPress={onOpen} hitSlop={8} style={{ width: 24, height: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name="SquareTerminal" size={12} color={colors.foregroundMuted} />
      </Pressable> : null}
    </View>
    {expanded ? <View style={{ ...styles.details, borderColor: colors.border, padding: 12, gap: 8 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 20, ...(bash ? { fontFamily: "monospace" } : {}) }}>{title}</Text>
      {description && description !== title ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{description}</Text> : null}
      {activity ? <Text selectable style={{ color: failed ? colors.statusDanger : colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{activity}</Text> : null}
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{[work.id, work.metric].filter(Boolean).join(" · ")}</Text>
    </View> : null}
  </View>;
}
