import { describe, expect, test } from "bun:test";
import { createReviewer } from "../src/reviewer.ts";
import type { ReviewerConfig } from "../src/types.ts";

const CFG: ReviewerConfig = { model: "test/small", timeoutMs: 50, maxPerSession: 3 };

interface FakeRegistry {
  calls: unknown[];
  reply: unknown;
  auth: boolean;
  model: boolean;
  hang?: boolean;
}

function fakeCtx(registry: Partial<FakeRegistry> = {}, userText = "fix the tests") {
  const calls: unknown[] = [];
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => (registry.model === false ? undefined : { provider, id }),
      hasConfiguredAuth: () => registry.auth !== false,
      complete: async (_model: unknown, context: unknown) => {
        calls.push(context);
        if (registry.hang) return new Promise(() => {});
        return registry.reply ?? { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"allow","reason":"routine"}' }] };
      },
    },
    sessionManager: {
      getBranch: () => [
        { type: "message", id: "1", parentId: null, timestamp: "", message: { role: "user", content: [{ type: "text", text: userText }] } },
      ],
    },
  };
  return { ctx: ctx as never, calls };
}

function review(ctx: never, tool = "bash", input = "npm test") {
  return createReviewer(CFG, { platform: "darwin", cwd: "/work/app" }, () => {}).review({
    ctx,
    toolName: tool,
    toolInput: input,
    staticAnalysis: "unknown command",
  });
}

describe("reviewer", () => {
  test("allow verdict releases the call", async () => {
    const { ctx, calls } = fakeCtx();
    const verdict = await review(ctx);
    expect(verdict?.verdict).toBe("allow");
    expect(calls.length).toBe(1);
  });

  test("ask and deny verdicts come back as-is", async () => {
    const ask = fakeCtx({ reply: { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"ask","reason":"outside workspace"}' }] } });
    expect((await review(ask.ctx))?.verdict).toBe("ask");
    const deny = fakeCtx({ reply: { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"deny","reason":"unrelated"}' }] } });
    expect((await review(deny.ctx))?.verdict).toBe("deny");
  });

  test("a hanging model times out and falls back", async () => {
    const { ctx } = fakeCtx({ hang: true });
    expect(await review(ctx)).toBeUndefined();
  });

  test("a non-JSON reply falls back", async () => {
    const { ctx } = fakeCtx({ reply: { stopReason: "stop", content: [{ type: "text", text: "sure, looks fine" }] } });
    expect(await review(ctx)).toBeUndefined();
  });

  test("no configured auth → no model call, falls back", async () => {
    const { ctx, calls } = fakeCtx({ auth: false });
    expect(await review(ctx)).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("unknown model → no model call, one warning", async () => {
    const { ctx, calls } = fakeCtx({ model: false });
    let warnings = 0;
    const r = createReviewer(CFG, { platform: "darwin", cwd: "/work" }, () => warnings++);
    expect(await r.review({ ctx, toolName: "bash", toolInput: "a", staticAnalysis: "x" })).toBeUndefined();
    expect(await r.review({ ctx, toolName: "bash", toolInput: "b", staticAnalysis: "x" })).toBeUndefined();
    expect(calls.length).toBe(0);
    expect(warnings).toBe(1);
  });

  test("identical calls hit the cache", async () => {
    const { ctx, calls } = fakeCtx();
    const r = createReviewer(CFG, { platform: "darwin", cwd: "/work" }, () => {});
    await r.review({ ctx, toolName: "bash", toolInput: "npm test", staticAnalysis: "x" });
    const second = await r.review({ ctx, toolName: "bash", toolInput: "npm test", staticAnalysis: "x" });
    expect(second?.verdict).toBe("allow");
    expect(calls.length).toBe(1);
  });

  test("maxPerSession caps real calls and warns once", async () => {
    const { ctx, calls } = fakeCtx();
    let warnings = 0;
    const r = createReviewer({ ...CFG, maxPerSession: 2 }, { platform: "darwin", cwd: "/work" }, () => warnings++);
    await r.review({ ctx, toolName: "bash", toolInput: "a", staticAnalysis: "x" });
    await r.review({ ctx, toolName: "bash", toolInput: "b", staticAnalysis: "x" });
    expect(await r.review({ ctx, toolName: "bash", toolInput: "c", staticAnalysis: "x" })).toBeUndefined();
    expect(await r.review({ ctx, toolName: "bash", toolInput: "d", staticAnalysis: "x" })).toBeUndefined();
    expect(calls.length).toBe(2);
    expect(warnings).toBe(1);
  });

  test("the payload carries cwd, platform, the user request and the call", async () => {
    const { ctx, calls } = fakeCtx({}, "please update deps");
    await review(ctx);
    const context = calls[0] as { messages: { content: { text: string }[] }[]; systemPrompt: string; tools: unknown[] };
    expect(context.tools).toEqual([]);
    const payload = JSON.parse(context.messages[0]!.content[0]!.text);
    expect(payload).toMatchObject({ cwd: "/work/app", platform: "darwin", toolName: "bash", toolInput: "npm test", userRequest: "please update deps" });
    expect(context.systemPrompt).toContain("Reply with exactly one JSON object");
  });
});
