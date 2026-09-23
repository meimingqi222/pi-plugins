/**
 * Determinism guards for workflow scripts.
 *
 * A workflow is replayable only if the same script and args produce the same
 * calls. Wall-clock time and randomness break that: a script that varies a
 * prompt by `Math.random()` journals a different call hash on every run, so
 * resume never matches and the journal stops meaning anything. The guards below
 * remove those sources, and the value they provide is *reproducibility*.
 *
 * **This is not a security boundary.** pi extensions run with the user's
 * permissions, and the script is written by the model inside the user's own
 * session. The guards exist so a run is deterministic and so a script cannot
 * accidentally reach the network or the OS; they are not a sandbox and must
 * never be described as one. Containment comes from running the script in a
 * worker that can be terminated.
 *
 * `installDeterminismGuards` is deliberately self-contained — it defines every
 * helper inside itself and is embedded into the worker through
 * `Function.prototype.toString()`. That is what keeps this file the single
 * source of truth instead of a hand-copied second version drifting in the
 * worker. Anything it closes over would be `undefined` there.
 */

export const FORBIDDEN_GLOBALS = [
  "process",
  "require",
  "fetch",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "crypto",
  "performance",
] as const;

/** Marker prepended to every guard error, so a caller can recognize its own refusal. */
export const GUARD_ERROR_PREFIX = "workflow-determinism:";

/**
 * Replace or remove the non-deterministic globals on `target`.
 *
 * Self-contained on purpose: every helper and constant it needs is defined
 * inside the function body, because this function is embedded into the worker
 * through `Function.prototype.toString()` and anything it closed over would be
 * `undefined` there. Returns the names actually changed, which can be fewer than
 * requested when a global is already absent.
 */
export function installDeterminismGuards(target: Record<string, unknown>): string[] {
  const prefix = "workflow-determinism:";
  const applied: string[] = [];

  const reason = (what: string): string =>
    prefix +
    " " +
    what +
    " is unavailable: workflow scripts must be deterministic so a resumed run replays the same calls";

  const forbid = (what: string): never => {
    throw new Error(reason(what));
  };

  const define = (holder: Record<string, unknown>, key: string, value: unknown): void => {
    Object.defineProperty(holder, key, { value: value, writable: false, configurable: false, enumerable: true });
  };

  const ForbiddenDate = function Date(): never {
    return forbid("Date");
  };
  define(ForbiddenDate as unknown as Record<string, unknown>, "now", function now(): never {
    return forbid("Date.now");
  });
  define(ForbiddenDate as unknown as Record<string, unknown>, "parse", function parse(): never {
    return forbid("Date.parse");
  });
  define(target, "Date", ForbiddenDate);
  applied.push("Date");

  const math = target.Math as Record<string, unknown> | undefined;
  if (math && typeof math === "object") {
    // Replaced in place rather than removing `Math`: every other method is
    // deterministic and a script is expected to use them.
    define(math, "random", function random(): never {
      return forbid("Math.random");
    });
    applied.push("Math.random");
  }

  const intl = target.Intl as Record<string, unknown> | undefined;
  if (intl && typeof intl === "object") {
    // A second clock: `Intl.DateTimeFormat` reads the system time zone.
    define(intl, "DateTimeFormat", function DateTimeFormat(): never {
      return forbid("Intl.DateTimeFormat");
    });
    applied.push("Intl.DateTimeFormat");
  }

  // `crypto` and `performance` are the two the earlier list missed: the first is
  // a second source of randomness (`randomUUID`, `getRandomValues`) and the
  // second a third clock (`performance.now()`), and either one makes a journaled
  // call hash differ between the live run and its replay. `setImmediate` joins
  // `setTimeout` as a scheduler the guard exists to remove.
  const names = ["process", "require", "fetch", "setTimeout", "setInterval", "setImmediate", "crypto", "performance"];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (name in target) {
      define(target, name, undefined);
      applied.push(name);
    }
  }

  return applied;
}
