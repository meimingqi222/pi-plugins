import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { nativeTimelineStyle as styles } from "./native-timeline-style.ts";
import type { LiveOutput } from "../shared/live-output.ts";

type Block = LiveOutput["blocks"][number];
type Colors = { foreground: string; foregroundMuted: string; surface1: string; border: string; statusDanger: string };

// The public SDK does not expose the host timeline renderer. Keep this adapter
// limited to its disclosure-row convention rather than a separate log UI.
function toolSummary(block: Block): { label: string; icon: string; preview: string } {
  const name = block.name || "Tool";
  const tools: Record<string, [string, string]> = {
    bash: ["Shell", "SquareTerminal"], read: ["Read", "Eye"],
    write: ["Write", "Pencil"], edit: ["Edit", "Pencil"],
    grep: ["Search", "Search"], find: ["Find", "Search"], ls: ["List", "Wrench"],
    subagent: ["Subagent tasks", "Wrench"], subagent_tasks: ["Subagent tasks", "Wrench"],
  };
  const [label, icon] = tools[name] ?? [name, "Wrench"];
  let preview = block.text.startsWith(`${name} `) ? block.text.slice(name.length + 1) : block.text === name ? "" : block.text;
  try {
    const args: unknown = JSON.parse(preview);
    if (args && typeof args === "object") {
      const values = args as Record<string, unknown>;
      const summary = values.command ?? values.path ?? values.pattern ?? values.task;
      if (typeof summary === "string") preview = summary;
      else if (Object.keys(values).length === 0) preview = "";
    }
  } catch { /* Bounded argument previews may end midway through JSON. */ }
  return { label, icon, preview: preview.replace(/\s+/g, " ").trim() };
}

function ActivityRow({ block, colors }: { block: Block; colors: Colors }) {
  // Follow execution by default, but respect a user's explicit disclosure choice
  // across polling updates. Completion collapses an untouched running row.
  const [override, setOverride] = useState<boolean>();
  const running = block.kind === "tool" && (block.live || block.result === undefined);
  const expanded = override ?? Boolean(running || block.isError);
  const { label, icon, preview } = block.kind === "thinking"
    ? { label: "Thinking", icon: "Brain", preview: "" }
    : toolSummary(block);
  const color = block.isError ? colors.statusDanger : expanded ? colors.foreground : colors.foregroundMuted;
  return <View style={styles.activity}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label}`} accessibilityState={{ expanded }} onPress={() => setOverride(!expanded)} style={{ ...styles.header, ...(expanded ? { backgroundColor: colors.surface1, borderColor: colors.border, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {}) }}>
      <View style={styles.iconBadge}><View style={styles.icon}><Icon name={expanded ? "ChevronDown" : block.isError ? "CircleAlert" : icon} size={12} color={color} /></View></View>
      <Text style={{ ...styles.label, color }}>{label}</Text>
      {preview ? <Text numberOfLines={1} ellipsizeMode="tail" style={{ ...styles.secondary, color }}>{preview}</Text> : null}
    </Pressable>
    {expanded ? <View style={{ ...styles.details, borderColor: colors.border, padding: 12, gap: 8 }}>
      <Text selectable style={{ fontSize: 13, lineHeight: 20, color: colors.foregroundMuted, ...(block.kind === "tool" ? { fontFamily: "monospace" } : {}) }}>{block.text}</Text>
      {block.result !== undefined ? <Text selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 18, color: block.isError ? colors.statusDanger : colors.foregroundMuted }}>{block.result}</Text> : null}
    </View> : null}
  </View>;
}

export function LiveTimeline({ blocks, colors }: { blocks: Block[]; colors: Colors }) {
  return <View style={styles.column}>
    {blocks.map((block) => block.kind === "thinking" || block.kind === "tool"
      ? <ActivityRow key={block.id} block={block} colors={colors} />
      : <Text key={block.id} selectable style={{ fontSize: 14, lineHeight: 22, paddingVertical: 8, marginVertical: 4, color: block.kind === "error" ? colors.statusDanger : block.kind === "note" ? colors.foregroundMuted : colors.foreground }}>{block.text}</Text>)}
  </View>;
}
