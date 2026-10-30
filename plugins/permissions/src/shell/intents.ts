/**
 * Extract extra read/write path intents from shell sub-commands (§4.3.4):
 * redirects, known file-reading commands, and file-writing commands.
 */

import type { Intent, PolicyEnv, ShellCommand, ShellRedirect } from "../types.ts";
import { normalizePath } from "../paths.ts";

/** cat/head/…/strings read every non-option operand. */
const READ_ALL = new Set(["cat", "head", "tail", "less", "more", "base64", "xxd", "od", "strings"]);
/** grep/rg need option-aware pattern and path extraction. */
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

/** Unknown options fail closed: their value arity may change operand roles. */
function searchPaths(command: ShellCommand, out: Extracted): (string | undefined)[] {
  const operands: (string | undefined)[] = [];
  const patternFiles: (string | undefined)[] = [];
  const valueOptions = new Set(["after-context", "before-context", "context", "max-count", "binary-files", "directories", "devices", "exclude", "exclude-dir", "include", "label", "glob", "iglob", "type", "type-not", "encoding", "max-depth", "max-filesize", "threads", "sort", "sortr"]);
  const flags = new Set(["ignore-case", "case-sensitive", "smart-case", "invert-match", "word-regexp", "line-regexp", "fixed-strings", "extended-regexp", "basic-regexp", "perl-regexp", "line-number", "no-line-number", "with-filename", "no-filename", "count", "files-with-matches", "files-without-match", "only-matching", "quiet", "silent", "recursive", "dereference-recursive", "text", "binary", "null", "null-data", "no-messages", "hidden", "no-ignore", "no-heading", "heading", "stats", "files", "follow", "multiline", "crlf", "version", "help"]);
  let explicitPattern = false;
  let optionsDone = false;
  const shortValues = command.name === "rg" ? "efABCmgtTjE" : "efABCmDd";
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    if (!optionsDone && arg === "--") { optionsDone = true; continue; }
    if (optionsDone || arg === "-" || !arg?.startsWith("-")) {
      if (arg === undefined) out.unresolved ??= "dynamic-path";
      operands.push(arg);
      continue;
    }
    const consume = (option: string, attached: string | undefined): void => {
      const value = attached ?? command.args[++index];
      if (value === undefined) out.unresolved ??= "dynamic-path";
      if (option === "e" || option === "regexp") explicitPattern = true;
      if (option === "f" || option === "file") {
        explicitPattern = true;
        patternFiles.push(value);
      }
    };
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const option = arg.slice(2, equal < 0 ? undefined : equal);
      if ((option === "color" || option === "colour") && command.name !== "rg") {
        // grep's optional color value is accepted only after '='.
      } else if (option === "regexp" || option === "file" || valueOptions.has(option) || option === "color") {
        consume(option, equal < 0 ? undefined : arg.slice(equal + 1));
      } else if (!flags.has(option) || equal >= 0) out.unresolved ??= "unknown-search-option";
      if (option === "files") explicitPattern = true;
    } else {
      for (let offset = 1; offset < arg.length; offset += 1) {
        const option = arg[offset]!;
        if (shortValues.includes(option)) {
          consume(option, offset + 1 < arg.length ? arg.slice(offset + 1) : undefined);
          break;
        }
        if (!"ivwxFEPGnhHclLoqsrRaIzZUuSV?bNT".includes(option)) out.unresolved ??= "unknown-search-option";
      }
    }
  }
  return [...patternFiles, ...operands.slice(explicitPattern ? 0 : 1)];
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
 * Operands of an in-place `sed`, with the option bundle and the script skipped.
 *
 * `sed -i 's/x/y/' file` and macOS's `sed -i '' 's/x/y/' file` both have to
 * yield just `file`. `nonOptionArgs` cannot be used here because it treats the
 * value of `-e`/`-f` as an operand and does not know that `-i` may take a
 * backup suffix as a separate word.
 */
function sedInPlaceOperands(command: ShellCommand): (string | undefined)[] | undefined {
  let inPlace = false;
  let scriptOption = false;
  const operands: (string | undefined)[] = [];
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    if (arg === undefined) {
      operands.push(undefined);
      continue;
    }
    if (arg === "--") {
      operands.push(...command.args.slice(index + 1));
      break;
    }
    if (arg === "-i" || arg === "--in-place") {
      inPlace = true;
      // macOS accepts a backup suffix as the next word; GNU attaches it.
      if (command.args[index + 1] === "") index += 1;
      continue;
    }
    if (arg.startsWith("--in-place=")) {
      inPlace = true;
      continue;
    }
    if (arg.startsWith("-i") && !arg.startsWith("--")) {
      inPlace = true;
      continue;
    }
    if (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file") {
      scriptOption = true;
      index += 1;
      continue;
    }
    if ((arg.startsWith("-e") || arg.startsWith("-f")) && arg.length > 2 && !arg.startsWith("--")) {
      scriptOption = true;
      continue;
    }
    if (arg !== "-" && arg.startsWith("-")) continue;
    operands.push(arg);
  }
  if (!inPlace) return undefined;
  // Without -e/-f the first operand is the script expression, not a file.
  return scriptOption ? operands : operands.slice(1);
}

/** Operands of `tar`, with old-style bundles (`czf`) and options removed. */
function tarOperands(command: ShellCommand): { operands: (string | undefined)[]; letters: string } {
  const operands: (string | undefined)[] = [];
  const bundles: string[] = [];
  let bundleSeen = false;
  for (const arg of command.args) {
    if (arg === undefined) {
      operands.push(undefined);
      continue;
    }
    if (arg === "--") continue;
    if (arg !== "-" && arg.startsWith("-")) {
      if (/^-[A-Za-z]+$/.test(arg)) bundles.push(arg.slice(1));
      bundleSeen = true;
      continue;
    }
    // Old-style `tar czf …`: the first bare word is the option bundle.
    if (!bundleSeen && /^[A-Za-z]+$/.test(arg)) {
      bundles.push(arg);
      bundleSeen = true;
      continue;
    }
    operands.push(arg);
  }
  return { operands, letters: bundles.join("") };
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
    for (const arg of searchPaths(command, out)) pathIntent("read", arg, arg ?? "?", command, env, out);
  } else if (COPY.has(command.name)) {
    for (const arg of args.slice(0, -1)) pathIntent("read", arg, arg ?? "?", command, env, out);
    if (args.length > 0) pathIntent("write", args[args.length - 1], args[args.length - 1] ?? "?", command, env, out);
  } else if (command.name === "mv") {
    for (const arg of args) pathIntent("write", arg, arg ?? "?", command, env, out);
  } else if (command.name === "ln") {
    // A hard link exposes an existing inode at another path; a symbolic link
    // does not open its source. Conservatively protect hard-link sources.
    if (!command.args.some((arg) => typeof arg === "string" && (arg === "--symbolic" || /^-[^-]*s/u.test(arg)))) {
      for (const arg of args.slice(0, -1)) pathIntent("read", arg, arg ?? "?", command, env, out);
    }
    if (args.length > 0) pathIntent("write", args[args.length - 1], args[args.length - 1] ?? "?", command, env, out);
  } else if (command.name === "sed") {
    // `sed -i` is the shortest route around a protected-write rule that only
    // understands redirects and `tee`: `sed -i '…' ~/.bashrc` rewrites the
    // file in place with no redirect at all.
    const targets = sedInPlaceOperands(command);
    if (targets) for (const arg of targets) pathIntent("write", arg, arg ?? "?", command, env, out);
  } else if (command.name === "patch") {
    // `patch FILE < diff` edits FILE in place; a second operand is the patch.
    if (args.length > 0) pathIntent("write", args[0], args[0] ?? "?", command, env, out);
    if (args.length > 1) pathIntent("read", args[1], args[1] ?? "?", command, env, out);
  } else if (command.name === "dd") {
    for (const arg of command.args) {
      if (typeof arg !== "string") continue;
      if (arg.startsWith("if=")) pathIntent("read", arg.slice(3), arg, command, env, out);
      else if (arg.startsWith("of=")) pathIntent("write", arg.slice(3), arg, command, env, out);
    }
  } else if (command.name === "tar") {
    // `tar czf - ~/.ssh` reads the credential directory; `tar xf archive`
    // writes into the working directory. The archive itself is a write when
    // creating and a read when extracting.
    const { operands, letters } = tarOperands(command);
    const extracting = /[xX]/.test(letters);
    const creating = /[cC]/.test(letters);
    if (extracting) {
      if (operands.length > 0) pathIntent("read", operands[0], operands[0] ?? "?", command, env, out);
    } else if (creating) {
      // `-` is an archive written to stdout, not a path.
      if (operands.length > 0 && operands[0] !== "-") {
        pathIntent("write", operands[0], operands[0] ?? "?", command, env, out);
      }
      for (const arg of operands.slice(1)) pathIntent("read", arg, arg ?? "?", command, env, out);
    } else {
      for (const arg of operands) pathIntent("read", arg, arg ?? "?", command, env, out);
    }
  } else if (command.name === "zip") {
    // `zip -r out.zip ~/.aws`: archive is the write, sources are reads.
    if (args.length > 0) pathIntent("write", args[0], args[0] ?? "?", command, env, out);
    for (const arg of args.slice(1)) pathIntent("read", arg, arg ?? "?", command, env, out);
  } else if (command.name === "unzip") {
    if (args.length > 0) pathIntent("read", args[0], args[0] ?? "?", command, env, out);
    for (const arg of args.slice(1)) pathIntent("write", arg, arg ?? "?", command, env, out);
  } else if (WRITE_TARGETS.has(command.name)) {
    for (const arg of args) pathIntent("write", arg, arg ?? "?", command, env, out);
  }
  return out;
}
