import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import permissionsExtension from "../src/index.ts";
import { optionAllowDirectory } from "../src/prompt.ts";
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

/**
 * A realpath'd directory the way `projects[<cwd>]` is keyed.
 *
 * Two details, both learned the hard way. `normalizePath` emits `/`-separated
 * paths on every platform, so a raw `C:\Users\…` names a key the plugin never
 * writes. And the plugin realpaths with `realpathSync.native`, which on Windows
 * goes through `GetFinalPathNameByHandle` and expands an 8.3 short component to
 * its long form; the non-native call resolves junctions but leaves a short
 * component alone. On a machine whose `%TEMP%` is `…/MEIMIN~1/…` the two disagree
 * by exactly that component, so a grant is written under one key and asserted
 * under another.
 */
function projectKey(directory: string): string {
  return fs.realpathSync.native(directory).replaceAll(path.sep, "/");
}

/**
 * An outside-the-workspace directory to be asked about, named the way this
 * platform spells a cache. It only has to be outside the workspace (so a
 * recursive delete of it is `dangerous` rather than scratch); the macOS path
 * would not exist on Windows, where the equivalent lives under `%LOCALAPPDATA%`.
 */
function cacheDirectory(name: string): string {
  const root =
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches")
        : path.join(os.homedir(), ".cache");
  return path.join(root, name);
}

/**
 * The OS sandbox exists on darwin (`sandbox-exec`) and linux (`bwrap`) only.
 * `detectSandbox` reports win32 as unsupported, policy only, and `wrapSandboxed`
 * then leaves the command as written — the contract its own unit case
 * (`sandbox.test.ts::unavailable or unsupported → no rewrite`) pins, which is why
 * the two integration cases below are skipped rather than reworded here.
 */
const noOsSandbox = process.platform === "win32";

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

  function setup(
    ui: FakeUi,
    ctxOpts?: { hasUI?: boolean; trusted?: boolean; registry?: Partial<FakeRegistry> },
    cwd = dir,
  ) {
    const pi = makePi();
    permissionsExtension(pi as never);
    const ctx = makeCtx(cwd, ui, ctxOpts);
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

  test("an always-allow rule persists under the realpath'd cwd and is read back", async () => {
    const real = fs.mkdtempSync(path.join(dir, "real-"));
    const link = path.join(dir, "link");
    // `junction` on Windows: a directory reparse point needs no privilege there,
    // where `symlink` is refused with EPERM unless the process is elevated or
    // Developer Mode is on. The type is ignored on POSIX.
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    process.env.PI_PERMISSIONS_MODE = "ask";

    const first = freshUi(async () => "Always allow in this project");
    const a = setup(first, { trusted: true }, link);
    await a.toolCall({ toolName: "bash", input: { command: "npm test" } });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "agent", "permissions.json"), "utf8"));
    expect(Object.keys(saved.projects)).toEqual([projectKey(real)]);

    // A fresh session at the same (linked) cwd finds the rule: no second dialog.
    const second = freshUi();
    const b = setup(second, { trusted: true }, link);
    expect(await b.toolCall({ toolName: "bash", input: { command: "npm test" } })).toBeUndefined();
    expect(second.selectCalls.length).toBe(0);
  });

  test("dangerous rm outside scratch: granting the directory persists it and silences the next call", async () => {
    const grant = cacheDirectory("pi-perm-grant");
    const target = path.join(grant, "data-old");
    const sibling = path.join(grant, "data-new");
    // Quoted, because an unquoted Windows path is a different command in a bash
    // dialect — `\U` is an escape there, so the shell really deletes `C:Users…`.
    // Quoting is also the spelling a paste into the editor produces.
    const remove = (operand: string) => ({ toolName: "bash", input: { command: `rm -rf "${operand}"` } });
    let granted: string | undefined;
    const ui = freshUi(async (_title, options) => {
      granted = options.find((option) => option.startsWith("Always allow this directory: "));
      return granted;
    });
    const { toolCall } = setup(ui);

    expect(await toolCall(remove(target))).toBeUndefined();
    // The option names the directory in the plugin's own normal form.
    expect(granted).toBe(optionAllowDirectory(grant.replaceAll(path.sep, "/")));
    expect(ui.selectCalls[0]!.title).toContain("additionalDirectories");

    const directory = granted!.slice("Always allow this directory: ".length);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "agent", "permissions.json"), "utf8"));
    expect(saved.projects[projectKey(dir)].additionalDirectories).toEqual([directory]);

    // The grant applies to the next call without a reload or a second dialog.
    expect(await toolCall(remove(sibling))).toBeUndefined();
    expect(ui.selectCalls.length).toBe(1);
  });

  test("a dangerous call with nothing coherent to grant keeps the plain prompt", async () => {
    const ui = freshUi();
    const { toolCall } = setup(ui);
    await toolCall({ toolName: "bash", input: { command: "git push -f" } });
    expect(ui.selectCalls[0]!.options.some((option) => option.startsWith("Always allow this directory: "))).toBe(false);
  });

  test("global protectedPaths exclusion silences a .env read only", async () => {
    writeGlobalConfig({ protectedPaths: { read: ["!**/.env"], write: [] } });
    const ui = freshUi();
    const { toolCall } = setup(ui);
    expect(await toolCall({ toolName: "read", input: { path: ".env" } })).toBeUndefined();
    expect(ui.selectCalls.length).toBe(0);

    // Writing the same file is still dangerous, and so is the exfiltration rule.
    await toolCall({ toolName: "write", input: { path: ".env", content: "x" } });
    expect(ui.selectCalls.length).toBe(1);
    expect(ui.selectCalls[0]!.options).toContain("Allow once");
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

  test("auto: reviewer sees the command past the 240-char display summary", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ reviewer: { model: "test/small" } });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui, { registry: { reply: { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"ask","reason":"needs a look"}' }] } } });
    const marker = "TAIL-MARKER-9f2c";
    const command = `mytool --flag ${"x".repeat(240)} && echo ${marker}`;
    await toolCall({ toolName: "bash", input: { command } });
    const context = ctx.registry.calls[0] as { messages: { content: { text: string }[] }[] };
    const payload = JSON.parse(context.messages[0]!.content[0]!.text) as { toolInput: string };
    expect(payload.toolInput).toContain(marker);
    // The human dialog keeps the bounded summary.
    expect(ui.selectCalls.length).toBe(1);
    expect(ui.selectCalls[0]!.title).toContain("…");
    expect(ui.selectCalls[0]!.title).not.toContain(marker);
  });

  test("auto: the reviewer payload keeps the command's newlines", async () => {
    process.env.PI_PERMISSIONS_MODE = "auto";
    writeGlobalConfig({ reviewer: { model: "test/small" } });
    const ui = freshUi();
    const { ctx, toolCall } = setup(ui);
    const command = "cd /tmp && python3 - <<'PY'\nprint(1)\nPY";
    expect(await toolCall({ toolName: "bash", input: { command } })).toBeUndefined();
    const context = ctx.registry.calls[0] as { messages: { content: { text: string }[] }[] };
    const payload = JSON.parse(context.messages[0]!.content[0]!.text) as { toolInput: string };
    expect(payload.toolInput).toContain("\nprint(1)\n");
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

  test.skipIf(noOsSandbox)("sandbox: allowed grey bash is rewritten to run inside it", async () => {
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

  test.skipIf(noOsSandbox)("sandbox: exfil-shaped grey bash still asks instead of bypassing", async () => {
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
  // Spawns Node and loads the real extension: ~1.5s idle, but a loaded
  // machine can push it past bun's 5s default — that is not a product bug.
}, 30_000);
