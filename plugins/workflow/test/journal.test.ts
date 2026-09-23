import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowRunPaths, newWorkflowRunId, readJsonLines, resolveWorkflowRoot, WorkflowJournal } from "../src/runs/journal.ts";
import { emptyWorkflowUsage, type WorkflowJournalEntry } from "../src/core/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-wf-"));
  roots.push(root);
  return root;
}

function entry(overrides: Partial<WorkflowJournalEntry> = {}): WorkflowJournalEntry {
  return {
    schemaVersion: 1,
    seq: 0,
    callId: "c0",
    callHash: "h0",
    prompt: "p",
    options: {},
    status: "completed",
    result: { ok: true },
    usage: emptyWorkflowUsage(),
    attempt: 1,
    createdAt: 1,
    ...overrides,
  };
}

describe("run paths", () => {
  test("the workflow root is pi's, not another tool's", () => {
    expect(resolveWorkflowRoot("/tmp/project")).toBe(join("/tmp/project", ".pi", "workflows"));
  });
  test("a run id that could escape the runs directory is rejected", () => {
    const cwd = "/tmp/project";
    for (const bad of ["../escape", "a/b", "", " ", "-leading", "x".repeat(97)]) {
      expect(() => createWorkflowRunPaths(cwd, bad)).toThrow();
    }
  });
  test("a generated run id is filesystem safe", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = newWorkflowRunId();
      expect(id).toMatch(/^wf_[0-9a-f]{16}$/);
      expect(() => createWorkflowRunPaths("/tmp/p", id)).not.toThrow();
    }
  });
});

describe("readJsonLines", () => {
  test("a missing file is empty, not an error", () => {
    expect(readJsonLines("/tmp/definitely-missing-pi-workflow")).resolves.toEqual([]);
  });
  test("stops at the first unparseable line so only a contiguous prefix is read", async () => {
    // A killed process can leave a partial final line; everything after a gap
    // must not be treated as trustworthy replay input.
    const root = await tempRoot();
    const file = join(root, "j.jsonl");
    await writeFile(file, `${JSON.stringify(entry({ seq: 0 }))}\n{"partial":\n${JSON.stringify(entry({ seq: 1 }))}\n`);
    const values = await readJsonLines<WorkflowJournalEntry>(file);
    expect(values).toHaveLength(1);
    expect(values[0].seq).toBe(0);
  });
});

describe("WorkflowJournal", () => {
  test("open writes the script once and refuses to overwrite it", async () => {
    const root = await tempRoot();
    const paths = createWorkflowRunPaths(root, "wf_test1");
    await WorkflowJournal.open(paths, "// first");
    // A second open must not replace the copy the journal refers to, or resume
    // would compare hashes against a different script than the one that ran.
    await WorkflowJournal.open(paths, "// second");
    expect(await readFile(paths.scriptPath, "utf8")).toBe("// first");
  });

  test("resumes a matching prefix and stops at the first divergence", async () => {
    const root = await tempRoot();
    const first = createWorkflowRunPaths(root, "wf_run1");
    const journal = await WorkflowJournal.open(first, "// script");
    await journal.append(entry({ seq: 0, callHash: "a" }));
    await journal.append(entry({ seq: 1, callHash: "b" }));
    await journal.flush();

    const second = createWorkflowRunPaths(root, "wf_run2");
    const resumed = await WorkflowJournal.open(second, "// script", first);
    expect(resumed.cached(0, "a")).toBeDefined();
    expect(resumed.cached(1, "b")).toBeDefined();

    const diverged = createWorkflowRunPaths(root, "wf_run3");
    const after = await WorkflowJournal.open(diverged, "// script", first);
    expect(after.cached(0, "a")).toBeDefined();
    expect(after.cached(1, "changed")).toBeUndefined();
    // Past the divergence nothing is reused, including a call that would match.
    expect(after.cached(1, "b")).toBeUndefined();
  });

  test("a gap in the sequence truncates the reusable prefix", async () => {
    // Load must stop at the hole rather than skip it, or a run would replay a
    // prefix that was never contiguous.
    const root = await tempRoot();
    const paths = createWorkflowRunPaths(root, "wf_gap");
    await mkdir(paths.runDir, { recursive: true });
    await writeFile(
      paths.journalPath,
      [entry({ seq: 0, callHash: "a" }), entry({ seq: 2, callHash: "c" }), entry({ seq: 3, callHash: "d" })]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const loaded = await WorkflowJournal.load(paths);
    expect(loaded.map((value) => value.seq)).toEqual([0]);
  });

  test("concurrent appends do not interleave into a corrupt file", async () => {
    const root = await tempRoot();
    const paths = createWorkflowRunPaths(root, "wf_conc");
    const journal = await WorkflowJournal.open(paths, "// s");
    await Promise.all(
      Array.from({ length: 25 }, (_value, index) => journal.append(entry({ seq: index, callHash: `h${index}` }))),
    );
    await journal.flush();
    const lines = (await readFile(paths.journalPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(25);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
