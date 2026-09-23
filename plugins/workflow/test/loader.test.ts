import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

test("pi loads the entry point under Node, where the typebox aliases decide which subpaths resolve", () => {
  // `bun test` asks the package's `exports` map, so it resolves any typebox
  // subpath and cannot observe this. pi loads extensions under Node
  // (`#!/usr/bin/env node`) through jiti, and hands it an alias table where
  // `typebox` is an entry *file*: only `typebox/compile` and `typebox/value`
  // are aliased as subpaths, so every other `typebox/<name>` import is
  // prefix-rewritten to `<entry>/<name>` and loading fails. That is the shipped
  // path (`dist/…/loader.js` applies the aliases unless pi itself runs from
  // TypeScript source), so the extension was unusable under pi while the
  // in-process test above stayed green. `node_modules` cannot show this either —
  // the failure is in pi's loader, not in resolution.
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
  // `import.meta.resolve` is bun's own resolution, so it finds the peer
  // dependency the way the static import above does; `createRequire` under bun
  // does not.
  const loaderUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const script = [
    `const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(loaderUrl)});`,
    `const { mkdtemp, rm } = await import("node:fs/promises");`,
    `const { tmpdir } = await import("node:os");`,
    `const { join } = await import("node:path");`,
    `const isolated = await mkdtemp(join(tmpdir(), "pi-workflow-loader-node-"));`,
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
    "    tools: result.extensions.flatMap((extension) => [...extension.tools.keys()]).sort(),",
    "  }));",
    "} finally {",
    "  await rm(isolated, { recursive: true, force: true });",
    "}",
  ].join(" ");
  const stdout = execFileSync(process.env.PI_WORKFLOW_TEST_NODE ?? "node", ["--input-type=module", "-e", script], {
    encoding: "utf-8",
  });
  expect(JSON.parse(stdout)).toEqual({ errors: [], tools: ["workflow", "workflow_status"] });
});
