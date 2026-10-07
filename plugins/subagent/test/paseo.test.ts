import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentRunResult, RpcChildInput } from "pi-agent-runner";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareHostArguments } from "../src/host-protocol.ts";
import { subagentExtension } from "../src/index.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  totalTokens: 0,
};

test.each(["foreground", "background"] as const)(
  "%s RPC launch reports readable progress before the child finishes",
  async (kind) => {
    const tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const messages: Array<{ content: string; display: boolean; details: { id: string; status: string } }> = [];
    const listeners = new Map<string, () => void>();
    let finish!: (result: AgentRunResult) => void;
    let started!: () => void;
    let taskDeadline: number | undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const done = new Promise<AgentRunResult>((resolve) => { finish = resolve; });
    const pi = {
      registerTool: (tool: unknown) => tools.push(tool as (typeof tools)[number]),
      on: (name: string, handler: () => void) => listeners.set(name, handler),
      events: { on: () => {}, emit: () => {} },
      sendMessage: (message: unknown) => messages.push(message as (typeof messages)[number]),
    } as unknown as ExtensionAPI;
    subagentExtension({
      discover: () => [{ name: "review", description: "review", systemPrompt: "review", filePath: "review.md" }],
      executor: async (input) => { taskDeadline = input.timeoutMs; started(); return done; },
      spawnRpcChild: async (input) => {
        taskDeadline = input.timeoutMs;
        started();
        return { pid: 1, done, send: () => true, end: () => {}, terminate: () => finish({ status: "aborted", usage }) };
      },
    })(pi);
    const call = tools[0]!.execute("live-call", { subagent_type: "review", prompt: "inspect", timeout: 1800, background: kind === "background" }, undefined, undefined, {
      cwd: process.cwd(), mode: "rpc", sessionManager: { getSessionId: () => "live-session" }, isIdle: () => false,
    });
    try {
      await ready;
      expect(taskDeadline).toBe(1_800_000);
      const progress = messages.find((message) => message.display && message.content.includes("starting"));
      expect(progress).toBeDefined();
      expect(progress!.details.status).toBe("running");
      if (kind === "foreground") expect(progress!.details.id).toBe("live-call");
      else expect(progress!.details.id).toMatch(/^sa-/u);
    } finally {
      finish({ status: "completed", text: "done", usage });
      await call;
      await new Promise((resolve) => setTimeout(resolve, 0));
      listeners.get("session_shutdown")?.();
    }
  },
);

test("Paseo gets a correlated failed update even when the parent consumes the answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-paseo-test-"));
  const oldDir = process.env.PI_SUBAGENT_LOG_DIR;
  process.env.PI_SUBAGENT_LOG_DIR = dir;
  interface CapturedTool {
    parameters: { required?: string[] };
    execute: (
      ...args: unknown[]
    ) => Promise<{ details: Record<string, unknown> }>;
  }
  interface StateMessage {
    customType: string;
    display: boolean;
    details: {
      id: string;
      status: string;
      nativeStatus: string;
      outputFile?: string;
    };
  }
  const tools: CapturedTool[] = [];
  const messages: Array<{
    message: StateMessage;
    options: { triggerTurn: boolean };
  }> = [];
  let child!: RpcChildInput;
  let finish!: (result: AgentRunResult) => void;
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    registerTool: (tool: unknown) => tools.push(tool as CapturedTool),
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    events: { on: () => {}, emit: () => {} },
    sendMessage: (message: unknown, options: unknown) =>
      messages.push({
        message: message as StateMessage,
        options: options as { triggerTurn: boolean },
      }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "paseo-test" },
    isIdle: () => false,
  };
  subagentExtension({
    discover: () => [
      {
        name: "review",
        description: "review",
        systemPrompt: "review",
        filePath: "review.md",
      },
    ],
    spawnRpcChild: async (input) => {
      child = input;
      return {
        pid: 1,
        done: new Promise((resolve) => {
          finish = resolve;
        }),
        send: () => true,
        end: () => {},
        terminate: () => finish({ status: "aborted", usage }),
      };
    },
  })(pi);
  try {
    expect(tools[0]!.parameters.required).toContain("subagent_type");
    expect(tools[0]!.parameters.required).toContain("prompt");
    const launched = await tools[0]!.execute(
      "spawn-call",
      { subagent_type: "review", prompt: "inspect", background: true },
      undefined,
      undefined,
      ctx,
    );
    expect(launched.details.agentId).toBe(launched.details.taskId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.onEvent?.({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "child output" }],
        isError: false,
      },
    });
    child.onIdleChange?.(true);
    child.onTurnSettled?.({
      status: "failed",
      errorMessage: "timed out",
      usage,
    });
    await tools[1]!.execute(
      "show",
      { action: "show", id: launched.details.taskId },
      undefined,
      undefined,
      ctx,
    );
    for (const listener of listeners.get("turn_end") ?? [])
      await listener({}, ctx);
    const updates = messages.filter(
      ({ message }) => message.customType === "subagent-update",
    );
    expect(updates.at(-1)!.message.details).toMatchObject({
      id: launched.details.agentId,
      status: "error",
      nativeStatus: "failed",
    });
    const transcript = readFileSync(
      updates.at(-1)!.message.details.outputFile!,
      "utf8",
    );
    expect(transcript).toContain("child output");
    expect(transcript).toContain("timed out");
    expect(updates.at(-1)!.message.display).toBe(false);
    expect(updates.at(-1)!.options.triggerTurn).toBe(false);
    expect(
      messages.filter(
        ({ message }) => message.customType === "subagent-result",
      ),
    ).toHaveLength(0);
    // A reply reopens the same correlated task; no new host card is needed.
    await tools[1]!.execute(
      "reply",
      { action: "reply", id: launched.details.taskId, prompt: "retry" },
      undefined,
      undefined,
      ctx,
    );
    expect(
      messages
        .filter(({ message }) => message.customType === "subagent-update")
        .at(-1)!.message.details.status,
    ).toBe("running");
    finish({ status: "aborted", usage });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      messages
        .filter(({ message }) => message.customType === "subagent-update")
        .at(-1)!.message.details.status,
    ).toBe("aborted");
  } finally {
    for (const listener of listeners.get("session_shutdown") ?? [])
      await listener({}, ctx);
    if (oldDir === undefined) delete process.env.PI_SUBAGENT_LOG_DIR;
    else process.env.PI_SUBAGENT_LOG_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy spawn arguments normalize to the host contract without shadowing another adapter", () => {
  expect(
    prepareHostArguments({
      agent: "review",
      task: "inspect",
      background: true,
    }),
  ).toEqual({ subagent_type: "review", prompt: "inspect", background: true });
  expect(
    prepareHostArguments({ subagent_type: "review", prompt: "inspect" }),
  ).toEqual({ subagent_type: "review", prompt: "inspect" });
});

test.each(["completed", "failed", "thrown"] as const)(
  "foreground %s exposes its transcript under the spawn call identity",
  async (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-paseo-foreground-"));
    const oldDir = process.env.PI_SUBAGENT_LOG_DIR;
    process.env.PI_SUBAGENT_LOG_DIR = dir;
    const tools: Array<{
      execute: (
        ...args: unknown[]
      ) => Promise<{ details: Record<string, unknown> }>;
    }> = [];
    const messages: Array<{
      customType: string;
      details: { id: string; outputFile?: string };
    }> = [];
    const pi = {
      registerTool: (tool: unknown) =>
        tools.push(tool as (typeof tools)[number]),
      on: () => {},
      events: { on: () => {}, emit: () => {} },
      sendMessage: (message: unknown) =>
        messages.push(message as (typeof messages)[number]),
    } as unknown as ExtensionAPI;
    subagentExtension({
      discover: () => [
        {
          name: "review",
          description: "review",
          systemPrompt: "review",
          filePath: "review.md",
        },
      ],
      executor: async (input) => {
        input.onEvent?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "reviewed" }],
          },
        });
        if (outcome === "thrown") throw new Error("spawn failed");
        if (outcome === "failed")
          return {
            status: "failed",
            text: "reviewed",
            errorMessage: "timed out",
            usage,
          };
        return { status: "completed", text: "reviewed", usage };
      },
    })(pi);
    try {
      const result = await tools[0]!.execute(
        "foreground-spawn",
        { subagent_type: "review", prompt: "inspect" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          sessionManager: { getSessionId: () => "foreground-session" },
          isIdle: () => true,
        },
      );
      expect(result.details.agentId).toBe("foreground-spawn");
      expect(result.details.nativeStatus).toBe(
        outcome === "completed" ? "completed" : "failed",
      );
      const update = messages.find(
        (message) => message.customType === "subagent-update" && message.details.outputFile,
      )!;
      expect(update.details.id).toBe("foreground-spawn");
      const rows = readFileSync(update.details.outputFile!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (outcome === "completed") {
        expect(
          rows.filter((row) => row.message.role === "assistant"),
        ).toHaveLength(1);
        expect(rows.at(-1).message.content[0].text).toBe("reviewed");
      } else {
        expect(rows.at(-1).message.content[0].text).toContain(
          outcome === "thrown" ? "spawn failed" : "timed out",
        );
      }
    } finally {
      if (oldDir === undefined) delete process.env.PI_SUBAGENT_LOG_DIR;
      else process.env.PI_SUBAGENT_LOG_DIR = oldDir;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
