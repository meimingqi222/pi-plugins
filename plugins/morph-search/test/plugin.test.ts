import { expect, spyOn, test } from "bun:test";
import { CompactClient } from "@morphllm/morphsdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import morphSearch, { resolveGitHubRepo } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";

/**
 * Announce a live redaction service on the shared bus, the way pi-redact does.
 * `enabled: false` models a paused redactor, which is an explicit user choice
 * and must still allow the upload.
 */
function announceRedactor(listeners: Map<string, Array<(value: unknown) => void>>, enabled = true): void {
  for (const listener of listeners.get("pi-redact:service") ?? []) {
    listener({
      version: 2,
      patternCount: 1,
      isEnabled: () => enabled,
      redactJson: (value: unknown) => value,
      redactString: (value: unknown) => value,
    });
  }
}

function registration(config: object) {
  const directory = mkdtempSync(join(tmpdir(), "morph-search-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const old = process.env.PI_MORPH_SEARCH_CONFIG;
  process.env.PI_MORPH_SEARCH_CONFIG = path;
  const tools: string[] = [];
  const events: string[] = [];
  try {
    morphSearch({
      registerTool(tool: { name: string }) { tools.push(tool.name); },
      on(event: string) { events.push(event); },
    } as never);
    return { tools, events };
  } finally {
    if (old === undefined) delete process.env.PI_MORPH_SEARCH_CONFIG;
    else process.env.PI_MORPH_SEARCH_CONFIG = old;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("only two search tools are registered; compaction and prompt routing are absent by default", () => {
  expect(registration({ apiKey: "example" })).toEqual({
    tools: ["warpgrep_codebase_search", "warpgrep_github_search"],
    events: [],
  });
});

test("compaction without a redactor does not upload the {{SECRET_l6neygg}}", async () => {
  // The upload is the same shape pi-permissions fails closed on: with no
  // redactor installed the whole transcript, secrets included, would leave
  // the machine. Compaction is opt-in, so falling back to pi's own summariser
  // costs nothing but a worse summary.
  const directory = mkdtempSync(join(tmpdir(), "morph-noredact-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({ apiKey: "example", compact: { enabled: true } }));
  const old = process.env.PI_MORPH_SEARCH_CONFIG;
  process.env.PI_MORPH_SEARCH_CONFIG = path;
  const requests: string[] = [];
  const compact = spyOn(CompactClient.prototype, "compact").mockImplementation(async (input) => {
    requests.push(JSON.stringify(input.messages));
    return { output: "unused" } as any;
  });
  const notices: string[] = [];
  try {
    let handler: any;
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    morphSearch({
      registerTool() {},
      on(_event: string, hook: any) { handler = hook; },
      events: {
        on(channel: string, listener: (value: unknown) => void) {
          listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        },
        emit(channel: string, value: unknown) {
          for (const listener of listeners.get(channel) ?? []) listener(value);
        },
      },
    } as never);
    // No announcement: this is the machine that runs pi-morph-search alone.
    const result = await handler({
      signal: new AbortController().signal,
      preparation: { messagesToSummarize: [{ role: "user", content: "secret bearing turn", timestamp: 1 }], turnPrefixMessages: [], firstKeptEntryId: "kept", tokensBefore: 100 },
    }, { ui: { notify: (message: string) => notices.push(message) } });
    expect(requests).toEqual([]);
    expect(result).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("pi-redact is not installed");
  } finally {
    compact.mockRestore();
    if (old === undefined) delete process.env.PI_MORPH_SEARCH_CONFIG;
    else process.env.PI_MORPH_SEARCH_CONFIG = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a paused redactor still allows the upload the user asked for", async () => {
  // A service that reports itself disabled is an explicit choice; only the
  // absence of a service is an unexamined gap.
  const directory = mkdtempSync(join(tmpdir(), "morph-paused-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({ apiKey: "example", compact: { enabled: true } }));
  const old = process.env.PI_MORPH_SEARCH_CONFIG;
  process.env.PI_MORPH_SEARCH_CONFIG = path;
  const requests: string[] = [];
  const compact = spyOn(CompactClient.prototype, "compact").mockImplementation(async (input) => {
    requests.push(JSON.stringify(input.messages));
    return { output: "summary" } as any;
  });
  try {
    let handler: any;
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    morphSearch({
      registerTool() {},
      on(_event: string, hook: any) { handler = hook; },
      events: {
        on(channel: string, listener: (value: unknown) => void) {
          listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        },
        emit(channel: string, value: unknown) {
          for (const listener of listeners.get(channel) ?? []) listener(value);
        },
      },
    } as never);
    announceRedactor(listeners, false);
    const result = await handler({
      signal: new AbortController().signal,
      preparation: { messagesToSummarize: [{ role: "user", content: "turn", timestamp: 1 }], turnPrefixMessages: [], firstKeptEntryId: "kept", tokensBefore: 100 },
    }, { ui: { notify: () => {} } });
    expect(requests).toHaveLength(1);
    expect(result.compaction.summary).toBe("summary");
  } finally {
    compact.mockRestore();
    if (old === undefined) delete process.env.PI_MORPH_SEARCH_CONFIG;
    else process.env.PI_MORPH_SEARCH_CONFIG = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compaction is opt in through the config file", () => {
  expect(registration({ apiKey: "example", compact: { enabled: true } }).events).toEqual(["session_before_compact"]);
});

test("successive compactions preserve the previous summary in the next request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morph-history-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({ apiKey: "example", compact: { enabled: true } }));
  const old = process.env.PI_MORPH_SEARCH_CONFIG;
  process.env.PI_MORPH_SEARCH_CONFIG = path;
  const requests: string[] = [];
  const compact = spyOn(CompactClient.prototype, "compact").mockImplementation(async (input) => {
    requests.push(JSON.stringify(input.messages));
    return { output: (input.messages ?? []).map((message) => message.content).join("\n") } as any;
  });
  try {
    let handler: any;
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    morphSearch({
      registerTool() {},
      on(_event: string, hook: any) { handler = hook; },
      events: {
        on(channel: string, listener: (value: unknown) => void) {
          listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        },
        emit(channel: string, value: unknown) {
          for (const listener of listeners.get(channel) ?? []) listener(value);
        },
      },
    } as never);
    // Compaction is fail-closed without a redactor, so the test installs one —
    // the same shape pi-redact announces on the bus.
    announceRedactor(listeners);
    let previousSummary = "Original acceptance constraint";
    for (const text of ["second round", "third round"]) {
      const result = await handler({ signal: new AbortController().signal, preparation: {
        previousSummary, messagesToSummarize: [{ role: "user", content: text, timestamp: 1 }],
        turnPrefixMessages: [], firstKeptEntryId: "kept", tokensBefore: 100,
      } });
      expect(requests.at(-1)).toContain("Original acceptance constraint");
      expect(result.compaction.summary).toContain("Original acceptance constraint");
      expect(result.compaction.firstKeptEntryId).toBe("kept");
      previousSummary = result.compaction.summary;
    }
  } finally {
    compact.mockRestore();
    if (old === undefined) delete process.env.PI_MORPH_SEARCH_CONFIG;
    else process.env.PI_MORPH_SEARCH_CONFIG = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file credential takes precedence over environment, and compact settings are validated", () => {
  const directory = mkdtempSync(join(tmpdir(), "morph-config-"));
  const path = join(directory, "config.json");
  const old = process.env.MORPH_API_KEY;
  process.env.MORPH_API_KEY = "environment";
  try {
    writeFileSync(path, JSON.stringify({ apiKey: "from-file", compact: { enabled: false } }));
    expect(loadConfig(path).apiKey).toBe("from-file");
    writeFileSync(path, JSON.stringify({ compact: { ratio: 2 } }));
    expect(() => loadConfig(path)).toThrow("compact.ratio");
  } finally {
    if (old === undefined) delete process.env.MORPH_API_KEY;
    else process.env.MORPH_API_KEY = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub search accepts only one safe public repository locator", () => {
  expect(resolveGitHubRepo("owner/repo")).toBe("owner/repo");
  expect(resolveGitHubRepo(undefined, "https://github.com/owner/repo.git")).toBe("owner/repo");
  expect(() => resolveGitHubRepo("owner/repo", "https://github.com/owner/repo")).toThrow();
  expect(() => resolveGitHubRepo(undefined, "https://evil.example/owner/repo")).toThrow();
});

test("pi loader accepts the extension and exposes only the two search tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morph-loader-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ apiKey: "example", compact: { enabled: false } }));
  const old = process.env.PI_MORPH_SEARCH_CONFIG;
  process.env.PI_MORPH_SEARCH_CONFIG = configPath;
  try {
    const entryPoint = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entryPoint],
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    expect(extensions.errors).toEqual([]);
    const plugin = extensions.extensions.find((extension) => extension.path === entryPoint);
    expect([...plugin!.tools.keys()].sort()).toEqual(["warpgrep_codebase_search", "warpgrep_github_search"]);
    expect(plugin!.handlers.has("before_agent_start")).toBe(false);
  } finally {
    if (old === undefined) delete process.env.PI_MORPH_SEARCH_CONFIG;
    else process.env.PI_MORPH_SEARCH_CONFIG = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid config keeps search tools registered for a diagnosable execution error", () => {
  expect(registration({ searchTimeoutMs: 1 }).tools).toEqual(['warpgrep_codebase_search', 'warpgrep_github_search']);
});
