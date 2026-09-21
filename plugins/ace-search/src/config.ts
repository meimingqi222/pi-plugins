/**
 * Configuration for pi-ace-search.
 *
 * The defaults are deliberately aligned with `acemcp-go` so this client can
 * reuse the index that `acemcp` already built:
 *
 *   - the same `~/.acemcp/settings.toml` file (BASE_URL, TOKEN, data dir),
 *   - the same `TEXT_EXTENSIONS` / `EXCLUDE_PATTERNS`,
 *   - the same `MAX_LINES_PER_BLOB` chunking and `sha256(path + content)` hash,
 *   - the same cache file name (`sha256(absPath)[:16] + ".json"`).
 *
 * Reusing the hashes, not just the settings, is the point: `acemcp` uploads
 * roughly 68s of chunks for a warm 4.4k-file repository on a cold cache, and
 * the cache is the only record of that work. A client that invented its own
 * chunking would pay that cost again on first run and would keep `acemcp` and
 * itself fighting over the same server-side index.
 *
 * Every field is overridable by environment variable so the extension can run
 * without touching `~/.acemcp`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Extensions acemcp uses when `TEXT_EXTENSIONS` is absent from settings. */
export const DEFAULT_TEXT_EXTENSIONS: readonly string[] = [
  ".py", ".js", ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".astro",
  ".go", ".rs", ".java", ".kt", ".groovy", ".gradle",
  ".cs", ".vb", ".fs", ".cpp", ".c", ".h", ".hpp", ".cc", ".cxx",
  ".rb", ".php", ".swift", ".scala", ".clj", ".cljs", ".ex", ".exs",
  ".lua", ".pl", ".pm", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".sql", ".r", ".m", ".mm", ".dart", ".zig", ".nim", ".v", ".hs", ".elm",
  ".md", ".txt", ".rst", ".adoc",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg", ".conf",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl",
  ".graphql", ".gql", ".proto", ".thrift",
  ".dockerfile", ".makefile", ".cmake",
];

/** Name-level excludes acemcp compiles into its matcher at startup. */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  ".git", "node_modules", "__pycache__", "vendor",
  ".venv", "venv", ".env", "env",
  ".pytest_cache", ".mypy_cache", ".tox", ".eggs",
  "dist", "build", ".idea", ".vscode",
  ".gradle", "target", "bin", "obj",
  "htmlcov", ".svn", ".hg",
  ".DS_Store", "Thumbs.db",
  "*.pyc", "*.pyo", "*.pyd",
  "*.egg-info",
  "pip-log.txt", "pip-delete-this-directory.txt",
  ".coverage",
];

export interface AceSearchConfig {
  /** ACE endpoint origin; the client appends `/batch-upload`, `/find-missing`, … */
  readonly baseUrl: string;
  /** Bearer token for the endpoint. Empty means uploads are refused early. */
  readonly token: string;
  /** Directory holding `cache/` and `uploaded_blobs.json`. */
  readonly dataDir: string;
  /** Absolute path of `~/.acemcp/settings.toml`; recorded for diagnostics. */
  readonly settingsPath: string;
  readonly textExtensions: readonly string[];
  readonly excludePatterns: readonly string[];
  readonly batchSize: number;
  /**
   * Simultaneous `/batch-upload` requests.
   *
   * acemcp hard-codes 4. Upload throughput dominates the cold-start wall clock
   * (68s for 6031 chunks at batch size 8), and the endpoint tolerated far more
   * than 4 in testing, so this is configurable rather than fixed.
   */
  readonly concurrency: number;
  readonly maxLinesPerBlob: number;
  readonly maxLineBytes: number;
  readonly maxFileBytes: number;
  /**
   * Override for the blob-hash store.
   *
   * Only needed when the cache file `acemcp` would use has no `entries` key,
   * i.e. an index built by an `acemcp` version that did not write hashes. Leave
   * empty to use the shared, warm cache.
   */
  readonly indexPath: string;
  /** `info` prints one phase line per stage; `debug` adds per-file detail. */
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export interface LoadConfigOptions {
  /** Override `~/.acemcp`; mainly for tests. */
  readonly home?: string;
  /**
   * Explicit `settings.toml` path.
   *
   * Exists so a non-default install location does not require editing this
   * package, and so tests never read a developer's real credentials.
   * `~/.acemcp/settings.toml` is only the default, matching `acemcp`.
   */
  readonly settingsPath?: string;
  /** `--data` from the CLI. */
  readonly dataDir?: string;
  /** `--base-url` from the CLI. */
  readonly baseUrl?: string;
  /** `--token` from the CLI. */
  readonly token?: string;
  /** `--index` from the CLI. */
  readonly indexPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function loadAceSearchConfig(options: LoadConfigOptions = {}): AceSearchConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  // Ordered: explicit option, then `PI_ACE_SETTINGS`, then the acemcp default.
  // Nothing here reads a machine-specific path it was not told about.
  const settingsPath =
    firstNonEmpty(options.settingsPath, env.PI_ACE_SETTINGS) ??
    join(home, ".acemcp", "settings.toml");
  const file = readSettingsFile(settingsPath);

  const dataDir =
    firstNonEmpty(options.dataDir, env.PI_ACE_DATA_DIR, join(home, ".acemcp", "data")) ??
    join(home, ".acemcp", "data");

  return {
    // acecpm's own default (`https://api.example.com`) is a placeholder that
    // never worked; failing loudly on it is better than a confusing 404.
    baseUrl: requireBaseUrl(
      firstNonEmpty(options.baseUrl, env.PI_ACE_BASE_URL, asString(file.BASE_URL)),
    ),
    token: firstNonEmpty(options.token, env.PI_ACE_TOKEN, asString(file.TOKEN)) ?? "",
    dataDir,
    settingsPath,
    textExtensions: normalizeExtensionList(
      stringList(env.PI_ACE_TEXT_EXTENSIONS) ??
        stringArray(file.TEXT_EXTENSIONS) ??
        DEFAULT_TEXT_EXTENSIONS,
    ),
    excludePatterns:
      stringList(env.PI_ACE_EXCLUDE_PATTERNS) ??
      stringArray(file.EXCLUDE_PATTERNS) ??
      DEFAULT_EXCLUDE_PATTERNS,
    batchSize: requirePositiveInt(
      "PI_ACE_BATCH_SIZE",
      firstInt(env.PI_ACE_BATCH_SIZE, asNumber(file.BATCH_SIZE), 8),
    ),
    concurrency: requirePositiveInt(
      "PI_ACE_CONCURRENCY",
      firstInt(env.PI_ACE_CONCURRENCY, undefined, 12),
    ),
    maxLinesPerBlob: requirePositiveInt(
      "PI_ACE_MAX_LINES_PER_BLOB",
      firstInt(env.PI_ACE_MAX_LINES_PER_BLOB, asNumber(file.MAX_LINES_PER_BLOB), 300),
    ),
    maxLineBytes: requirePositiveInt(
      "PI_ACE_MAX_LINE_BYTES",
      firstInt(env.PI_ACE_MAX_LINE_BYTES, asNumber(file.MAX_LINE_BYTES), 10 * 1024),
    ),
    maxFileBytes: requirePositiveInt(
      "PI_ACE_MAX_FILE_BYTES",
      firstInt(env.PI_ACE_MAX_FILE_BYTES, undefined, 1024 * 1024),
    ),
    indexPath: firstNonEmpty(options.indexPath, env.PI_ACE_INDEX, asString(file.INDEX_PATH)) ?? "",
    logLevel: normalizeLogLevel(env.PI_ACE_LOG_LEVEL ?? asString(file.LOG_LEVEL) ?? "info"),
  };
}

function requireBaseUrl(value: string | null): string {
  if (!value) {
    throw new Error(
      "ACE base URL is not configured. Set BASE_URL in ~/.acemcp/settings.toml or PI_ACE_BASE_URL.",
    );
  }
  return value.replace(/\/+$/, "");
}

function requirePositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstInt(
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number,
): number {
  if (envValue?.trim()) return Number(envValue.trim());
  if (fileValue !== undefined) return fileValue;
  return fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Environment variables are strings, so a list override arrives as either a
 * JSON-ish `a,b` string or (from a test harness) a real array. Reading only
 * arrays silently discarded every `PI_ACE_TEXT_EXTENSIONS=...` setting.
 */
function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return stringArray(value);
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string").map((s) => s.trim());
  return items.some((item) => item.length > 0) ? items.filter((item) => item.length > 0) : undefined;
}

function normalizeExtensionList(extensions: readonly string[]): string[] {
  return extensions.map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}

function normalizeLogLevel(value: string): AceSearchConfig["logLevel"] {
  const level = value.trim().toLowerCase();
  return level === "debug" || level === "warn" || level === "error" ? level : "info";
}

// ---------------------------------------------------------------------------
// settings.toml
// ---------------------------------------------------------------------------

export type SettingsFile = Record<string, unknown>;

/**
 * Parse the flat `KEY = value` subset used by `~/.acemcp/settings.toml`.
 *
 * The file is written by hand and read by viper, which also supports nested
 * tables. Nothing in acemcp's own defaults uses a table, and the only keys this
 * client needs are scalars or string arrays, so rejecting anything else keeps
 * the parser small. A malformed file is ignored rather than fatal: falling back
 * to defaults still produces a usable index, whereas throwing would make the
 * extension unusable because of an unrelated hand edit.
 */
export function parseSettingsToml(text: string): SettingsFile {
  const result: SettingsFile = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line || line.startsWith("[")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const valueText = line.slice(separator + 1).trim();
    const value = parseTomlValue(valueText);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inString = !inString;
    else if (char === "#" && !inString) return line.slice(0, index);
  }
  return line;
}

function parseTomlValue(text: string): unknown {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const items: string[] = [];
    let current = "";
    let inString = false;
    for (const char of text.slice(1, -1)) {
      if (char === '"') {
        inString = !inString;
        if (!inString) {
          items.push(current);
          current = "";
        }
        continue;
      }
      if (inString) current += char;
    }
    return items;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  const number = Number(text);
  return Number.isFinite(number) && text !== "" ? number : undefined;
}

function readSettingsFile(settingsPath: string): SettingsFile {
  try {
    return parseSettingsToml(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute-ise a path against a base directory, mirroring acemcp's POSIX form. */
export function toPosixAbsolutePath(path: string, cwd: string): string {
  return resolve(isAbsolute(path) ? path : join(cwd, path)).split("\\").join("/");
}
