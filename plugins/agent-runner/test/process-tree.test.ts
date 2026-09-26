import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentExecutor } from "../src/executor.ts";

const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));

for (const background of [false, true]) {
 for (const mode of ["abort", "timeout"] as const) {
  test.skipIf(process.platform === "win32")(`real Pi ${background ? "background bash" : "bash"} stops writing after agent ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-real-shell-"));
    const pidPath = join(root, "pid");
    const heartbeatPath = join(root, "heartbeat");
    const controller = new AbortController();
    const execution = createAgentExecutor({
      invocation: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/pi-shell.mjs", import.meta.url))] },
      timeoutMs: mode === "timeout" ? 2000 : 8000,
    })({ cwd: root, prompt: JSON.stringify({ pidPath, heartbeatPath, background }), signal: controller.signal });
    try {
      const deadline = Date.now() + 5000;
      while (!(await readFile(heartbeatPath, "utf8").catch(() => ""))) {
        if (Date.now() >= deadline) throw new Error("Pi bash never started writing");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (mode === "abort") controller.abort();
      const result = await execution;
      expect(result.status).toBe(mode === "abort" ? "aborted" : "failed");
      const before = await readFile(heartbeatPath, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await readFile(heartbeatPath, "utf8")).toBe(before);
    } finally {
      controller.abort();
      await execution;
      const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
      if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ } }
      await rm(root, { recursive: true, force: true });
    }
  }, 12000);
 }
}

for (const mode of ["timeout", "abort", "exit", "ignore-term"] as const) {
  test.skipIf(process.platform === "win32")(`inherited pipes cannot delay ${mode} settlement`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tree-"));
    const pidPath = join(root, "pid");
    const controller = new AbortController();
    const abortTimer = mode === "abort" ? setTimeout(() => controller.abort(), 600) : undefined;
    try {
      const start = Date.now();
      const result = await createAgentExecutor({
        invocation: { command: process.execPath, args: [fixture] }, timeoutMs: mode === "timeout" || mode === "ignore-term" ? 600 : 8000,
      })({ cwd: root, prompt: JSON.stringify({ mode, pidPath }), signal: controller.signal });
      expect(Date.now() - start).toBeLessThan(2500);
      expect(result.status).toBe(mode === "abort" ? "aborted" : mode === "exit" ? "completed" : "failed");
      const pid = Number(await readFile(pidPath, "utf8"));
      // Allow init to reap the orphan after the process-group kill.
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt++) {
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive).toBe(false);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);
}
