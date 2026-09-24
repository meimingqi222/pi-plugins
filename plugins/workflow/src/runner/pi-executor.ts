/**
 * Workflow's adapter over `pi-agent-runner`.
 *
 * Everything *around* the child process that is workflow policy stays here:
 * resolving a role to a tool list, loading the child shell guard, and asking the
 * runner to parse a structured value when the script declared a schema. The
 * process handling itself — stdin, the drain, the kill, the child environment —
 * lives in the shared runner, so a fix there fixes this plugin and `pi-subagent`
 * at once.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentExecutor, type PiInvocation } from "pi-agent-runner";
import { parseStructuredReply, type AgentExecutor } from "./agent-runner.ts";
import { resolveToolProfile } from "./roles.ts";
import type { WorkflowAgentRunInput, WorkflowAgentRunResult } from "../core/types.ts";

export interface PiExecutorOptions {
  /** Wall-clock cap for one agent. The process is killed when it expires. */
  timeoutMs?: number;
  /** Override for tests; defaults to the resolved pi invocation. */
  invocation?: PiInvocation;
  /** Extra flags appended before the prompt. */
  extraArgs?: string[];
}

/**
 * The path to the child guard extension, or undefined when it is not on disk.
 *
 * Guarded by `existsSync`: passing `--extension` for a missing file would fail
 * every child, which is worse than leaving the shell unbounded.
 */
export function childGuardPath(): string | undefined {
  try {
    const path = fileURLToPath(new URL("./child-guard.ts", import.meta.url));
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Build the executor that runs workflow agents as pi subprocesses. */
export function createPiExecutor(options: PiExecutorOptions = {}): AgentExecutor {
  const run = createAgentExecutor({
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.invocation ? { invocation: options.invocation } : {}),
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
  });

  return async (input: WorkflowAgentRunInput): Promise<WorkflowAgentRunResult> => {
    // Resolve the role before spawning, and report a bad role as a failed result
    // rather than throwing out of the executor. Every other failure path returns
    // one, and a caller that wraps `agent()` in try/catch inside a script would
    // otherwise see an exception that bypasses the run's accounting entirely.
    let tools: string[] | undefined;
    try {
      tools = resolveToolProfile(input.options.toolProfile);
    } catch (error) {
      return {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    const guardPath = childGuardPath();
    const result = await run({
      prompt: input.prompt,
      cwd: input.cwd,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(input.options.model ? { model: input.options.model } : {}),
      ...(input.options.effort ? { effort: input.options.effort } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
      ...(guardPath ? { extensionPaths: [guardPath] } : {}),
      ...(input.options.schema ? { parse: parseStructuredReply } : {}),
    });

    return {
      status: result.status,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.value !== undefined ? { value: result.value } : {}),
      usage: result.usage,
      ...(result.model ? { model: result.model } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  };
}
