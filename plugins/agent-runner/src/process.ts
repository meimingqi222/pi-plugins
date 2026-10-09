import { spawn } from "node:child_process";
import { join } from "node:path";

interface KillTreeOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  timeoutMs?: number;
}

/** Await Windows tree cleanup; POSIX group signalling completes synchronously. */
export async function killAgentTree(pid: number | undefined, options: KillTreeOptions = {}): Promise<void> {
  if (!pid) return;
  if ((options.platform ?? process.platform) === "win32") {
    const spawnTaskkill = options.spawn ?? spawn;
    await new Promise<void>((resolve) => {
      try {
        const killer = spawnTaskkill(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        const finish = () => { clearTimeout(timer); killer.unref(); resolve(); };
        const timer = setTimeout(() => {
          try { killer.kill(); } catch { /* Best-effort cleanup stays bounded. */ }
          finish();
        }, options.timeoutMs ?? 2000);
        killer.once("error", finish);
        killer.once("close", finish);
      } catch { resolve(); }
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}
