import { expect, spyOn, test } from "bun:test";
import { CompactClient } from "@morphllm/morphsdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import morphSearch, { resolveGitHubRepo } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";

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
    morphSearch({ registerTool() {}, on(_event: string, hook: any) { handler = hook; } } as never);
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
