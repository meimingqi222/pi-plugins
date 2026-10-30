/**
 * Parent-death detection for a detached child.
 *
 * A child spawned `detached: true` leads its own process group, which is what
 * keeps it alive when the terminal that launched it goes away — and also what
 * keeps it alive when the *parent* dies. `SIGKILL` the parent (an OOM kill, a
 * `kill -9` in a script) and every in-flight child keeps running to its own
 * timeout, spending provider budget with no owner left to read the result.
 *
 * POSIX has `PR_SET_PDEATHSIG` for exactly this, but Node exposes no portable
 * binding for it, and this runner already supports Windows where there is no
 * such signal at all. So the watchdog is a second, tiny process whose only job
 * is to notice the parent is gone and take the child's group with it:
 *
 * - it is spawned detached too, so the parent's death does not take it down;
 * - it polls `process.kill(parentPid, 0)`, which throws `ESRCH` once the parent
 *   is gone — a poll rather than a pipe, because a pipe would close on any
 *   parent exit including a clean one the child should survive;
 * - it kills the child's whole group, not just the child, so a grandchild the
 *   child spawned does not outlive it;
 * - it exits when the child exits on its own, and hard-stops after a bounded
 *   lifetime, so a wedged watchdog cannot linger.
 *
 * This is best effort by construction: `SIGKILL` the watchdog as well and the
 * orphan window returns. That window is documented in the runner's README
 * rather than papered over.
 */

import { spawn } from "node:child_process";

export interface WatchdogOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  /** How often to check that the parent is still alive. */
  pollMs?: number;
  /** Hard cap, so a wedged watchdog cannot outlive the run it guards. */
  maxLifetimeMs?: number;
}

/** Default poll: frequent enough to matter, sparse enough to be free. */
const DEFAULT_POLL_MS = 1_000;

/**
 * The watchdog program. Kept as a string so it runs under whichever runtime
 * spawned the parent — node or bun — with no file to write and no loader.
 */
const WATCHDOG_SOURCE = `
const parentPid = Number(process.env.PI_WATCHDOG_PARENT_PID);
const childPid = Number(process.env.PI_WATCHDOG_CHILD_PID);
const pollMs = Number(process.env.PI_WATCHDOG_POLL_MS || ${DEFAULT_POLL_MS});
const maxLifetimeMs = Number(process.env.PI_WATCHDOG_MAX_LIFETIME_MS || 0);
const startedAt = Date.now();

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const killGroup = () => {
  try { process.kill(-childPid, "SIGKILL"); return; } catch { /* Group already gone. */ }
  try { process.kill(childPid, "SIGKILL"); } catch { /* Already gone. */ }
};

const timer = setInterval(() => {
  if (!alive(parentPid)) { clearInterval(timer); killGroup(); process.exit(0); }
  if (!alive(childPid)) { clearInterval(timer); process.exit(0); }
  if (maxLifetimeMs > 0 && Date.now() - startedAt > maxLifetimeMs) {
    clearInterval(timer);
    process.exit(0);
  }
}, pollMs);
// Deliberately *not* unref'd. This process has nothing else to do, so an unref'd
// interval lets the event loop empty and the watchdog exit before the parent it
// is meant to outlive — the exact failure it exists to prevent. Its own exit is
// bounded instead: the parent dies, the child dies, or the lifetime cap fires.
`;

/**
 * Start the watchdog for `childPid`.
 *
 * Returns a stop function that ends it without touching the child — the caller
 * uses it when the child settles normally, so the watchdog does not sit out the
 * rest of its poll interval for nothing.
 */
export function startParentWatchdog(childPid: number | undefined, options: WatchdogOptions = {}): () => void {
  if (!childPid) return () => {};
  const platform = options.platform ?? process.platform;
  // Windows has no process groups and no `kill(pid, 0)` liveness probe, so the
  // group sweep there stays the runner's own taskkill path.
  if (platform === "win32") return () => {};

  const spawnWatchdog = options.spawn ?? spawn;
  let stopped = false;
  try {
    const watchdog = spawnWatchdog(process.execPath, ["-e", WATCHDOG_SOURCE], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        PI_WATCHDOG_PARENT_PID: String(process.pid),
        PI_WATCHDOG_CHILD_PID: String(childPid),
        PI_WATCHDOG_POLL_MS: String(options.pollMs ?? DEFAULT_POLL_MS),
        ...(options.maxLifetimeMs ? { PI_WATCHDOG_MAX_LIFETIME_MS: String(options.maxLifetimeMs) } : {}),
      },
    });
    watchdog.unref();
    return () => {
      if (stopped) return;
      stopped = true;
      try { watchdog.kill(); } catch { /* Already gone. */ }
    };
  } catch {
    // A watchdog that cannot start must not fail the run it was meant to guard.
    return () => {};
  }
}
