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
export const OPT_DENY_FEEDBACK = "Deny and explain to the agent…";

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

/** Longest command lines the dialog keeps verbatim before folding the rest. */
const COMMAND_BLOCK_LINES = 4;
/** Soft-wrap column: past this a line folds rather than being cut mid-token. */
const COMMAND_BLOCK_WIDTH = 80;
/** Raw characters formatted before the block folds, with the elision stated. */
const COMMAND_BLOCK_MAX_CHARS = 600;

/**
 * The command as an indented block — what the approval dialog shows.
 *
 * Newlines survive on purpose. Flattening a heredoc, a pipeline or a
 * multi-line `python -c` into one line destroys the structure a reviewer needs
 * in order to see an injection in, which is the one thing this dialog exists
 * for. A line past the wrap column folds instead of being cut, because a cut
 * reads as a different command than the one about to run.
 *
 * Every elision is stated, in lines or in characters. A silently shortened
 * command is the failure mode this replaces: the dialog would show a command
 * that is not the one about to run.
 */
export function formatCommandBlock(command: string): string {
  const truncated = command.length > COMMAND_BLOCK_MAX_CHARS;
  const bounded = truncated ? command.slice(0, COMMAND_BLOCK_MAX_CHARS) : command;
  const lines = bounded.split("\n");
  const kept: string[] = [];
  for (const line of lines.slice(0, COMMAND_BLOCK_LINES)) {
    if (line.length <= COMMAND_BLOCK_WIDTH) {
      kept.push(`  ${line}`);
      continue;
    }
    for (let index = 0; index < line.length; index += COMMAND_BLOCK_WIDTH) {
      kept.push(`  ${line.slice(index, index + COMMAND_BLOCK_WIDTH)}`);
    }
  }
  const hiddenLines = lines.length - COMMAND_BLOCK_LINES;
  if (hiddenLines > 0) kept.push(`  … ${hiddenLines} more lines`);
  else if (truncated) kept.push(`  … ${command.length - COMMAND_BLOCK_MAX_CHARS} more characters`);
  return kept.join("\n");
}

/** The bounded command block for the approval dialog. */
export function summarizeInput(tool: string, input: Record<string, unknown>): string {
  // Not pre-sliced: `formatCommandBlock` bounds the text itself and is the only
  // place that knows an elision happened, so it is the only place that can
  // state it. Slicing here would hide the cut from the marker.
  return formatCommandBlock(describeInput(tool, input));
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
        return [];
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

export interface PromptOptions {
  dangerous: boolean;
  readOnly: boolean;
  toolName: string;
  reason: string;
  summary: string;
  allowRules: string[];
  allowSession: boolean;
  grantDirectory?: string;
  deps: PromptDeps;
}

/** Serialize the entire approval transaction, including applying its grant. */
export function createPrompter() {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    withApproval<T>(task: (ask: typeof run) => Promise<T>): Promise<T> {
      const result = queue.then(() => task(run));
      queue = result.catch(() => undefined);
      return result;
    },
  };

  async function run(opts: PromptOptions): Promise<PromptOutcome> {
    // Labelled fields, not one run-on line: tool, reason and target are three
    // different kinds of fact, and a reviewer has about a second to find the
    // one that matters before deciding.
    const title = [
      `[pi-permissions] ${opts.dangerous ? "DANGEROUS" : "Approve"} ${opts.toolName}`,
      `Reason: ${opts.reason}`,
      "Target:",
      opts.summary,
    ].join("\n");
    const directoryOption = opts.grantDirectory ? optionAllowDirectory(opts.grantDirectory) : undefined;
    // A terminal `select` focuses its first option, so the order *is* the
    // default. "Allow once" first on a dangerous call trains a carriage-return
    // reflex that authorises exactly the calls this tier exists to stop; deny
    // has to be the option the reflex reaches.
    const options: string[] = [];
    if (opts.dangerous) {
      options.push(OPT_DENY, OPT_DENY_FEEDBACK, OPT_ALLOW_ONCE);
      // Dangerous calls offer no rule-based grant (a rule cannot lift the tier),
      // but a directory the user vouches for is exactly what additionalDirectories
      // is for — the same shape as the workspace itself.
      if (directoryOption) options.push(directoryOption);
    } else {
      options.push(OPT_ALLOW_ONCE);
      if (opts.allowSession) {
        options.push(OPT_ALLOW_SESSION);
        if (!opts.readOnly && opts.allowRules.length > 0) options.push(OPT_ALLOW_ALWAYS);
      }
      options.push(OPT_DENY, OPT_DENY_FEEDBACK);
    }
    const choice = await opts.deps.select(title, options, { signal: opts.deps.signal });
    if (opts.deps.signal?.aborted || !choice || !options.includes(choice)) return { outcome: "deny", rules: [] };
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
