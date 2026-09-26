import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentChildEnv, subagentExtension, subagentsDisabled } from "../src/index.ts";

interface CapturedTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  execute?: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => { render(width: number): string[] };
  renderResult?: (...args: any[]) => { render(width: number): string[] };
}

function fakePi(): { pi: ExtensionAPI; tools: CapturedTool[]; messages: Array<{ message: any; options: any }>; emit: (name: string, value?: any) => void } {
  const tools: CapturedTool[] = [];
  const listeners = new Map<string, Array<(value: any) => void>>();
  const messages: Array<{ message: any; options: any }> = [];
  const emit = (name: string, value?: any) => { for (const handler of listeners.get(name) ?? []) handler(value); };
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    on(name: string, handler: (value: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
    events: {
      on(name: string, handler: (value: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      emit,
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, messages, emit };
}

describe("subagentsDisabled", () => {
  test("honours the documented spellings", () => {
    expect(subagentsDisabled({ PI_SUBAGENT_DISABLE: "1" })).toBe(true);
    expect(subagentsDisabled({ PI_SUBAGENT_DISABLE: "ON" })).toBe(true);
    expect(subagentsDisabled({ PI_SUBAGENT_DISABLE: "true" })).toBe(true);
    expect(subagentsDisabled({})).toBe(false);
    expect(subagentsDisabled({ PI_SUBAGENT_DISABLE: "0" })).toBe(false);
  });

  /**
   * Fan-out is one level deep.
   *
   * `pi-agent-runner` sets the child environment; this plugin reads the switch.
   * The two halves are composed here rather than asserted separately, so the
   * test fails if either the runner stops setting the flag or this plugin stops
   * honoring it. The env's exact shape is pinned once, in the runner's own test.
   */
  test("a subagent child cannot delegate again", () => {
    expect(subagentsDisabled(agentChildEnv({}))).toBe(true);
  });
});

describe("the extension registers delegation and task tools", () => {
  test("shows the selected agent, task and live tool activity", async () => {
    const { pi, tools } = fakePi();
    const updates: any[] = [];
    subagentExtension({
      discover: () => [{ name: "explore", description: "read", systemPrompt: "Explore", filePath: "explore.md" }],
      executor: async (input) => {
        input.onProgress?.({ type: "tool_start", toolName: "grep", target: "plugins/workflow/src" });
        input.onProgress?.({ type: "tool_end", toolName: "grep" });
        input.onProgress?.({ type: "tool_start", toolName: "read" });
        input.onProgress?.({ type: "tool_end", toolName: "read" });
        return { status: "completed", text: "Found the runner", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 2 } };
      },
    })(pi);
    const tool = tools[0]!;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const call = tool.renderCall!({ agent: "explore", task: "Inspect pi-workflow" }, theme).render(120).join("\n");
    expect(call).toContain("explore");
    expect(call).toContain("Inspect pi-workflow");
    const result = await tool.execute!("call-activity", { agent: "explore", task: "Inspect pi-workflow" }, undefined, (update: any) => updates.push(update), { cwd: "/repo" });
    expect(updates.length).toBeGreaterThan(1);
    const running = tool.renderResult!(updates[1], { expanded: false, isPartial: true }, theme).render(120).join("\n");
    expect(running).toContain("explore · running · using grep plugins/workflow/src");
    const done = tool.renderResult!(result, { expanded: true, isPartial: false }, theme).render(120).join("\n");
    expect(done).toContain("explore · completed · 2 tools");
    expect(done).toContain("grep plugins/workflow/src → read");
    expect(done).toContain("Found the runner");
  });
  test("a launched background task is not painted as a failure", () => {
    // The immediate handle is a success (`status: "running"`, `taskId` set) but
    // rendered with the label `launched`; a colour table that knew only
    // `completed` and `running` fell through to `error`, so a task that started
    // fine looked red — the one signal the user reads as "this failed".
    const { pi, tools } = fakePi();
    subagentExtension()(pi);
    const colors: string[] = [];
    const theme = { fg: (color: string, text: string) => { colors.push(color); return text; }, bold: (text: string) => text };
    const launched = {
      content: [{ type: "text", text: "started" }],
      details: { agent: "explore", status: "running", taskId: "sa-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 }, output: "" },
    };
    const line = tools[0]!.renderResult!(launched, { expanded: false, isPartial: false }, theme).render(120).join("\n");
    expect(line).toContain("launched");
    expect(colors).not.toContain("error");
  });

  test("a normal host gets foreground/background delegation and a task control tool", () => {
    const { pi, tools } = fakePi();
    subagentExtension()(pi);
    expect(tools.length).toBe(2);
    expect(tools[0]!.name).toBe("subagent");
    expect(tools[1]!.name).toBe("subagent_tasks");
    expect(tools[0]!.promptGuidelines?.length).toBeGreaterThan(0);
  });

  test("a disabled host registers nothing", () => {
    const { pi, tools } = fakePi();
    subagentExtension({ enabled: false })(pi);
    expect(tools.length).toBe(0);
  });

  test("reports foreground child usage to a goal service loaded later", async () => {
    const { pi, tools } = fakePi();
    const reported: number[] = [];
    let childModel: string | undefined;
    subagentExtension({
      discover: () => [{ name: "scout", description: "read", systemPrompt: "Scout", filePath: "scout.md" }],
      executor: async (input) => {
        childModel = input.model;
        return { status: "completed", text: "ok", usage: { input: 3, output: 2, cacheRead: 5, cacheWrite: 0, cost: 0, totalTokens: 10 } };
      },
    })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: (tokens: number) => reported.push(tokens) }) });
    await tools[0]!.execute!("call-1", { agent: "scout", task: "x" }, undefined, undefined, {
      cwd: "/repo", model: { provider: "parent", id: "model" }, thinkingLevel: "high",
    });
    expect(reported).toEqual([10]);
    expect(childModel).toBe("parent/model");
  });

  test("background returns immediately, then delivers the answer and charges goal usage", async () => {
    const { pi, tools, messages } = fakePi();
    const reported: number[] = [];
    let finish: ((value: any) => void) | undefined;
    let childModel: string | undefined;
    let childHasProgress = false;
    subagentExtension({
      discover: () => [{ name: "explore", description: "read", systemPrompt: "Explore", filePath: "explore.md" }],
      executor: (input) => {
        childModel = input.model;
        childHasProgress = Boolean(input.onProgress);
        input.onProgress?.({ type: "tool_start", toolName: "read", target: "src/index.ts" });
        return new Promise((resolve) => { finish = resolve; });
      },
    })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: (tokens: number) => reported.push(tokens) }) });
    const ctx = { cwd: "/repo", model: { provider: "parent", id: "model" }, sessionManager: { getSessionId: () => "session-a" } };
    const launched = await tools[0]!.execute!("bg-1", { agent: "explore", task: "Inspect", background: true }, undefined, undefined, ctx);
    const id = launched.details.taskId as string;
    expect(id).toStartWith("sa-");
    expect(launched.content[0].text).toContain("started in the background");
    expect(childModel).toBe("parent/model");
    expect(childHasProgress).toBe(true);
    expect(reported).toEqual([]);
    const running = await tools[1]!.execute!("status-1", { action: "show", id }, undefined, undefined, ctx);
    expect(running.content[0].text).toContain("running");
    expect(running.content[0].text).toContain("read src/index.ts");
    finish!({ status: "completed", text: "Found the entry", usage: { input: 3, output: 2, cacheRead: 5, cacheWrite: 0, cost: 0, totalTokens: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toEqual([10]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.content).toContain("Found the entry");
    expect(messages[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    const settled = await tools[1]!.execute!("status-2", { action: "show", id }, undefined, undefined, ctx);
    expect(settled.content[0].text).toContain("completed");
  });

  test("a background task is cancelled on tree navigation and late results cannot wake the new branch", async () => {
    const { pi, tools, messages, emit } = fakePi();
    let childSignal: AbortSignal | undefined;
    let resolveChild!: (value: any) => void;
    subagentExtension({ executor: (input) => {
      childSignal = input.signal;
      return new Promise((resolve) => { resolveChild = resolve; });
    } })(pi);
    const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "same-session" } };
    await tools[0]!.execute!("tree-job", { agent: "explore", task: "Inspect", background: true }, undefined, undefined, ctx);
    emit("session_before_tree");
    try {
      expect(childSignal?.aborted).toBe(true);
    } finally {
      resolveChild({ status: "completed", text: "Old branch answer", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 2 } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(messages).toHaveLength(0);
  });

  test("shows-quiet-time-and-a-bounded-activity-trail-for-a-running-task", async () => {
    const { pi, tools } = fakePi();
    let finish: ((value: any) => void) | undefined;
    subagentExtension({
      executor: (input) => {
        const onActivity = (input as unknown as {
          onActivity?: (activity: Record<string, unknown>) => void;
        }).onActivity;
        for (let index = 0; index < 12; index += 1) {
          onActivity?.({
            event: "tool_start",
            phase: "tool",
            at: Date.now() - 125_000,
            toolName: "grep",
            target: "src/worker.ts",
            output: "must not be exposed",
          });
        }
        return new Promise((resolve) => { finish = resolve; });
      },
    })(pi);
    const ctx = {
      cwd: "/repo",
      sessionManager: { getSessionId: () => "session-a" },
    };
    const launched = await tools[0]!.execute!("bg-visibility", {
      agent: "explore",
      task: "Inspect the worker",
      background: true,
    }, undefined, undefined, ctx);
    const id = launched.details.taskId as string;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = await tools[1]!.execute!("status-visibility", {
      action: "show",
      id,
    }, undefined, undefined, ctx);
    expect(status.content[0]!.text).toContain("tool grep src/worker.ts");
    expect(status.content[0]!.text).toContain("possible stall");

    const events = await tools[1]!.execute!("events-visibility", {
      action: "events",
      id,
    }, undefined, undefined, ctx);
    expect(events.content[0]!.text).toContain("tool_start");
    expect(events.content[0]!.text).toContain("grep src/worker.ts");
    expect(events.content[0]!.text).not.toContain("must not be exposed");
    expect(events.details.events).toHaveLength(10);
    expect(JSON.stringify(events.details.events)).not.toContain("must not be exposed");

    finish!({ status: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } });
  });

  test("explicit-log-action-reads-only-a-bounded-matching-tail", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const logDir = await mkdtemp(join(tmpdir(), "pi-subagent-log-test-"));
    const previousLogDir = process.env.PI_SUBAGENT_LOG_DIR;
    process.env.PI_SUBAGENT_LOG_DIR = logDir;
    let finish: ((value: any) => void) | undefined;
    try {
      const { pi, tools } = fakePi();
      subagentExtension({
        executor: async (input) => {
          await writeFile(input.evidencePath!, [
            JSON.stringify({ type: "assistant_message", text: "needle early" }),
            JSON.stringify({ type: "tool_execution_start", toolName: "grep", args: { pattern: "secret query" } }),
            JSON.stringify({ type: "tool_execution_end", toolName: "grep", result: { content: "needle result body" } }),
          ].join("\n") + "\n");
          return new Promise((resolve) => { finish = resolve; });
        },
      })(pi);
      const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session-log" } };
      const launched = await tools[0]!.execute!("log-job", {
        agent: "explore", task: "Inspect", background: true,
      }, undefined, undefined, ctx);
      const id = launched.details.taskId as string;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const shown = await tools[1]!.execute!("log-show", {
        action: "show", id,
      }, undefined, undefined, ctx);
      const listed = await tools[1]!.execute!("log-list", {
        action: "list",
      }, undefined, undefined, ctx);
      expect(shown.details.logPath).toBeUndefined();
      expect(JSON.stringify(listed.details)).not.toContain(logDir);

      const log = await tools[1]!.execute!("log-read", {
        action: "log", id, query: "needle", lines: 1,
      }, undefined, undefined, ctx);
      expect(log.content[0]!.text).toContain("needle result body");
      expect(log.content[0]!.text).not.toContain("secret query");
      expect(log.content[0]!.text).not.toContain("needle early");

      finish!({ status: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } });
    } finally {
      if (previousLogDir === undefined) delete process.env.PI_SUBAGENT_LOG_DIR;
      else process.env.PI_SUBAGENT_LOG_DIR = previousLogDir;
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("a background task can be cancelled and cannot notify a switched session", async () => {
    const { pi, tools, messages, emit } = fakePi();
    let childSignal: AbortSignal | undefined;
    subagentExtension({
      discover: () => [{ name: "explore", description: "read", systemPrompt: "Explore", filePath: "explore.md" }],
      executor: (input) => new Promise((resolve) => {
        childSignal = input.signal;
        input.signal?.addEventListener("abort", () => resolve({ status: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } }), { once: true });
      }),
    })(pi);
    let sessionId = "session-a";
    const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => sessionId } };
    const launched = await tools[0]!.execute!("bg-2", { agent: "explore", task: "Inspect", background: true }, undefined, undefined, ctx);
    const id = launched.details.taskId as string;
    const cancelled = await tools[1]!.execute!("cancel-1", { action: "cancel", id }, undefined, undefined, ctx);
    expect(cancelled.content[0].text).toContain("Stopping");
    expect(childSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.options).toBeUndefined();
    const next = await tools[0]!.execute!("bg-3", { agent: "explore", task: "Inspect", background: true }, undefined, undefined, ctx);
    const nextId = next.details.taskId as string;
    emit("session_shutdown", { type: "session_shutdown" });
    sessionId = "session-b";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toHaveLength(1);
    const hidden = await tools[1]!.execute!("status-3", { action: "show", id: nextId }, undefined, undefined, ctx);
    expect(hidden.content[0].text).toContain("No subagent task");
  });
});

/**
 * The plugin has to load through pi itself.
 *
 * A registration that typechecks can still fail to load — a bad import, an
 * extension entry that exports no factory — and that failure is invisible until
 * a user installs the package. The loader is the real path the two meet on.
 */
test("pi loads the subagent extension without errors", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "pi-subagent-load-"));
  try {
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
    const loader = new DefaultResourceLoader({
      cwd: isolated,
      agentDir: isolated,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entry],
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions.find((extension) => extension.path === entry)).toBeDefined();
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});
