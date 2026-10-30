// Paseo 0.11 AgentStreamView.streamItemWrapper and ToolCallMessage styles.
/**
 * How far this card must reach past the timeline column to line up with the
 * host's own tool rows. Derived, not chosen: see the note on `activity`.
 */
const HOST_EDGE_COMPENSATION = -13;
// The public plugin theme exposes colors only; keep the host's default layout
// tokens here until its SDK exposes appearance metrics as well.
export const nativeTimelineStyle = {
  rail: { paddingHorizontal: 16, paddingVertical: 16 },
  column: { width: "100%" as const, maxWidth: 820, alignSelf: "center" as const, paddingHorizontal: 8, minWidth: 0 },
  // Not a spacing choice: the host's own tool row is inset further than this
  // timeline column, and the card has to reach the same text edge as the host's
  // rows to look native. The value is the difference between those two
  // paddings, so it moves when either does — there is exactly one place to
  // update, and it overflows horizontally on a narrow pane the moment it is
  // wrong. Revisit when the host exposes its row padding.
  activity: { minWidth: 0, marginHorizontal: HOST_EDGE_COMPENSATION },
  header: { flexDirection: "row" as const, alignItems: "center" as const, borderRadius: 8, borderWidth: 1, borderColor: "transparent", paddingHorizontal: 8, paddingVertical: 4, overflow: "hidden" as const },
  iconBadge: { width: 22, height: 22, marginRight: 4, alignItems: "center" as const, justifyContent: "center" as const, flexShrink: 0 },
  icon: { marginLeft: -1 },
  label: { fontSize: 14, fontWeight: "normal" as const, flexShrink: 0 },
  secondary: { fontSize: 14, fontWeight: "normal" as const, marginLeft: 8, flexShrink: 1, minWidth: 0 },
  details: { borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, overflow: "hidden" as const, minWidth: 0 },
};
