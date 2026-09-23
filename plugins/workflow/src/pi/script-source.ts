/**
 * Where a workflow script comes from.
 *
 * A script is either inline, a path, or a saved workflow by name. All three
 * paths are resolved here, with two rules that matter:
 *
 * - **Containment.** A script path must stay inside the working directory, and a
 *   saved name must stay inside its saved directory. A run writes its own copy,
 *   its journal, and its evidence alongside the script, so a path that escapes
 *   would put those outside the project.
 * - **A size cap.** The script is embedded into a worker and journaled, so an
 *   unbounded one is a memory and a disk problem before it is a logic problem.
 */

import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkflowRunPaths } from "../runs/journal.ts";
import { listWorkflowRuns } from "../runs/progress.ts";

export const MAX_SCRIPT_BYTES = 128 * 1024;

export interface WorkflowSource {
  name: string;
  script: string;
  /** Present for a path or saved script; absent for inline. */
  sourcePath?: string;
}

export interface WorkflowRequest {
  script?: string;
  scriptPath?: string;
  name?: string;
}

/** Whether `target` is `root` or inside it. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface PromotedWorkflow {
  name: string;
  path: string;
  scope: "project" | "user";
}

/**
 * Copy a run's persisted script into the saved set, so it can be run by name.
 *
 * The run's own copy is what is promoted: `script.js` is written before the
 * script executes, so it is the exact text that produced the run rather than a
 * re-reading of a path that may have moved since. Without this, `name` is a
 * read-only feature — a saved workflow could only be created in an editor
 * outside pi, which is most of the reason to have one.
 *
 * Refuses an existing name instead of overwriting it. A saved workflow may have
 * been edited on purpose after the run it came from, and silently replacing it
 * would destroy that with no way back.
 */
export async function promoteWorkflow(options: {
  cwd: string;
  name: string;
  scope?: "project" | "user";
  runId?: string;
  /** Injected so a test can point the user scope at a temp directory. */
  homeRoot?: string;
}): Promise<PromotedWorkflow> {
  const scope = options.scope ?? "project";
  const name = normalizeSavedName(options.name);

  let scriptPath: string;
  if (options.runId) {
    scriptPath = createWorkflowRunPaths(options.cwd, options.runId).scriptPath;
  } else {
    const [latest] = await listWorkflowRuns(options.cwd, 1);
    if (!latest) {
      throw new Error("No workflow run to save yet. Run one, then /workflows save <name>.");
    }
    scriptPath = path.join(latest.dir, "script.js");
  }

  const root = savedWorkflowRoots(options.cwd, options.homeRoot)[scope];
  await mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.js`);
  try {
    await copyFile(scriptPath, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Saved workflow "${name}" already exists at ${target}. Pick another name, or delete it first.`);
    }
    if (code === "ENOENT") {
      throw new Error(`That run has no persisted script at ${scriptPath}, so there is nothing to save.`);
    }
    throw error;
  }
  return { name, path: target, scope };
}

/** The saved-workflow directories: project first, then user. */
export function savedWorkflowRoots(cwd: string, homeRoot?: string): { project: string; user: string } {
  return {
    project: path.join(path.resolve(cwd), ".pi", "workflows", "saved"),
    user: path.join(path.resolve(homeRoot ?? os.homedir()), ".pi", "workflows", "saved"),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** A saved name is a filename, so it is allow-listed rather than sanitized. */
export function normalizeSavedName(name: string): string {
  const normalized = name.trim().replace(/\.js$/iu, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(normalized)) {
    throw new Error(`Invalid workflow name "${name}": use letters, digits, dot, dash or underscore`);
  }
  return normalized;
}

/**
 * Resolve exactly one of inline / path / name into a script.
 *
 * Requiring exactly one is deliberate: accepting more than one would mean
 * silently picking a winner, and the caller cannot tell which script ran.
 */
export async function resolveWorkflowSource(
  cwd: string,
  request: WorkflowRequest,
): Promise<WorkflowSource> {
  const chosen =
    Number(Boolean(request.script?.trim())) +
    Number(Boolean(request.scriptPath?.trim())) +
    Number(Boolean(request.name?.trim()));
  if (chosen !== 1) {
    throw new Error("workflow requires exactly one of `script`, `scriptPath`, or `name`");
  }

  let script: string;
  let name: string;
  let sourcePath: string | undefined;

  if (request.script?.trim()) {
    script = request.script;
    name = "inline";
  } else if (request.scriptPath?.trim()) {
    sourcePath = path.resolve(cwd, request.scriptPath);
    if (!isInside(cwd, sourcePath)) {
      throw new Error("workflow scriptPath must stay inside the working directory");
    }
    script = await readFile(sourcePath, "utf8");
    name = path.basename(sourcePath, path.extname(sourcePath));
  } else {
    const saved = normalizeSavedName(request.name ?? "");
    const roots = savedWorkflowRoots(cwd);
    const candidates = [path.join(roots.project, `${saved}.js`), path.join(roots.user, `${saved}.js`)];
    sourcePath = undefined;
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        sourcePath = candidate;
        break;
      }
    }
    if (!sourcePath) {
      throw new Error(`Saved workflow "${saved}" was not found in ${roots.project} or ${roots.user}`);
    }
    script = await readFile(sourcePath, "utf8");
    name = saved;
  }

  const bytes = Buffer.byteLength(script, "utf8");
  if (bytes > MAX_SCRIPT_BYTES) {
    throw new Error(`Workflow script is ${bytes} bytes; the limit is ${MAX_SCRIPT_BYTES}`);
  }
  return { name: name.slice(0, 200), script, ...(sourcePath ? { sourcePath } : {}) };
}
