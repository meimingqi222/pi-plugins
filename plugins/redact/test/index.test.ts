import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import piRedact from "../src/index.ts";
import * as FX from "./fixtures.ts";

const GHP = FX.GITHUB_PAT;

type Handler = (event: any, ctx: any) => unknown;
type HandlerMap = Map<string, Handler[]>;

interface MockPi {
  handlers: HandlerMap;
  commands: Map<string, any>;
  entries: Array<{ customType: string; data: unknown }>;
  on: (event: string, handler: Handler) => void;
  registerCommand: (name: string, options: any) => void;
  appendEntry: (customType: string, data: unknown) => void;
  events: MockEvents;
}

/** A `pi.events` stand-in that records emissions and lets tests subscribe. */
interface MockEvents {
  emitted: Array<{ channel: string; data: unknown }>;
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
}

function createMockEvents(): MockEvents {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    emit(channel, data) {
      emitted.push({ channel, data });
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

function createMockPi(): MockPi {
  const handlers: HandlerMap = new Map();
  const commands = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];

  return {
    handlers,
    commands,
    entries,
    events: createMockEvents(),
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
}

function createMockCtx(): { notifications: string[]; ctx: any } {
  const notifications: string[] = [];
  return {
    notifications,
    ctx: {
      ui: {
        notify: (message: string) => notifications.push(message),
      },
      sessionManager: {
        getBranch: () => [],
      },
    },
  };
}

/** Invoke a registered handler and return the first non-undefined result. */
async function emit(pi: MockPi, event: string, payload: any, ctx: any): Promise<any> {
  for (const handler of pi.handlers.get(event) ?? []) {
    const result = await handler({ type: event, ...payload }, ctx);
    if (result !== undefined) return result;
  }
  return undefined;
}

const ENV_KEYS = [
  "PI_REDACT",
  "PI_REDACT_CONFIG",
  "PI_REDACT_PATTERNS",
  "PI_REDACT_PATHS",
  "PI_REDACT_TOOL_RESULTS",
  "PI_REDACT_TOOL_INPUTS",
  "PI_REDACT_USER_INPUT",
  "PI_REDACT_CACHE_MB",
  "PI_REDACT_NOTIFY",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PI_REDACT_NOTIFY = "false";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("pi-redact extension", () => {
  test("registers the universal gate and the /redact command", () => {
    const pi = createMockPi();
    piRedact(pi as any);

    expect(pi.handlers.has("before_provider_request")).toBe(true);
    expect(pi.handlers.has("context")).toBe(true);
    expect(pi.handlers.has("tool_result")).toBe(true);
    expect(pi.commands.has("redact")).toBe(true);
  });

  test("redacts the final provider payload", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    const payload = {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: `token ${GHP}` }],
    };
    const result = await emit(pi, "before_provider_request", { payload }, ctx);

    expect(JSON.stringify(result)).not.toContain(GHP);
    expect(result.models ?? result.model).toBe("deepseek-v4.1-flash");
    expect(result.messages).toHaveLength(1);
  });

  test("returns undefined for a clean payload (no-op for other extensions)", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    const result = await emit(
      pi,
      "before_provider_request",
      { payload: { messages: [{ role: "user", content: "hello world" }] } },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  test("redacts the agent context messages", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    const messages = [
      { role: "user", content: [{ type: "text", text: `use ${GHP}` }] },
    ];
    const result = await emit(pi, "context", { messages }, ctx);
    expect(result.messages[0].content[0].text).not.toContain(GHP);
  });

  test("redacts tool result content and keeps details when untouched", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    const details = { exitCode: 0 };
    const result = await emit(
      pi,
      "tool_result",
      { content: [{ type: "text", text: `leaked ${GHP}` }], details },
      ctx,
    );

    expect(result.content[0].text).not.toContain(GHP);
    // details unchanged → not included in the patch
    expect("details" in result).toBe(false);
  });

  test("skips everything when PI_REDACT=false", async () => {
    process.env.PI_REDACT = "false";
    const pi = createMockPi();
    piRedact(pi as any);

    expect(pi.handlers.size).toBe(0);
    expect(pi.commands.size).toBe(0);
  });

  test("does not register tool_input or user_input handlers by default", () => {
    const pi = createMockPi();
    piRedact(pi as any);

    expect(pi.handlers.has("tool_call")).toBe(false);
    expect(pi.handlers.has("input")).toBe(false);
  });

  test("/redact off pauses redaction and persists state", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx, notifications } = createMockCtx();

    await pi.commands.get("redact").handler("off", ctx);
    expect(pi.entries.at(-1)).toEqual({ customType: "redact-state", data: { enabled: false } });

    const result = await emit(
      pi,
      "before_provider_request",
      { payload: { text: GHP } },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(notifications.some((n) => n.includes("paused"))).toBe(true);
  });

  test("/redact test redacts a sample string", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx, notifications } = createMockCtx();

    await pi.commands.get("redact").handler(`test ${GHP}`, ctx);
    const output = notifications.join("\n");
    expect(output).not.toContain(GHP);
    expect(output).toContain("[REDACTED:github-pat]");
  });

  test("/redact patterns lists id, category and title", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx, notifications } = createMockCtx();

    await pi.commands.get("redact").handler("patterns", ctx);
    const output = notifications.join("\n");
    expect(output).toContain("github-pat");
    expect(output).toContain("[github]");
  });

  test("restores paused state from session state on resume", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();
    ctx.sessionManager.getBranch = () => [
      { type: "custom", customType: "redact-state", data: { enabled: false } },
    ];

    await emit(pi, "session_start", { reason: "resume" }, ctx);

    const result = await emit(pi, "before_provider_request", { payload: { text: GHP } }, ctx);
    expect(result).toBeUndefined();
  });

  test("PI_REDACT_PATTERNS disables a specific rule", async () => {
    process.env.PI_REDACT_PATTERNS = "github-pat,github-oauth,github-app-token,github-refresh-token,github-fine-grained-pat,sk-secret";
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    const result = await emit(pi, "before_provider_request", { payload: { text: GHP } }, ctx);
    expect(result).toBeUndefined();
  });

  test("degrades gracefully if the redactor throws", async () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    // A payload with a throwing toJSON-ish getter must not break the request.
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "boom", {
      enumerable: true,
      get() {
        throw new Error("kaboom");
      },
    });

    const result = await emit(pi, "before_provider_request", { payload }, ctx);
    expect(result).toBeUndefined();
  });

  test("PI_REDACT_CACHE_MB is reported in /redact status", async () => {
    process.env.PI_REDACT_CACHE_MB = "8";
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx, notifications } = createMockCtx();

    await pi.commands.get("redact").handler("status", ctx);
    expect(notifications.join("\n")).toContain("8 MB budget");
  });

  test("an invalid PI_REDACT_CACHE_MB falls back to the default", async () => {
    process.env.PI_REDACT_CACHE_MB = "not-a-number";
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx, notifications } = createMockCtx();

    await pi.commands.get("redact").handler("status", ctx);
    expect(notifications.join("\n")).toContain("32 MB default");
  });

  test("a tiny cache budget still redacts correctly", async () => {
    process.env.PI_REDACT_CACHE_MB = "1";
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();

    const result = await emit(
      pi,
      "before_provider_request",
      { payload: { text: `x`.repeat(3_000_000) + GHP } },
      ctx,
    );
    expect(JSON.stringify(result)).not.toContain(GHP);
  });
});

describe("redaction service", () => {
  const SERVICE_CHANNEL = "pi-redact:service";
  const DISCOVERY_CHANNEL = "pi-redact:service-request";

  test("announces a usable service on the shared bus", () => {
    // Other extensions (pi-jev-compact) redact their own outbound payloads
    // through this, so it must be announced without anyone asking first.
    const pi = createMockPi();
    piRedact(pi as any);

    const announcement = pi.events.emitted.find((e) => e.channel === SERVICE_CHANNEL);
    expect(announcement).toBeDefined();
    const service = announcement!.data as Record<string, unknown>;
    expect(service.version).toBe(2);
    expect(typeof service.redactJson).toBe("function");
    expect(typeof service.redactString).toBe("function");
    expect(typeof service.isEnabled).toBe("function");
    expect((service.isEnabled as () => boolean)()).toBe(true);
  });

  test("the announced service redacts deep values", () => {
    const pi = createMockPi();
    piRedact(pi as any);
    const service = pi.events.emitted.find((e) => e.channel === SERVICE_CHANNEL)!.data as any;

    const out = service.redactJson({ messages: [{ text: `token ${GHP}` }] });
    expect(JSON.stringify(out)).not.toContain(GHP);
    expect(JSON.stringify(out)).toContain("[REDACTED:github-pat]");
  });

  test("re-announces when a consumer loads late and asks", () => {
    // Load order is not controllable, so a consumer that missed the initial
    // announcement asks for it. Without this the bridge would silently never
    // activate when pi-redact happened to load first.
    const pi = createMockPi();
    piRedact(pi as any);
    const before = pi.events.emitted.filter((e) => e.channel === SERVICE_CHANNEL).length;

    pi.events.emit(DISCOVERY_CHANNEL, undefined);

    const after = pi.events.emitted.filter((e) => e.channel === SERVICE_CHANNEL).length;
    expect(after).toBe(before + 1);
  });

  test("the announced service propagates engine errors instead of failing open", () => {
    // Deliberate asymmetry with the extension's own hooks: those use `safe()`,
    // which fails open by returning the raw value, because blocking pi's
    // provider request would break the session. A consumer's contract is
    // fail-closed, so the service must let the error through — otherwise
    // pi-jev-compact would upload the raw payload believing it was redacted.
    const pi = createMockPi();
    piRedact(pi as any);
    const service = pi.events.emitted.find((e) => e.channel === SERVICE_CHANNEL)!.data as any;

    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "boom", {
      enumerable: true,
      get() {
        throw new Error("engine exploded");
      },
    });

    expect(() => service.redactJson({ nested: payload })).toThrow();
  });

  test("paused state is honoured by the service", () => {
    // The service is a live view, not a snapshot: a user who pauses redaction
    // must not have pi-jev-compact silently continue redacting (or vice versa).
    const pi = createMockPi();
    piRedact(pi as any);
    const { ctx } = createMockCtx();
    const service = pi.events.emitted.find((e) => e.channel === SERVICE_CHANNEL)!.data as any;

    expect(JSON.stringify(service.redactJson({ text: GHP }))).not.toContain(GHP);
    expect(service.isEnabled()).toBe(true);

    // Drive the same state machine `/redact off` uses.
    return pi.commands
      .get("redact")
      .handler("off", ctx)
      .then(() => {
        const out = service.redactJson({ text: GHP });
        expect(JSON.stringify(out)).toContain(GHP);
        expect(service.isEnabled()).toBe(false);
      });
  });

  test("PI_REDACT=false announces nothing", () => {
    process.env.PI_REDACT = "false";
    const pi = createMockPi();
    piRedact(pi as any);
    expect(pi.events.emitted).toHaveLength(0);
  });
});
