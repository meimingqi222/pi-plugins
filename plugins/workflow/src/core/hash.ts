/**
 * Stable hashing for call identity.
 *
 * A journal is only useful for resume if the same call hashes the same on the
 * second run, so the encoding must be independent of object key order and of
 * anything the runtime varies between runs. `JSON.stringify` is not enough: it
 * preserves insertion order, and two objects that differ only in key order are
 * the same call.
 *
 * Non-finite numbers encode as `null` rather than throwing, because a script can
 * legitimately pass `Infinity` through `args` and the call still has to have an
 * identity. `undefined` inside an object is dropped by `JSON.stringify` and so
 * hashes as absent; that is the same value the wire would carry, which is the
 * property that matters.
 */

import { createHash } from "node:crypto";
import type { WorkflowJsonValue } from "./types.ts";

/** Deterministic JSON text: object keys sorted, non-finite numbers as `null`. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** SHA-256 of the stable encoding. Used as a journal call key. */
export function workflowHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * Coerce a value into the JSON subset the wire and journal accept.
 *
 * The runtime must never hand a non-JSON value to `JSON.stringify` on a path
 * whose consumer assumes JSON, so this is applied at the boundary rather than
 * trusted. Objects become null-prototype records so a script-supplied `__proto__`
 * key cannot reach `Object.prototype` on the way out.
 */
export function workflowJsonValue(value: unknown): WorkflowJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => workflowJsonValue(item));
  if (typeof value === "object") {
    const result = Object.create(null) as { [key: string]: WorkflowJsonValue };
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = workflowJsonValue(item);
    }
    return result;
  }
  return String(value);
}
