import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRpcChild, type RpcChild } from "pi-agent-runner";
import { subagentExtension } from "../src/index.ts";

class Process extends EventEmitter {
  pid = undefined;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kills = 0;
  constructor() { super(); this.stdin.resume(); }
  kill() { this.kills++; queueMicrotask(() => this.emit("close", 143)); return true; }
  unref() {}
  event(value: object) { this.stdout.write(JSON.stringify(value) + "\n"); }
  answer(text: string) {
    this.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
    this.event({ type: "agent_settled" });
  }
}

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "pi-retirement-"));
  const oldLog = process.env.PI_SUBAGENT_LOG_DIR;
  const oldKeepalive = process.env.PI_SUBAGENT_KEEPALIVE_MS;
  process.env.PI_SUBAGENT_LOG_DIR = directory;
  process.env.PI_SUBAGENT_KEEPALIVE_MS = "25";
  const child = new Process();
  let handle!: RpcChild;
  const messages: any[] = [];
  const tools: any[] = [];
  const hooks = new Map<string, any>();
  const ctx = { cwd: directory, mode: "rpc", sessionManager: { getSessionId: () => "retirement-session" }, isIdle: () => true };
  try {
    subagentExtension({
      discover: () => [{ name: "review", description: "review", systemPrompt: "Review", filePath: "review.md" }],
      spawnRpcChild: async input => {
        handle = await spawnRpcChild(input, { spawnFn: (() => child) as any, invocation: { command: "pi", args: [] }, terminationGraceMs: 10, stdioGraceMs: 10 });
        return handle;
      },
    })({ registerTool: (tool: any) => tools.push(tool), on: (name: string, hook: any) => hooks.set(name, hook), events: { on() {}, emit() {} }, sendMessage: (message: any) => messages.push(message) } as any);
    const result = await tools[0].execute("launch", { agent: "review", task: "Review the repository" }, undefined, undefined, ctx);
    // The detached registry work may still be preparing its system prompt.
    while (!handle) await new Promise(resolve => setTimeout(resolve, 1));
    child.event({ type: "agent_start" });
    return { child, handle, messages, tools, ctx, id: result.details.taskId, cleanup: async () => {
      hooks.get("session_shutdown")?.({}, ctx);
      handle.terminate(); await handle.done;
      rmSync(directory, { recursive: true, force: true });
      if (oldLog === undefined) delete process.env.PI_SUBAGENT_LOG_DIR; else process.env.PI_SUBAGENT_LOG_DIR = oldLog;
      if (oldKeepalive === undefined) delete process.env.PI_SUBAGENT_KEEPALIVE_MS; else process.env.PI_SUBAGENT_KEEPALIVE_MS = oldKeepalive;
    } };
  } catch (error) {
    handle?.terminate(); await handle?.done;
    rmSync(directory, { recursive: true, force: true });
    if (oldLog === undefined) delete process.env.PI_SUBAGENT_LOG_DIR; else process.env.PI_SUBAGENT_LOG_DIR = oldLog;
    if (oldKeepalive === undefined) delete process.env.PI_SUBAGENT_KEEPALIVE_MS; else process.env.PI_SUBAGENT_KEEPALIVE_MS = oldKeepalive;
    throw error;
  }
}

test("real RPC retirement through the registry and host publisher keeps Completed and delivers once", async () => {
  const h = await harness();
  try {
    h.child.answer("Completed review");
    expect((await h.handle.done).status).toBe("completed");
    await new Promise(resolve => setTimeout(resolve, 5));
    const shown = await h.tools[1].execute("show", { action: "show", id: h.id }, undefined, undefined, h.ctx);
    expect(shown.details.status).toBe("completed");
    expect(h.messages.filter(message => message.customType === "subagent-result")).toHaveLength(1);
    expect(h.messages.filter(message => message.customType === "subagent-update").every(message => message.details.nativeStatus !== "failed")).toBe(true);
    expect(h.messages.find(message => message.customType === "subagent-result").content).toContain("Completed review");
  } finally { await h.cleanup(); }
});

test("an accepted reply cancels idle retirement and may work past the previous keepalive deadline", async () => {
  const h = await harness();
  try {
    h.child.answer("First review");
    await h.tools[1].execute("reply", { action: "reply", id: h.id, prompt: "Keep reviewing" }, undefined, undefined, h.ctx);
    // Even before the child's agent_start arrives, the admitted reply owns the lane.
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(h.child.kills).toBe(0);
    h.child.event({ type: "agent_start" });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(h.child.kills).toBe(0);
    h.child.answer("Second review");
    expect(await h.handle.done).toMatchObject({ status: "completed", text: "Second review" });
  } finally { await h.cleanup(); }
});
