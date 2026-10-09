/**
 * Static bash analysis on top of `unbash` (design doc §4.3.1–4.3.3).
 *
 * The traversal approach is adapted from Step-Code's shell-analysis.ts /
 * command-policy.ts (MIT, see ATTRIBUTION.md), simplified to what this plugin
 * needs: a flat list of unwrapped commands, their redirects, and pipeline
 * groupings — no variable tracking and no stdin dataflow.
 */

import {
  type Node,
  type ParsedScript,
  type Redirect,
  type Word,
  type WordPart,
  parse,
} from "unbash";
import type { PolicyEnv, ShellAnalysis, ShellCommand, ShellRedirect } from "../types.ts";

const MAX_SOURCE_LENGTH = 128_000;
const MAX_SCRIPT_DEPTH = 12;
const MAX_COMMANDS = 4096;

/** Commands whose tail is the command that actually matters (§4.3.2). */
const WRAPPER_VALUE_OPTS: Readonly<Record<string, readonly string[]>> = {
  builtin: [],
  command: [],
  doas: ["-u", "-C"],
  env: ["-u", "--unset", "-C", "--chdir"],
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  nohup: [],
  setsid: [],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  sudo: ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-D", "--chdir", "-R", "--chroot", "-r", "--role", "-t", "--type"],
  time: ["-f", "--format", "-o", "--output"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-a", "--arg-file", "-E", "-I", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"],
};
const WRAPPER_FLAGS: Readonly<Record<string, readonly string[]>> = {
  builtin: [],
  command: ["-p", "-v", "-V"],
  doas: ["-n", "-L"],
  env: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
  exec: ["-c", "-l"],
  nice: [],
  nohup: [],
  setsid: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"],
  stdbuf: [],
  sudo: ["-n", "--non-interactive", "-E", "--preserve-env", "-H", "--set-home", "-b", "--background", "-k", "-K", "-S", "--stdin"],
  time: ["-p", "--portability", "-v", "--verbose", "-a", "--append"],
  timeout: ["--foreground", "--preserve-status", "-v", "--verbose"],
  xargs: ["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x", "--exit"],
};

const BOURNE_SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const POWER_SHELLS = new Set(["powershell", "pwsh"]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

interface RawInvocation {
  words: (string | undefined)[];
  rawWords: string[];
  redirects: ShellRedirect[];
  pipeline: number;
}

interface PendingScript {
  text: string;
  depth: number;
  dialect: "bash" | "cmd";
}

function normalizeExecutable(word: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const base = word.split(/[\\/]/u).at(-1) ?? word;
    return base.toLowerCase().replace(/\.exe$/u, "");
  }
  const base = word.split("/").at(-1) ?? word;
  return platform === "darwin" ? base.toLowerCase() : base;
}

function redirectOp(operator: string): ShellRedirect["op"] {
  if (operator === ">" || operator === ">>" || operator === "|>") return ">";
  if (operator === "&>" || operator === "&>>") return "&>";
  if (operator === "<") return "<";
  return "other";
}

/** Words that are fully static yield a string; anything dynamic yields undefined. */
function wordValue(word: Word, visitScript: (script: ParsedScript) => void, home: string): string | undefined {
  if (!word.parts) return word.value;
  let value = "";
  for (const part of word.parts) {
    const piece = partValue(part, visitScript, home);
    if (piece === undefined) return undefined;
    value += piece;
  }
  return value;
}

function partValue(part: WordPart, visitScript: (script: ParsedScript) => void, home: string): string | undefined {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
      return part.value;
    case "AnsiCQuoted":
      // $'...' escapes differ across shells; treat as dynamic.
      return undefined;
    case "DoubleQuoted":
    case "LocaleString": {
      let value = "";
      for (const child of part.parts) {
        const piece = partValue(child, visitScript, home);
        if (piece === undefined) return undefined;
        value += piece;
      }
      return value;
    }
    case "CommandExpansion":
    case "ProcessSubstitution":
      if (part.script) visitScript(part.script);
      return undefined;
    case "SimpleExpansion":
      return part.text === "$HOME" ? home : undefined;
    case "ParameterExpansion":
      if (part.text === "${HOME}") return home;
      if (part.operand) wordValue(part.operand, visitScript, home);
      return undefined;
    case "BraceExpansion":
    case "ExtendedGlob":
      if (part.parts) for (const child of part.parts) partValue(child, visitScript, home);
      return undefined;
    default:
      return undefined;
  }
}

/** Unwrap sudo/env/timeout/... and return the real command plus the wrapper chain. */
function unwrapInvocation(raw: RawInvocation, env: PolicyEnv): { command?: ShellCommand; unresolved?: string } {
  let words = raw.words;
  let rawWords = raw.rawWords;
  const via: string[] = [];
  let index = 0;
  while (index < words.length) {
    const executable = words[index];
    if (executable === undefined) return { unresolved: "dynamic-command" };
    const name = normalizeExecutable(executable, env.platform);
    const valueOpts = WRAPPER_VALUE_OPTS[name];
    if (!valueOpts) {
      const args = words.slice(index + 1);
      const rawArgs = rawWords.slice(index + 1);
      // xargs feeds stdin tokens into argv — the last operands are unknowable.
      if (via.includes("xargs")) args.push(undefined);
      return {
        command: {
          name,
          args,
          rawArgs,
          redirects: raw.redirects,
          via,
          rawName: rawWords[index] ?? executable,
        },
      };
    }
    via.push(name);
    index += 1;
    while (index < words.length) {
      const word = words[index];
      if (word === undefined) return { unresolved: "dynamic-wrapper" };
      // env NAME=value assignments are wrapper arguments, not the command.
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
        index += 1;
        continue;
      }
      if (word === "--") {
        index += 1;
        break;
      }
      if (!word.startsWith("-") || word === "-") break;
      if (name === "command" && /^-[^-]*[vV]/u.test(word)) {
        // `command -v` is a lookup, not an exec wrapper.
        return {
          command: { name, args: words.slice(1), rawArgs: rawWords.slice(1), redirects: raw.redirects, via: [], rawName: rawWords[0] ?? name },
        };
      }
      if (name === "env" && (word.startsWith("--split-string") || /^-[^-]*S/u.test(word))) {
        return { unresolved: "wrapper-split-string" };
      }
      index += 1;
      let takesValue = false;
      if (word.startsWith("--")) {
        const eq = word.indexOf("=");
        const option = eq < 0 ? word : word.slice(0, eq);
        if (valueOpts.includes(option)) takesValue = eq < 0;
        else if (eq >= 0 || !WRAPPER_FLAGS[name]?.includes(option)) return { unresolved: "wrapper-options" };
      } else {
        for (let flag = 1; flag < word.length; flag += 1) {
          const token = `-${word[flag]}`;
          if (valueOpts.includes(token)) {
            takesValue = flag === word.length - 1;
            break;
          }
          if (!WRAPPER_FLAGS[name]?.includes(token)) return { unresolved: "wrapper-options" };
        }
      }
      if (takesValue) {
        if (words[index] === undefined) return { unresolved: "dynamic-wrapper" };
        index += 1;
      }
    }
    if (name === "timeout") {
      // DURATION is mandatory; skip it before the wrapped command.
      if (words[index] === undefined) return { unresolved: "dynamic-wrapper" };
      index += 1;
    }
    // The wrapped command starts at `index`; continue unwrapping from there.
    words = words.slice(index);
    rawWords = rawWords.slice(index);
    index = 0;
  }
  return {};
}

/**
 * Analyze one shell text. Returns every sub-command (unwrapped), grouped
 * pipelines, and the first unresolved reason if anything was dynamic.
 */
export function analyzeShell(input: string, env: PolicyEnv): ShellAnalysis {
  const commands: ShellCommand[] = [];
  const pipelines: number[][] = [];
  let unresolved: string | undefined;
  const mark = (reason: string): void => {
    unresolved ??= reason;
  };

  const pending: PendingScript[] = [{ text: input, depth: 0, dialect: "bash" }];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const next = pending.shift()!;
    if (next.depth > MAX_SCRIPT_DEPTH) {
      mark("analysis-limit");
      continue;
    }
    if (seen.has(next.text)) continue;
    seen.add(next.text);

    if (next.dialect === "cmd") {
      // cmd /c or powershell -Command payloads: split on ; & | and tokenize.
      for (const segment of next.text.split(/[;&|]+/u)) {
        const tokens = segment.trim().split(/\s+/u).filter(Boolean);
        if (tokens.length === 0) continue;
        const raw: RawInvocation = { words: tokens, rawWords: tokens, redirects: [], pipeline: pipelines.length };
        const unwrapped = unwrapInvocation(raw, env);
        if (!unwrapped.command) {
          mark(unwrapped.unresolved ?? "dynamic-command");
          continue;
        }
        pipelines.push([commands.length]);
        commands.push(unwrapped.command);
      }
      continue;
    }

    if (next.text.length > MAX_SOURCE_LENGTH) {
      mark("analysis-limit");
      continue;
    }
    let script: ParsedScript;
    try {
      script = parse(next.text);
    } catch {
      mark("parse-error");
      continue;
    }
    if (script.errors?.length) mark("parse-error");

    const invocations: RawInvocation[] = [];
    let pipelineCount = 0;

    const visitScript = (nested: ParsedScript): void => {
      for (const statement of nested.commands) visitNode(statement);
    };

    const collectRedirects = (redirects: readonly Redirect[], into: ShellRedirect[]): void => {
      for (const redirect of redirects) {
        const op = redirectOp(redirect.operator);
        // Keep every redirect: intents only consume file ops, but rules inspect
        // "other" targets too (e.g. `>& /dev/tcp/…` for reverse-shell).
        const target = redirect.target ? wordValue(redirect.target, visitScript, env.home) : undefined;
        into.push({ op, target });
      }
    };

    function visitNode(node: Node, pipeline?: number): void {
      switch (node.type) {
        case "Command": {
          const redirects: ShellRedirect[] = [];
          collectRedirects(node.redirects, redirects);
          if (!node.name) return;
          const words = [node.name, ...node.suffix].map((word) => wordValue(word, visitScript, env.home));
          const rawWords = [node.name, ...node.suffix].map((word) => word.text);
          invocations.push({ words, rawWords, redirects, pipeline: pipeline ?? ++pipelineCount });
          return;
        }
        case "Statement": {
          const redirects: ShellRedirect[] = [];
          collectRedirects(node.redirects, redirects);
          if (node.command.type === "Command") {
            const inner = node.command;
            if (inner.name) {
              collectRedirects(inner.redirects, redirects);
              const words = [inner.name, ...inner.suffix].map((word) => wordValue(word, visitScript, env.home));
              const rawWords = [inner.name, ...inner.suffix].map((word) => word.text);
              invocations.push({ words, rawWords, redirects, pipeline: pipeline ?? ++pipelineCount });
              return;
            }
          }
          visitNode(node.command, pipeline);
          return;
        }
        case "Pipeline": {
          const id = ++pipelineCount;
          for (const command of node.commands) visitNode(command, id);
          return;
        }
        case "AndOr":
        case "CompoundList":
          for (const command of node.commands) visitNode(command);
          return;
        case "If":
          visitNode(node.clause);
          visitNode(node.then);
          if (node.else) visitNode(node.else);
          return;
        case "For":
        case "Select":
          visitNode(node.body);
          return;
        case "While":
          visitNode(node.clause);
          visitNode(node.body);
          return;
        case "Function":
        case "Coproc": {
          const redirects: ShellRedirect[] = [];
          collectRedirects(node.redirects, redirects);
          visitNode(node.body);
          return;
        }
        case "Subshell":
        case "BraceGroup":
          visitNode(node.body);
          return;
        case "Case":
          for (const item of node.items) visitNode(item.body);
          return;
        default:
          // Arithmetic/Test/ArithmeticFor: no plain commands to classify.
          return;
      }
    }

    for (const statement of script.commands) visitNode(statement);

    // Group collected invocations into pipelines.
    const byPipeline = new Map<number, number[]>();
    for (const raw of invocations) {
      const unwrapped = unwrapInvocation(raw, env);
      if (!unwrapped.command) {
        mark(unwrapped.unresolved ?? "dynamic-command");
        continue;
      }
      const command = unwrapped.command;
      const commandIndex = commands.length;
      commands.push(command);
      if (commands.length > MAX_COMMANDS) {
        mark("analysis-limit");
        break;
      }
      const list = byPipeline.get(raw.pipeline) ?? [];
      list.push(commandIndex);
      byPipeline.set(raw.pipeline, list);
      if (unwrapped.unresolved) mark(unwrapped.unresolved);

      // §4.3.3 recursion.
      if (command.name === "eval") {
        const source = command.args[0] === "--" ? command.args.slice(1) : command.args;
        if (source.includes(undefined)) mark("dynamic-script");
        else pending.push({ text: source.join(" "), depth: next.depth + 1, dialect: "bash" });
      } else if (command.name === "find") {
        for (let index = 0; index < command.args.length; index += 1) {
          const flag = command.args[index];
          if (flag === undefined) {
            mark("dynamic-find");
            continue;
          }
          if (!FIND_EXEC_FLAGS.has(flag)) continue;
          const end = command.args.findIndex((arg, offset) => offset > index && (arg === ";" || arg === "+"));
          const execWords = command.args.slice(index + 1, end < 0 ? undefined : end);
          const execRaw = command.rawArgs.slice(index + 1, end < 0 ? undefined : end);
          if (execWords.includes(undefined)) mark("dynamic-script");
          else if (execWords.length > 0) {
            invocations.push({ words: execWords, rawWords: execRaw, redirects: [], pipeline: raw.pipeline });
          }
          index = end < 0 ? command.args.length : end;
        }
      } else if (BOURNE_SHELLS.has(command.name)) {
        const scriptArg = bourneScriptArg(command);
        if (scriptArg === undefined) {
          if (command.args.includes(undefined)) mark("dynamic-script");
        } else if (scriptArg.length > 0) {
          pending.push({ text: scriptArg, depth: next.depth + 1, dialect: "bash" });
        }
      } else if (POWER_SHELLS.has(command.name)) {
        const scriptArg = powerShellScriptArg(command);
        if (scriptArg === undefined) {
          if (command.args.includes(undefined)) mark("dynamic-script");
        } else if (scriptArg.length > 0) {
          pending.push({ text: scriptArg, depth: next.depth + 1, dialect: "cmd" });
        }
      } else if (command.name === "cmd") {
        const scriptArg = cmdScriptArg(command);
        if (scriptArg !== undefined && scriptArg.length > 0) {
          pending.push({ text: scriptArg, depth: next.depth + 1, dialect: "cmd" });
        }
      }
    }
    for (const list of byPipeline.values()) pipelines.push(list);
    if (commands.length > MAX_COMMANDS) break;
  }

  return { commands, pipelines, unresolved };
}

/** `bash|sh|zsh -c '<script>'` → the script string, else undefined. */
function bourneScriptArg(command: ShellCommand): string | undefined {
  const args = command.args;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg === "-c" || /^-[^-]*c/u.test(arg)) return args[index + 1];
    if (!arg.startsWith("-") && !arg.startsWith("+")) return undefined;
  }
  return undefined;
}

/** `powershell|pwsh -Command|-c '<script>'` → script, else undefined. */
function powerShellScriptArg(command: ShellCommand): string | undefined {
  const args = command.args;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (/^-[^-]*c/iu.test(arg) || arg.toLowerCase() === "-command") return args[index + 1];
  }
  return undefined;
}

/** `cmd /c|//c '<script>'` → script, else undefined. */
function cmdScriptArg(command: ShellCommand): string | undefined {
  const args = command.args;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (/^\/+c$/iu.test(arg)) return args[index + 1];
  }
  return undefined;
}
