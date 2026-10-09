/**
 * Optional OS sandbox for bash commands (§12). Default off.
 *
 * The mechanism is a command rewrite: an allowed `bash` call's command text is
 * wrapped in `sandbox-exec` (macOS, built in) or `bwrap` (Linux, when present
 * and usable). Windows has no lightweight mechanism — MiniMax's answer is an
 * 11k-line Rust helper that needs a dedicated local account, admin install and
 * machine-wide firewall rules, which defeats "lightweight" — so win32 reports
 * `unavailable … (policy only)` and commands pass through unmodified.
 *
 * The rewrite happens inside `tool_call`, so it works for both pi's builtin
 * bash and pi-bg-bash without replacing either tool.
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { PolicyEnv, SandboxSettings } from "../types.ts";
import { expandPattern } from "../path-policy.ts";
import { normalizePath } from "../paths.ts";

export interface SandboxAvailability {
  /** The platform has a mechanism at all. */
  supported: boolean;
  /** The mechanism actually works (binary present, probe succeeded). */
  available: boolean;
  /** Human-readable status for `/permissions sandbox status` and the status line. */
  detail: string;
}

/** Injectable so tests can fake platforms and probes. */
export interface SandboxDeps {
  exists(path: string): boolean;
  isDirectory?(path: string): boolean;
  /** Runs argv directly; returns true when the probe exits 0. */
  probe(argv: string[]): boolean;
  /** PATH lookup for a bare command name. */
  onPath(name: string): boolean;
}

/** Test seam: plugin tests inject a fake platform/probe without env surgery. */
let overriddenDeps: SandboxDeps | undefined;
export function setSandboxDepsForTest(deps: SandboxDeps | undefined): void {
  overriddenDeps = deps;
}

export function sandboxDeps(): SandboxDeps {
  return overriddenDeps ?? defaultDeps();
}

/**
 * `isDirectory` is optional in `SandboxDeps`, and the Linux wrap needs it to pick
 * tmpfs (directory) over a /dev/null file bind (file). Its absence used to reach
 * the real filesystem through `buildBwrapArgs`' default argument: a `denyRead`
 * path that `exists` reports but `statSync` cannot stat (a container home, a
 * TOCTOU race) threw ENOENT, which aborted the whole wrap and — through the
 * handler's fail-closed catch — re-prompted the user and then ran the command
 * *outside* the sandbox. Never throw here: an unstatable credential path is
 * masked as a file, which hides it and fails loudly if it is really a directory.
 */
function isDirectoryOrFalse(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultDeps(): SandboxDeps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: isDirectoryOrFalse,
    probe: (argv) => {
      try {
        return spawnSync(argv[0]!, argv.slice(1), { stdio: "ignore", timeout: 10_000 }).status === 0;
      } catch {
        return false;
      }
    },
    onPath: (name) => {
      for (const dir of (process.env.PATH ?? "").split(":")) {
        if (dir && fs.existsSync(`${dir}/${name}`)) return true;
      }
      return false;
    },
  };
}

export function detectSandbox(env: PolicyEnv, deps: SandboxDeps = sandboxDeps()): SandboxAvailability {
  if (env.platform === "darwin") {
    const ok = deps.exists("/usr/bin/sandbox-exec");
    return { supported: true, available: ok, detail: ok ? "sandbox-exec" : "sandbox-exec missing" };
  }
  if (env.platform === "linux") {
    if (!deps.onPath("bwrap")) return { supported: true, available: false, detail: "bwrap not on PATH" };
    // User namespaces are often disabled inside containers; probe for real.
    const ok = deps.probe(["bwrap", "--ro-bind", "/", "/", "true"]);
    return { supported: true, available: ok, detail: ok ? "bwrap" : "bwrap present but unusable (no user namespaces?)" };
  }
  return { supported: false, available: false, detail: `unavailable on ${env.platform} (policy only)` };
}

/** Directory-class credential roots the sandbox must hide (§12.2). */
const DENY_READ_DIRS = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.azure", "~/.kube"];

const DENY_READ_FILES = ["~/.pi/agent/auth.json"];

/** Common package/tool caches: without them `npm install` etc. fail and users disable the sandbox. */
const CACHE_DIRS = [
  "~/.npm",
  "~/.cache",
  "~/.bun",
  "~/.cargo",
  "~/.gradle",
  "~/.m2",
  "~/.pnpm-store",
  "~/.yarn",
  "~/Library/Caches",
];

export interface SandboxPolicy {
  /** Realpath'd directories the command may write. */
  writable: string[];
  /** Realpath'd paths the command may not read. */
  denyRead: string[];
  network: "on" | "off";
}

export function resolveSandboxPolicy(env: PolicyEnv, settings: SandboxSettings, exists: (p: string) => boolean): SandboxPolicy {
  const writable = new Set<string>();
  for (const dir of [env.cwd, ...env.additionalDirs, ...env.tempDirs]) {
    writable.add(env.realpath(dir));
  }
  for (const pattern of CACHE_DIRS) {
    const dir = env.realpath(normalizePath(expandPattern(pattern, env), env));
    if (exists(dir)) writable.add(dir);
  }
  for (const extra of settings.allowWrite) {
    writable.add(env.realpath(normalizePath(expandPattern(extra, env), env)));
  }
  const denyRead = new Set<string>();
  for (const pattern of [...DENY_READ_DIRS, ...DENY_READ_FILES, ...settings.denyRead]) {
    denyRead.add(env.realpath(normalizePath(expandPattern(pattern, env), env)));
  }
  // A writable path that is also deny-listed must not write: keep it readable
  // only by dropping it from writable when it sits inside a denied root.
  return { writable: [...writable], denyRead: [...denyRead], network: settings.network };
}

/** Escape a path for embedding inside an SBPL double-quoted string. */
function sbplEscape(p: string): string {
  return p.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

/** Shell single-quote escape: abc'def → 'abc'\''def'. */
export function shQuote(text: string): string {
  return `'${text.replace(/'/gu, `'\\''`)}'`;
}

/**
 * macOS seatbelt profile. Verified on macOS 27:
 * - file-write* deny with require-all(require-not(subpath …)) confines writes;
 *   every writable path MUST be realpath'd (/tmp → /private/tmp).
 * - file-read* deny blocks reads AND directory listing under the subpath.
 * - network-outbound (remote ip) blocks all outbound TCP including localhost —
 *   "off" really means no outbound IP traffic; localhost services included.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines = ["(version 1)", "(allow default)"];
  const writable = policy.writable.map((p) => `    (require-not (subpath "${sbplEscape(p)}"))`).join("\n");
  lines.push(
    `(deny file-write*\n  (require-all\n${writable ? `${writable}\n` : ""}    (require-not (literal "/dev/null"))\n    (require-not (literal "/dev/tty"))\n    (require-not (regex #"^/dev/fd/"))))`,
  );
  for (const p of policy.denyRead) {
    lines.push(`(deny file-read* (subpath "${sbplEscape(p)}"))`, `(deny file-read* (literal "${sbplEscape(p)}"))`);
  }
  if (policy.network === "off") {
    lines.push("(deny network-outbound (remote ip))");
  }
  return `${lines.join("\n")}\n`;
}

/** bwrap argv (before the `--` command tail). Only existing paths are bound/masked. */
export function buildBwrapArgs(policy: SandboxPolicy, exists: (p: string) => boolean, isDirectory: (p: string) => boolean = isDirectoryOrFalse): string[] {
  const args = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const dir of policy.writable) {
    if (exists(dir)) args.push("--bind", dir, dir);
  }
  for (const p of policy.denyRead) {
    if (!exists(p)) continue;
    if (isDirectory(p)) args.push("--tmpfs", p);
    else args.push("--ro-bind", "/dev/null", p);
  }
  if (policy.network === "off") args.push("--unshare-net");
  args.push("--die-with-parent");
  return args;
}

/** Wrap a bash command so it runs inside the sandbox; undefined when unavailable. */
export function wrapSandboxed(
  command: string,
  env: PolicyEnv,
  settings: SandboxSettings,
  availability: SandboxAvailability,
  deps: SandboxDeps = sandboxDeps(),
): string | undefined {
  if (!availability.available) return undefined;
  const policy = resolveSandboxPolicy(env, settings, deps.exists);
  if (env.platform === "darwin") {
    return `/usr/bin/sandbox-exec -p ${shQuote(buildSeatbeltProfile(policy))} /bin/bash -c ${shQuote(command)}`;
  }
  if (env.platform === "linux") {
    const argv = buildBwrapArgs(policy, deps.exists, deps.isDirectory).map(shQuote).join(" ");
    return `${argv} -- /bin/bash -c ${shQuote(command)}`;
  }
  return undefined;
}
