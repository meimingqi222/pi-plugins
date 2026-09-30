import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Lane } from "../src/lane.ts";
import { SubagentResultDelivery } from "../src/result-delivery.ts";

const model = {
  id: "delivery-test", name: "delivery test", api: "openai-completions", provider: "openai",
  baseUrl: "http://localhost.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
} as const;

function record(session: AgentSession, status: "completed" | "failed" = "completed"): Lane {
  return {
    id: "sa-delivery-test", agent: "explore", alias: "delivery", task: "inspect", kind: "background",
    sessionId: session.sessionManager.getSessionId(), status: "running", startedAt: Date.now(),
    resultRevision: 1, turnsAnswered: 1,
    result: {
      content: [{ type: "text", text: "child evidence" }],
      details: {
        agent: "explore", status, output: "child evidence",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 },
      },
    },
  };
}

async function withSession(factory: ExtensionFactory, run: (session: AgentSession) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-delivery-runtime-"));
  let session: AgentSession | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, extensionFactories: [factory],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(model.provider, "offline-test");
    const created = await createAgentSession({
      cwd: dir, agentDir: dir, settingsManager, resourceLoader, modelRuntime,
      sessionManager: SessionManager.inMemory(dir), model: { ...model, input: ["text"] }, noTools: "builtin",
    });
    session = created.session;
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    await run(session);
    expect(errors).toEqual([]);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

function installModel(session: AgentSession, useTool: boolean): Array<{ messages: unknown[] }> {
  const requests: Array<{ messages: unknown[] }> = [];
  session.agent.streamFunction = async (_model, context) => {
    requests.push({ messages: structuredClone(context.messages) });
    const toolCall = useTool && requests.length === 1;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: toolCall
        ? [{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }]
        : [{ type: "text", text: "parent summary" }],
      stopReason: toolCall ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return {
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
      result: async () => message,
    } as any;
  };
  return requests;
}

describe("Pi native result delivery", () => {
  for (const scenario of [
    { consumed: false, status: "completed", name: "turn_end steering reaches the next model call within the same run" },
    { consumed: true, status: "completed", name: "a tool-read result creates no duplicate native input or extra run" },
    { consumed: false, status: "failed", name: "an unread failure reaches the next model call within the same run" },
  ] as const) {
    test(scenario.name, async () => {
      let current!: AgentSession;
      const factory: ExtensionFactory = (pi) => {
        const delivery = new SubagentResultDelivery(pi);
        pi.registerTool({
          name: "probe", label: "probe", description: "delivery probe", parameters: Type.Object({}),
          async execute(_id, _params, signal, _update, ctx) {
            const answer = record(current, scenario.status);
            delivery.offer(answer, { isCurrent: () => true, isIdle: () => ctx.isIdle() });
            if (scenario.consumed) delivery.consume(answer, signal);
            return { content: [{ type: "text", text: scenario.consumed ? "child evidence" : "independent work" }], details: {} };
          },
        });
      };
      await withSession(factory, async (session) => {
        current = session;
        const requests = installModel(session, true);
        const events: string[] = [];
        session.subscribe((event) => events.push(event.type));
        await session.prompt("inspect", { expandPromptTemplates: false });
        expect(session.agent.state.errorMessage).toBeUndefined();
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1])).toContain("child evidence");
        expect(events.filter((name) => name === "agent_start")).toHaveLength(1);
        expect(events.filter((name) => name === "agent_settled")).toHaveLength(1);
        const results = session.agent.state.messages.filter((message: any) => message.customType === "subagent-result");
        expect(results).toHaveLength(scenario.consumed ? 0 : 1);
      });
    });
  }

  test("a completion after agent_end wakes exactly one settled follow-up", async () => {
    let offered = false;
    let delivery!: SubagentResultDelivery;
    const factory: ExtensionFactory = (pi) => {
      delivery = new SubagentResultDelivery(pi);
    };
    await withSession(factory, async (session) => {
      const requests = installModel(session, false);
      const internal = session as unknown as { _handlePostAgentRun: () => Promise<boolean> };
      const checkNativeQueue = internal._handlePostAgentRun.bind(session);
      internal._handlePostAgentRun = async () => {
        const continueRun = await checkNativeQueue();
        if (!continueRun && !offered) {
          offered = true;
          expect(session.isIdle).toBe(false);
          delivery.offer(record(session), { isCurrent: () => true, isIdle: () => session.isIdle });
        }
        return continueRun;
      };
      let starts = 0;
      let settlements = 0;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      session.subscribe((event) => {
        if (event.type === "agent_start") starts++;
        if (event.type === "agent_settled" && ++settlements === 2) resolveDone();
      });
      await session.prompt("inspect", { expandPromptTemplates: false });
      await done;
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("child evidence");
      expect(starts).toBe(2);
      expect(settlements).toBe(2);
    });
  });
});
