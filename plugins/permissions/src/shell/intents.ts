/**
 * Extract extra read/write path intents from shell sub-commands (§4.3.4):
 * redirects, known file-reading commands, and file-writing commands.
 */

import type { Intent, PolicyEnv, ShellCommand, ShellRedirect } from "../types.ts";
import { normalizePath } from "../paths.ts";

/** cat/head/…/strings read every non-option operand. */
const READ_ALL = new Set(["cat", "head", "tail", "less", "more", "base64", "xxd", "od", "strings"]);
/** grep/rg: first non-option operand is the pattern, the rest are files. */
const READ_SKIP_FIRST = new Set(["grep", "rg", "egrep", "fgrep"]);
/** cp/scp/rsync: all but last operand are sources, last is the destination. */
const COPY = new Set(["cp", "scp", "rsync"]);
/** Write-ish commands whose operands are targets. */
const WRITE_TARGETS = new Set(["tee", "touch", "mkdir", "rm", "rmdir", "chmod", "chown", "truncate", "install", "shred", "unlink"]);

/** Redirect/fd targets that carry no file meaning — skip silently. */
const NULL_TARGETS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/tty",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/full",
]);

interface Extracted {
  intents: Intent[];
  unresolved?: string;
}

function nonOptionArgs(command: ShellCommand): { args: (string | undefined)[]; raw: string[] } {
  const args: (string | undefined)[] = [];
  const raw: string[] = [];
  let optionsDone = false;
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    if (!optionsDone && arg === "--") {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && typeof arg === "string" && arg.startsWith("-") && arg !== "-") continue;
    args.push(arg);
    raw.push(command.rawArgs[index] ?? "");
  }
  return { args, raw };
}

function pathIntent(kind: "read" | "write", target: string | undefined, rawTarget: string, command: ShellCommand, env: PolicyEnv, out: Extracted): void {
  if (target === undefined) {
    out.unresolved ??= "dynamic-path";
    return;
  }
  const path = normalizePath(target, env);
  if (NULL_TARGETS.has(path)) return;
  out.intents.push({
    kind,
    tool: "bash",
    path,
    raw: `${command.rawName} ${rawTarget}`.trim(),
  });
}

/**
 * Path intents for one unwrapped command. The caller assigns `sourceIndex`.
 * Dynamic targets set `unresolved` instead of producing an intent.
 */
export function extractPathIntents(command: ShellCommand, env: PolicyEnv): Extracted {
  const out: Extracted = { intents: [] };

  for (const redirect of command.redirects) {
    if (redirect.op === "other") continue;
    const kind = redirect.op === "<" ? "read" : "write";
    pathIntent(kind, redirect.target, redirect.target ?? "?", command, env, out);
  }

  const { args } = nonOptionArgs(command);
  if (READ_ALL.has(command.name)) {
    for (const arg of args) pathIntent("read", arg, arg ?? "?", command, env, out);
  } else if (READ_SKIP_FIRST.has(command.name)) {
    for (const arg of args.slice(1)) pathIntent("read", arg, arg ?? "?", command, env, out);
  } else if (COPY.has(command.name)) {
    for (const arg of args.slice(0, -1)) pathIntent("read", arg, arg ?? "?", command, env, out);
    if (args.length > 0) pathIntent("write", args[args.length - 1], args[args.length - 1] ?? "?", command, env, out);
  } else if (command.name === "mv") {
    for (const arg of args) pathIntent("write", arg, arg ?? "?", command, env, out);
  } else if (command.name === "ln") {
    // Only the link name is created; treat the last operand as the write target.
    if (args.length > 0) pathIntent("write", args[args.length - 1], args[args.length - 1] ?? "?", command, env, out);
  } else if (WRITE_TARGETS.has(command.name)) {
    for (const arg of args) pathIntent("write", arg, arg ?? "?", command, env, out);
  }
  return out;
}
