import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { killAgentTree } from "../src/process.ts";

/** Whether a pid is still running, asked without signalling it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killAgentTree", () => {
  test("ends a real child process on this platform", async () => {
    // The platform branch that actually stops a stuck agent is untestable through
    // a fake child: on Windows `killAgentTree` spawns `taskkill /F /T` and never
    // signals through the ChildProcess object, which is why a fake with no pid
    // (the shape `rpc-child.test.ts` uses on purpose) observes nothing. A real
    // child is the only thing that pins the branch, and `process-tree.test.ts`
    // skips every real-tree case on Windows, so without this the Windows stop
    // path has no coverage at all.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      // The executor gives a child its own process group on POSIX so the group
      // kill reaches detached shells; mirror it, or the negative-pid kill would
      // hit the test runner's own group.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    try {
      const pid = child.pid;
      expect(typeof pid).toBe("number");
      expect(alive(pid!)).toBe(true);
      await killAgentTree(pid);
      // Cleanup has completed; allow the OS a short window to reap the child.
      const deadline = Date.now() + 5_000;
      while (alive(pid!) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive(pid!)).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
  }, 15_000);

  test("a pid-less child is a no-op rather than an error", () => {
    expect(() => killAgentTree(undefined)).not.toThrow();
  });
});
