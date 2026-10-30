// Paseo 0.11 AgentStreamView.streamItemWrapper and ToolCallMessage styles.
// The public plugin theme exposes colors only; keep the host's default layout
// tokens here until its SDK exposes appearance metrics as well.

/** Horizontal padding of the timeline rail. */
export const RAIL_PADDING = 16;
/** Horizontal padding of the centred content column inside the rail. */
export const COLUMN_PADDING = 8;
/** Widest the content column ever gets. */
export const COLUMN_MAX_WIDTH = 820;
/**
 * How far the host's own tool row is inset from the rail's edge.
 *
 * Not exposed by the 0.11 SDK, so it is measured rather than derived. It is the
 * only number here that a host upgrade can invalidate.
 */
const HOST_ROW_INSET = 21;

/**
 * How far a card reaches past the column to line up with the host's tool rows.
 *
 * The difference of the two paddings, not a spacing choice: the host's row is
 * inset further than this column, and a card that does not reach the same text
 * edge looks foreign next to the host's own rows.
 *
 * Note the consequence, which is why the derivation is spelled out: a negative
 * margin widens the card, so its outer width is the column's *content* width
 * plus twice this value. That is only safe while the column is narrower than the
 * rail leaves room for — at `COLUMN_MAX_WIDTH` there is slack, and on a narrow
 * pane there is none, where the card extends past the rail and produces a
 * horizontal scrollbar. `native-timeline-style.test.ts` pins the arithmetic;
 * fixing the narrow case needs a width the item props do not carry.
 */
const HOST_EDGE_COMPENSATION = COLUMN_PADDING - HOST_ROW_INSET;

export const nativeTimelineStyle = {
  rail: { paddingHorizontal: RAIL_PADDING, paddingVertical: 16 },
  column: { width: "100%" as const, maxWidth: COLUMN_MAX_WIDTH, alignSelf: "center" as const, paddingHorizontal: COLUMN_PADDING, minWidth: 0 },
  activity: { minWidth: 0, marginHorizontal: HOST_EDGE_COMPENSATION },
  header: { flexDirection: "row" as const, alignItems: "center" as const, borderRadius: 8, borderWidth: 1, borderColor: "transparent", paddingHorizontal: 8, paddingVertical: 4, overflow: "hidden" as const },
  iconBadge: { width: 22, height: 22, marginRight: 4, alignItems: "center" as const, justifyContent: "center" as const, flexShrink: 0 },
  icon: { marginLeft: -1 },
  label: { fontSize: 14, fontWeight: "normal" as const, flexShrink: 0 },
  secondary: { fontSize: 14, fontWeight: "normal" as const, marginLeft: 8, flexShrink: 1, minWidth: 0 },
  details: { borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, overflow: "hidden" as const, minWidth: 0 },
};
