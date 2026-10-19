import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import piRedact from "../src/index.ts";
import { GITHUB_PAT } from "./fixtures.ts";

for (const redactFirst of [true, false]) test(`Pi native compaction blocks stored secrets and preserves clean custom summaries (redact first: ${redactFirst})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-redact-summary-"));
  let session: AgentSession | undefined;
  try {
    const model = {
      id: "offline-summary", name: "offline summary", api: "openai-completions" as const, provider: "openai",
      baseUrl: "http://localhost.invalid", reasoning: false, input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 }, retry: { enabled: false },
    });
    let useCustomSummary = false;
    const customCompactor: typeof piRedact = (pi) => {
      pi.on("session_before_compact", (event) => {
        if (!useCustomSummary) return;
        return { compaction: { summary: "custom safe summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      });
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      extensionFactories: redactFirst ? [piRedact, customCompactor] : [customCompactor, piRedact],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(model.provider, "offline-test");
    const history = SessionManager.inMemory(dir);
    history.appendMessage({ role: "user", content: GITHUB_PAT, timestamp: 1 });
    history.appendMessage({ role: "user", content: "newer context ".repeat(30), timestamp: 2 });
    history.appendMessage({ role: "user", content: "latest request", timestamp: 3 });
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, settingsManager, resourceLoader, modelRuntime,
      sessionManager: history, model, noTools: "all",
    }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    let requests = 0;
    session.agent.streamFunction = async () => {
      requests += 1;
      return { result: async () => ({
        role: "assistant", content: [{ type: "text", text: "offline summary" }], stopReason: "stop",
        api: model.api, provider: model.provider, model: model.id, timestamp: 4,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }) } as any;
    };
    let blocked = false;
    try { await session.compact(); } catch { blocked = true; }
    expect(blocked).toBe(true);
    expect(requests).toBe(0);
    expect(errors).toEqual([]);
    // Prove this fixture really reaches generation when an explicit pause permits it.
    await session.prompt("/redact off");
    await session.compact();
    expect(requests).toBeGreaterThan(0);
    await session.prompt("/redact on");
    history.appendMessage({ role: "user", content: "clean follow-up ".repeat(30), timestamp: 5 });
    history.appendMessage({ role: "user", content: "latest clean request", timestamp: 6 });
    useCustomSummary = true;
    const beforeCustom = requests;
    expect((await session.compact()).summary).toBe("custom safe summary");
    expect(requests).toBe(beforeCustom);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
