/**
 * pi-redact — pi extension that strips secrets from everything sent to a model.
 *
 * Port of `opencode-redact` (https://github.com/meimingqi222/opencode-redact)
 * to pi's extension API.
 *
 * Primary gate: the `before_provider_request` hook wraps every provider call
 * (including auto-compaction, branch summaries and overflow retries, which
 * never route through the `context` hook), so the final serialized payload is
 * always scanned. `context` and `tool_result` add defense in depth.
 *
 * Configuration (env vars, all optional):
 *
 *   PI_REDACT=false                  disable the extension entirely
 *   PI_REDACT_CONFIG=<path>          load a JSON config file
 *   PI_REDACT_PATTERNS=a,b           disable built-in patterns by id
 *   PI_REDACT_PATHS=a,b.c            extra path-based redaction
 *   PI_REDACT_TOOL_RESULTS=false     keep raw tool results in the session
 *   PI_REDACT_USER_INPUT=true        also rewrite the user's stored prompt
 *   PI_REDACT_CACHE_MB=32            redaction cache budget in megabytes
 *   PI_REDACT_NOTIFY=false           silence the startup notification
 *
 * It also publishes a redaction service on pi's shared event bus
 * (`pi.events`, channel `pi-redact:service`) so other independently-installed
 * extensions can redact their own outbound payloads with this same engine
 * instead of duplicating the rule set. See ./service.ts.
 *
 * @see ./patterns.ts for the full built-in rule set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRedactor, type Redactor, type SecretPattern } from "./engine.ts";
import { SECRET_PATTERNS } from "./patterns.ts";
import { redactJson } from "./pi-bridge.ts";
import {
  REDACT_DISCOVERY_CHANNEL,
  REDACT_SERVICE_CHANNEL,
  REDACT_SERVICE_VERSION,
  type RedactService,
} from "./service.ts";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface RedactConfig {
  disabled?: boolean;
  disabledPatterns?: string[];
  extraPatterns?: SecretPattern[];
  redactPaths?: string[];
  pathCensor?: string;
  redactToolResults?: boolean;
  redactToolInputs?: boolean;
  redactUserInput?: boolean;
  notify?: boolean;
  /** Max redaction-cache bytes (MB via env). Defaults to 32 MB. */
  cacheBytes?: number;
  /** Max redaction-cache size in MB. */
  cacheMB?: number;
}

interface ResolvedConfig {
  disabled: boolean;
  disabledPatterns: Set<string>;
  extraPatterns: SecretPattern[];
  redactPaths: string[];
  pathCensor: string;
  redactToolResults: boolean;
  redactToolInputs: boolean;
  redactUserInput: boolean;
  notify: boolean;
  cacheBytes: number | undefined;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readConfigFile(): RedactConfig {
  const explicit = process.env.PI_REDACT_CONFIG;
  const candidates = explicit
    ? [isAbsolute(explicit) ? explicit : resolve(explicit)]
    : [join(agentDir(), "redact.json")];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RedactConfig;
    } catch (error) {
      console.warn(
        `pi-redact: ignoring invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {};
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveConfig(): ResolvedConfig {
  const file = readConfigFile();
  const disabledPatterns = new Set([
    ...(file.disabledPatterns ?? []),
    ...parseList(process.env.PI_REDACT_PATTERNS),
  ]);

  // cacheBytes (exact) wins over cacheMB (megabytes) wins over the default.
  const cacheMB = parsePositiveInt(process.env.PI_REDACT_CACHE_MB) ??
    (typeof file.cacheMB === "number" ? file.cacheMB : undefined);
  const cacheBytes = file.cacheBytes ?? (cacheMB === undefined ? undefined : cacheMB * 1024 * 1024);

  return {
    disabled: process.env.PI_REDACT === "false" || file.disabled === true,
    disabledPatterns,
    extraPatterns: file.extraPatterns ?? [],
    redactPaths: [...(file.redactPaths ?? []), ...parseList(process.env.PI_REDACT_PATHS)],
    pathCensor: file.pathCensor ?? "[REDACTED]",
    redactToolResults: process.env.PI_REDACT_TOOL_RESULTS !== "false" && file.redactToolResults !== false,
    redactToolInputs: process.env.PI_REDACT_TOOL_INPUTS === "true" || file.redactToolInputs === true,
    redactUserInput: process.env.PI_REDACT_USER_INPUT === "true" || file.redactUserInput === true,
    notify: process.env.PI_REDACT_NOTIFY !== "false" && file.notify !== false,
    cacheBytes,
  };
}

function buildRedactor(config: ResolvedConfig): Redactor {
  const patterns = [...SECRET_PATTERNS, ...config.extraPatterns].filter(
    (pattern) => !config.disabledPatterns.has(pattern.id),
  );
  return createRedactor(patterns, {
    redactPaths: config.redactPaths,
    pathCensor: config.pathCensor,
    ...(config.cacheBytes === undefined ? {} : { cacheBytes: config.cacheBytes }),
  });
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface RedactState {
  enabled: boolean;
  redactions: number;
  requests: number;
}

/** Deep-redact `value` and report how many strings changed. */
function redactValue(value: unknown, redactor: Redactor): { value: unknown; hits: number } {
  return redactJson(value, redactor);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piRedact(pi: ExtensionAPI) {
  const config = resolveConfig();
  if (config.disabled) return;

  const redactor = buildRedactor(config);
  const state: RedactState = { enabled: true, redactions: 0, requests: 0 };

  const record = (hits: number): void => {
    if (hits > 0) state.redactions += hits;
  };

  const safe = <T>(fn: () => T, fallback: T): T => {
    if (!state.enabled) return fallback;
    try {
      return fn();
    } catch (error) {
      console.warn(`pi-redact: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };

  // --- service for other extensions ----------------------------------------
  // pi-redact's hooks only see pi's own provider payloads; an extension that
  // posts a conversation to its own backend (pi-jev-compact -> TypeSafe) never
  // passes through them. Publishing the live redactor on the shared bus lets
  // such an extension redact its own outbound payload with this engine, without
  // importing this package or duplicating the rules. The consumer validates
  // `version` at runtime. See ./service.ts.
  //
  // The announcement is emitted twice on purpose. Load order is not
  // controllable and there is no "wait for extension X", so whichever plugin
  // loads second would miss a single announcement. A late consumer that hears
  // nothing emits on the discovery channel and the announcement is repeated.
  // The service is deliberately **not** wrapped in `safe()`. `safe` fails open
  // (returns the raw value on error), which is right for pi's own provider
  // payloads — blocking the request would break the session — but wrong here:
  // the consumer's contract is fail-closed, so an engine error must propagate
  // and let it abort the upload rather than silently transmit the raw value.
  // The paused case still returns the input unchanged, because that is the
  // user's explicit choice, not a failure.
  const service: RedactService = {
    version: REDACT_SERVICE_VERSION,
    patternCount: redactor.patternCount,
    redactJson: (value) => (state.enabled ? redactValue(value, redactor).value : value),
    redactString: (value) => (state.enabled ? redactor.string(value) : value),
  };
  const announce = (): void => {
    try {
      pi.events?.emit(REDACT_SERVICE_CHANNEL, service);
    } catch {
      // A bus failure (or a pi version without `pi.events`) must never take the
      // extension down; redaction of pi's own payloads does not depend on it.
    }
  };
  announce();
  try {
    pi.events?.on(REDACT_DISCOVERY_CHANNEL, announce);
  } catch {
    // Same reasoning: discovery is a convenience, not a correctness requirement.
  }

  // --- persistence ---------------------------------------------------------
  pi.on("session_start", async (event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "redact-state") {
        const data = entry.data as { enabled?: boolean } | undefined;
        if (typeof data?.enabled === "boolean") state.enabled = data.enabled;
      }
    }

    if (config.notify && event.reason === "startup") {
      const paths = config.redactPaths.length ? `, ${config.redactPaths.length} paths` : "";
      ctx.ui.notify(
        `pi-redact: ${redactor.patternCount} patterns${paths} — ${state.enabled ? "enabled" : "paused"}`,
        state.enabled ? "info" : "warning",
      );
    }
  });

  // --- primary gate: final provider payload --------------------------------
  // Covers the agent loop, auto-compaction, branch summaries and retries.
  pi.on("before_provider_request", (event) => {
    const result = safe(() => redactValue(event.payload, redactor), undefined);
    if (!result || result.hits === 0) return undefined;
    state.requests += 1;
    record(result.hits);
    return result.value;
  });

  // --- defense in depth: agent context -------------------------------------
  pi.on("context", (event) => {
    const result = safe(() => redactValue(event.messages, redactor), undefined);
    if (!result || result.hits === 0) return undefined;
    record(result.hits);
    return { messages: result.value as typeof event.messages };
  });

  // --- tool results (stored in the session) --------------------------------
  if (config.redactToolResults) {
    pi.on("tool_result", (event) => {
      const content = safe(() => redactValue(event.content, redactor), undefined);
      const details = safe(() => redactValue(event.details, redactor), undefined);

      let pathHits = 0;
      let pathedDetails = details?.value;
      if (config.redactPaths.length > 0) {
        const base = details?.value ?? event.details;
        const pathed = safe(() => redactor.paths(base), undefined);
        if (pathed !== undefined && pathed !== base) {
          pathedDetails = pathed;
          pathHits += 1;
        }
      }

      const detailsHits = (details?.hits ?? 0) + pathHits;
      if ((content?.hits ?? 0) === 0 && detailsHits === 0) return undefined;

      record((content?.hits ?? 0) + detailsHits);

      // Only include `details` in the patch when it actually changed, so an
      // untouched `details` value is preserved rather than cleared.
      const patch: { content?: typeof event.content; details?: unknown } = {};
      if (content) patch.content = content.value as typeof event.content;
      if (detailsHits > 0) patch.details = pathedDetails;
      return patch;
    });
  }

  // --- optional: tool call arguments ---------------------------------------
  // Off by default: pi applies input mutations to the real execution, so
  // redacting here would corrupt commands that legitimately carry credentials.
  if (config.redactToolInputs) {
    pi.on("tool_call", (event) => {
      const result = safe(() => redactValue(event.input, redactor), undefined);
      if (!result || result.hits === 0) return undefined;
      record(result.hits);
      Object.assign(event.input, result.value as Record<string, unknown>);
      return undefined;
    });
  }

  // --- optional: stored user prompt ----------------------------------------
  if (config.redactUserInput) {
    pi.on("input", (event) => {
      const next = safe(() => redactor.string(event.text), undefined);
      if (typeof next !== "string" || next === event.text) return { action: "continue" };
      record(1);
      return { action: "transform", text: next };
    });
  }

  // --- command -------------------------------------------------------------
  pi.registerCommand("redact", {
    description: "Show or control pi-redact secret redaction",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "status", label: "status", description: "Show current state" },
        { value: "on", label: "on", description: "Enable redaction" },
        { value: "off", label: "off", description: "Pause redaction" },
        { value: "toggle", label: "toggle", description: "Toggle redaction" },
        { value: "patterns", label: "patterns", description: "List active patterns" },
        { value: "test", label: "test", description: "Redact a sample string" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      const persist = (): void => pi.appendEntry("redact-state", { enabled: state.enabled });

      switch (command || "status") {
        case "on":
          state.enabled = true;
          persist();
          ctx.ui.notify("pi-redact enabled", "info");
          return;

        case "off":
          state.enabled = false;
          persist();
          ctx.ui.notify(
            "pi-redact paused — secrets will be sent to the model until re-enabled",
            "warning",
          );
          return;

        case "toggle":
          state.enabled = !state.enabled;
          persist();
          ctx.ui.notify(`pi-redact ${state.enabled ? "enabled" : "paused"}`, state.enabled ? "info" : "warning");
          return;

        case "patterns": {
          const lines = redactor.patternList.map((p) => `  ${p.id} [${p.category}] ${p.title}`);
          ctx.ui.notify(`${redactor.patternCount} active patterns:\n${lines.join("\n")}`, "info");
          return;
        }

        case "test": {
          const sample = rest.join(" ");
          if (!sample) {
            ctx.ui.notify("Usage: /redact test <text containing a secret>", "info");
            return;
          }
          const result = redactor.string(sample);
          const changed = typeof result === "string" && result !== sample;
          // Never echo the raw sample: it may contain a live secret.
          ctx.ui.notify(
            changed
              ? `pi-redact matched. Output:\n${result}`
              : "pi-redact found no known secret in that text.",
            changed ? "info" : "warning",
          );
          return;
        }

        default:
          ctx.ui.notify(
            [
              `pi-redact: ${state.enabled ? "enabled" : "paused"}`,
              `patterns: ${redactor.patternCount} (${config.disabledPatterns.size} disabled)`,
              `paths: ${redactor.pathCount}`,
              `redactions this session: ${state.redactions} across ${state.requests} requests`,
              `cache: ${redactor.cacheEntries} entries${config.cacheBytes === undefined ? " (32 MB default)" : ` (${Math.round(config.cacheBytes / 1024 / 1024)} MB budget)`}`,
              `tool results: ${config.redactToolResults ? "redacted" : "raw"} | tool inputs: ${config.redactToolInputs ? "redacted" : "raw"} | user input: ${config.redactUserInput ? "redacted" : "raw"}`,
              `config: ${process.env.PI_REDACT_CONFIG || join(agentDir(), "redact.json")}`,
            ].join("\n"),
            "info",
          );
      }
    },
  });
}
