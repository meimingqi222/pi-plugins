/**
 * How to invoke pi as a subprocess.
 *
 * A workflow agent is a separate pi process in JSON mode, which is pi's own
 * proven pattern for a subagent (see the bundled `extensions/subagent` example).
 * Reusing it means the agent gets a real session, real tools, real compaction,
 * and real provider auth, instead of a half-reimplementation inside the plugin.
 *
 * The invocation has two shapes and getting them wrong fails silently:
 *
 * - **From source** (`node .../pi/dist/cli.js`, or `tsx`), `argv[1]` is the
 *   script and must be forwarded along with the preload/loader flags, or the
 *   child starts without the TypeScript loader the parent was launched with.
 * - **From a compiled binary**, `argv[1]` is a virtual path inside the executable
 *   (`/$bunfs/...`). Forwarding it would pass a nonexistent file to the child, so
 *   the executable is invoked bare and resolves its own entry point.
 *
 * The fallback name is `pi` rather than an absolute path because a user may have
 * either the npm bin or a compiled binary on `PATH`, and `process.execPath` for a
 * compiled binary *is* the binary.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export interface PiInvocation {
  command: string;
  args: string[];
}

/** Flags that must be replayed on a source launch, with or without a value. */
const LOADER_FLAG = /^(?:--require|--import|--loader|--experimental-loader|-r)$/u;
const LOADER_FLAG_INLINE = /^(?:--require|--import|--loader|--experimental-loader)=/u;
const RUNTIME_NAMES = /^(?:node|bun)(?:\.exe)?$/u;

/** True when a path is a virtual entry point inside a compiled executable. */
function isVirtualScript(script: string): boolean {
  return script.includes("$bunfs") || script.startsWith("/$bunfs/");
}

/**
 * Forward only loader preloads from the parent's exec args.
 *
 * Debugger ports and parent-only execution modes must not be copied to every
 * child: a second process cannot bind the same inspector port, and `--eval`
 * would replace the child's program entirely.
 */
export function forwardedExecArgs(execArgv: readonly string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index]!;
    if (LOADER_FLAG.test(arg)) {
      const value = execArgv[index + 1];
      if (value !== undefined) {
        forwarded.push(arg, value);
        index += 1;
      }
    } else if (LOADER_FLAG_INLINE.test(arg) || /^-r.+$/u.test(arg)) {
      forwarded.push(arg);
    }
  }
  return forwarded;
}

/**
 * Resolve how to spawn pi.
 *
 * `execPath` and `argv1` are injectable so the decision can be tested without
 * depending on how the test runner itself was launched.
 */
export function resolvePiInvocation(
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
  execArgv: readonly string[] = process.execArgv,
): PiInvocation {
  if (argv1 && !isVirtualScript(argv1) && existsSync(argv1) && /\.(?:[cm]?js|[cm]?ts)$/iu.test(argv1)) {
    // Source launch: keep the script and the loaders the parent was started with.
    return { command: execPath, args: [...forwardedExecArgs(execArgv), argv1] };
  }
  const executable = path.basename(execPath).toLowerCase();
  if (RUNTIME_NAMES.test(executable)) {
    // A plain interpreter with no forwarding script: rely on `PATH`.
    return { command: "pi", args: [] };
  }
  // A compiled binary (or a renamed executable) is its own entry point.
  return { command: execPath, args: [] };
}

/** Convenience wrapper matching the name used by callers. */
export function whichPi(): PiInvocation {
  return resolvePiInvocation();
}

/**
 * Arguments that make pi emit a machine-readable run.
 *
 * `--mode json` streams one JSON object per line, `-p` is non-interactive, and
 * `--no-session` keeps a fan-out of hundreds of agents from filling the session
 * store with transcripts the user never asked for.
 */
export function jsonRunArgs(): string[] {
  return ["--mode", "json", "-p", "--no-session"];
}
