import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { LiveOutput } from "../shared/live-output.ts";
import { liveLogSchema } from "../shared/work-status.ts";
import { pollLiveOutput } from "./live-poll.ts";
import { nativeTimelineStyle } from "./native-timeline-style.ts";
import { LiveTimeline } from "./live-timeline.tsx";

export type LiveScreenProps = PluginScreenProps & { read: (log: string) => Promise<LiveOutput> };

export function LiveScreen({ theme, params, layout, navigation, read }: LiveScreenProps) {
  const [output, setOutput] = useState<LiveOutput>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [follow, setFollow] = useState(true);
  const scroll = useRef<ScrollView>(null);
  const valid = liveLogSchema.safeParse(params.log);
  const log = valid.success ? valid.data : undefined;
  useEffect(() => {
    setOutput(undefined);
    setError(undefined);
    if (!log) return;
    return pollLiveOutput(() => read(log), value => {
      setOutput(previous => previous?.revision === value.revision && previous?.state === value.state ? previous : value);
      setError(undefined);
    }, () => setError("Output connection unavailable"));
  }, [log, read, retry]);
  const colors = theme.colors;
  const iconButton = { padding: 8, borderRadius: 4, minWidth: 36, minHeight: 36, alignItems: "center" as const, justifyContent: "center" as const };
  return <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.surface0 }}>
    <View style={{ padding: layout.compact ? 12 : 20, gap: 10, borderBottomWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {navigation && params.agentId ? <Pressable accessibilityRole="button" accessibilityLabel="Back to conversation" onPress={() => navigation.openAgent({ agentId: params.agentId! })} style={iconButton}><Icon name="ArrowLeft" size={18} color={colors.foregroundMuted} /></Pressable> : null}
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: colors.foreground }}>{params.title || "Subagent output"}</Text>
          <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>{params.id || "Subagent"}</Text>
        </View>
        <Text style={{ fontSize: 12, color: error ? colors.statusDanger : colors.accent }}>{error ? "Reconnecting" : "Following output"}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Switch accessibilityLabel="Follow output" value={follow} onValueChange={setFollow} />
        <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>Follow output</Text>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh output" onPress={() => setRetry(value => value + 1)} style={iconButton}><Icon name="RefreshCw" size={16} color={colors.foregroundMuted} /></Pressable>
      </View>
      {error ? <Text style={{ fontSize: 12, color: colors.statusDanger }}>{error}</Text> : null}
    </View>
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={nativeTimelineStyle.rail} onContentSizeChange={() => { if (follow) scroll.current?.scrollToEnd({ animated: false }); }}>
      <View style={nativeTimelineStyle.column}>
      {!log ? <Text style={{ color: colors.statusDanger }}>Invalid transcript reference</Text> : !output || output.blocks.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{!output ? "Connecting..." : "Waiting for subagent output..."}</Text> : null}
      {output?.earlierDataOmitted ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Earlier output omitted</Text> : null}
      </View>
      {output ? <LiveTimeline blocks={output.blocks} colors={colors} /> : null}
    </ScrollView>
  </View>;
}
