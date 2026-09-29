/**
 * Permission config files (§5.1–5.2): global `~/.pi/agent/permissions.json`
 * plus project `<cwd>/.pi/permissions.json`. Untrusted project files can only
 * tighten. All writes go through a temp-file + rename so concurrent pi
 * processes cannot corrupt the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { modeRank } from "./types.ts";
import type { Mode, ReviewerConfig, SandboxSettings } from "./types.ts";

export interface PermFileConfig {
  mode?: Mode;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  protectedPaths: { read: string[]; write: string[] };
  reviewer?: ReviewerConfig;
  sandbox?: Partial<SandboxSettings>;
  projects?: Record<string, ProjectOverride>;
}

export interface ProjectOverride {
  mode?: Mode;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  reviewer?: ReviewerConfig;
  sandbox?: Partial<SandboxSettings>;
}

const MODES = new Set(["read-only", "ask", "auto", "yolo"]);

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export const DEFAULT_REVIEWER_TIMEOUT_MS = 15_000;
export const DEFAULT_REVIEWER_MAX_PER_SESSION = 100;

function parseReviewer(value: unknown): ReviewerConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const model = typeof raw.model === "string" && raw.model.length > 0 ? raw.model : undefined;
  if (model && model !== "jev" && model !== "none" && !model.includes("/")) return undefined;
  return {
    model,
    timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_REVIEWER_TIMEOUT_MS,
    maxPerSession:
      typeof raw.maxPerSession === "number" && Number.isSafeInteger(raw.maxPerSession) && raw.maxPerSession > 0
        ? raw.maxPerSession
        : DEFAULT_REVIEWER_MAX_PER_SESSION,
  };
}

function parseSandbox(value: unknown): Partial<SandboxSettings> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const out: Partial<SandboxSettings> = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (raw.network === "on" || raw.network === "off") out.network = raw.network;
  const allowWrite = asStringList(raw.allowWrite);
  if (allowWrite.length) out.allowWrite = allowWrite;
  const denyRead = asStringList(raw.denyRead);
  if (denyRead.length) out.denyRead = denyRead;
  return out;
}

function parseOverride(value: unknown): ProjectOverride | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const mode = typeof raw.mode === "string" && MODES.has(raw.mode) ? (raw.mode as Mode) : undefined;
  const reviewer = parseReviewer(raw.reviewer);
  const sandbox = parseSandbox(raw.sandbox);
  return {
    mode,
    allow: asStringList(raw.allow),
    ask: asStringList(raw.ask),
    deny: asStringList(raw.deny),
    additionalDirectories: asStringList(raw.additionalDirectories),
    ...(reviewer ? { reviewer } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
}

/** Parse a config file. Invalid JSON or a wrong top-level type is a warning, not a crash. */
export function parsePermFile(text: string): { config?: PermFileConfig; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `invalid JSON: ${String(error)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "top level must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const config: PermFileConfig = {
    allow: asStringList(obj.allow),
    ask: asStringList(obj.ask),
    deny: asStringList(obj.deny),
    additionalDirectories: asStringList(obj.additionalDirectories),
    protectedPaths: {
      read: asStringList((obj.protectedPaths as Record<string, unknown> | undefined)?.read),
      write: asStringList((obj.protectedPaths as Record<string, unknown> | undefined)?.write),
    },
  };
  if (typeof obj.mode === "string" && MODES.has(obj.mode)) config.mode = obj.mode as Mode;
  const reviewer = parseReviewer(obj.reviewer);
  if (reviewer) config.reviewer = reviewer;
  const sandbox = parseSandbox(obj.sandbox);
  if (sandbox) config.sandbox = sandbox;
  if (typeof obj.projects === "object" && obj.projects !== null) {
    config.projects = {};
    for (const [key, value] of Object.entries(obj.projects as Record<string, unknown>)) {
      const override = parseOverride(value);
      if (override) config.projects[key] = override;
    }
  }
  return { config };
}

export function loadPermFile(file: string): { config: PermFileConfig; warning?: string } {
  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed = parsePermFile(text);
    if (!parsed.config) return { config: emptyConfig(), warning: `${file}: ${parsed.error}` };
    return { config: parsed.config };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { config: emptyConfig() };
    return { config: emptyConfig(), warning: `${file}: ${String(error)}` };
  }
}

export function emptyConfig(): PermFileConfig {
  return { allow: [], ask: [], deny: [], additionalDirectories: [], protectedPaths: { read: [], write: [] } };
}

export interface MergedConfig {
  /** Effective mode candidates; resolved per §5.2 order by the caller. */
  globalMode?: Mode;
  projectMode?: Mode;
  projectTrusted: boolean;
  rules: { kind: "allow" | "ask" | "deny"; text: string; source: "global" | "project" | "project-rules" }[];
  additionalDirectories: string[];
  protectedRead: string[];
  protectedWrite: string[];
  /** `!`-prefixed exclusions from the global file; honored for reads only. */
  protectedReadExclude: string[];
  reviewer?: ReviewerConfig;
  sandbox: SandboxSettings;
  warnings: string[];
}

const EXCLUDE_PREFIX = "!";

/** Split `protectedPaths` entries into includes and `!`-prefixed exclusions. */
function splitProtected(entries: string[]): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const entry of entries) {
    const text = entry.trim();
    if (!text) continue;
    if (!text.startsWith(EXCLUDE_PREFIX)) {
      include.push(text);
      continue;
    }
    const pattern = text.slice(EXCLUDE_PREFIX.length).trim();
    if (pattern) exclude.push(pattern);
  }
  return { include, exclude };
}

/**
 * Merge global + global.projects[cwd] + project config under the trust rules:
 * an untrusted project can only tighten (ask/deny/protectedPaths/mode-stricter).
 */
export function mergeConfig(globalFile: string, projectFile: string, trusted: boolean, cwdKey: string): MergedConfig {
  const global = loadPermFile(globalFile);
  const project = loadPermFile(projectFile);
  const warnings = [global.warning, project.warning].filter((warning): warning is string => Boolean(warning));
  const rules: MergedConfig["rules"] = [];
  const push = (kind: "allow" | "ask" | "deny", texts: string[], source: "global" | "project" | "project-rules"): void => {
    for (const text of texts) rules.push({ kind, text, source });
  };

  push("allow", global.config.allow, "global");
  push("ask", global.config.ask, "global");
  push("deny", global.config.deny, "global");

  const perProject = global.config.projects?.[cwdKey];
  if (perProject) {
    push("allow", perProject.allow, "project-rules");
    push("ask", perProject.ask, "project-rules");
    push("deny", perProject.deny, "project-rules");
  }

  // Project file: deny/ask/protectedPaths always apply; allow/additionalDirs only when trusted.
  push("ask", project.config.ask, "project");
  push("deny", project.config.deny, "project");
  if (trusted) {
    push("allow", project.config.allow, "project");
  }

  const additionalDirectories = [
    ...global.config.additionalDirectories,
    ...(perProject?.additionalDirectories ?? []),
    ...(trusted ? project.config.additionalDirectories : []),
  ];

  // Project mode: trusted → applies as-is; untrusted → only when stricter than global.
  let projectMode = project.config.mode;
  if (!trusted && projectMode && global.config.mode && modeRank(projectMode) > modeRank(global.config.mode)) {
    projectMode = undefined;
  }

  // Reviewer: only from sources that may loosen (global, per-project, trusted project file).
  const reviewer = (trusted ? project.config.reviewer : undefined) ?? perProject?.reviewer ?? global.config.reviewer;

  // Sandbox merges like the rest: an untrusted project may tighten (enable,
  // network "off", denyRead) but not loosen (disable, extra allowWrite).
  const gs = global.config.sandbox ?? {};
  const ps = perProject?.sandbox ?? {};
  const prs = project.config.sandbox ?? {};
  const sandbox: SandboxSettings = {
    enabled: trusted ? (prs.enabled ?? ps.enabled ?? gs.enabled ?? false) : Boolean(gs.enabled ?? ps.enabled) || prs.enabled === true,
    network: gs.network === "off" || ps.network === "off" || prs.network === "off" ? "off" : "on",
    allowWrite: [...(gs.allowWrite ?? []), ...(ps.allowWrite ?? []), ...(trusted ? (prs.allowWrite ?? []) : [])],
    denyRead: [...(gs.denyRead ?? []), ...(ps.denyRead ?? []), ...(prs.denyRead ?? [])],
  };

  const globalRead = splitProtected(global.config.protectedPaths.read);
  const globalWrite = splitProtected(global.config.protectedPaths.write);
  const projectRead = splitProtected(project.config.protectedPaths.read);
  const projectWrite = splitProtected(project.config.protectedPaths.write);
  // Exclusions loosen, so only the user's own global file may carry them: a
  // repository cannot unprotect its `.env`, and write protection is never
  // liftable at all (the model must not grant itself writes to pi's config).
  if (projectRead.exclude.length > 0 || projectWrite.exclude.length > 0) {
    warnings.push(`${projectFile}: protectedPaths "!" exclusions are ignored outside the global config`);
  }
  if (globalWrite.exclude.length > 0) {
    warnings.push(`${globalFile}: protectedPaths.write does not support "!" exclusions (write protection cannot be lifted)`);
  }

  return {
    globalMode: perProject?.mode ?? global.config.mode,
    projectMode,
    projectTrusted: trusted,
    rules,
    additionalDirectories,
    protectedRead: [...globalRead.include, ...projectRead.include],
    protectedReadExclude: globalRead.exclude,
    protectedWrite: [...globalWrite.include, ...projectWrite.include],
    reviewer,
    sandbox,
    warnings,
  };
}

/** Atomic JSON write: tmp file in the same directory + rename. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Merge a rule into `projects[<cwdKey>].allow` of the global file. */
export function appendProjectAllowRule(globalFile: string, cwdKey: string, rule: string): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Missing or broken file: start fresh rather than preserving garbage.
  }
  const projects = (typeof raw.projects === "object" && raw.projects !== null ? raw.projects : {}) as Record<string, unknown>;
  const entry = (typeof projects[cwdKey] === "object" && projects[cwdKey] !== null ? projects[cwdKey] : {}) as Record<string, unknown>;
  const allow = asStringList(entry.allow);
  if (!allow.includes(rule)) allow.push(rule);
  entry.allow = allow;
  projects[cwdKey] = entry;
  raw.projects = projects;
  writeJsonAtomic(globalFile, raw);
}

/** Merge a directory into `projects[<cwdKey>].additionalDirectories` of the global file. */
export function appendAdditionalDirectory(globalFile: string, cwdKey: string, directory: string): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Missing or broken file: start fresh rather than preserving garbage.
  }
  const projects = (typeof raw.projects === "object" && raw.projects !== null ? raw.projects : {}) as Record<string, unknown>;
  const entry = (typeof projects[cwdKey] === "object" && projects[cwdKey] !== null ? projects[cwdKey] : {}) as Record<string, unknown>;
  const directories = asStringList(entry.additionalDirectories);
  if (!directories.includes(directory)) directories.push(directory);
  entry.additionalDirectories = directories;
  projects[cwdKey] = entry;
  raw.projects = projects;
  writeJsonAtomic(globalFile, raw);
}

/** Persist the session mode into the global file ("/permissions mode x --save"). */
export function saveGlobalMode(globalFile: string, mode: Mode): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Fresh file is fine.
  }
  raw.mode = mode;
  writeJsonAtomic(globalFile, raw);
}

/** Persist sandbox.enabled into the global file ("/permissions sandbox on|off --save"). */
export function saveGlobalSandboxEnabled(globalFile: string, enabled: boolean): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Fresh file is fine.
  }
  const sandbox = (typeof raw.sandbox === "object" && raw.sandbox !== null ? raw.sandbox : {}) as Record<string, unknown>;
  sandbox.enabled = enabled;
  raw.sandbox = sandbox;
  writeJsonAtomic(globalFile, raw);
}
