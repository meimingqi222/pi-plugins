import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { LiveOutput } from "../shared/live-output.ts";
import { liveLogSchema } from "../shared/work-status.ts";
import { pollLiveOutput } from "./live-poll.ts";
import { nativeTimelineStyle } from "./native-timeline-style.ts";
import { LiveTimeline } from "./live-timeline.tsx";

export type LiveScreenProps = PluginScreenProps & { read: (log: string, options?: { all?: boolean }) => Promise<LiveOutput> };

type HistoryControlsProps = {
  output?: LiveOutput;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  colors: { foreground: string; foregroundMuted: string; surface1: string; border: string };
};

export function HistoryControls({ output, expanded, onExpandedChange, colors }: HistoryControlsProps) {
  if (!output || (!expanded && !output.earlierDataOmitted)) return null;
  let message = "Earlier output omitted";
  if (expanded) {
    message = `Showing extended history (${output.blocks.length} items)`;
    if (output.earlierDataOmitted) message = "History display limit reached; older output is still omitted.";
  }
  const action = expanded ? "Show recent only" : "Show more history";
  return <View style={{ alignItems: "center", paddingVertical: 10, gap: 6 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{message}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={action} onPress={() => onExpandedChange(!expanded)} style={{ paddingVertical: 4, paddingHorizontal: 12, borderRadius: 4, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ fontSize: 12, color: colors.foreground }}>{action}</Text>
    </Pressable>
  </View>;
}

export function LiveScreen({ theme, params, layout, navigation, read }: LiveScreenProps) {
  const [output, setOutput] = useState<LiveOutput>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [follow, setFollow] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const valid = liveLogSchema.safeParse(params.log);
  const log = valid.success ? valid.data : undefined;
  const previousLog = useRef(log);
  useEffect(() => {
    if (previousLog.current !== log) {
      setOutput(undefined);
      previousLog.current = log;
    }
    setError(undefined);
    if (!log) return;
    return pollLiveOutput(() => read(log, { all: showAll }), value => {
      setOutput(previous => previous?.revision === value.revision && previous?.state === value.state ? previous : value);
      setError(undefined);
    }, () => setError("Output connection unavailable"));
  }, [log, read, retry, showAll]);
  const colors = theme.colors;
  const successColor = (colors as unknown as Record<string, string>).statusSuccess ?? "#10b981";
  return <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.surface0 }}>
    <View style={{
      paddingHorizontal: layout.compact ? 12 : 20,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderColor: colors.border,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: 48,
      gap: 12,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0, gap: 10 }}>
        {navigation && params.agentId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to conversation"
            onPress={() => navigation.openAgent({ agentId: params.agentId! })}
            hitSlop={8}
            style={{ alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="ArrowLeft" size={18} color={colors.foreground} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "600", color: colors.foreground, lineHeight: 20 }}>
            {params.title || "Subagent"}
          </Text>
          {params.id ? (
            <Text numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 11, color: colors.foregroundMuted, marginTop: 1 }}>
              {params.id}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: layout.compact ? 8 : 12, flexShrink: 0 }}>
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 12,
          backgroundColor: error ? `${colors.statusDanger}15` : `${successColor}18`,
        }}>
          <View style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: error ? colors.statusDanger : successColor,
          }} />
          <Text style={{
            fontSize: 12,
            fontWeight: "500",
            color: error ? colors.statusDanger : successColor,
          }}>
            {error ? "Reconnecting" : "Following output"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Switch
            accessibilityLabel="Auto-scroll"
            value={follow}
            onValueChange={setFollow}
            trackColor={{ false: colors.border, true: successColor }}
          />
          {!layout.compact ? (
            <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>Auto-scroll</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh output"
          onPress={() => setRetry(value => value + 1)}
          hitSlop={8}
          style={{ alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="RefreshCw" size={15} color={colors.foregroundMuted} />
        </Pressable>
      </View>
    </View>
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={nativeTimelineStyle.rail} onContentSizeChange={() => { if (follow) scroll.current?.scrollToEnd({ animated: false }); }}>
      <View style={nativeTimelineStyle.column}>
      {!log ? <Text style={{ color: colors.statusDanger }}>Invalid transcript reference</Text> : !output || output.blocks.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{!output ? "Connecting..." : "Waiting for subagent output..."}</Text> : null}
      {output?.prompt ? <View style={{ backgroundColor: colors.surface1, borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: 14, marginVertical: 8 }}>
        <Text selectable style={{ fontSize: 13, lineHeight: 20, color: colors.foreground }}>{output.prompt}</Text>
        {output.promptTruncated ? <Text style={{ fontSize: 12, color: colors.foregroundMuted, marginTop: 8 }}>Task prompt truncated</Text> : null}
      </View> : null}
      <HistoryControls output={output} expanded={showAll} onExpandedChange={setShowAll} colors={colors} />
      </View>
      {output ? <LiveTimeline blocks={output.blocks} colors={colors} /> : null}
    </ScrollView>
  </View>;
}
