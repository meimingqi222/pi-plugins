/**
 * Rough PowerShell analysis (§4.4): no real parser — segments on `;`/`|`,
 * tokenizes on whitespace, and applies the same rule engine. Segments that
 * look ambiguous simply land on `grey`.
 */

import { classifyPath, EMPTY_PATH_POLICY, type PathPolicyConfig } from "../path-policy.ts";
import { normalizePath } from "../paths.ts";
import type { GradedIntent, PolicyEnv, ShellAnalysis, ShellCommand, Tier } from "../types.ts";
import { tierRank } from "../types.ts";

const READ_CMDLETS = new Set(["get-content", "gc", "cat", "type"]);
const WRITE_CMDLETS = new Set(["set-content", "out-file", "add-content", "new-item", "remove-item", "copy-item", "move-item", "rename-item"]);

function unquote(token: string): string {
  return token.replace(/^["']|["']$/gu, "");
}

/** Build a ShellAnalysis-shaped result so the shared rule engine can grade it. */
export function analyzePowerShell(text: string, env: PolicyEnv): ShellAnalysis {
  const commands: ShellCommand[] = [];
  const pipelines: number[][] = [];
  // Split pipelines first so `a | b` keeps its grouping, then `;` segments.
  for (const line of text.split(/\r?\n|;/u)) {
    const stages = line.split(/\|/u);
    if (stages.every((stage) => !stage.trim())) continue;
    const group: number[] = [];
    for (const stage of stages) {
      const tokens = stage.trim().split(/\s+/u).filter(Boolean);
      if (tokens.length === 0) continue;
      const name = unquote(tokens[0]!.split(/[\\/]/u).at(-1) ?? tokens[0]!).toLowerCase().replace(/\.exe$/u, "");
      const args: (string | undefined)[] = [];
      const rawArgs: string[] = [];
      const redirects: { op: ">" | ">>" | "<" | "&>" | "other"; target?: string }[] = [];
      for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === ">" || token === ">>") {
          redirects.push({ op: token as ">" | ">", target: tokens[index + 1] === undefined ? undefined : unquote(tokens[++index]!) });
          continue;
        }
        args.push(unquote(token));
        rawArgs.push(token);
      }
      group.push(commands.length);
      commands.push({ name, args, rawArgs, redirects, via: [], rawName: tokens[0]! });
    }
    if (group.length > 0) pipelines.push(group);
  }
  return { commands, pipelines };
}

/** Path intents for powershell commands (§4.4 last bullet). */
export function powerShellPathIntents(command: ShellCommand, env: PolicyEnv): { intents: { kind: "read" | "write"; path: string; raw: string }[] } {
  const intents: { kind: "read" | "write"; path: string; raw: string }[] = [];
  const positional = command.args.filter((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"));
  const flagValue = (flags: string[]): string | undefined => {
    for (let index = 0; index < command.args.length; index += 1) {
      const arg = command.args[index];
      if (typeof arg === "string" && flags.includes(arg.toLowerCase())) {
        const next = command.args[index + 1];
        return typeof next === "string" ? next : undefined;
      }
    }
    return undefined;
  };
  const push = (kind: "read" | "write", target: string | undefined): void => {
    if (!target) return;
    intents.push({ kind, path: normalizePath(target, env), raw: `${command.rawName} ${target}` });
  };
  if (READ_CMDLETS.has(command.name)) {
    push("read", flagValue(["-path", "-literalpath"]) ?? positional[0]);
  } else if (WRITE_CMDLETS.has(command.name)) {
    push("write", flagValue(["-path", "-literalpath", "-destination"]) ?? positional[0]);
    if (command.name === "copy-item" || command.name === "move-item") {
      push("write", flagValue(["-destination"]));
    }
  }
  return { intents };
}

/** Standalone verdict for a `powershell` tool call. */
export function gradePowerShell(text: string, env: PolicyEnv, config: PathPolicyConfig = EMPTY_PATH_POLICY): { intents: GradedIntent[]; tier: Tier; mutating: boolean; ruleId?: string; reason: string } {
  const analysis = analyzePowerShell(text, env);
  const intents: GradedIntent[] = [];
  let tier: Tier = "safe";
  let ruleId: string | undefined;
  let reason = "no commands";
  const bump = (t: Tier, id: string | undefined, why: string): void => {
    if (tierRank(t) > tierRank(tier)) {
      tier = t;
      ruleId = id;
      reason = why;
    }
  };

  const PS_READ_ONLY = /^(?:get-|select-|where-object|sort-object|measure-object|format-|out-string|test-path|resolve-path|write-output|write-host|get-childitem|gci|dir|ls)$/iu;
  const PS_DANGEROUS = /^(?:format-volume|clear-disk|set-executionpolicy|stop-computer|restart-computer)$/iu;
  const joinedLower = text.toLowerCase();

  for (const command of analysis.commands) {
    const intent: GradedIntent = { kind: "exec", tool: "powershell", command, raw: command.rawName, tier: "grey", mutating: true };
    const args = command.args.map((arg) => arg?.toLowerCase() ?? "");
    if (command.name === "remove-item" && args.some((a) => a.startsWith("-recurse")) && args.some((a) => a.startsWith("-force"))) {
      intent.tier = "dangerous";
      intent.ruleId = "windows-destructive";
      intent.reason = "Remove-Item -Recurse -Force";
    } else if (PS_DANGEROUS.test(command.name)) {
      // Format-Volume/Clear-Disk on the system drive is unrecoverable.
      if ((command.name === "format-volume" || command.name === "clear-disk") && args.some((a) => /^"?c:"?$/iu.test(a))) {
        intent.tier = "forbidden";
        intent.ruleId = "disk-format";
        intent.reason = `${command.rawName} on the system drive`;
      } else {
        intent.tier = "dangerous";
        intent.ruleId = "windows-destructive";
        intent.reason = command.rawName;
      }
    } else if (/^(?:remove-itemproperty|set-itemproperty|new-itemproperty)$/u.test(command.name) && args.some((a) => a.startsWith("hklm:"))) {
      intent.tier = "dangerous";
      intent.ruleId = "windows-destructive";
      intent.reason = `${command.rawName} on HKLM:`;
    } else if (PS_READ_ONLY.test(command.name)) {
      intent.tier = "safe";
      intent.mutating = false;
      intent.ruleId = "safe-command";
      intent.reason = "read-only cmdlet";
    }
    intents.push(intent);
    bump(intent.tier, intent.ruleId, intent.reason ?? command.rawName);

    for (const extracted of powerShellPathIntents(command, env).intents) {
      const verdict = classifyPath(extracted.kind, extracted.path, "powershell", env, config);
      intents.push({ kind: extracted.kind, tool: "powershell", path: extracted.path, raw: extracted.raw, tier: verdict.tier, ruleId: verdict.ruleId, reason: verdict.reason, mutating: extracted.kind === "write" });
      bump(verdict.tier, verdict.ruleId, verdict.reason);
    }
  }

  // iex fed by a network fetch is the PowerShell pipe-to-shell.
  if (/\b(?:iex|invoke-expression)\b/u.test(joinedLower) && /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b/u.test(joinedLower)) {
    bump("dangerous", "pipe-to-shell", "remote download piped into Invoke-Expression");
  }
  if (/\bvssadmin\s+delete\s+shadows/u.test(joinedLower)) {
    bump("forbidden", "shadow-copy-delete", "backup deletion");
  }
  if (intents.length === 0) reason = "no commands";
  return { intents, tier, mutating: intents.some((intent) => intent.mutating === true), ruleId, reason };
}
