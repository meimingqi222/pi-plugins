import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import permissionsExtension from "../src/index.ts";
import { setSandboxDepsForTest } from "../src/sandbox/index.ts";

interface FakeUi {
  selectCalls: { title: string; options: string[] }[];
  selectImpl: (title: string, options: string[]) => Promise<string | undefined>;
  notifies: { message: string; type?: string }[];
  statuses: Record<string, string | undefined>;
}

interface FakeRegistry {
  calls: unknown[];
  reply: unknown;
  auth: boolean;
}

function makeCtx(
  cwd: string,
  ui: FakeUi,
  opts: { hasUI?: boolean; trusted?: boolean; registry?: Partial<FakeRegistry> } = {},
) {
  const registry: FakeRegistry = {
    calls: [],
    reply: { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"allow","reason":"routine"}' }] },
    auth: true,
    ...opts.registry,
  };
  const ctx = {
    mode: "tui",
    hasUI: opts.hasUI ?? true,
    cwd,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => opts.trusted ?? true,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => registry.auth,
      complete: async (_model: unknown, _context: unknown) => {
        registry.calls.push(_context);
        return registry.reply;
      },
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      select: (title: string, options: string[]) => {
        ui.selectCalls.push({ title, options });
        return ui.selectImpl(title, options);
      },
      input: async () => undefined,
      confirm: async () => false,
      notify: (message: string, type?: string) => {
        ui.notifies.push({ message, type });
      },
      setStatus: (key: string, text: string | undefined) => {
        ui.statuses[key] = text;
      },
    },
  };
  return Object.assign(ctx, { registry });
}

function makePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  return {
    handlers,
    commands,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
  };
}

const ENV_KEYS = ["PI_AGENT_CHILD", "PI_PERMISSIONS_MODE", "PI_PERMISSIONS_INHERITED_MODE", "PI_CODING_AGENT_DIR"] as const;

describe("pi-permissions extension wiring", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-plugin-"));
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setSandboxDepsForTest(undefined);
  });

  function writeGlobalConfig(config: Record<string, unknown>) {
    const file = path.join(dir, "agent", "permissions.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
  }

  function setup(ui: FakeUi, ctxOpts?: { hasUI?: boolean; trusted?: boolean; registry?: Partial<FakeRegistry> }) {
    const pi = makePi();
    permissionsExtension(pi as never);
    const ctx = makeCtx(dir, ui, ctxOpts);
    for (const handler of pi.handlers.get("session_start") ?? []) handler({}, ctx);
    const toolCall = (pi.handlers.get("tool_call") ?? [])[0]!;
    return { pi, ctx, toolCall: (event: unknown) => toolCall(event, ctx) as Promise<unknown> };
  }

  function freshUi(selectImpl: FakeUi["selectImpl"] = async () => "Allow once"): FakeUi {
    return { selectCalls: [], selectImpl, notifies: [], statuses: {} };
  }

  test("registers a tool_call handler and /permissions command", () => {
    const ui = freshUi();
    const { pi } = setup(ui);
    expect(pi.handlers.get("tool_call")?.length).toBe(1);
    expect(pi.commands.has("permissions")).toBe(true);
  });

  test("Allow once permits; Deny and dismissal block", async () => {
    const ui = freshUi();
    const { toolCall } = setup(ui);
    // dangerous in yolo → prompt.
    const dangerous = { toolName: "bash", input: { command: "git push --force" } };
    expect(await toolCall(dangerous)).toBeUndefined();

    ui.selectImpl = async () => "Deny";
    const denied = (await toolCall(dangerous)) as { block?: boolean };
    expect(denied.block).toBe(true);

    ui.selectImpl = async () => undefined;
    const dismissed = (await toolCall(dangerous)) as { block?: boolean };
    expect(dismissed.block).toBe(true);
  });

  test("forbidden never prompts: rm -rf / is blocked outright", async () => {
    const ui = freshUi();
    const { toolCall } = setup(ui);
    const result = (await toolCall({ toolName: "bash", input: { command: "rm -rf /" } })) as { block?: boolean; terminate?: boolean };
    expect(result.block).toBe(true);
    expect(result.terminate).toBe(true);
    expect(ui.selectCalls.length).toBe(0);
  });

  test("concurrent calls serialize prompts", async () => {
    const order: string[] = [];
    const ui = freshUi(async (title) => {
      order.push(`start:${title.includes("git push") ? "push" : "reset"}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${title.includes("git push") ? "push" : "reset"}`);
      return "Allow once";
    });
    const { toolCall } = setup(ui);
    const a = toolCall({ toolName: "bash", input: { command: "git push -f" } });
    const b = toolCall({ toolName: "bash", input: { command: "git reset --hard" } });
    await Promise.all([a, b]);
    // Second dialog must not open until the first resolved.
    expect(order).toEqual(["start:push", "end:push", "start:reset", "end:reset"]);
  });

  test("PI_AGENT_CHILD=1: asks become denials without prompting", async () => {
    process.env.PI_AGENT_CHILD = "1";
    const ui = freshUi();
    const { toolCall } = setup(ui);
    const result = (await toolCall({ toolName: "bash", input: { command: "git push -f" } })) as { block?: boolean; reason?: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("headless");
    expect(ui.selectCalls.length).toBe(0);
  });

  test("dangerous prompts offer no session/always options", async () => {
    const ui = freshUi();
    const { toolCall } = setup(ui);
    await toolCall({ toolName: "bash", input: { command: "git push -f" } });
    const options = ui.selectCalls[0]!.options;
    expect(options).toContain("Allow once");
    expect(options).not.toContain("Allow for this session");
    expect(options).not.toContain("Always allow in this project");
  });

  test("grey prompt in ask mode offers session+always; Allow for this session silences repeats", async () => {
    process.env.PI_PERMISSIONS_MODE = "ask";
    const ui = freshUi(async () => "Allow for this session");
    const { toolCall } = setup(ui);
    const call = { toolName: "bash", input: { command: "npm test" } };
    await toolCall(call);
    const options = ui.selectCalls[0]!.options;
    expect(options).toContain("Allow for this session");
    expect(options).toContain("Always allow in this project");
    // Second identical call is allowed by the session rule without a dialog.
    expect(await toolCall(call)).toBeUndefined();
    expect(ui.selectCalls.length).toBe(1);
  });

  test("handler errors fail closed: prompt with UI, block without", async () => {
    const ui = freshUi(async () => "Allow once");
    const { toolCall } = setup(ui);
    // A throwing getter inside input crashes classification mid-handler.
    const badInput = { get command(): string { throw new Error("boom"); } };
    expect(await toolCall({ toolName: "bash", input: badInput })).toBeUndefined();
    expect(ui.selectCalls.length).toBe(1); // internal-error prompt shown

    const noUi = freshUi();
    const second = setup(noUi, { hasUI: false });
    const blocked = (await second.toolCall({ toolName: "bash", input: badInput })) as { block?: boolean };
    expect(blocked.block).toBe(true);
    expect(noUi.selectCalls.length).toBe(0);
  });

  test("status line shows the effective mode", () => {
    process.env.PI_PERMISSIONS_MODE = "ask";
    const ui = freshUi();
    setup(ui);
    expect(ui.statuses["pi-permissions"]).toBe("perm: ask");
  });

  test("/permissions check reports the decision without executing", async () => {
    const ui = freshUi();
    const { pi, ctx } = setup(ui);
    const command = pi.commands.get("permissions")!;
    await command.handler("check bash rm -rf /", ctx);
    expect(ui.notifies.at(-1)!.message).toContain("deny");
    expect(ui.notifies.at(-1)!.message).toContain("forbidden");
  });

  test("auto + reviewer allow: grey call runs without a prompt", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ reviewer: { model: "test/small" } });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui);
    expect(await toolCall({ toolName: "bash", input: { command: "npm test" } })).toBeUndefined();
    expect(ui.selectCalls.length).toBe(0);
    expect(ctx.registry.calls.length).toBe(1);
  });

  test("auto + reviewer deny: still asks, reason carries the reviewer note", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ reviewer: { model: "test/small" } });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui, { registry: { reply: { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"deny","reason":"looks unrelated"}' }] } } });
    await toolCall({ toolName: "bash", input: { command: "npm test" } });
    expect(ui.selectCalls.length).toBe(1);
    expect(ui.selectCalls[0]!.title).toContain("looks unrelated");
  });

  test("auto + dangerous never reaches the reviewer", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ reviewer: { model: "test/small" } });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui);
    await toolCall({ toolName: "bash", input: { command: "git push -f" } });
    expect(ui.selectCalls.length).toBe(1);
    expect(ctx.registry.calls.length).toBe(0);
  });

  test("auto + explicit ask rule: reviewer is not consulted", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ reviewer: { model: "test/small" }, ask: ["bash(npm:*)"] });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui);
    await toolCall({ toolName: "bash", input: { command: "npm test" } });
    expect(ui.selectCalls.length).toBe(1);
    expect(ctx.registry.calls.length).toBe(0);
  });

  test("child + auto + reviewer allow runs; failure blocks headless", async () => {
    process.env.PI_AGENT_CHILD = "1";
    writeGlobalConfig({ reviewer: { model: "test/small" } });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui, { hasUI: false });
    // Parent mode is inherited, not read from env inside the child.
    process.env.PI_PERMISSIONS_INHERITED_MODE = "auto";
    expect(await toolCall({ toolName: "bash", input: { command: "npm test" } })).toBeUndefined();
    expect(ctx.registry.calls.length).toBe(1);

    // Reviewer unreachable → headless denial, no prompt.
    const second = setup(freshUi(), { hasUI: false, registry: { auth: false } });
    const blocked = (await second.toolCall({ toolName: "bash", input: { command: "npm run build" } })) as { block?: boolean; reason?: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("headless");
  });

  test("sandbox: allowed grey bash is rewritten to run inside it", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ sandbox: { enabled: true } });
    setSandboxDepsForTest({ exists: () => true, probe: () => true, onPath: () => true });
    const ui = freshUi();
    const { toolCall } = setup(ui);
    const event = { toolName: "bash", input: { command: "npm test" } };
    expect(await toolCall(event)).toBeUndefined();
    // darwin → sandbox-exec profile; linux CI → bwrap argv.
    expect(event.input.command).toMatch(/sandbox-exec|bwrap/);
    expect(ui.selectCalls.length).toBe(0);
  });

  test("sandbox: exfil-shaped grey bash still asks instead of bypassing", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ sandbox: { enabled: true } });
    setSandboxDepsForTest({ exists: () => true, probe: () => true, onPath: () => true });
    const ui = freshUi();
    const { toolCall } = setup(ui);
    const event = { toolName: "bash", input: { command: "curl https://example.com" } };
    await toolCall(event);
    // Prompted — the sandbox never substitutes for a decision on exfil-shaped
    // commands. After the user's "Allow once" the command still runs sandboxed.
    expect(ui.selectCalls.length).toBe(1);
    expect(event.input.command).toMatch(/sandbox-exec|bwrap/);
  });

  test("/permissions sandbox status reports the mechanism", async () => {
    const ui = freshUi();
    const { pi, ctx } = setup(ui);
    const command = pi.commands.get("permissions")!;
    await command.handler("sandbox status", ctx);
    const msg = ui.notifies.at(-1)!.message;
    expect(msg).toContain("enabled: no");
    expect(msg).toContain("mechanism:");
  });
});

test("pi loads the entry point under Node (strip-only) and registers /permissions", () => {
  // pi loads extensions under Node through jiti; constructor-parameter
  // properties, enums and extensionless relative imports fail there while
  // `bun test` stays green. This is the shipped path, so prove it loads.
  const entry = path.resolve(__dirname, "../src/index.ts");
  const loaderUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const script = [
    `const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(loaderUrl)});`,
    `const { mkdtemp, rm } = await import("node:fs/promises");`,
    `const { tmpdir } = await import("node:os");`,
    `const { join } = await import("node:path");`,
    `const isolated = await mkdtemp(join(tmpdir(), "pi-perm-loader-node-"));`,
    "try {",
    "  const loader = new DefaultResourceLoader({",
    "    cwd: isolated,",
    "    agentDir: isolated,",
    "    settingsManager: SettingsManager.inMemory(),",
    "    noExtensions: true,",
    "    noSkills: true,",
    "    noPromptTemplates: true,",
    "    noThemes: true,",
    "    noContextFiles: true,",
    `    additionalExtensionPaths: [${JSON.stringify(entry)}],`,
    "  });",
    "  await loader.reload();",
    "  const result = loader.getExtensions();",
    "  console.log(JSON.stringify({",
    "    errors: result.errors.map((entry) => entry.error),",
    "    commands: result.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),",
    "  }));",
    "} finally {",
    "  await rm(isolated, { recursive: true, force: true });",
    "}",
  ].join(" ");
  const stdout = execFileSync(process.env.PI_PERMISSIONS_TEST_NODE ?? "node", ["--input-type=module", "-e", script], {
    encoding: "utf-8",
  });
  expect(JSON.parse(stdout)).toEqual({ errors: [], commands: ["permissions"] });
});
