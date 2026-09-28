/**
 * Shared types for the permission layer.
 *
 * Every tool call is first decomposed into one or more `Intent`s, each intent is
 * graded into a `Tier`, and the mode × rules decide the final `Action`. All of
 * the modules that produce or consume these types are pure functions of their
 * arguments plus `PolicyEnv`; file-system and pi access lives at the edges.
 */

export type IntentKind = "read" | "write" | "exec" | "other";
export type Tier = "safe" | "grey" | "dangerous" | "forbidden";
export type Mode = "read-only" | "ask" | "auto" | "yolo";
export type Action = "allow" | "ask" | "deny";

/** Strictness order: a lower number is a stricter mode. */
export const MODE_ORDER: readonly Mode[] = ["read-only", "ask", "auto", "yolo"];

export function modeRank(mode: Mode): number {
  return MODE_ORDER.indexOf(mode);
}

export const TIER_ORDER: readonly Tier[] = ["safe", "grey", "dangerous", "forbidden"];

export function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

export function worstTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** A single shell sub-command, already unwrapped from sudo/env/timeout etc. */
export interface ShellCommand {
  /** Basename of the executable; `.exe` stripped + lowercased on win32, lowercased on darwin. */
  name: string;
  /** undefined = the argument is dynamic (contains $VAR, $(...), globs, ...). */
  args: (string | undefined)[];
  /** Raw word texts parallel to `args` ("$HOME", "~/", "*", quoting kept off). */
  rawArgs: string[];
  redirects: ShellRedirect[];
  /** Wrappers the command was found under, e.g. ["sudo", "env"]. */
  via: string[];
  /** Raw text of the command name word (before basename normalization). */
  rawName: string;
}

export interface ShellRedirect {
  op: ">" | ">>" | "<" | "&>" | "other";
  /** undefined = dynamic target. */
  target?: string;
}

export interface ShellAnalysis {
  /** Flattened sub-commands: pipelines, &&, ||, ;, subshells and recursed scripts. */
  commands: ShellCommand[];
  /** Command indexes grouped per pipeline, for "read secret | curl" style rules. */
  pipelines: number[][];
  /** Why static analysis was incomplete, if it was: "parse-error", "dynamic-command", ... */
  unresolved?: string;
}

export interface Intent {
  kind: IntentKind;
  /** Original tool name ("bash", "read", "subagent", ...). */
  tool: string;
  /** Normalized absolute target path for read/write intents. */
  path?: string;
  /** The sub-command for exec intents. */
  command?: ShellCommand;
  /** For intents extracted from a shell command, the index of the exec intent it belongs to. */
  sourceIndex?: number;
  /** Snippet for prompts and allow-rule generation. */
  raw?: string;
  /** True when a safe-tier intent still changes state (writes or mutating commands). */
  mutating?: boolean;
}

/** An intent after intrinsic classification. */
export interface GradedIntent extends Intent {
  tier: Tier;
  ruleId?: string;
  reason?: string;
}

export interface Classification {
  intents: GradedIntent[];
  tier: Tier;
  mutating: boolean;
  reason: string;
  ruleId?: string;
}

export interface Decision {
  action: Action;
  tier: Tier;
  /** Human readable, shown in the prompt and returned to the model when blocked. */
  reason: string;
  ruleId?: string;
  /** The user rule text that matched, e.g. "bash(npm publish:*)". */
  matchedRule?: string;
  /** Whether the prompt may offer "always allow" options (false for dangerous). */
  allowAlwaysOffered: boolean;
  /**
   * The ask came from an explicit `ask` rule rather than the mode table —
   * the auto-mode reviewer must not override it (§11.1).
   */
  askedByRule?: boolean;
}

/** Reviewer model settings from config (`reviewer` key, §11.2). */
export interface ReviewerConfig {
  /** "provider/model-id", resolved via `ctx.modelRegistry.find`. */
  model: string;
  timeoutMs: number;
  maxPerSession: number;
}

/** Sandbox settings from config (`sandbox` key, §12.2). */
export interface SandboxSettings {
  enabled: boolean;
  network: "on" | "off";
  /** Extra writable paths beyond the defaults. */
  allowWrite: string[];
  /** Extra paths the sandboxed command may not read. */
  denyRead: string[];
}

/**
 * Injectable environment: the ONLY way policy code learns about platform,
 * paths and symlinks. Tests construct it by hand (including win32 on macOS).
 */
export interface PolicyEnv {
  platform: NodeJS.Platform;
  /** Normalized home directory. */
  home: string;
  /** Workspace root, normalized. */
  cwd: string;
  /** Normalized temp directories. */
  tempDirs: string[];
  /** Configured extra writable directories. */
  additionalDirs: string[];
  /**
   * Resolve symlinks. For a missing path, resolve the deepest existing
   * ancestor and re-append the tail; on failure return the input unchanged.
   */
  realpath(p: string): string;
}
