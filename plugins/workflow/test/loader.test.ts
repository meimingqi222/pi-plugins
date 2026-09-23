import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("pi loads the published entry point and registers the workflow tool and command", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "pi-workflow-loader-"));
  try {
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
    const loader = new DefaultResourceLoader({
      cwd: isolated,
      agentDir: isolated,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entry],
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    const plugin = result.extensions.find((extension) => extension.path === entry);
    expect(plugin).toBeDefined();
    expect(plugin!.commands.has("workflows")).toBe(true);
    expect([...plugin!.tools.keys()].sort()).toEqual(["workflow", "workflow_status"]);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});
