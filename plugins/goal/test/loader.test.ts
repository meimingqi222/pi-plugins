import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("pi loads the published entry point and registers goal commands and tools", async () => {
  const isolatedDirectory = await mkdtemp(join(tmpdir(), "pi-goal-loader-"));
  try {
    const entryPoint = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
    const loader = new DefaultResourceLoader({
      cwd: isolatedDirectory,
      agentDir: isolatedDirectory,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entryPoint],
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    const plugin = result.extensions.find((extension) => extension.path === entryPoint);
    expect(plugin).toBeDefined();
    expect(plugin!.commands.has("goal")).toBe(true);
    expect([...plugin!.tools.keys()].sort()).toEqual(["get_goal", "update_goal"]);
    expect(plugin!.handlers.has("agent_settled")).toBe(true);
  } finally {
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("the plugin registers nothing in a process told to run without goals", async () => {
  // A child spawned to do one delegated job has no user and no goal of its own,
  // and pi core has no subagent primitive to enforce that — so the spawner says
  // so in the environment and the plugin honors it. Without this the parent's
  // objective is injected into a context that cannot act on it, and the parent's
  // budget pays for the tokens it produces.
  const isolatedDirectory = await mkdtemp(join(tmpdir(), "pi-goal-disabled-"));
  const previous = process.env.PI_GOAL_DISABLE;
  process.env.PI_GOAL_DISABLE = "1";
  try {
    const entryPoint = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
    const loader = new DefaultResourceLoader({
      cwd: isolatedDirectory,
      agentDir: isolatedDirectory,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entryPoint],
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    const plugin = result.extensions.find((extension) => extension.path === entryPoint);
    expect(plugin!.commands.size).toBe(0);
    expect(plugin!.tools.size).toBe(0);
    expect(plugin!.handlers.size).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.PI_GOAL_DISABLE;
    else process.env.PI_GOAL_DISABLE = previous;
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});
