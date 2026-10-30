/** Minimum contract accepted by independently installed consumers. */
export interface RedactService {
  version: number;
  isEnabled?: () => boolean;
  redactJson(value: unknown): unknown;
  redactString(value: string | null | undefined): string | null | undefined;
  patternCount?: number;
}

/** v1 predates isEnabled; v2 must expose live enablement. */
export function isCompatibleRedactService(value: unknown): value is RedactService {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.version === 1 || (candidate.version === 2 && typeof candidate.isEnabled === "function"))
    && typeof candidate.redactJson === "function" && typeof candidate.redactString === "function";
}
