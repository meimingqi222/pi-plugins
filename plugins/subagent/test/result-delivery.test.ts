import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, RpcChildInput } from "pi-agent-runner";
import { subagentExtension } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness() {
  const tools: Array<{ execute: (...args: any[]) => Promise<any> }> = [];
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const messages: Array<{ message: any; options: any }> = [];
  let input!: RpcChildInput;
  let finish!: (result: AgentRunResult) => void;
  let rejectDone!: (error: Error) => void;
  let idle = false;
  let refuseNextSend = false;
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "result-session" }, isIdle: () => idle };
  const emit = async (name: string, event: any = {}, eventContext: typeof ctx & { signal?: AbortSignal } = ctx) => {
    for (const handler of listeners.get(name) ?? []) await handler(event, eventContext);
  };
  const pi = {
    registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
    on: (name: string, handler: (...args: any[]) => unknown) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    events: { on: () => {}, emit: () => {} },
    sendMessage: (message: any, options: any) => {
      if (refuseNextSend) {
        refuseNextSend = false;
        throw new Error("delivery refused");
      }
      if (message.customType !== "subagent-update") messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-result-"));
  cleanups.push(async () => { await emit("session_shutdown"); await rm(dir, { recursive: true, force: true }); });
  const previousLogDir = process.env.PI_SUBAGENT_LOG_DIR;
  process.env.PI_SUBAGENT_LOG_DIR = dir;
  let id: string;
  try {
    subagentExtension({
      discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
      spawnRpcChild: async (value) => {
        input = value;
        return {
          pid: 1,
          done: new Promise<AgentRunResult>((resolve, reject) => { finish = resolve; rejectDone = reject; }),
          send: () => true,
          end: () => finish({ status: "completed", text: "the answer", usage }),
          terminate: () => finish({ status: "aborted", text: "", usage }),
        };
      },
    })(pi);
    const launched = await tools[0]!.execute("launch", { agent: "explore", task: "inspect", background: true }, undefined, undefined, ctx);
    id = launched.details.taskId;
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (previousLogDir === undefined) delete process.env.PI_SUBAGENT_LOG_DIR;
    else process.env.PI_SUBAGENT_LOG_DIR = previousLogDir;
  }
  return {
    messages, emit, input, ctx,
    setIdle: (value: boolean) => { idle = value; },
    refuseSend: () => { refuseNextSend = true; },
    settle: (text = "the answer", status: "completed" | "failed" = "completed") => {
      input.onIdleChange?.(true);
      input.onTurnSettled?.({ status, text, usage });
    },
    finish: async (status: AgentRunResult["status"] = "completed") => {
      finish({ status, text: "the answer", usage });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    reject: async (message: string) => {
      rejectDone(new Error(message));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    query: (action: string, params: Record<string, unknown> = {}, signal?: AbortSignal) =>
      tools[1]!.execute("query", { action, id, ...params }, signal, undefined, ctx),
    writeLog: (text: string) => writeFile(input.evidencePath!, text),
  };
}

describe("subagent result delivery", () => {
  test("an unread answer enters the active run at turn_end and is not resent at settlement", async () => {
    const host = await harness();
    host.settle();
    expect(host.messages).toHaveLength(0);
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(1);
  });

  for (const action of ["show", "wait", "log"]) {
    test(`${action} returning a final answer consumes its pending notification`, async () => {
      const host = await harness();
      await host.writeLog(`${JSON.stringify({ type: "tool_execution_end", result: "partial evidence" })}\n`);
      host.settle();
      const result = await host.query(action, { timeout: 0 });
      expect(result.content[0].text).toContain("the answer");
      await host.emit("turn_end");
      host.setIdle(true);
      await host.emit("agent_settled");
      expect(host.messages).toHaveLength(0);
    });
  }

  test("reading progress logs does not consume a later final answer", async () => {
    const host = await harness();
    await host.writeLog(`${JSON.stringify({ type: "message_update", text: "partial answer" })}\n`);
    const result = await host.query("log");
    expect(result.content[0].text).toContain("partial answer");
    host.settle();
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(1);
  });

  test("a truncated log appends the canonical final answer before consuming it", async () => {
    const host = await harness();
    const answer = "complete answer " + "detail ".repeat(700);
    await host.writeLog(`${JSON.stringify({ type: "message_end", text: answer })}\n`);
    host.settle(answer);
    const result = await host.query("log");
    expect(result.content[0].text).toContain("line truncated");
    expect(result.content[0].text).toContain(answer);
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(0);
  });

  test("an unavailable raw log still returns and consumes an available answer", async () => {
    const host = await harness();
    host.settle();
    const result = await host.query("log");
    expect(result.content[0].text).toContain("log is unavailable");
    expect(result.content[0].text).toContain("the answer");
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(0);
  });

  test("reading an old answer during a reply does not consume the next revision", async () => {
    const host = await harness();
    host.settle("first answer");
    await host.query("reply", { prompt: "next question" });
    expect((await host.query("show")).content[0].text).toContain("first answer");
    host.settle("second answer");
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]!.message.content).toContain("second answer");
    expect(host.messages[0]!.message.content).not.toContain("first answer");
  });

  test("keepalive settlement preserves the answer revision consumed through show", async () => {
    const host = await harness();
    host.settle();
    await host.finish();
    await host.query("show");
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(0);
  });

  test("a result after agent_end uses the settled fallback", async () => {
    const host = await harness();
    await host.emit("agent_end");
    host.settle();
    expect(host.messages).toHaveLength(0);
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  test("an aborted result query does not consume the notification", async () => {
    const host = await harness();
    host.settle();
    await host.query("wait", { timeout: 0 }, AbortSignal.abort());
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(1);
  });

  test("status and event inspection do not consume the final answer", async () => {
    const host = await harness();
    host.settle();
    await host.query("list");
    await host.query("events");
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(1);
  });

  test("a refused send stays pending for the next safe boundary", async () => {
    const host = await harness();
    host.settle();
    host.refuseSend();
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(0);
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(1);
  });

  test("a new terminal failure is not suppressed by a previously read turn", async () => {
    const host = await harness();
    host.settle();
    await host.query("show");
    await host.query("reply", { prompt: "next question" });
    await host.finish("failed");
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]!.message.details.status).toBe("failed");
    expect(host.messages[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  test("process exit does not reannounce an already read failed turn", async () => {
    const host = await harness();
    host.settle("the answer", "failed");
    await host.query("show");
    await host.finish("failed");
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(0);
  });

  test("an exceptional terminal failure replaces an old answer with a new revision", async () => {
    const host = await harness();
    host.settle("first answer");
    await host.query("show");
    await host.query("reply", { prompt: "next question" });
    await host.reject("new failure");
    const result = await host.query("show");
    expect(result.content[0].text).toContain("new failure");
    expect(result.content[0].text).not.toContain("first answer");
    expect(result.details.resultRevision).toBe(2);
    await host.emit("turn_end");
    expect(host.messages).toHaveLength(0);
  });

  test("an aborted parent turn retains unread results for the settled fallback", async () => {
    const host = await harness();
    host.settle();
    await host.emit("turn_end", {}, { ...host.ctx, signal: AbortSignal.abort() });
    expect(host.messages).toHaveLength(0);
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(1);
  });

  test("session navigation discards both boundary delivery paths", async () => {
    const host = await harness();
    host.settle();
    await host.emit("session_before_tree");
    await host.emit("turn_end");
    host.setIdle(true);
    await host.emit("agent_settled");
    expect(host.messages).toHaveLength(0);
  });
});
