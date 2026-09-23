/**
 * Reading the state of saved workflows and past runs.
 *
 * Everything here is best-effort: a run directory can be half-written by a killed
 * process, and a listing command reporting "unreadable" is more useful than one
 * that throws. Each entry is therefore validated and dropped when it does not
 * match, rather than trusted because it was found on disk.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveWorkflowRoot, readJsonLines } from "./journal.ts";
import type { WorkflowRunResult } from "../core/types.ts";

export interface SavedWorkflow {
  name: string;
  path: string;
  /** Whether it came from the project or the user directory. */
  scope: "project" | "user";
}

export type WorkflowRunStatus =
  | "completed"
  | "partial"
  | "failed"
  | "aborted"
  | "budget_exceeded"
  | "unfinished"
  | "empty";

export interface WorkflowRunSummary {
  runId: string;
  dir: string;
  status: WorkflowRunStatus;
  /** Name from the script's first comment, or `inline`. */
  name?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Wall-clock span, when both ends are known. */
  durationMs?: number;
  spentTokens?: number;
  /** Calls that completed (or were reused) — the ones that produced a result. */
  okCalls?: number;
  /** Calls that failed and were journaled. */
  failedCalls?: number;
  /** The most recent journaled failure, for the listing. */
  lastError?: string;
}

/**
 * List saved workflows.
 *
 * Project scripts shadow user scripts of the same name, which is the same
 * precedence a reader expects from a project-local override.
 */
export async function listSavedWorkflows(roots: { project: string; user: string }): Promise<SavedWorkflow[]> {
  const found = new Map<string, SavedWorkflow>();
  for (const [scope, root] of [
    ["user", roots.user],
    ["project", roots.project],
  ] as const) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".js")) continue;
      const name = entry.slice(0, -3);
      // Project is read last, so it wins the name.
      found.set(name, { name, path: path.join(root, entry), scope });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List recent runs for a project, newest first.
 *
 * Reads only the small summary fields; a full result is not needed to list runs
 * and a large `value` would be loaded for nothing.
 */
export async function listWorkflowRuns(cwd: string, limit = 20): Promise<WorkflowRunSummary[]> {
  const runsRoot = path.join(resolveWorkflowRoot(cwd), "runs");
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return [];
  }

  const summaries: WorkflowRunSummary[] = [];
  for (const runId of entries) {
    const dir = path.join(runsRoot, runId);
    const summary = await readRunSummary(runId, dir);
    if (summary) summaries.push(summary);
  }
  summaries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return summaries.slice(0, limit);
}

async function readRunSummary(runId: string, dir: string): Promise<WorkflowRunSummary | undefined> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  // The journal is the durable record of what actually ran, so the summary is
  // derived from it rather than from a separate status file that could disagree.
  const entries = await readJsonLines<{
    status?: unknown;
    usage?: { input?: number; output?: number };
    createdAt?: unknown;
    error?: unknown;
  }>(path.join(dir, "journal.jsonl"));

  let spentTokens = 0;
  let startedAt: number | undefined;
  let finishedAt: number | undefined;
  let okCalls = 0;
  let failedCalls = 0;
  let lastError: string | undefined;
  for (const entry of entries) {
    // Every entry carries a timestamp, including a failure, so a run that only
    // failed still reports when it was alive.
    if (typeof entry.createdAt === "number") {
      startedAt ??= entry.createdAt;
      finishedAt = entry.createdAt;
    }
    // Usage is summed before the status branch: a failed call still spent real
    // tokens, and skipping it would report a run that cost money as costing
    // nothing — the same undercount the journal fix removed from the live path.
    const input = typeof entry.usage?.input === "number" ? entry.usage.input : 0;
    const output = typeof entry.usage?.output === "number" ? entry.usage.output : 0;
    spentTokens += input + output;
    if (entry.status === "failed") {
      failedCalls += 1;
      if (typeof entry.error === "string") lastError = entry.error;
      continue;
    }
    if (entry.status !== "completed" && entry.status !== "cached") continue;
    okCalls += 1;
  }

  const script = await readScriptName(path.join(dir, "script.js"));

  // The run's own verdict, when it left one.
  //
  // `progress.json` is written by the orchestrator and carries the status the
  // script actually ended with; the journal is a ledger of calls. Deriving the
  // run status from the ledger alone reported a run that had completed and
  // returned its value as `partial` because one child call inside it failed —
  // the listing contradicted the result the user had already been handed, and
  // every run that lost a single agent read as a failure. The verdict decides;
  // the counts can still veto a claimed success that produced nothing.
  const snapshot = await readProgressSnapshot(path.join(dir, "progress.json"));
  const verdict = typeof snapshot?.status === "string" ? snapshot.status : undefined;

  let status: WorkflowRunStatus;
  if (entries.length > 0) {
    status = runStatusFrom(verdict, okCalls, failedCalls);
  } else if (snapshot) {
    // An empty journal does not mean the run did nothing: every run before
    // failures were journaled has only a script on disk, and a run the budget
    // refused before its first call has nothing to journal at all. The snapshot
    // is the other record of activity, so it is consulted before calling the run
    // empty.
    //
    // The snapshot's status is one of these, `budget_exceeded` included: a run the
    // budget stopped before starting has a progress status of its own, and the
    // union admitting it is what keeps this a fact rather than a cast.
    status = verdict === undefined || verdict === "running" ? "unfinished" : (verdict as WorkflowRunStatus);
    // The snapshot carries the fields the journal would, so an unjournaled run
    // reports what it did instead of looking untouched.
    if (startedAt === undefined && typeof snapshot.startedAt === "number") {
      startedAt = snapshot.startedAt;
      finishedAt = typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : startedAt;
    }
    const ok = typeof snapshot.completedAgents === "number" ? snapshot.completedAgents : 0;
    const total = typeof snapshot.totalAgents === "number" ? snapshot.totalAgents : ok;
    if (okCalls === 0 && ok > 0) okCalls = ok;
    if (verdict !== "running" && failedCalls === 0 && total > ok) failedCalls = total - ok;
    if (spentTokens === 0 && typeof snapshot.spentTokens === "number") spentTokens = snapshot.spentTokens;
  } else {
    status = "empty";
  }

  // Derived after the progress fallback, which is what supplies the timestamps
  // for a run whose journal is empty.
  const durationMs = startedAt === undefined ? undefined : (finishedAt ?? startedAt) - startedAt;

  return {
    runId,
    dir,
    status,
    ...(script ? { name: script } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    spentTokens,
    ...(okCalls > 0 ? { okCalls } : {}),
    ...(failedCalls > 0 ? { failedCalls } : {}),
    ...(lastError ? { lastError: lastError.slice(0, STORED_ERROR_CHARS) } : {}),
  };
}

/**
 * The run's status: its own verdict when it left one, otherwise the ledger.
 *
 * A verdict of `completed` with no successful call is not a completed run —
 * whatever the script returned, nothing was produced, and calling that
 * `completed` would hide a total failure behind a status word. With at least one
 * successful call the verdict stands, and the losses stay visible in the counts
 * (`5 ok, 1 failed`) rather than being promoted to a verdict of their own.
 *
 * Without a snapshot the ledger is all there is, and `partial` remains the only
 * honest word for a run that produced some results and lost others — that is the
 * shape a killed process leaves behind.
 *
 * `running` in the snapshot is itself a verdict: the run never reached an end,
 * so partial success in the journal must not be promoted to `completed`.
 */
function runStatusFrom(verdict: string | undefined, okCalls: number, failedCalls: number): WorkflowRunStatus {
  if (verdict === undefined) {
    return okCalls === 0 && failedCalls > 0 ? "failed" : failedCalls > 0 ? "partial" : okCalls > 0 ? "completed" : "unfinished";
  }
  if (verdict === "running") return "unfinished";
  if (verdict === "completed" && okCalls === 0 && failedCalls > 0) return "failed";
  return verdict as WorkflowRunStatus;
}

/**
 * The terminal progress snapshot, for a run whose journal is empty.
 *
 * Best-effort like everything else here: a run killed mid-write may have a half
 * document, which is a reason to fall back to "empty" rather than to throw.
 */
async function readProgressSnapshot(filePath: string): Promise<
  { status?: string; startedAt?: number; updatedAt?: number; spentTokens?: number; completedAgents?: number; totalAgents?: number } | undefined
> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as never;
  } catch {
    return undefined;
  }
}

/** The saved script's first comment line, if it names the workflow. */
async function readScriptName(scriptPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(scriptPath, "utf8");
    const match = /^\s*(?:\/\/|\/\*)\s*([^\n*]{1,120})/u.exec(content);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * How much of an error the summary keeps.
 *
 * Generously above `MAX_ERROR_CHARS`: the formatter is the only place that cuts
 * with an ellipsis, and a store that cut first would leave the marker off (a
 * string already at the formatter's bound is returned unchanged). This record is
 * read by listings other than `/workflows`, which may want more of it.
 */
const STORED_ERROR_CHARS = 400;
const MAX_ERROR_CHARS = 160;
const MAX_NAME_CHARS = 40;

/** Thousands separators: a token count is read as a magnitude, not counted. */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** `14:31` for today's run, `09-22 14:31` for an older one. */
function formatClock(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "?       ";
  const date = new Date(at);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `today ${time}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

/** `42s`, `9m 52s`, `1h 04m` — coarse enough to scan, precise enough to matter. */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The status word, padded so the columns after it line up across runs. */
function formatStatus(status: WorkflowRunStatus): string {
  const label =
    status === "partial"
      ? "partial"
      : status === "unfinished"
        ? "unfinished"
        : status === "empty"
          ? "empty"
          : status;
  return label.padEnd(10, " ");
}

/** `1 ok, 2 failed` — the split a reader actually wants, not a bare total. */
function formatCallCounts(run: WorkflowRunSummary): string {
  const ok = run.okCalls ?? 0;
  const failed = run.failedCalls ?? 0;
  if (ok === 0 && failed === 0) return "no calls";
  const parts: string[] = [`${ok} ok`];
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}

function runLines(run: WorkflowRunSummary): string[] {
  const duration = formatDuration(run.durationMs);
  const counts = formatCallCounts(run);
  const detail = [counts, run.spentTokens ? `${formatCount(run.spentTokens)} tok` : "", duration].filter(Boolean);
  const lines = [`  ${run.runId}  ${formatClock(run.startedAt)}  ${formatStatus(run.status)}  ${detail.join("  ")}`];
  if (run.name && !looksLikeATask(run.name)) lines.push(`      ${run.name.slice(0, MAX_NAME_CHARS)}`);
  if (run.lastError) lines.push(`      error: ${shortenError(run.lastError)}`);
  return lines;
}

/**
 * One run's own lines, without the listing around it.
 *
 * `formatWorkflowStatus` answers "what has been running here": it carries the
 * saved set, the recent set and a legend about unjournaled runs. `/workflows
 * <runId>` asks about one run, and the same per-run lines are the answer.
 */
export function formatRunSummary(run: WorkflowRunSummary): string {
  return runLines(run).join("\n");
}

/**
 * Whether a script's first comment names the workflow or describes the task.
 *
 * An inline script is usually written with a leading comment describing what it
 * is for, which is a task description rather than a name. Printing it under a
 * run id adds a second, competing label for the same thing, so it is skipped.
 */
function looksLikeATask(name: string): boolean {
  return /\b(the|a|an)\s+\w+/iu.test(name) || name.split(/\s+/u).length > 4;
}

/**
 * Keep the head of an error and drop a trailing JSON payload.
 *
 * Providers report limits as a JSON body after the useful part, and the useful
 * part — which limit, which model — is at the front. Cutting mid-JSON leaves a
 * dangling brace that reads like a truncation bug.
 */
function shortenError(error: string): string {
  const trimmed = error.trim();
  if (trimmed.length <= MAX_ERROR_CHARS) return trimmed;
  const head = trimmed.slice(0, MAX_ERROR_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > MAX_ERROR_CHARS / 2 ? head.slice(0, lastSpace) : head).trimEnd()} …`;
}

/** Render a listing for a `ctx.ui.notify` call, bounded and plain text. */
export function formatWorkflowStatus(runs: WorkflowRunSummary[], saved: SavedWorkflow[]): string {
  const lines: string[] = [];
  lines.push(saved.length > 0 ? `Saved workflows (${saved.length}):` : "Saved workflows: none");
  for (const workflow of saved) {
    lines.push(`  ${workflow.name}  (${workflow.scope})`);
  }
  lines.push("");
  lines.push(runs.length > 0 ? `Recent runs (${runs.length}), newest first:` : "Recent runs: none");
  for (const run of runs) lines.push(...runLines(run));
  // Stated once as a legend rather than once per run: several runs predate failure
  // journaling, and repeating the same explanation adds noise, not information.
  const unjournaled = runs.filter((run) => run.okCalls === undefined && run.failedCalls === undefined).length;
  if (unjournaled > 0) {
    lines.push(
      "",
      `${unjournaled} run${unjournaled === 1 ? "" : "s"} marked \`empty\` have no journal — they predate failure journaling, so only the script is on disk.`,
    );
  }
  return lines.join("\n");
}

export type { WorkflowRunResult };
