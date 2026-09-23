import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SCRIPT_BYTES,
  normalizeSavedName,
  promoteWorkflow,
  resolveWorkflowSource,
  savedWorkflowRoots,
} from "../src/pi/script-source.ts";
import { createWorkflowRunPaths } from "../src/runs/journal.ts";

/**
 * The resolution rules are the plugin's outer boundary and were only exercised
 * indirectly, through the loader test. Each one below is a stated guarantee, so
 * each gets a test rather than a reader's confidence.
 */

async function withTemp(): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-src-"));
  const home = await mkdtemp(join(tmpdir(), "pi-wf-home-"));
  return { root, home, cleanup: () => rm(root, { recursive: true, force: true }).then(() => rm(home, { recursive: true, force: true })) };
}

/** A run directory holding only a script, which is what promotion reads. */
async function withRun(root: string, runId: string, script: string): Promise<void> {
  const paths = createWorkflowRunPaths(root, runId);
  await mkdir(paths.runDir, { recursive: true });
  await writeFile(paths.scriptPath, script);
}

describe("workflow source resolution", () => {
  test("requires exactly one of script, scriptPath, or name", async () => {
    const { root, cleanup } = await withTemp();
    try {
      await expect(resolveWorkflowSource(root, {})).rejects.toThrow(/exactly one/);
      await expect(resolveWorkflowSource(root, { script: "return 1;", name: "x" })).rejects.toThrow(/exactly one/);
      expect((await resolveWorkflowSource(root, { script: "return 1;" })).name).toBe("inline");
    } finally {
      await cleanup();
    }
  });

  test("refuses a scriptPath outside the working directory", async () => {
    const { root, cleanup } = await withTemp();
    try {
      await expect(resolveWorkflowSource(root, { scriptPath: "../escape.js" })).rejects.toThrow(/inside the working directory/);
    } finally {
      await cleanup();
    }
  });

  test("refuses a script larger than the cap, because it is embedded and journaled", async () => {
    const { root, cleanup } = await withTemp();
    try {
      const oversized = `return 1; // ${"x".repeat(MAX_SCRIPT_BYTES)}`;
      await expect(resolveWorkflowSource(root, { script: oversized })).rejects.toThrow(/the limit is/);
    } finally {
      await cleanup();
    }
  });

  test("a saved name is an allow-listed filename, not a path", () => {
    expect(normalizeSavedName("  panel-review.js  ")).toBe("panel-review");
    // The rule that keeps a saved name inside its directory: no separators, no
    // leading dot, so `../` and an absolute path cannot be spelled.
    for (const bad of ["../escape", "a/b", ".hidden", "", "  "]) {
      expect(() => normalizeSavedName(bad)).toThrow(/Invalid workflow name/);
    }
  });
});

describe("promoting a run to a saved workflow", () => {
  test("the saved copy is the run's own script, and resolves by name afterwards", async () => {
    // The round trip is what makes `name` usable: without it a saved workflow
    // could only be created in an editor outside pi.
    const { root, cleanup } = await withTemp();
    try {
      const script = "// a panel\nreturn await agent('x', {});";
      await withRun(root, "wf_1", script);

      const promoted = await promoteWorkflow({ cwd: root, name: "panel", homeRoot: "/nonexistent" });
      expect(promoted.scope).toBe("project");
      expect(promoted.path).toBe(join(savedWorkflowRoots(root).project, "panel.js"));
      expect(await readFile(promoted.path, "utf8")).toBe(script);

      const resolved = await resolveWorkflowSource(root, { name: "panel" });
      expect(resolved.name).toBe("panel");
      expect(resolved.script).toBe(script);
    } finally {
      await cleanup();
    }
  });

  test("refuses to overwrite a saved workflow that already exists", async () => {
    // A saved workflow may have been edited on purpose after the run it came
    // from; replacing it silently would destroy that with no way back.
    const { root, cleanup } = await withTemp();
    try {
      await withRun(root, "wf_1", "return 1;");
      await promoteWorkflow({ cwd: root, name: "panel", homeRoot: "/nonexistent" });
      await expect(promoteWorkflow({ cwd: root, name: "panel", homeRoot: "/nonexistent" })).rejects.toThrow(
        /already exists/,
      );
    } finally {
      await cleanup();
    }
  });

  test("says so when there is no run to promote", async () => {
    const { root, cleanup } = await withTemp();
    try {
      await expect(promoteWorkflow({ cwd: root, name: "panel", homeRoot: "/nonexistent" })).rejects.toThrow(
        /No workflow run to save/,
      );
    } finally {
      await cleanup();
    }
  });

  test("the user scope writes under the given home, not the real one", async () => {
    const { root, home, cleanup } = await withTemp();
    try {
      await withRun(root, "wf_1", "return 1;");
      const promoted = await promoteWorkflow({ cwd: root, name: "panel", scope: "user", homeRoot: home });
      expect(promoted.scope).toBe("user");
      expect(promoted.path).toBe(join(savedWorkflowRoots(root, home).user, "panel.js"));
    } finally {
      await cleanup();
    }
  });

  test("promotes a named run rather than the newest one", async () => {
    const { root, cleanup } = await withTemp();
    try {
      await withRun(root, "wf_old", "return 'old';");
      await withRun(root, "wf_new", "return 'new';");
      const promoted = await promoteWorkflow({ cwd: root, name: "old", runId: "wf_old", homeRoot: "/nonexistent" });
      expect(await readFile(promoted.path, "utf8")).toBe("return 'old';");
    } finally {
      await cleanup();
    }
  });
});
