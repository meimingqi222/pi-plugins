/**
 * Permission config files (§5.1–5.2): global `~/.pi/agent/permissions.json`
 * plus project `<cwd>/.pi/permissions.json`. Untrusted project files can only
 * tighten. All writes go through a temp-file + rename so concurrent pi
 * processes cannot corrupt the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { modeRank } from "./types.ts";
import type { Mode } from "./types.ts";

export interface PermFileConfig {
  mode?: Mode;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  protectedPaths: { read: string[]; write: string[] };
  projects?: Record<string, ProjectOverride>;
}

export interface ProjectOverride {
  mode?: Mode;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
}

const MODES = new Set(["read-only", "ask", "auto", "yolo"]);

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseOverride(value: unknown): ProjectOverride | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const mode = typeof raw.mode === "string" && MODES.has(raw.mode) ? (raw.mode as Mode) : undefined;
  return {
    mode,
    allow: asStringList(raw.allow),
    ask: asStringList(raw.ask),
    deny: asStringList(raw.deny),
    additionalDirectories: asStringList(raw.additionalDirectories),
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
  warnings: string[];
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

  return {
    globalMode: perProject?.mode ?? global.config.mode,
    projectMode,
    projectTrusted: trusted,
    rules,
    additionalDirectories,
    protectedRead: [...global.config.protectedPaths.read, ...project.config.protectedPaths.read],
    protectedWrite: [...global.config.protectedPaths.write, ...project.config.protectedPaths.write],
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
