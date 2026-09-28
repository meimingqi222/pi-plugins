/**
 * User rule syntax (§5.3): `<tool>` or `<tool>(<pattern>)` with allow/ask/deny
 * kinds. deny > ask > allow. Rules are matched against intents, not raw text.
 */

import { matchGlob } from "./glob.ts";
import { normalizePath } from "./paths.ts";
import type { GradedIntent, PolicyEnv } from "./types.ts";

export type RuleKind = "allow" | "ask" | "deny";
export type RuleSource = "global" | "project" | "project-rules" | "session";

export interface UserRule {
  raw: string;
  kind: RuleKind;
  source: RuleSource;
  tool: string;
  /** Parameter inside parens; undefined for the bare `<tool>` form. */
  pattern?: string;
  /** pattern ends with ":*" → prefix match for shell rules. */
  prefix: boolean;
  valid: boolean;
  invalidReason?: string;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export function parseRule(raw: string, kind: RuleKind, source: RuleSource): UserRule {
  const rule: UserRule = { raw, kind, source, tool: "", prefix: false, valid: false };
  const match = /^([a-z_][a-z0-9_-]*)(?:\((.*)\))?$/isu.exec(raw.trim());
  if (!match) {
    rule.invalidReason = "unparseable rule";
    return rule;
  }
  rule.tool = match[1]!.toLowerCase();
  let pattern = match[2];
  if (pattern !== undefined) {
    pattern = pattern.trim();
    if (pattern === "") {
      rule.invalidReason = "empty pattern";
      return rule;
    }
    if (SHELL_TOOLS.has(rule.tool)) {
      if (pattern.endsWith(":*")) {
        rule.prefix = true;
        pattern = pattern.slice(0, -2);
      }
    } else if (pattern.endsWith(":*")) {
      rule.invalidReason = ":* prefix is only valid for bash/powershell";
      return rule;
    }
    if (!PATH_TOOLS.has(rule.tool) && !SHELL_TOOLS.has(rule.tool)) {
      rule.invalidReason = `tool "${rule.tool}" does not take a pattern`;
      return rule;
    }
    rule.pattern = pattern;
  }
  rule.valid = true;
  return rule;
}

/** Text a shell command is matched against: name + defined args, "?" for dynamic. */
export function commandText(intent: GradedIntent): string {
  const command = intent.command;
  if (!command) return intent.raw ?? "";
  const parts = [command.name];
  for (let index = 0; index < command.args.length; index += 1) {
    parts.push(command.args[index] ?? command.rawArgs[index] ?? "?");
  }
  return parts.join(" ");
}

function shellRuleMatches(rule: UserRule, intent: GradedIntent): boolean {
  if (intent.tool !== rule.tool) return false;
  if (rule.pattern === undefined) return true;
  // Dynamic args make a command ineligible for allow rules (they may match ask/deny).
  if (rule.kind === "allow" && intent.command?.args.includes(undefined)) return false;
  const text = commandText(intent);
  if (rule.prefix) return text === rule.pattern || text.startsWith(`${rule.pattern} `);
  return text === rule.pattern;
}

function pathRuleMatches(rule: UserRule, intent: GradedIntent, env: PolicyEnv): boolean {
  if (intent.kind !== "read" && intent.kind !== "write") return false;
  // Path rules apply to the intent kind, whatever tool produced it.
  const toolMatches =
    (rule.tool === "read" && intent.kind === "read") ||
    (["write", "edit"].includes(rule.tool) && intent.kind === "write") ||
    (["grep", "find", "ls"].includes(rule.tool) && intent.kind === "read" && intent.tool === rule.tool) ||
    intent.tool === rule.tool;
  if (!toolMatches) return false;
  if (rule.pattern === undefined) return true;
  if (!intent.path) return false;
  let pattern = rule.pattern;
  // Unanchored globs (starting with ** or *) match anywhere; others resolve like paths.
  if (!pattern.startsWith("*")) {
    pattern = normalizePath(pattern, env);
  }
  return matchGlob(pattern, intent.path, env);
}

export function ruleMatches(rule: UserRule, intent: GradedIntent, env: PolicyEnv): boolean {
  if (!rule.valid) return false;
  if (SHELL_TOOLS.has(rule.tool)) return shellRuleMatches(rule, intent);
  if (PATH_TOOLS.has(rule.tool)) return pathRuleMatches(rule, intent, env);
  // Bare tool name: matches intents produced by that tool (not derived path intents).
  return intent.tool === rule.tool && intent.kind !== "exec";
}
