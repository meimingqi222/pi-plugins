import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

const NO_AGENT_DIR = "/nonexistent-agent-dir";

function review(ctx: never, tool = "bash", input = "npm test") {
  return createReviewer(CFG, { platform: "darwin", cwd: "/work/app" }, NO_AGENT_DIR, () => {})!.review({
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
    const r = createReviewer(CFG, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => warnings++)!;
    expect(await r.review({ ctx, toolName: "bash", toolInput: "a", staticAnalysis: "x" })).toBeUndefined();
    expect(await r.review({ ctx, toolName: "bash", toolInput: "b", staticAnalysis: "x" })).toBeUndefined();
    expect(calls.length).toBe(0);
    expect(warnings).toBe(1);
  });

  test("identical calls hit the cache", async () => {
    const { ctx, calls } = fakeCtx();
    const r = createReviewer(CFG, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {})!;
    await r.review({ ctx, toolName: "bash", toolInput: "npm test", staticAnalysis: "x" });
    const second = await r.review({ ctx, toolName: "bash", toolInput: "npm test", staticAnalysis: "x" });
    expect(second?.verdict).toBe("allow");
    expect(calls.length).toBe(1);
  });

  test("maxPerSession caps real calls and warns once", async () => {
    const { ctx, calls } = fakeCtx();
    let warnings = 0;
    const r = createReviewer({ ...CFG, maxPerSession: 2 }, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => warnings++)!;
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
    // The rubric scopes the judgment to machine effects, not the user's goals.
    expect(context.systemPrompt).toContain("not whether the user's goal is legal");
    expect(context.systemPrompt).toContain("reading files — inside or outside the workspace — qualifies");
  });
});

describe("jev backend", () => {
  interface JevCall {
    url: string;
    body: { model?: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, string> }> };
    auth: string;
  }

  function fakeJevFetch(choice: string | undefined, calls: JevCall[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as JevCall["body"];
      calls.push({ url: String(url), body, auth: String((init?.headers as Record<string, string>)?.authorization) });
      const answer = choice === undefined ? {} : { verdict: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: "jev-latest", answers: answer }),
      } as Response;
    }) as typeof fetch;
  }

  const JEV_ENV = { TYPESAFE_API_KEY: "key" };

  test('model "jev" sends a choice question and maps the verdict', async () => {
    const { ctx } = fakeCtx();
    const calls: JevCall[] = [];
    const r = createReviewer(
      { model: "jev", timeoutMs: 5000, maxPerSession: 5 },
      { platform: "darwin", cwd: "/work" },
      NO_AGENT_DIR,
      () => {},
      { env: JEV_ENV, fetch: fakeJevFetch("allow", calls) },
    )!;
    const verdict = await r.review({ ctx, toolName: "bash", toolInput: "npm test", staticAnalysis: "unknown" });
    expect(verdict?.verdict).toBe("allow");
    expect(verdict?.reason).toContain("jev allow");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("systemone");
    expect(calls[0]!.auth).toBe("Bearer key");
    expect(calls[0]!.body.questions.verdict.type).toBe("choice");
    expect(Object.keys(calls[0]!.body.questions.verdict.criteria ?? {})).toEqual(["allow", "ask", "deny"]);
    expect(calls[0]!.body.state).toMatchObject({ cwd: "/work", toolName: "bash", toolInput: "npm test" });
  });

  test("the jev question scopes the judgment to machine effects", async () => {
    const { ctx } = fakeCtx();
    const calls: JevCall[] = [];
    const r = createReviewer(
      { model: "jev", timeoutMs: 5000, maxPerSession: 5 },
      { platform: "darwin", cwd: "/work" },
      NO_AGENT_DIR,
      () => {},
      { env: JEV_ENV, fetch: fakeJevFetch("ask", calls) },
    )!;
    await r.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" });
    const question = calls[0]!.body.questions.verdict;
    expect(question.instructions).toContain("not whether the user's goal is legal");
    expect(question.instructions).toContain("heredocs");
    expect(question.instructions).toContain("answer ask");
    expect(question.criteria!.allow).toContain("inside or outside the workspace");
    expect(question.criteria!.deny).toContain("damage this machine");
    expect(question.criteria!.deny).not.toContain("malicious");
  });

  test("no reviewer section autodetects jev when a key exists", async () => {
    const { ctx } = fakeCtx();
    const calls: JevCall[] = [];
    const r = createReviewer(undefined, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {}, {
      env: JEV_ENV,
      fetch: fakeJevFetch("ask", calls),
    })!;
    expect(await r.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" })).toMatchObject({ verdict: "ask" });
    expect(calls.length).toBe(1);
  });

  test("no reviewer section and no jev key → disabled", () => {
    expect(
      createReviewer(undefined, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {}, { env: {} }),
    ).toBeUndefined();
  });

  test('model "none" disables the reviewer even with a key', () => {
    expect(
      createReviewer({ model: "none", timeoutMs: 1, maxPerSession: 1 }, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {}, { env: JEV_ENV }),
    ).toBeUndefined();
  });

  test('model "jev" without a key warns once and disables', () => {
    let warnings = 0;
    expect(
      createReviewer({ model: "jev", timeoutMs: 1, maxPerSession: 1 }, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => warnings++, { env: {} }),
    ).toBeUndefined();
    expect(warnings).toBe(1);
  });

  test("auth.json[typesafe] supplies the key when the env var is absent", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-perm-jev-"));
    try {
      await fs.promises.writeFile(path.join(dir, "auth.json"), JSON.stringify({ typesafe: { type: "api_key", key: "filekey" } }));
      const { ctx } = fakeCtx();
      const calls: JevCall[] = [];
      const r = createReviewer(undefined, { platform: "darwin", cwd: "/work" }, dir, () => {}, {
        env: {},
        fetch: fakeJevFetch("allow", calls),
      })!;
      await r.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" });
      expect(calls[0]!.auth).toBe("Bearer filekey");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test("jev-compact.json supplies the key, and the env var wins over it", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-perm-jev-"));
    try {
      await fs.promises.writeFile(path.join(dir, "jev-compact.json"), JSON.stringify({ apiKey: "cfgkey" }));
      const { ctx } = fakeCtx();
      const calls: JevCall[] = [];
      const fromFile = createReviewer(undefined, { platform: "darwin", cwd: "/work" }, dir, () => {}, {
        env: {},
        fetch: fakeJevFetch("allow", calls),
      })!;
      await fromFile.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" });
      expect(calls[0]!.auth).toBe("Bearer cfgkey");
      const fromEnv = createReviewer(undefined, { platform: "darwin", cwd: "/work" }, dir, () => {}, {
        env: JEV_ENV,
        fetch: fakeJevFetch("allow", calls),
      })!;
      await fromEnv.review({ ctx, toolName: "bash", toolInput: "y", staticAnalysis: "x" });
      expect(calls[1]!.auth).toBe("Bearer key");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test("JEV_COMPACT_MODEL and JEV_COMPACT_BASE_URL reach the request", async () => {
    const { ctx } = fakeCtx();
    const calls: JevCall[] = [];
    const r = createReviewer(undefined, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {}, {
      env: { ...JEV_ENV, JEV_COMPACT_MODEL: "jev-x", JEV_COMPACT_BASE_URL: "https://example.test/one" },
      fetch: fakeJevFetch("deny", calls),
    })!;
    expect(await r.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" })).toMatchObject({ verdict: "deny" });
    expect(calls[0]!.url).toBe("https://example.test/one");
    expect(calls[0]!.body.model).toBe("jev-x");
  });

  test("a jev transport error falls back to asking", async () => {
    const { ctx } = fakeCtx();
    const failing = (async () => ({ ok: false, status: 500, text: async () => "boom" }) as Response) as unknown as typeof fetch;
    const r = createReviewer({ model: "jev", timeoutMs: 5000, maxPerSession: 5 }, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {}, { env: JEV_ENV, fetch: failing })!;
    expect(await r.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" })).toBeUndefined();
  });

  test("a jev response without a verdict answer falls back", async () => {
    const { ctx } = fakeCtx();
    const calls: JevCall[] = [];
    const r = createReviewer({ model: "jev", timeoutMs: 5000, maxPerSession: 5 }, { platform: "darwin", cwd: "/work" }, NO_AGENT_DIR, () => {}, { env: JEV_ENV, fetch: fakeJevFetch(undefined, calls) })!;
    expect(await r.review({ ctx, toolName: "bash", toolInput: "x", staticAnalysis: "x" })).toBeUndefined();
  });
});
