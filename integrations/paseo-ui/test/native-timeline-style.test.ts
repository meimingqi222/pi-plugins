import { describe, expect, test } from "bun:test";
import {
  COLUMN_MAX_WIDTH,
  COLUMN_PADDING,
  RAIL_PADDING,
  nativeTimelineStyle,
} from "../client/native-timeline-style.ts";

/**
 * The host's tool row is inset further than this timeline column, so a card
 * reaches past the column with a negative margin to share its text edge. That
 * margin is a derived difference, and the arithmetic is what these tests pin:
 * a future edit that moves one padding without the other would otherwise
 * silently misalign every card against the host's own rows.
 */
describe("nativeTimelineStyle", () => {
  test("the compensation is exactly the difference between the two insets", () => {
    // column padding 8, host row inset 21 → the card reaches 13px past the
    // column on each side, which is 21 - 8 in the host's favour.
    expect(nativeTimelineStyle.activity.marginHorizontal).toBe(-13);
    expect(nativeTimelineStyle.activity.marginHorizontal).toBe(COLUMN_PADDING - 21);
  });

  test("the tokens the derivation rests on are the ones in use", () => {
    expect(nativeTimelineStyle.rail.paddingHorizontal).toBe(RAIL_PADDING);
    expect(nativeTimelineStyle.column.paddingHorizontal).toBe(COLUMN_PADDING);
    expect(nativeTimelineStyle.column.maxWidth).toBe(COLUMN_MAX_WIDTH);
  });

  test("a card at the widest column still fits inside the rail", () => {
    // The only regime the compensation is safe in: the column is capped well
    // below what the rail leaves room for, so the overhang has slack.
    const railContent = COLUMN_MAX_WIDTH + 2 * RAIL_PADDING;
    const cardOuter = COLUMN_MAX_WIDTH - 2 * COLUMN_PADDING - 2 * nativeTimelineStyle.activity.marginHorizontal;
    expect(cardOuter).toBeLessThanOrEqual(railContent);
  });
});
