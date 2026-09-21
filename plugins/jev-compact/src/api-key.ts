/**
 * Resolving the TypeSafe / Jev API key.
 *
 * Three sources, tried in order, so the key can live wherever it is most
 * appropriate for the machine rather than in one mandatory place:
 *
 *   1. `TYPESAFE_API_KEY` — the environment. Best for CI and for a shell that
 *      already exports it.
 *   2. `<agent dir>/jev-compact.json` — `{ "apiKey": "..." }`, mode 0600. The
 *      plugin's own file, for a machine where exporting from a shell rc file is
 *      not enough (a GUI-launched pi never reads `.zshrc`).
 *   3. `<agent dir>/auth.json` — the credential file pi's `/login` writes,
 *      under a provider id chosen by this plugin (`DEFAULT_AUTH_PROVIDER_ID`).
 *
 * `auth.json` is read **directly as a file**, not through pi's model registry.
 * That distinction is the whole reason this module exists: `getApiKeyForProvider`
 * resolves through registered model providers and returns nothing for an id that
 * is not a model, so it cannot read a plugin-owned entry. Reading the JSON does
 * work, and it is safe in both directions because a stored credential is
 * `{ type, key }` — the same shape pi writes for its own providers — and pi's
 * write path is `delete currentData[provider]` followed by a re-serialization of
 * the whole object, so a foreign key is preserved rather than dropped.
 *
 * The environment wins over both files so an explicit export can always override
 * a stale stored value without editing a file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Provider id used as the `auth.json` key. Not a pi model provider. */
export const DEFAULT_AUTH_PROVIDER_ID = "typesafe";

/** Plugin-owned config file, relative to the pi agent directory. */
export const CONFIG_FILE_NAME = "jev-compact.json";

export type ApiKeySource =
  | "environment"
  | "config-file"
  | "auth-file"
  | "none";

export interface ResolvedApiKey {
  readonly key: string | undefined;
  readonly source: ApiKeySource;
  /**
   * True when the raw value needed repair (embedded whitespace).
   *
   * Reported rather than silently fixed because the common cause is not a bad
   * value: a process that started before the variable was edited keeps the old
   * value for its whole lifetime, so the warning can fire while the stored value
   * is already correct.
   */
  readonly repaired: boolean;
}

export interface ResolveApiKeyOptions {
  /** Directory holding `auth.json` and the plugin config file. */
  readonly agentDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Override the `auth.json` key. Defaults to `typesafe`. */
  readonly authProviderId?: string;
  /** Injected for tests; defaults to reading from disk. */
  readonly readFile?: (path: string) => string | undefined;
}

/**
 * Resolve the key from the environment, the plugin config file, then `auth.json`.
 *
 * Never throws: a broken or unreadable file is skipped, because the failure mode
 * of a missing key is already a fall back to pi's own compaction, and turning an
 * unrelated file permission problem into a startup crash would be worse.
 */
export function resolveApiKey(options: ResolveApiKeyOptions): ResolvedApiKey {
  const env = options.env ?? process.env;
  const read =
    options.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });

  // 1. Environment.
  const fromEnv = normalize(env.TYPESAFE_API_KEY);
  if (fromEnv) return { ...fromEnv, source: "environment" };

  // 2. The plugin's own config file.
  const configRaw = read(join(options.agentDir, CONFIG_FILE_NAME));
  const fromConfig = configRaw === undefined ? undefined : readConfigFile(configRaw);
  if (fromConfig) return { ...fromConfig, source: "config-file" as const };

  // 3. auth.json, read directly.
  const authRaw = read(join(options.agentDir, "auth.json"));
  const providerId = options.authProviderId ?? DEFAULT_AUTH_PROVIDER_ID;
  const fromAuth = authRaw === undefined ? undefined : readAuthFile(authRaw, providerId);
  if (fromAuth) return { ...fromAuth, source: "auth-file" as const };

  return { key: undefined, source: "none", repaired: false };
}

/** Strip whitespace and report whether any was present. */
function normalize(raw: unknown): { key: string; repaired: boolean } | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  // An API key pasted into `setx` or a shell heredoc can pick up a trailing
  // newline, and a newline inside an HTTP header throws before the request is
  // sent with a message that names no cause. A real key never contains
  // whitespace, so stripping cannot mask a different mistake.
  const cleaned = raw.replace(/\s+/g, "");
  if (cleaned.length === 0) return undefined;
  return { key: cleaned, repaired: cleaned !== raw };
}

function readConfigFile(raw: string): { key: string; repaired: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return normalize((parsed as { apiKey?: unknown }).apiKey);
}

function readAuthFile(raw: string, providerId: string): { key: string; repaired: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  // Only an api_key credential is usable as a Jev key. An oauth entry under this
  // id would be a different kind of value entirely, so it is ignored rather than
  // guessed at.
  const credential = entry as { type?: unknown; key?: unknown };
  if (credential.type !== "api_key") return undefined;
  return normalize(credential.key);
}

/** Human-readable source, for the startup notice. */
export function describeApiKeySource(source: ApiKeySource, providerId = DEFAULT_AUTH_PROVIDER_ID): string {
  switch (source) {
    case "environment":
      return "TYPESAFE_API_KEY";
    case "config-file":
      return CONFIG_FILE_NAME;
    case "auth-file":
      return `auth.json[${providerId}]`;
    case "none":
      return "not configured";
  }
}
