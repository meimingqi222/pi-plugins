import { describe, expect, test } from "bun:test";
import { FORBIDDEN_GLOBALS, GUARD_ERROR_PREFIX, installDeterminismGuards } from "../src/host/sandbox.ts";

/**
 * Build a stand-in global object.
 *
 * The guards take their target as an argument precisely so they can be tested
 * here: mutating the test process's real `globalThis` would break every other
 * test in the file. `Math`'s methods are non-enumerable, so spreading it yields
 * an empty object; the methods are copied explicitly.
 */
function fakeMath(): Record<string, unknown> {
  return { random: Math.random, floor: Math.floor, max: Math.max };
}

function fakeGlobal(): Record<string, unknown> {
  return {
    Date,
    Math: fakeMath(),
    Intl: { DateTimeFormat: Intl.DateTimeFormat },
    process: { pid: 1 },
    require: () => undefined,
    fetch: () => undefined,
    setTimeout: () => undefined,
    setInterval: () => undefined,
    setImmediate: () => undefined,
    crypto: { randomUUID: () => "x" },
    performance: { now: () => 1 },
  };
}

describe("installDeterminismGuards", () => {
  test("removes the capability globals", () => {
    const target = fakeGlobal();
    const applied = installDeterminismGuards(target);
    for (const name of [
      "process",
      "require",
      "fetch",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "crypto",
      "performance",
    ]) {
      expect(target[name]).toBeUndefined();
      expect(applied).toContain(name);
    }
  });

  test("covers every non-determinism source the guard list names", () => {
    // `crypto` and `performance` were missing from an earlier list, and each is
    // enough on its own to make a call hash differ between a run and its replay:
    // `randomUUID`/`getRandomValues` and `performance.now()`. The constant and
    // the loop that applies it were separate literals, so this pins them together.
    const target = fakeGlobal();
    installDeterminismGuards(target);
    for (const name of FORBIDDEN_GLOBALS) {
      expect(target[name]).toBeUndefined();
    }
  });

  test("Date construction throws, and so does Date.now", () => {
    const target = fakeGlobal();
    installDeterminismGuards(target);
    const GuardedDate = target.Date as unknown as { new (): unknown; now(): number };
    // Reading the clock is the failure resume cannot tolerate: a script that
    // varies a prompt by time journals a different call hash every run.
    expect(() => new GuardedDate()).toThrow(/deterministic/);
    expect(() => GuardedDate.now()).toThrow(/deterministic/);
  });

  test("Math.random throws while the rest of Math still works", () => {
    const target = fakeGlobal();
    installDeterminismGuards(target);
    const math = target.Math as typeof Math;
    expect(() => math.random()).toThrow(/deterministic/);
    expect(math.floor(1.5)).toBe(1);
    expect(math.max(1, 2)).toBe(2);
  });

  test("Intl.DateTimeFormat is removed as a second clock", () => {
    const target = fakeGlobal();
    installDeterminismGuards(target);
    const intl = target.Intl as { DateTimeFormat: unknown };
    expect(() => new (intl.DateTimeFormat as new () => unknown)()).toThrow(/deterministic/);
  });
  test("a guard cannot be undone by the script", () => {
    // A guard that is writable is not a guard: one line restores `Date` and the
    // journal silently stops being reproducible.
    const target = fakeGlobal();
    installDeterminismGuards(target);
    const before = target.Date;
    expect(() => {
      "use strict";
      target.Date = "restored";
    }).toThrow();
    expect(target.Date).toBe(before);
  });

  test("reports only what it actually changed", () => {
    const target = { Math: fakeMath() };
    const applied = installDeterminismGuards(target);
    // `process` etc. are absent from this target, so they must not be claimed.
    expect(applied).toContain("Math.random");
    expect(applied).not.toContain("process");
  });

  test("every guard error carries the recognisable prefix", () => {
    // The prefix is how a caller tells a determinism refusal apart from a real
    // script error, so it is part of the contract rather than cosmetic.
    const target = fakeGlobal();
    installDeterminismGuards(target);
    const math = target.Math as typeof Math;
    expect(() => math.random()).toThrow(GUARD_ERROR_PREFIX);
  });

  test("is self-contained so it survives being stringified into a worker", () => {
    // The worker embeds this function through Function.prototype.toString(), so
    // anything it closes over would be undefined there. Re-evaluating the source
    // in isolation is the check that keeps that true.
    const source = installDeterminismGuards.toString();
    const revived = new Function(`return (${source})`)() as typeof installDeterminismGuards;
    const target = fakeGlobal();
    const applied = revived(target);
    expect(applied).toContain("Date");
    const GuardedDate = target.Date as unknown as { new (): unknown };
    expect(() => new GuardedDate()).toThrow(/deterministic/);
  });

  test("names the capability globals it removes", () => {
    // `Date`/`Math.random`/`Intl.DateTimeFormat` are replaced rather than
    // removed, so they are guarded but not in this list.
    expect([...FORBIDDEN_GLOBALS]).toContain("fetch");
    expect([...FORBIDDEN_GLOBALS]).toContain("process");
    expect([...FORBIDDEN_GLOBALS]).not.toContain("Date");
  });
});
