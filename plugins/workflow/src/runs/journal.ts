/**
 * Workflow run storage on disk.
 *
 * Every write is either append-only or an atomic rename, because a run can be
 * killed at any moment and the next process has to be able to tell what was
 * fully written. The journal is the case that matters: a partial final line is
 * possible, so the reader stops at the first line it cannot parse rather than
 * skipping it — resuming across a gap would replay a prefix that was never
 * contiguous.
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isJournalEntry, ResumeLog } from "../core/journal.ts";
import type { WorkflowJournalEntry } from "../core/types.ts";

const JOURNAL_FILENAME = "journal.jsonl";
const PROGRESS_FILENAME = "progress.json";
const EVIDENCE_FILENAME = "evidence.jsonl";

export interface WorkflowRunPaths {
  root: string;
  runDir: string;
  scriptPath: string;
  journalPath: string;
  progressPath: string;
  evidencePath: string;
}

/**
 * The workflow root for a project.
 *
 * `.pi/workflows` rather than whatever a previous tool used, because this is a
 * pi plugin and the directory is pi's.
 */
export function resolveWorkflowRoot(cwd: string): string {
  return path.join(path.resolve(cwd), ".pi", "workflows");
}

export function createWorkflowRunPaths(cwd: string, runId: string): WorkflowRunPaths {
  const root = resolveWorkflowRoot(cwd);
  const runDir = path.join(root, "runs", safeRunId(runId));
  return {
    root,
    runDir,
    scriptPath: path.join(runDir, "script.js"),
    journalPath: path.join(runDir, JOURNAL_FILENAME),
    progressPath: path.join(runDir, PROGRESS_FILENAME),
    evidencePath: path.join(runDir, EVIDENCE_FILENAME),
  };
}

/**
 * Reject a run id that could escape the runs directory.
 *
 * A run id is embedded in a path, so it is checked against an allow-list rather
 * than sanitized: a value that needs sanitizing is a caller bug, and silently
 * rewriting it would hide the bug while producing an unexpected path.
 */
function safeRunId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(trimmed)) {
    throw new Error("Invalid workflow run id");
  }
  return trimmed;
}

export function newWorkflowRunId(): string {
  return `wf_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const values: T[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      // A partial final line can be left by a killed process. Stop here so a
      // later run can only resume the verified contiguous prefix.
      break;
    }
  }
  return values;
}

/** Write via a temporary file and rename, so a reader never sees a half-written file. */
export async function writeWorkflowFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Append-only journal, plus the files a run produces alongside it.
 *
 * Writes are serialized through one queue so two concurrent appends cannot
 * interleave and produce a corrupt line. The queue swallows failures for
 * ordering purposes while still rejecting the awaited call, so one failed append
 * does not wedge every later one.
 */
export class WorkflowJournal {
  readonly paths: WorkflowRunPaths;
  private appendQueue: Promise<void> = Promise.resolve();
  private log: ResumeLog;

  constructor(paths: WorkflowRunPaths, previous: readonly WorkflowJournalEntry[] = []) {
    this.paths = paths;
    this.log = new ResumeLog(previous);
  }

  /** Resume state, for callers that report cache hits. */
  get resume(): ResumeLog {
    return this.log;
  }

  /**
   * Persist the executed script and load the previous journal, once.
   *
   * The script is written with `wx` so a re-invocation cannot silently overwrite
   * the copy a previous run's journal refers to — the pair has to stay
   * consistent for resume to mean anything.
   */
  static async open(
    paths: WorkflowRunPaths,
    script: string,
    resumeFrom?: WorkflowRunPaths,
  ): Promise<WorkflowJournal> {
    await mkdir(paths.runDir, { recursive: true });
    try {
      await writeFile(paths.scriptPath, script, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
    const previous = resumeFrom ? await WorkflowJournal.load(resumeFrom) : [];
    return new WorkflowJournal(paths, previous);
  }

  /** Read a previous run's reusable entries, filtered to a contiguous valid prefix. */
  static async load(paths: WorkflowRunPaths): Promise<WorkflowJournalEntry[]> {
    const entries = await readJsonLines<WorkflowJournalEntry>(paths.journalPath);
    const result: WorkflowJournalEntry[] = [];
    let expected = 0;
    for (const entry of entries) {
      // A gap in the sequence means the contiguous prefix ended. Everything
      // after it is not trustworthy as a replay source.
      if (!isJournalEntry(entry) || entry.seq !== expected) break;
      result.push(entry);
      expected += 1;
    }
    return result;
  }

  /** The cached entry for a call, or `undefined` to run it live. */
  cached(seq: number, callHash: string): WorkflowJournalEntry | undefined {
    return this.log.cached(seq, callHash);
  }

  async append(entry: WorkflowJournalEntry): Promise<void> {
    await this.appendLine(this.paths.journalPath, entry);
  }

  /**
   * Overwrite the run's progress snapshot.
   *
   * The journal records what finished; this records what is happening right now,
   * so a run can be diagnosed (or confirmed alive) from disk after the process
   * that owned it is gone. Atomic, because a reader must never see half a JSON
   * document.
   */
  async writeProgress(progress: unknown): Promise<void> {
    await writeWorkflowFileAtomic(this.paths.progressPath, `${JSON.stringify(progress, null, 2)}\n`);
  }

  async appendEvidence(value: unknown, evidencePath = this.paths.evidencePath): Promise<void> {
    await this.appendLine(path.resolve(evidencePath), value);
  }

  async flush(): Promise<void> {
    await this.appendQueue;
  }

  private async appendLine(filePath: string, value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    await this.enqueue(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.appendQueue.then(operation, operation);
    this.appendQueue = pending.catch(() => undefined);
    return pending;
  }
}

function isFileNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}
