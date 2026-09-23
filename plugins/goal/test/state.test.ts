import { describe, expect, test } from "bun:test";
import { nextActionKey } from "../src/state.ts";

/**
 * The fingerprint decides whether two verifier rounds asked for the same work.
 *
 * It is only useful if it is *stable* across the tokens that change every
 * attempt (a scratch path, a generated id) and *sensitive* to the tokens that
 * name different work. Both directions are bugs: too sensitive and the stall
 * guard never fires, too lossy and genuine progress looks like a stall.
 */
describe("next action fingerprint", () => {
  const folds = (label: string) => {
    const variants = [
      `Fix the failing test in ${label}`,
      `Fix the failing test in ${label.replace(/[a-z0-9]+$/, "ffffffffffff")}`,
    ];
    return new Set(variants.map(nextActionKey)).size === 1;
  };

  test("a per-attempt scratch path folds to one fingerprint", () => {
    // The path embeds a per-attempt id, so the raw text differs every round.
    // Left alone, the stall guard would never trip and only the run cap would stop a stuck goal.
    expect(folds("/tmp/grok-goal-a1b2c3d4e5f6/out.log")).toBe(true);
    expect(folds("/private/tmp/grok-goal-a1b2c3d4e5f6/out.log")).toBe(true);
    expect(folds("/var/folders/ab/cdef1234/T/goal-x/out.log")).toBe(true);
  });

  test("a uuid or generated id folds to one fingerprint", () => {
    expect(nextActionKey("Check 550e8400-e29b-41d4-a716-446655440000"))
      .toBe(nextActionKey("Check 550e8400-e29b-41d4-a716-446655440001"));
    expect(nextActionKey("Verify commit deadbeef1234"))
      .toBe(nextActionKey("Verify commit 0f1e2d3c4b5a"));
  });

  test("plain integers and line numbers still distinguish work", () => {
    // Folding every digit would collapse genuinely different steps and make a
    // progressing goal look stalled.
    expect(nextActionKey("Run test 3 to confirm")).not.toBe(nextActionKey("Run test 4 to confirm"));
    expect(nextActionKey("fix src/a.ts:41")).not.toBe(nextActionKey("fix src/a.ts:42"));
    expect(nextActionKey("continue from step 1")).not.toBe(nextActionKey("continue from step 2"));
  });

  test("ordinary words are not mistaken for ids", () => {
    // Short hex-looking words are real English; only 12+ hex chars fold.
    expect(nextActionKey("run the decaf test")).not.toBe(nextActionKey("run the facade test"));
    expect(nextActionKey("check the defaced output")).not.toBe(nextActionKey("check the facade output"));
  });

  test("a reworded request with a different action stays distinct", () => {
    expect(nextActionKey("Run the remaining test")).not.toBe(nextActionKey("Rewrite the parser"));
  });

  test("case, punctuation and whitespace still fold", () => {
    expect(nextActionKey("Run  the remaining TEST!")).toBe(nextActionKey("run the remaining test"));
  });
});
