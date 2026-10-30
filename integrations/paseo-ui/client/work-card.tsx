import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkState, WorkStatus } from "../shared/work-status.ts";
import { nativeTimelineStyle as styles } from "./native-timeline-style.ts";

/**
 * The seven states the terminal already renders, so a card and the fleet row
 * for the same child say the same word.
 *
 * Each raw status lands in exactly one bucket; the terminal glyph for it is the
 * one `WORK_ICONS` maps to the same bucket. A `WorkStatus` that is none of
 * these falls through to `running`, which is the only state that must never be
 * claimed falsely in the other direction: showing work as finished when it is
 * not is the failure that costs the user something.
 */
const STATUS_TO_WORK: Record<WorkStatus["status"], WorkState> = {
  running: "running", active: "running", verifying: "running",
  paused: "idle",
  timedout: "stalled", no_progress: "stalled",
  completed: "succeeded", complete: "succeeded", exited: "succeeded",
  failed: "failed", blocked: "failed", budget_limited: "failed",
  aborted: "stopped", killed: "stopped", interrupted: "stopped",
};

const WORK_LABELS: Record<WorkState, string> = {
  queued: "Queued",
  running: "Running",
  idle: "Idle",
  stalled: "Stalled",
  succeeded: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function workStateOf(status: WorkStatus["status"]): WorkState {
  return STATUS_TO_WORK[status] ?? "running";
}
const tools: Record<WorkStatus["kind"], { label: string; icon: string }> = {
  Bash: { label: "Shell", icon: "SquareTerminal" },
  Subagent: { label: "Subagent", icon: "Bot" },
  Workflow: { label: "Workflow", icon: "GitMerge" },
  Goal: { label: "Goal", icon: "Target" },
};

export function WorkCard({ item, theme, onOpen, latest }: PluginTimelineItemProps<WorkStatus> & { onOpen?: () => void; latest?: WorkStatus }) {
  const original = item.data;
  const work = original.kind === "Subagent" && latest?.kind === "Subagent" && latest.id === original.id
    ? { ...original, status: latest.status, activity: latest.activity, metric: latest.metric, liveLog: latest.liveLog ?? original.liveLog }
    : original;
  const failed = ["failed", "timedout", "blocked", "no_progress"].includes(work.status);
  const [override, setOverride] = useState<boolean>(false);
  // Collapsed by default, failures included. A row of consecutive failures all
  // springing open is an information avalanche that pushes earlier context off
  // the timeline; the failure gets a one-line summary instead.
  const expanded = override;
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
        {/* The tool's own icon stays put. Replacing it with the disclosure chevron on
            expand erased the one cue that says whether this row is Shell,
            Subagent, Workflow or Goal. */}
        <View style={styles.iconBadge}><View style={styles.icon}><Icon name={tool.icon} size={12} color={color} /></View></View>
        <Text style={{ ...styles.label, color, ...(active ? { opacity: 0.72 } : {}) }}>{tool.label}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{ ...styles.secondary, color }}>{title.replace(/\s+/gu, " ")}</Text>
        <Text style={{ fontSize: 12, fontWeight: "normal", color: failed ? colors.statusDanger : colors.foregroundMuted, marginLeft: 8, flexShrink: 0 }}>{WORK_LABELS[workStateOf(work.status)]}</Text>
        <View style={{ width: 16, alignItems: "center", flexShrink: 0 }}>
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
        </View>
      </Pressable>
      {canOpen ? <Pressable accessibilityRole="button" accessibilityLabel={`Open subagent output: ${title}`} onPress={onOpen} hitSlop={8} style={{ width: 24, height: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name="SquareTerminal" size={12} color={colors.foregroundMuted} />
      </Pressable> : null}
    </View>
    {failed && !expanded && activity ? <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.statusDanger, fontSize: 12, paddingHorizontal: 8, paddingBottom: 4 }}>{activity}</Text> : null}
    {expanded ? <View style={{ ...styles.details, borderColor: colors.border, padding: 12, gap: 8 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 20, ...(bash ? { fontFamily: "monospace" } : {}) }}>{title}</Text>
      {description && description !== title ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{description}</Text> : null}
      {activity ? <Text selectable style={{ color: failed ? colors.statusDanger : colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{activity}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
          <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>ID: {work.id}</Text>
          {work.metric ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>Usage: {work.metric}</Text> : null}
        </View>
    </View> : null}
  </View>;
}
