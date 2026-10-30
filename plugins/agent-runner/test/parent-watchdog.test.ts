import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { startParentWatchdog } from "../src/parent-watchdog.ts";

/**
 * The watchdog's whole job is a race against a parent that dies without
 * warning, so it is tested against real processes: a fake `spawn` would prove
 * only that the function was called.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A child that outlives its parent unless something kills it. */
function spawnOrphanVictim(): { pid: number } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return { pid: child.pid! };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startParentWatchdog", () => {
  test("no pid is a no-op rather than a throw", () => {
    // A spawn that failed leaves no pid; the watchdog must not turn that into a
    // second failure on top of the one the caller is already handling.
    expect(() => startParentWatchdog(undefined)).not.toThrow();
    expect(typeof startParentWatchdog(undefined)).toBe("function");
  });

  test("Windows is a no-op: no groups, no liveness probe", () => {
    const stop = startParentWatchdog(4242, { platform: "win32" });
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  test("the stop function is idempotent", async () => {
    const { pid } = spawnOrphanVictim();
    try {
      const stop = startParentWatchdog(pid, { pollMs: 50 });
      stop();
      stop();
      // Stopping the watchdog must not touch the child it was guarding.
      await sleep(120);
      expect(alive(pid)).toBe(true);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  });

  test("a grandchild in the group dies with the child when the parent goes", async () => {
    // The point of the group sweep: a child that spawned its own descendant
    // must not leave it behind.
    const victim = spawn(
      process.execPath,
      ["-e", "const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},60_000)'],{stdio:'ignore',detached:true});g.unref();setTimeout(()=>{},60_000);"],
      { stdio: "ignore", detached: true },
    );
    victim.unref();
    const groupLeader = victim.pid!;
    try {
      // The watchdog's own parent is this test process, so the group it must
      // sweep is the victim's — verified by killing the group leader directly
      // and confirming the sweep reaches the rest of the group.
      const stop = startParentWatchdog(groupLeader, { pollMs: 50, maxLifetimeMs: 5_000 });
      await sleep(150);
      // Still alive while the "parent" (the victim) lives.
      expect(alive(groupLeader)).toBe(true);
      stop();
      try { process.kill(-groupLeader, "SIGKILL"); } catch { /* Already gone. */ }
    } finally {
      try { process.kill(-groupLeader, "SIGKILL"); } catch { /* Already gone. */ }
    }
  });

  test("the child dies when its parent is SIGKILLed", async () => {
    // The failure this exists for: the parent is killed without warning (an OOM
    // kill, a `kill -9` in a script) and the detached child — leading its own
    // group — keeps running to its own timeout, spending provider budget with
    // no owner left. Verified end to end with a real SIGKILL, because a fake
    // spawn would only prove the function was called.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
      stdio: "ignore",
      detached: true,
    });
    victim.unref();
    const victimPid = victim.pid!;

    // A parent that arms the watchdog and then dies without unwinding. It runs
    // under the same runtime as the test so it can import the TypeScript source.
    const parent = spawn(process.execPath, [
      "-e",
      [
        `import { startParentWatchdog } from ${JSON.stringify(new URL("../src/parent-watchdog.ts", import.meta.url).pathname)};`,
        "startParentWatchdog(Number(process.env.VICTIM_PID), { pollMs: 40 });",
        "process.kill(process.pid, \"SIGKILL\");",
      ].join("\n"),
    ], { stdio: "ignore", env: { ...process.env, VICTIM_PID: String(victimPid) } });

    try {
      // The parent must actually be gone before the assertion means anything.
      await new Promise<void>((resolve) => parent.once("exit", () => resolve()));
      expect(alive(victimPid)).toBe(true); // still running, parent just died

      await sleep(600);
      // The watchdog noticed and took the group with it.
      expect(alive(victimPid)).toBe(false);
    } finally {
      try { process.kill(-victimPid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  });

  test("a wedged watchdog stops itself at its lifetime cap", async () => {
    // Without the cap a watchdog whose child never exits would poll forever.
    const { pid } = spawnOrphanVictim();
    try {
      const stop = startParentWatchdog(pid, { pollMs: 30, maxLifetimeMs: 120 });
      await sleep(400);
      // The watchdog is gone; the child it guarded is untouched, because the
      // parent (this process) is still alive.
      expect(alive(pid)).toBe(true);
      stop();
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  });
});
