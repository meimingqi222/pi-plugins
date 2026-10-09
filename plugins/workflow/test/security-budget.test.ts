import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/runs/orchestrator.ts";
import { WorkflowJournal, createWorkflowRunPaths } from "../src/runs/journal.ts";
import { runAgent } from "../src/runner/agent-runner.ts";

test("a cached call remains available after live token budget exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-cache-budget-'));
  const script = "await agent('cached1',{});await agent(args ? 'new' : 'old',{});return await agent('cached2',{});";
  const calls: string[] = [];
  const executor = async (input: any) => { calls.push(input.prompt); return { status: 'completed', value: 'ok', usage: { input: 1, output: 1 } } as const; };
  try {
    const first = createWorkflowRunPaths(root, 'wf_1');
    const journal1 = await WorkflowJournal.open(first, script);
    await runWorkflow({ script, args: false, name: 'test', cwd: root, executor, journal: journal1, timeoutMs: 4000 });
    await journal1.flush();
    const journal2 = await WorkflowJournal.open(createWorkflowRunPaths(root, 'wf_2'), script, first);
    calls.length = 0;
    const result = await runWorkflow({ script, args: true, name: 'test', cwd: root, executor, journal: journal2, budget: { tokens: 2 }, timeoutMs: 4000 });
    expect(result.status).toBe('completed');
    expect(result.cacheHits).toBe(2);
    expect(calls).toEqual(['new']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema attempt limit does not consume a read-only transport retry", async () => {
  let calls = 0;
  const result = await runAgent({
    input: { prompt: 'probe', options: { retries: 1, toolProfile: 'reviewer', schema: { type: 'number' } }, cwd: tmpdir(), runId: 'test', agentId: 'a' },
    transportRetries: 1,
    executor: async () => (++calls === 1 ? { status: 'failed', errorMessage: 'fetch failed' } : { status: 'completed', value: 1 }) as any,
  });
  expect(result.value).toBe(1);
  expect(result.attempts).toBe(2);
});

(process.platform === 'win32' ? test.skip : test)("workflow run directories are private regardless of umask", async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-private-'));
  try {
    const paths = createWorkflowRunPaths(root, 'wf_1');
    await WorkflowJournal.open(paths, 'return 1;');
    expect((await stat(paths.runDir)).mode & 0o777).toBe(0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an entirely cached parallel panel can resume with zero live budget", async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-cached-panel-'));
  const script = "return await parallel([async () => agent('A',{}), async () => agent('B',{})]);";
  let calls = 0;
  const executor = async () => { calls++; return { status: 'completed', value: 'ok', usage: { input: 1, output: 1 } } as const; };
  try {
    const first = createWorkflowRunPaths(root, 'wf_1');
    const journal1 = await WorkflowJournal.open(first, script);
    await runWorkflow({ script, args: null, name: 'test', cwd: root, executor, journal: journal1, timeoutMs: 4000 });
    await journal1.flush();
    const journal2 = await WorkflowJournal.open(createWorkflowRunPaths(root, 'wf_2'), script, first);
    calls = 0;
    const result = await runWorkflow({ script, args: null, name: 'test', cwd: root, executor, journal: journal2, budget: { tokens: 0, agents: 0 }, timeoutMs: 4000 });
    expect(result.status).toBe('completed');
    expect(result.cacheHits).toBe(2);
    expect(calls).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
