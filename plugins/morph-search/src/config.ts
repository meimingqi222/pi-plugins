import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MorphSearchConfig {
  apiKey: string;
  baseUrl: string;
  searchTimeoutMs: number;
  compact: { enabled: boolean; timeoutMs: number; ratio: number; preserveRecent: number };
}

export const defaultConfigPath = () => process.env.PI_MORPH_SEARCH_CONFIG || join(homedir(), ".pi", "agent", "morph-search.json");

export function loadConfig(path = defaultConfigPath()): MorphSearchConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid Morph config: ${path}`);
  const value = raw as Record<string, unknown>;
  const compact = value.compact === undefined ? {} : value.compact;
  if (!compact || typeof compact !== "object" || Array.isArray(compact)) throw new Error("compact must be an object");
  const c = compact as Record<string, unknown>;
  const number = (input: unknown, fallback: number, name: string, min: number, max: number) => {
    const result = input === undefined ? fallback : input;
    if (typeof result !== "number" || !Number.isFinite(result) || result < min || result > max) {
      throw new Error(`${name} must be a number from ${min} to ${max}`);
    }
    return result;
  };
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") throw new Error("apiKey must be a string");
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") throw new Error("baseUrl must be a string");
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") throw new Error("compact.enabled must be a boolean");
  const preserveRecent = number(c.preserveRecent, 1, "compact.preserveRecent", 0, 1000);
  if (!Number.isInteger(preserveRecent)) throw new Error("compact.preserveRecent must be an integer");
  return {
    apiKey: (value.apiKey as string | undefined)?.trim() || process.env.MORPH_API_KEY || "",
    baseUrl: (value.baseUrl as string | undefined) || "https://api.morphllm.com",
    searchTimeoutMs: number(value.searchTimeoutMs, 60000, "searchTimeoutMs", 1000, 300000),
    compact: {
      enabled: c.enabled === true,
      timeoutMs: number(c.timeoutMs, 60000, "compact.timeoutMs", 1000, 300000),
      ratio: number(c.ratio, 0.3, "compact.ratio", 0.05, 1),
      preserveRecent,
    },
  };
}
