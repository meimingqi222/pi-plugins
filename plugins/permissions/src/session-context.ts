import { createHash } from "node:crypto";

export const INHERITED_CONTEXT_ENV = "PI_PERMISSIONS_INHERITED_CONTEXT";
// Keep the snapshot small enough for subprocess environment limits.
const MAX_CONTEXT_BYTES = 8192;

export interface SessionContext {
  version: 1;
  cwd: string;
  rules: string[];
  exactCalls: string[];
  sandboxOverride?: boolean;
}

/** Hash full input and execution settings, without placing raw tool payloads in env. */
export function approvalKey(tool: string, input: Record<string, unknown>, cwd: string, shell: unknown): string {
  const serialized = JSON.stringify([tool, input, cwd, shell], (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
    }
    return value;
  });
  return createHash("sha256").update(serialized).digest("hex");
}

export function encodeSessionContext(context: SessionContext): string | undefined {
  const encoded = JSON.stringify(context);
  return Buffer.byteLength(encoded) <= MAX_CONTEXT_BYTES ? encoded : undefined;
}

/** A snapshot grants only approvals in its parent's canonical working directory. */
export function decodeSessionContext(raw: string | undefined, cwd: string): SessionContext | undefined {
  if (!raw || Buffer.byteLength(raw) > MAX_CONTEXT_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<SessionContext> | null;
    if (!value || value.version !== 1 || value.cwd !== cwd) return undefined;
    if (!Array.isArray(value.rules) || !value.rules.every(rule => typeof rule === "string")) return undefined;
    if (!Array.isArray(value.exactCalls) || !value.exactCalls.every(key => typeof key === "string" && /^[a-f0-9]{64}$/u.test(key))) return undefined;
    if (value.sandboxOverride !== undefined && typeof value.sandboxOverride !== "boolean") return undefined;
    return { version: 1, cwd, rules: value.rules, exactCalls: value.exactCalls, sandboxOverride: value.sandboxOverride };
  } catch {
    return undefined;
  }
}
