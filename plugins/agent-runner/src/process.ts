import { spawn } from "node:child_process";
import { join } from "node:path";

/** The executor creates a dedicated process group on POSIX. */
export function killAgentTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {});
      killer.unref();
    } catch { /* Settlement remains bounded even if taskkill cannot start. */ }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}
