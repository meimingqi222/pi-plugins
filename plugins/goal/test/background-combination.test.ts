import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalPlugin from "../src/index.ts";
import bgBashPlugin from "../../bg-bash/src/index.ts";
import { subagentExtension } from "../../subagent/src/index.ts";
import { workflowExtension } from "../../workflow/src/pi/index.ts";

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Background combination did not settle");
}

for (const goalFirst of [true, false]) {
  for (const navigate of [false, true]) {
    test(`background plugins with goal ${goalFirst ? "first" : "last"}: ${navigate ? "navigation drops queued results" : "deliver once before verification"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-background-combination-"));
      const previous = { plan: process.env.PI_GOAL_PLAN, logs: process.env.PI_BG_BASH_LOG_DIR };
      process.env.PI_GOAL_PLAN = "false";
      process.env.PI_BG_BASH_LOG_DIR = join(root, "logs");
      const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
      const bus = new Map<string, Array<(value: any) => void>>();
      const tools = new Map<string, any>();
      const commands = new Map<string, any>();
      const entries: any[] = [];
      const delivered: string[] = [];
      let idle = true;
      let queued = false;
      let verified = 0;
      const ctx: any = {
        cwd: root, hasUI: false, isIdle: () => idle, hasPendingMessages: () => queued, abort() {},
        ui: { setStatus() {}, notify() {}, setWorkingMessage() {} },
        sessionManager: { getSessionId: () => "same", getBranch: () => entries, getSessionDir: () => root },
        model: { provider: "test", id: "model" },
        modelRegistry: { hasConfiguredAuth: () => true, find: () => undefined, complete: async () => {
          verified++;
          return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "done", evidence: "results" }) }] };
        } },
      };
      const pi: any = {
        on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
        events: {
          on(name: string, handler: any) { bus.set(name, [...(bus.get(name) ?? []), handler]); },
          emit(name: string, value: any) { for (const handler of bus.get(name) ?? []) handler(value); },
        },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerCommand(name: string, command: any) { commands.set(name, command); },
        registerMessageRenderer() {}, registerShortcut() {}, registerFlag() {},
        appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
        sendMessage(message: any, options: any) {
          if (message.customType === "goal-continuation") return;
          expect(idle).toBe(true);
          delivered.push(message.customType);
          if (options?.triggerTurn) queued = true;
        },
      };
      const emit = async (name: string, event: any = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
      };
      const call = (name: string, args: any) => tools.get(name).execute(name, args, undefined, undefined, ctx);
      const state = async () => (await call("get_goal", {})).details;
      try {
        if (goalFirst) goalPlugin(pi);
        bgBashPlugin(pi);
        workflowExtension({ executor: async () => ({ status: "completed", text: "workflow evidence", usage: { input: 2, output: 3 } }) })(pi);
        subagentExtension({ executor: async () => ({ status: "completed", text: "subagent evidence", usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0 } }) })(pi);
        if (!goalFirst) goalPlugin(pi);
        await commands.get("goal").handler("task", ctx);
        await emit("agent_start");
        idle = false;
        await call("workflow", { script: "return await agent('inspect', {});" });
        await call("subagent", { agent: "explore", task: "inspect", background: true });
        await call("bash", { command: "echo evidence", background: true });
        await call("update_goal", { kind: "candidate_complete", message: "done" });
        await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
        await until(async () => (await state()).used === 12 && (await call("bg_tasks", { action: "list" })).content[0].text.includes("exited"));
        expect(delivered).toHaveLength(0);
        if (navigate) await emit("session_before_tree");
        idle = true;
        await emit("agent_settled");
        expect(delivered.sort()).toEqual(navigate ? [] : ["bg_bash_result", "subagent-result", "workflow-result"]);
        expect(verified).toBe(0);
        if (!navigate) {
          queued = false;
          await emit("agent_start");
          await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
          await emit("agent_settled");
          await until(async () => (await state()).status === "complete");
          expect(verified).toBe(1);
          expect((await state()).used).toBe(12);
          expect(delivered).toHaveLength(3);
        }
      } finally {
        await emit("session_shutdown");
        if (previous.plan === undefined) delete process.env.PI_GOAL_PLAN;
        else process.env.PI_GOAL_PLAN = previous.plan;
        if (previous.logs === undefined) delete process.env.PI_BG_BASH_LOG_DIR;
        else process.env.PI_BG_BASH_LOG_DIR = previous.logs;
        await rm(root, { recursive: true, force: true });
      }
    }, 10000);
  }
}
