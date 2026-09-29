/**
 * The serialized approval prompt (§5.4). At most one dialog is ever up:
 * concurrent tool calls queue behind a promise chain.
 */

import type { Classification, PolicyEnv } from "./types.ts";

export interface PromptDeps {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  signal?: AbortSignal;
}

export interface PromptOutcome {
  outcome: "allow-once" | "allow-session" | "allow-always" | "allow-directory" | "deny";
  /** User feedback attached to a denial. */
  feedback?: string;
  /** Generated allow rule(s) for session/always choices. */
  rules: string[];
  /** Directory granted by `allow-directory` (persisted to additionalDirectories). */
  directory?: string;
}

export const OPT_ALLOW_ONCE = "Allow once";
export const OPT_ALLOW_SESSION = "Allow for this session";
export const OPT_ALLOW_ALWAYS = "Always allow in this project";
export const OPT_DENY = "Deny";
export const OPT_DENY_FEEDBACK = "Deny with feedback…";

/** Label for the directory grant offered on a dangerous call outside the workspace. */
export function optionAllowDirectory(directory: string): string {
  return `Always allow this directory: ${directory}`;
}

/**
 * The tool call's text with control characters stripped; newlines and tabs
 * stay, so multi-line code (heredocs) keeps its structure. Unbounded — the
 * reviewer bounds its own payload. The dialog must not use this: a command
 * cut mid-token reads as an unparseable call and biases the reviewer to `ask`.
 */
export function describeInput(tool: string, input: Record<string, unknown>): string {
  const key =
    (typeof input.command === "string" && input.command) ||
    (typeof input.path === "string" && input.path) ||
    JSON.stringify(input);
  return String(key).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}

/** One line, bounded — what the approval dialog shows. */
export function summarizeInput(tool: string, input: Record<string, unknown>): string {
  const flat = describeInput(tool, input).replace(/\s*\n\s*/gu, " ");
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

/**
 * The narrowest generated allow rules for this call (§5.4):
 * bash → `bash(<name> <firstOperand>:*)` per exec intent; path tools →
 * `<tool>(<abs path>)`; anything else → bare `<tool>`.
 */
export function buildAllowRules(classification: Classification, env: PolicyEnv): string[] {
  const rules = new Set<string>();
  for (const intent of classification.intents) {
    if (intent.kind === "exec" && intent.command) {
      const command = intent.command;
      // Skip dynamic commands: they cannot be safely generalized.
      if (command.args.includes(undefined)) {
        rules.add(`${intent.tool}(${command.name}:*)`);
        continue;
      }
      const firstOperand = command.args.find((arg) => typeof arg === "string" && !arg.startsWith("-") && arg !== command.name);
      rules.add(`${intent.tool}(${firstOperand ? `${command.name} ${firstOperand}` : command.name}:*)`);
    } else if ((intent.kind === "read" || intent.kind === "write") && intent.path) {
      const tool = intent.tool === "bash" || intent.tool === "powershell" ? (intent.kind === "read" ? "read" : "write") : intent.tool;
      rules.add(`${tool}(${intent.path})`);
    } else if (intent.kind === "other") {
      rules.add(intent.tool);
    }
  }
  return [...rules];
}

export function createPrompter(): { ask(opts: {
  dangerous: boolean;
  readOnly: boolean;
  toolName: string;
  reason: string;
  summary: string;
  allowRules: string[];
  /** Directory the user may grant to make this dangerous call ordinary. */
  grantDirectory?: string;
  deps: PromptDeps;
}): Promise<PromptOutcome> } {
  let queue: Promise<unknown> = Promise.resolve();
  const ask = (opts: Parameters<typeof run>[0]): Promise<PromptOutcome> => {
    const result = queue.then(() => run(opts));
    queue = result.catch(() => undefined);
    return result;
  };
  return { ask };

  async function run(opts: {
    dangerous: boolean;
    readOnly: boolean;
    toolName: string;
    reason: string;
    summary: string;
    allowRules: string[];
    grantDirectory?: string;
    deps: PromptDeps;
  }): Promise<PromptOutcome> {
    const title = `[pi-permissions] ${opts.dangerous ? "DANGEROUS" : "Approve"} ${opts.toolName}\n${opts.reason}\n${opts.summary}`;
    const directoryOption = opts.grantDirectory ? optionAllowDirectory(opts.grantDirectory) : undefined;
    const options = [OPT_ALLOW_ONCE];
    if (!opts.dangerous) {
      options.push(OPT_ALLOW_SESSION);
      if (!opts.readOnly) options.push(OPT_ALLOW_ALWAYS);
    } else if (directoryOption) {
      // Dangerous calls offer no rule-based grant (a rule cannot lift the tier),
      // but a directory the user vouches for is exactly what additionalDirectories
      // is for — the same shape as the workspace itself.
      options.push(directoryOption);
    }
    options.push(OPT_DENY, OPT_DENY_FEEDBACK);
    const choice = await opts.deps.select(title, options, { signal: opts.deps.signal });
    if (choice === OPT_ALLOW_ONCE) return { outcome: "allow-once", rules: opts.allowRules };
    if (choice === OPT_ALLOW_SESSION) return { outcome: "allow-session", rules: opts.allowRules };
    if (choice === OPT_ALLOW_ALWAYS) return { outcome: "allow-always", rules: opts.allowRules };
    if (directoryOption && choice === directoryOption) {
      return { outcome: "allow-directory", rules: [], directory: opts.grantDirectory };
    }
    if (choice === OPT_DENY_FEEDBACK) {
      const feedback = await opts.deps.input("Tell the agent why (optional)", undefined, { signal: opts.deps.signal });
      return { outcome: "deny", rules: [], feedback: feedback ?? undefined };
    }
    // OPT_DENY or undefined (cancelled/dismissed): deny either way.
    return { outcome: "deny", rules: [] };
  }
}
