/**
 * pi-redact — bridge between the shared redaction engine and pi's data shapes.
 *
 * pi's model input has two entry points we care about:
 *
 *   1. `context` event          → AgentMessage[] for the main agent loop
 *   2. `before_provider_request` → the final provider payload. This wraps
 *      `streamFn`, so it also covers requests pi builds internally and never
 *      routes through `context` (notably auto-compaction, branch summaries,
 *      and overflow retries).
 *
 * Both are deep-walked with a copy-on-write JSON redactor. Binary content
 * (pi `ImageContent` and base64 blobs) is preserved untouched.
 */

import type { Redactor } from "./engine.ts";

/** Result of a deep redaction pass. */
export interface DeepRedactResult {
  value: unknown;
  /** Number of string values that were actually changed. */
  hits: number;
}

/** True for plain `{}` / `Object.create(null)` objects, false for class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Preserve binary payloads. pi uses `{ type: "image", data, mimeType }`;
 * other harnesses use `{ type: "base64" | "image", data }`. Both must survive.
 */
function isBinaryPayload(value: Record<string, unknown>): boolean {
  if (typeof value.data === "string" && (value.type === "image" || value.type === "base64")) {
    return true;
  }
  if (value.isImage === true && typeof value.content === "string") {
    return true;
  }
  return false;
}

/**
 * Recursively redact every string reachable through plain objects and arrays.
 *
 * Copy-on-write: unchanged branches keep their original reference, so provider
 * payloads that contain class instances or special objects round-trip intact.
 *
 * `inProgress` is a recursion stack used to break cycles: a node is only
 * marked while its own children are being visited, so the same object
 * appearing twice in sibling positions is still redacted both times.
 */
export function redactJson(
  value: unknown,
  redactor: Redactor,
  inProgress: WeakSet<object> = new WeakSet(),
): DeepRedactResult {
  if (typeof value === "string") {
    const next = redactor.string(value);
    if (typeof next === "string" && next !== value) {
      return { value: next, hits: 1 };
    }
    return { value, hits: 0 };
  }

  if (Array.isArray(value)) {
    if (inProgress.has(value)) return { value, hits: 0 };
    inProgress.add(value);

    let hits = 0;
    let changed = false;
    const next = value.map((item) => {
      const result = redactJson(item, redactor, inProgress);
      if (result.hits > 0) {
        hits += result.hits;
        changed = true;
      }
      return result.value;
    });

    inProgress.delete(value);
    return changed ? { value: next, hits } : { value, hits: 0 };
  }

  if (isPlainObject(value)) {
    if (isBinaryPayload(value)) return { value, hits: 0 };
    if (inProgress.has(value)) return { value, hits: 0 };
    inProgress.add(value);

    let hits = 0;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = redactJson(item, redactor, inProgress);
      if (result.hits > 0) {
        hits += result.hits;
        changed = true;
      }
      next[key] = result.value;
    }

    inProgress.delete(value);
    return changed ? { value: next, hits } : { value, hits: 0 };
  }

  // Numbers, booleans, null, undefined, class instances, buffers, dates.
  return { value, hits: 0 };
}
