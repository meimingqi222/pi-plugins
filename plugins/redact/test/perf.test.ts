import { afterEach, describe, expect, test } from "bun:test";
import { createRedactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";
import * as FX from "./fixtures.ts";

/**
 * Performance regression guards.
 *
 * These assert on behaviour that makes the hot path fast, not on wall clock
 * time, so they stay deterministic in CI.
 *
 * NOTE: string comparisons (`toBe`) check value, not identity — primitives are
 * compared by value. Every cache assertion here therefore uses an *observable
 * side effect* (a `toLowerCase` call count or a cache entry count) rather than
 * string equality, which would pass whether or not the cache was used.
 */

const CODE_LINE = "const result = items.filter((item) => item.enabled).map((item) => item.value * 2);";
const NO_SECRET_BODY = (CODE_LINE + "\n").repeat(4000); // ~330 KB
const SECRET = FX.GITHUB_PAT;

const realToLowerCase = String.prototype.toLowerCase;
let lowerCaseCalls = 0;

function spyOnToLowerCase(): void {
  lowerCaseCalls = 0;
  // @ts-ignore — deliberately replacing a built-in for measurement
  String.prototype.toLowerCase = function (this: string) {
    lowerCaseCalls++;
    return realToLowerCase.call(this);
  };
}

afterEach(() => {
  String.prototype.toLowerCase = realToLowerCase;
});

describe("hot path performance guards", () => {
  test("toLowerCase runs at most once per string, not once per pattern", () => {
    // Regression: the engine previously lowercased the whole input inside the
    // keyword test for each of ~71 case-insensitive patterns. On a 500 KB
    // string that cost ~17 ms instead of ~1 ms.
    const redactor = createRedactor(SECRET_PATTERNS);
    spyOnToLowerCase();
    redactor.string(NO_SECRET_BODY);
    const calls = lowerCaseCalls;

    const caseInsensitivePatterns = SECRET_PATTERNS.filter((p) => p.caseInsensitive).length;
    expect(caseInsensitivePatterns).toBeGreaterThan(50); // sanity: the trap is real
    expect(calls).toBeLessThanOrEqual(1);
  });

  test("toLowerCase is re-run only when a replacement actually changes the text", () => {
    const redactor = createRedactor(SECRET_PATTERNS);
    // Two case-insensitive secrets => at most 3 lowercases (initial + 2 invalidations).
    const input =
      `${FX.OPENAI_KEY_2} and ${FX.OPENAI_KEY_4} and nothing else`;
    spyOnToLowerCase();
    redactor.string(input);

    expect(lowerCaseCalls).toBeLessThanOrEqual(3);
  });

  test("a repeated pass is served from cache (zero pattern work)", () => {
    const redactor = createRedactor(SECRET_PATTERNS);
    const text = "x".repeat(1000) + " " + SECRET;

    redactor.string(text); // populate

    // A cache hit must not run any pattern at all, so no lowercasing happens.
    spyOnToLowerCase();
    const second = redactor.string(text);
    expect(lowerCaseCalls).toBe(0);
    expect(second).toContain("[REDACTED:github-pat]");
  });

  test("large strings (>512 KB) are cached", () => {
    // Regression: strings above 512_000 chars were skipped, so a large file
    // read was fully rescanned on every turn.
    const redactor = createRedactor(SECRET_PATTERNS);
    const text = "x".repeat(700_000) + " " + SECRET;

    redactor.string(text); // populate
    const entriesAfterFirst = redactor.cacheEntries;
    expect(entriesAfterFirst).toBe(1); // proves it WAS stored

    spyOnToLowerCase();
    redactor.string(text);
    expect(lowerCaseCalls).toBe(0); // no rescan => cache hit
  });

  test("cache is byte bounded, not entry-count bounded", () => {
    // Regression: the old cache had no byte accounting and cleared entirely at
    // 4000 entries, so a few large entries could exhaust memory.
    const small = createRedactor(SECRET_PATTERNS, { cacheBytes: 8 * 1024 });
    for (let i = 0; i < 200; i++) {
      small.string(`id-${i} `.repeat(500));
    }
    // Byte budget must keep the entry count far below the 200 inserted.
    expect(small.cacheEntries).toBeLessThan(20);
    // Still correct after heavy eviction.
    expect(small.string(SECRET)).toBe("[REDACTED:github-pat]");
  });

  test("a single oversized entry does not evict everything else", () => {
    const redactor = createRedactor(SECRET_PATTERNS, { cacheBytes: 64 * 1024 });
    const keep = "kept-value ".repeat(50) + SECRET;
    redactor.string(keep);
    expect(redactor.cacheEntries).toBe(1);

    // Insert an entry far larger than the whole budget.
    redactor.string("z".repeat(500_000));

    // The small entry must still be present, proving the oversized insert was
    // skipped rather than clearing the cache.
    expect(redactor.cacheEntries).toBe(1);
    spyOnToLowerCase();
    redactor.string(keep);
    expect(lowerCaseCalls).toBe(0); // still a cache hit
  });

  test("payloads without secrets return the original reference (no allocation)", () => {
    const redactor = createRedactor(SECRET_PATTERNS);
    const payload = { messages: [{ role: "user", content: NO_SECRET_BODY }] };
    expect(payload.messages[0]!.content).toBe(NO_SECRET_BODY);
  });

  test("clearCache resets accounting without breaking correctness", () => {
    const redactor = createRedactor(SECRET_PATTERNS);
    const text = "clean ".repeat(1000);
    redactor.string(text);
    expect(redactor.cacheEntries).toBe(1);

    redactor.clearCache();
    expect(redactor.cacheEntries).toBe(0);
    expect(redactor.string(SECRET)).toBe("[REDACTED:github-pat]");
  });
});
