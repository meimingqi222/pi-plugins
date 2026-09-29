/**
 * Command rules (design doc §4.3.5–4.3.6). Every rule returns a hit with a
 * stable id; the worst tier across all commands and path intents wins.
 * This table is contractual — changes go through the design doc first.
 */

import { isCredentialPath, classifyPath, type PathPolicyConfig, EMPTY_PATH_POLICY } from "../path-policy.ts";
import { isFilesystemRoot, isInside, isStrictlyInside, normalizePath } from "../paths.ts";
import { extractPathIntents } from "./intents.ts";
import type { GradedIntent, PolicyEnv, ShellAnalysis, ShellCommand, Tier } from "../types.ts";
import { tierRank } from "../types.ts";

const SYSTEM_DIRS = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/System",
  "/Library",
  "/Applications",
  "/private",
  "C:/Windows",
  "C:/Program Files",
  "C:/Program Files (x86)",
  "C:/ProgramData",
];

const HOME_LITERALS = new Set(["~", "~/", "$HOME", "${HOME}"]);

/**
 * True when `target` sits strictly below a temp dir. macOS realpaths `/tmp` and
 * `/var/folders` into `/private`, so the blanket `/private` SYSTEM_DIRS entry
 * otherwise reads every scratch path as a filesystem boundary. The temp dir
 * itself is still a boundary — deleting `/tmp` is not a scratch cleanup.
 */
function insideTempDir(target: string, env: PolicyEnv): boolean {
  return env.tempDirs.some((dir) => isStrictlyInside(target, dir, env));
}

function flagScan(command: ShellCommand): { recursive: boolean; force: boolean } {
  let recursive = false;
  let force = false;
  for (const arg of command.args) {
    if (arg === "--") break;
    if (arg === undefined) continue;
    if (arg === "--recursive") recursive = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("-") && !arg.startsWith("--")) {
      recursive ||= /[rR]/u.test(arg.slice(1));
      force ||= arg.includes("f");
    }
  }
  return { recursive, force };
}

function operands(command: ShellCommand): { values: (string | undefined)[]; raw: string[] } {
  const values: (string | undefined)[] = [];
  const raw: string[] = [];
  let done = false;
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    if (!done && arg === "--") {
      done = true;
      continue;
    }
    if (!done && typeof arg === "string" && arg.startsWith("-") && arg !== "-") continue;
    values.push(arg);
    raw.push(command.rawArgs[index] ?? "");
  }
  return { values, raw };
}

/** rm-root: recursive+force rm aimed at a filesystem boundary. */
function hitRmRoot(command: ShellCommand, env: PolicyEnv): boolean {
  if (command.name !== "rm") return false;
  const { recursive, force } = flagScan(command);
  if (!recursive || !force) return false;
  const { values, raw } = operands(command);
  const cwdIsBoundary = isFilesystemRoot(env.cwd) || env.cwd === env.home;
  for (let index = 0; index < values.length; index += 1) {
    const text = raw[index] ?? "";
    if (text === "/*" || text === "/") return true;
    if (HOME_LITERALS.has(text)) return true;
    if (text === "*" && cwdIsBoundary) return true;
    const value = values[index];
    if (value === undefined) continue;
    const target = normalizePath(value, env);
    if (isFilesystemRoot(target)) return true;
    if (target === env.home || isInside(env.home, target, env)) return true;
    if (SYSTEM_DIRS.some((dir) => isInside(target, dir, env)) && !insideTempDir(target, env)) return true;
  }
  return false;
}

const DISK_FORMAT_NAMES = /^(?:mkfs(?:\.[\w.-]*)?|newfs[\w.-]*|diskpart)$/u;

function hitDiskFormat(command: ShellCommand): boolean {
  if (DISK_FORMAT_NAMES.test(command.name)) return true;
  if (command.name === "format" && command.args.some((arg) => /^[a-zA-Z]:$/u.test(arg ?? ""))) return true;
  if (
    command.name === "diskutil" &&
    command.args.some((arg) => ["eraseDisk", "eraseVolume", "zeroDisk", "secureErase"].includes(arg ?? ""))
  ) {
    return true;
  }
  return false;
}

function hitDiskWrite(command: ShellCommand): boolean {
  if (command.name === "dd" && command.args.some((arg) => /^of=\/dev\//u.test(arg ?? ""))) return true;
  return command.redirects.some((redirect) => /^\/dev\/(?:sd|nvme|disk|hd)/u.test(redirect.target ?? ""));
}

function hitShadowCopyDelete(command: ShellCommand): boolean {
  const joined = command.args.join(" ").toLowerCase();
  if (command.name === "vssadmin" && /delete\s+shadows/u.test(joined)) return true;
  if (command.name === "wbadmin" && /delete/u.test(joined)) return true;
  if (command.name === "cipher" && /\/w/iu.test(joined)) return true;
  return false;
}

function hitReverseShell(command: ShellCommand): boolean {
  for (const arg of command.args) {
    if (typeof arg === "string" && /\/dev\/(?:tcp|udp)\//u.test(arg)) return true;
  }
  for (const redirect of command.redirects) {
    if (typeof redirect.target === "string" && /\/dev\/(?:tcp|udp)\//u.test(redirect.target)) return true;
  }
  if (["nc", "ncat", "netcat"].includes(command.name)) {
    for (const arg of command.args) {
      if (typeof arg === "string" && /^-[^-]*[ec]/u.test(arg)) return true;
    }
  }
  return false;
}

const EXFIL_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat", "scp", "ssh", "http", "https", "ftp", "sftp"]);
const SHELL_SINKS = new Set(["sh", "bash", "zsh", "dash", "ksh", "python", "python2", "python3", "node", "perl", "ruby", "iex"]);
const FETCH_COMMANDS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"]);

/**
 * Interpreter flags whose next operand IS the program. A pipe into one of these
 * delivers data, not code: `curl … | node -e 'JSON.parse(…)'` parses stdin,
 * while `curl … | node` reads the program from stdin and stays dangerous.
 * `-s`/`-`/`-i` are deliberately absent — they put the program back on stdin.
 */
const INLINE_PROGRAM_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-m", "--module"]);

/**
 * True when the command runs a program given as a literal argv operand. A
 * dynamic operand parses as `undefined`, so `node -e "$(curl …)"` and
 * `python3 -c "$PROG"` never qualify, and neither does a flag-shaped operand
 * (`bash -e -s` reads the program from stdin).
 */
function hasInlineProgram(command: ShellCommand): boolean {
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index];
    if (arg === "--") break;
    if (typeof arg !== "string" || !INLINE_PROGRAM_FLAGS.has(arg)) continue;
    const program = command.args[index + 1];
    return typeof program === "string" && !program.startsWith("-");
  }
  return false;
}

// ---------------------------------------------------------------------------
// dangerous rules
// ---------------------------------------------------------------------------

function hitRmRecursiveForce(command: ShellCommand, env: PolicyEnv): boolean {
  if (command.name !== "rm") return false;
  const { recursive, force } = flagScan(command);
  if (!recursive || !force) return false;
  const { values } = operands(command);
  const safeDirs = [env.cwd, ...env.additionalDirs, ...env.tempDirs];
  for (const value of values) {
    if (value === undefined) continue;
    const target = normalizePath(value, env);
    if (target === env.cwd || isInside(`${env.cwd}/.git`, target, env)) return true;
    if (!safeDirs.some((dir) => isInside(target, dir, env))) return true;
  }
  return false;
}

const GIT_PUSH_DANGER = new Set(["--force", "-f", "--force-with-lease", "--delete"]);

function hitGitDestructive(command: ShellCommand): boolean {
  if (command.name !== "git" || command.args.length === 0) return false;
  const sub = command.args[0];
  const rest = command.args.slice(1);
  if (sub === "push") {
    return rest.some(
      (arg) => (arg !== undefined && GIT_PUSH_DANGER.has(arg)) || (typeof arg === "string" && arg.startsWith(":")),
    );
  }
  if (sub === "reset") return rest.includes("--hard");
  if (sub === "clean") {
    return rest.some(
      (arg) => arg === "--force" || (typeof arg === "string" && /^-[^-]*f/u.test(arg)),
    );
  }
  if (sub === "branch") return rest.includes("-D");
  if (sub === "filter-branch" || sub === "filter-repo") return true;
  if (sub === "checkout") {
    const dashdash = rest.indexOf("--");
    return (dashdash >= 0 && rest[dashdash + 1] === ".") || rest.includes(".");
  }
  if (sub === "restore") return rest.includes(".") || rest.includes("--worktree");
  return false;
}

function hitPrivilegeEscalation(command: ShellCommand): boolean {
  if (["su", "runas"].includes(command.name)) return true;
  return command.via.some((wrapper) => wrapper === "sudo" || wrapper === "doas");
}

function hitPermissionBroad(command: ShellCommand, env: PolicyEnv): boolean {
  if (command.name === "chmod") {
    const broadMode = command.args.some((arg) => arg !== undefined && /777|a\+rwx|a=rwx|o\+w/u.test(arg));
    if (broadMode) return true;
    return isRecursive(command) && !recursiveTargetsAreScratch(command, env);
  }
  if (command.name === "chown") {
    return isRecursive(command) && !recursiveTargetsAreScratch(command, env);
  }
  if (command.name === "takeown") return true;
  if (command.name === "icacls") {
    return command.args.some((arg) => typeof arg === "string" && /^\/grant/iu.test(arg));
  }
  return false;
}

function isRecursive(command: ShellCommand): boolean {
  return command.args.some((arg) => arg !== undefined && (/^-[^-]*R/u.test(arg) || arg === "--recursive"));
}

/**
 * True when every operand of a recursive chmod/chown resolves strictly inside
 * the workspace, an extra dir, or a temp dir — scratch the caller already owns,
 * where `chmod -R 755 ./dist` is routine rather than a broad permission change.
 * The roots themselves stay out: `chmod -R 755 .` still asks, as does any
 * dynamic operand, because neither can be proven to stay inside scratch.
 */
function recursiveTargetsAreScratch(command: ShellCommand, env: PolicyEnv): boolean {
  const scratch = [env.cwd, ...env.additionalDirs, ...env.tempDirs];
  const { values } = operands(command);
  if (values.length === 0) return false;
  return values.every((value) => {
    if (value === undefined) return false;
    const target = normalizePath(value, env);
    return scratch.some((dir) => isStrictlyInside(target, dir, env));
  });
}

const LIFECYCLE_NAMES = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const LIFECYCLE_WRAPPERS = new Set(["systemctl", "init", "telinit", "loginctl"]);
const LIFECYCLE_ACTIONS = new Set(["reboot", "poweroff", "halt", "shutdown"]);

function hitSystemLifecycle(command: ShellCommand): boolean {
  if (LIFECYCLE_NAMES.has(command.name)) return true;
  return (
    LIFECYCLE_WRAPPERS.has(command.name) &&
    command.args.some((arg) => arg !== undefined && LIFECYCLE_ACTIONS.has(arg.toLowerCase()))
  );
}

function hitPublish(command: ShellCommand): boolean {
  const [sub] = command.args;
  switch (command.name) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "cargo":
      return sub === "publish";
    case "twine":
      return sub === "upload";
    case "gem":
      return sub === "push";
    case "gh":
      return sub === "release" && command.args[1] === "create";
    case "docker":
      return sub === "push";
    default:
      return false;
  }
}

function hitWindowsDestructive(command: ShellCommand): boolean {
  const name = command.name.toLowerCase();
  if (name === "rd" || name === "rmdir") {
    return command.args.some((arg) => typeof arg === "string" && /^\/s/iu.test(arg));
  }
  if (name === "del" || name === "erase") {
    return command.args.some((arg) => typeof arg === "string" && /^\/[sq]/iu.test(arg));
  }
  if (name === "reg") {
    const sub = command.args[0]?.toLowerCase();
    if (sub === "delete") return true;
    if (sub === "add" && command.args.some((arg) => typeof arg === "string" && /^hklm/iu.test(arg))) return true;
  }
  if (name === "set-executionpolicy" || name === "bcdedit") return true;
  return false;
}

function hitCrontabRemove(command: ShellCommand): boolean {
  return command.name === "crontab" && command.args.includes("-r");
}

const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:database|table|schema)|truncate\s+table)\b/iu;

// ---------------------------------------------------------------------------
// safe list
// ---------------------------------------------------------------------------

const SAFE_NAMES = new Set([
  "ls", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr",
  "grep", "rg", "egrep", "fgrep", "fd", "tree", "stat", "file", "which", "type", "whoami",
  "date", "uname", "du", "df", "diff", "true", "false", "basename", "dirname", "realpath",
  "readlink", "nl", "tac", "column", "cksum", "md5sum", "sha1sum", "sha256sum",
]);

const GIT_SAFE_SUBS = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "describe"]);
const GIT_BRANCH_WRITE_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);

function isSafeCommand(command: ShellCommand): boolean {
  const args = command.args;
  if (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0] ?? "")) return true;
  if (command.name === "git") {
    const sub = args[0];
    if (sub === undefined) return false;
    if (GIT_SAFE_SUBS.has(sub)) return !args.slice(1).includes(undefined);
    if (sub === "branch") {
      return !args.slice(1).some((arg) => arg === undefined || GIT_BRANCH_WRITE_FLAGS.has(arg));
    }
    if (sub === "remote") return args.length === 2 && args[1] === "-v";
    return false;
  }
  if (command.name === "find") {
    const blocked = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"]);
    return !args.some((arg) => arg === undefined || blocked.has(arg));
  }
  if (!SAFE_NAMES.has(command.name)) return false;
  // File-reading safe commands: dynamic operands could point anywhere.
  if (args.includes(undefined)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// forbidden/dangerous evaluation
// ---------------------------------------------------------------------------

interface Hit {
  id: string;
  tier: Tier;
  reason: string;
}

function forbiddenHit(command: ShellCommand, env: PolicyEnv): Hit | undefined {
  if (hitRmRoot(command, env)) return { id: "rm-root", tier: "forbidden", reason: "recursive force-delete aimed at a filesystem boundary" };
  if (hitDiskFormat(command)) return { id: "disk-format", tier: "forbidden", reason: "filesystem format command" };
  if (hitDiskWrite(command)) return { id: "disk-write", tier: "forbidden", reason: "direct write to a block device" };
  if (hitShadowCopyDelete(command)) return { id: "shadow-copy-delete", tier: "forbidden", reason: "deleting backup/shadow copies" };
  if (hitReverseShell(command)) return { id: "reverse-shell", tier: "forbidden", reason: "reverse-shell pattern (/dev/tcp or nc -e/-c)" };
  return undefined;
}

function dangerousHit(command: ShellCommand, env: PolicyEnv): Hit | undefined {
  if (hitRmRecursiveForce(command, env)) return { id: "rm-recursive-force", tier: "dangerous", reason: "rm -rf on the workspace root, .git, or outside the workspace" };
  if (hitGitDestructive(command)) return { id: "git-destructive", tier: "dangerous", reason: "destructive git operation (force push / reset --hard / clean -f / ...)" };
  if (hitPrivilegeEscalation(command)) return { id: "privilege-escalation", tier: "dangerous", reason: "privilege escalation (sudo/doas/su/runas)" };
  if (hitPermissionBroad(command, env)) return { id: "permission-broad", tier: "dangerous", reason: "broad permission change (chmod 777/-R, chown -R, icacls /grant)" };
  if (hitSystemLifecycle(command)) return { id: "system-lifecycle", tier: "dangerous", reason: "system power/lifecycle command" };
  if (hitPublish(command)) return { id: "publish", tier: "dangerous", reason: "package/image publish" };
  if (hitWindowsDestructive(command)) return { id: "windows-destructive", tier: "dangerous", reason: "destructive Windows command" };
  if (hitCrontabRemove(command)) return { id: "crontab-remove", tier: "dangerous", reason: "crontab -r removes all cron entries" };
  return undefined;
}

// ---------------------------------------------------------------------------
// raw-text fallbacks (run when analysis is incomplete, and destructive-sql always)
// ---------------------------------------------------------------------------

const RAW_FALLBACK: readonly Hit[] = [
  {
    id: "rm-root",
    tier: "forbidden",
    reason: "rm -rf on a filesystem boundary (unparsed fallback)",
  },
  { id: "disk-format", tier: "forbidden", reason: "filesystem format command (unparsed fallback)" },
  { id: "reverse-shell", tier: "forbidden", reason: "reverse-shell pattern (unparsed fallback)" },
  { id: "shadow-copy-delete", tier: "forbidden", reason: "backup deletion (unparsed fallback)" },
  { id: "git-destructive", tier: "dangerous", reason: "destructive git operation (unparsed fallback)" },
];

const RAW_PATTERNS: Record<string, RegExp> = {
  "rm-root": /\brm\s[^;&|]*-[a-zA-Z]*[rR][a-zA-Z]*f[^;&|]*\s(?:\/\*?|~|\$HOME|\*)\s*(?=[;&|)]|$)/u,
  "disk-format": /\bmkfs(?:\.[\w.-]+)?\b|\bnewfs[\w.-]*\b|\bdiskpart\b|\bdiskutil\s+(?:eraseDisk|eraseVolume|zeroDisk|secureErase)\b|\bformat\s+[a-zA-Z]:/iu,
  "reverse-shell": /\/dev\/(?:tcp|udp)\//u,
  "shadow-copy-delete": /\bvssadmin\s+delete\s+shadows|\bwbadmin\s+delete|\bcipher\s+\/w/iu,
  "git-destructive": /\bgit\s+push\s[^;&|]*(?:--force|--force-with-lease|-f\b|--delete)|\bgit\s+reset\s+--hard|\bgit\s+clean\s[^;&|]*-[a-zA-Z]*f|\bgit\s+(?:filter-branch|filter-repo)/iu,
};

// ---------------------------------------------------------------------------
// top-level evaluation
// ---------------------------------------------------------------------------

export interface ShellVerdict {
  intents: GradedIntent[];
  tier: Tier;
  mutating: boolean;
  ruleId?: string;
  reason: string;
}

/**
 * Grade every command and extracted path intent of an analyzed shell text.
 * `raw` is the original command text (used by the destructive-sql scan and
 * the unresolved fallbacks).
 */
export function evaluateShell(analysis: ShellAnalysis, raw: string, env: PolicyEnv, config: PathPolicyConfig = EMPTY_PATH_POLICY): ShellVerdict {
  const intents: GradedIntent[] = [];
  let tier: Tier = "safe";
  let ruleId: string | undefined;
  let reason = "no commands";
  const bump = (t: Tier, id: string | undefined, why: string): void => {
    if (tierRank(t) > tierRank(tier)) {
      tier = t;
      ruleId = id;
      reason = why;
    } else if (t === tier && ruleId === undefined && id) {
      ruleId = id;
      reason = why;
    }
  };

  // Map command index → exec intent index for pipeline rules.
  const execIndex: number[] = [];

  for (const command of analysis.commands) {
    const execIntent: GradedIntent = {
      kind: "exec",
      tool: "bash",
      command,
      raw: command.rawName,
      tier: "grey",
      mutating: true,
    };
    const forbidden = forbiddenHit(command, env);
    const dangerous = forbidden ? undefined : dangerousHit(command, env);
    const hit = forbidden ?? dangerous;
    if (hit) {
      execIntent.tier = hit.tier;
      execIntent.ruleId = hit.id;
      execIntent.reason = hit.reason;
      bump(hit.tier, hit.id, hit.reason);
    } else if (isSafeCommand(command)) {
      execIntent.tier = "safe";
      execIntent.mutating = false;
      execIntent.reason = "known read-only command";
      execIntent.ruleId = "safe-command";
    } else {
      execIntent.reason = analysis.unresolved ? `unrecognized command (unresolved: ${analysis.unresolved})` : "unrecognized command";
      bump("grey", undefined, execIntent.reason);
    }
    intents.push(execIntent);
    execIndex.push(intents.length - 1);

    const extracted = extractPathIntents(command, env);
    for (const intent of extracted.intents) {
      const verdict = classifyPath(intent.kind as "read" | "write", intent.path!, command.rawName, env, config);
      const graded: GradedIntent = { ...intent, sourceIndex: execIndex[execIndex.length - 1], tier: verdict.tier, ruleId: verdict.ruleId, reason: verdict.reason, mutating: intent.kind === "write" };
      intents.push(graded);
      bump(verdict.tier, verdict.ruleId, verdict.reason);
    }
    if (extracted.unresolved) bump("grey", undefined, "dynamic path in command arguments");
  }

  // Pipeline composition rules need command indexes, which map onto exec intents.
  const execNameAt = (commandIndex: number): string => analysis.commands[commandIndex]?.name ?? "";
  for (const pipeline of analysis.pipelines) {
    if (pipeline.length < 2) continue;
    const names = pipeline.map(execNameAt);
    const secretRead = pipeline.some((commandIndex) => {
      const command = analysis.commands[commandIndex]!;
      const extracted = extractPathIntents(command, env);
      return extracted.intents.some((intent) => intent.kind === "read" && isCredentialPath(intent.path!, env, config));
    });
    const sinkIndex = names.findIndex((name) => SHELL_SINKS.has(name));
    const fetchIndex = names.findIndex((name) => FETCH_COMMANDS.has(name));
    if (secretRead && names.some((name) => EXFIL_COMMANDS.has(name))) {
      for (const commandIndex of pipeline) {
        const intent = intents[execIndex[commandIndex]!]!;
        intent.tier = "forbidden";
        intent.ruleId = "secret-exfil";
        intent.reason = "credential file piped to a network command";
      }
      bump("forbidden", "secret-exfil", "credential file piped to a network command");
      continue;
    }
    if (fetchIndex >= 0 && sinkIndex > fetchIndex) {
      // Every interpreter after the fetch must be an inline-program form, or the
      // pipeline stays dangerous: `curl … | node -e '<literal>' | sh` is not
      // covered by relaxing the first sink alone.
      const sinksAfterFetch = pipeline.filter(
        (commandIndex, position) => position > fetchIndex && SHELL_SINKS.has(execNameAt(commandIndex)),
      );
      if (!sinksAfterFetch.every((commandIndex) => hasInlineProgram(analysis.commands[commandIndex]!))) {
        const intent = intents[execIndex[pipeline[sinkIndex]!]!]!;
        if (intent.tier !== "forbidden") {
          intent.tier = "dangerous";
          intent.ruleId = "pipe-to-shell";
          intent.reason = "remote download piped into a shell/interpreter";
        }
        bump("dangerous", "pipe-to-shell", "remote download piped into a shell/interpreter");
      }
    }
  }

  // destructive-sql scans the raw text regardless of parse quality.
  if (DESTRUCTIVE_SQL.test(raw)) bump("dangerous", "destructive-sql", "destructive SQL statement");

  // Unresolved analysis: raw-text fallbacks for the catastrophic rules, else ≥ grey.
  if (analysis.unresolved) {
    for (const hit of RAW_FALLBACK) {
      if (RAW_PATTERNS[hit.id]!.test(raw)) {
        bump(hit.tier, hit.id, hit.reason);
      }
    }
    bump("grey", undefined, `could not fully analyze the command (${analysis.unresolved})`);
  }

  if (intents.length === 0) {
    bump(analysis.unresolved ? "grey" : "safe", undefined, analysis.unresolved ?? "no commands");
  }
  if (tier === "safe" && reason === "no commands") reason = "read-only";
  const mutating = intents.some((intent) => intent.mutating === true);
  return { intents, tier, mutating, ruleId, reason };
}
