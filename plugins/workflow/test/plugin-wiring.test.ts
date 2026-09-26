import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { workflowExtension } from "../src/pi/index.ts";
import type { AgentExecutor } from "../src/runner/agent-runner.ts";

/**
 * Wiring tests for the plugin entry: that a tool call *launches* a run and
 * returns, and that the result is delivered when the run settles.
 *
 * This is the design's "background execution + result delivery", and it is the
 * difference between a workflow that outlives one turn and one that holds the
 * conversation hostage. The modules underneath are tested elsewhere; what is
 * checked here is that they are connected.
 *
 * Each test runs against a temporary working directory. A run writes its journal
 * under `<cwd>/.pi/workflows/runs`, so using the repository's own directory would
 * litter the checkout with run directories.
 */

const roots: string[] = [];
async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wf-wiring-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Captured {
  tool: { name: string; execute: (...args: any[]) => Promise<any> };
  tools: Map<string, { name: string; execute: (...args: any[]) => Promise<any> }>;
  command: { handler: (args: string, ctx: any) => Promise<void> };
  delivered: Array<{ customType: string; content: unknown; details?: unknown; options?: unknown }>;
  shutdown: Array<() => void>;
  events: Map<string, Array<(event?: any, ctx?: any) => void>>;
  toolCalls: Array<(event: any) => any>;
  messageRenderers: Map<string, (...args: any[]) => any>;
}

function fakePi(): { pi: any; captured: Captured } {
  const listeners = new Map<string, Array<(value: any) => void>>();
  const captured: Captured = {
    tool: undefined as never,
    tools: new Map(),
    command: undefined as never,
    delivered: [],
    shutdown: [],
    events: new Map(),
    toolCalls: [],
    messageRenderers: new Map(),
  };
  const pi = {
    registerTool(tool: any) {
      captured.tools.set(tool.name, tool);
      // `captured.tool` stays the launch tool; the status tool is fetched by name.
      if (tool.name === "workflow") captured.tool = tool;
    },
    registerCommand(_name: string, command: any) {
      captured.command = command;
    },
    registerShortcut() {},
    registerMessageRenderer(type: string, renderer: (...args: any[]) => any) {
      captured.messageRenderers.set(type, renderer);
    },
    registerFlag() {},
    on(event: string, handler: any) {
      captured.events.set(event, [...(captured.events.get(event) ?? []), handler]);
      if (event === "session_shutdown") captured.shutdown.push(handler);
      if (event === "tool_call") captured.toolCalls.push(handler);
      return () => {};
    },
    sendMessage(message: any, options?: unknown) {
      captured.delivered.push({ customType: message.customType, content: message.content, details: message.details, options });
    },
    events: {
      on(name: string, handler: (value: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      emit(name: string, value: any) { for (const handler of listeners.get(name) ?? []) handler(value); },
    },
  };
  return { pi, captured };
}

const fakeExecutor: AgentExecutor = async (input) => ({
  status: "completed",
  value: `echo:${input.prompt}`,
  text: `echo:${input.prompt}`,
  usage: { input: 1, output: 1 },
});

function fakeCtx(cwd: string, notices: string[] = []): any {
  return {
    cwd,
    ui: { notify: (text: string) => notices.push(text) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "test", getBranch: () => [] },
  };
}

/**
 * Wait for a condition instead of a fixed number of ticks.
 *
 * Settlement runs through the worker host, so it needs real time — a few
 * microtasks are not enough. Polling is what keeps these tests deterministic
 * rather than flaky.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}

const SCRIPT = "return await agent('hi', {});";

describe("workflow tool launches a background run", () => {
  test("a run cannot deliver into a later session", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sessionId = "first";
    const ctx = fakeCtx(cwd);
    ctx.sessionManager.getSessionId = () => sessionId;
    workflowExtension({ cwd, executor: async () => { await gate; return { status: "completed", text: "old answer", usage: { input: 1, output: 1 } }; } })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);
    sessionId = "second";
    release();
    await waitForStatus(captured, cwd, "Settled runs:");
    expect(captured.delivered).toHaveLength(0);
  });

  test("leaving a session stops its workflow even when the session id stays the same", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    workflowExtension({ cwd, executor: async () => { await gate; return { status: "completed", text: "old answer", usage: { input: 1, output: 1 } }; } })(pi);
    const ctx = fakeCtx(cwd);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);
    for (const handler of captured.events.get("session_before_tree") ?? []) handler({}, ctx);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.delivered).toHaveLength(0);
    expect(await statusText(captured, cwd)).toContain("No workflow runs in this session");
  });

  test("leaving a session releases the goal lease and origin handles even when the run never settles", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reported: number[] = [];
    workflowExtension({
      cwd,
      // Ignores abort: settlement only happens after the leave, the case in
      // which stopAll alone would leave the lease and origin maps populated.
      executor: async () => {
        await gate;
        return { status: "completed", text: "late answer", usage: { input: 4, output: 4 } };
      },
    })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: (tokens: number) => reported.push(tokens) }) });
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    for (const handler of captured.events.get("session_before_switch") ?? []) handler({}, fakeCtx(cwd));
    // The lease is closed at zero instead of waiting for a settle that abort
    // cannot force.
    expect(reported).toEqual([0]);

    // The work may settle later or abort before the executor starts. Either
    // way, the old session must not deliver or report spend a second time.
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.delivered).toHaveLength(0);
    expect(reported).toEqual([0]);
  });

  test("leaving a session bills the workflow usage already reported in progress", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reported: number[] = [];
    let calls = 0;
    let secondReturned = false;
    workflowExtension({
      cwd,
      executor: async () => {
        calls += 1;
        if (calls === 2) await gate;
        if (calls === 2) secondReturned = true;
        return { status: "completed", text: "done", usage: { input: 4, output: 5 } };
      },
    })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: (tokens: number) => reported.push(tokens) }) });
    const script = "await agent('first', {}); return await agent('second', {});";
    const ctx = fakeCtx(cwd);
    await captured.tool.execute("call", { script }, undefined, undefined, ctx);
    await waitFor(() => calls === 2);
    for (const handler of captured.events.get("session_before_switch") ?? []) handler({}, ctx);
    expect(reported).toEqual([9]);
    release();
    await waitFor(() => secondReturned);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reported).toEqual([9]);
  });

  test("leaving a session releases the active run slot even if abort is ignored", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const previousLimit = process.env.PI_WORKFLOW_MAX_ACTIVE_RUNS;
    process.env.PI_WORKFLOW_MAX_ACTIVE_RUNS = "1";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      workflowExtension({ cwd, executor: async () => {
        await gate;
        return { status: "completed", text: "done", usage: { input: 1, output: 1 } };
      } })(pi);
      const ctx = fakeCtx(cwd);
      await captured.tool.execute("first", { script: SCRIPT }, undefined, undefined, ctx);
      for (const handler of captured.events.get("session_before_switch") ?? []) handler({}, ctx);
      await expect(captured.tool.execute("second", { script: SCRIPT }, undefined, undefined, ctx)).resolves.toBeDefined();
      release();
      await waitForStatus(captured, cwd, "Settled runs:");
    } finally {
      release();
      if (previousLimit === undefined) delete process.env.PI_WORKFLOW_MAX_ACTIVE_RUNS;
      else process.env.PI_WORKFLOW_MAX_ACTIVE_RUNS = previousLimit;
    }
  });

  test("a failed background run wakes the caller with its failure", async () => {
    const cwd = await tempCwd();
    await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
    await writeFile(join(cwd, ".pi", "workflows", "runs"), "blocked");
    const { pi, captured } = fakePi();
    workflowExtension({ cwd, executor: fakeExecutor })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));
    await waitFor(() => captured.delivered.length === 1);
    expect(captured.delivered[0]?.content).toContain("failed");
    expect(captured.delivered[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("delivery failure is visible instead of silently swallowed", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ cwd, executor: fakeExecutor, deliver: () => { throw new Error("delivery broke"); } })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd, notices));
    await waitFor(() => notices.some((notice) => notice.includes("delivery broke")));
    expect(captured.delivered).toHaveLength(0);
  });
  test("reports cache-inclusive live spend to the goal when it settles", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const reported: number[] = [];
    workflowExtension({
      cwd,
      executor: async () => ({ status: "completed", text: "ok", value: "ok", usage: { input: 3, output: 2, cacheRead: 5, cacheWrite: 0 } }),
    })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: (tokens: number) => reported.push(tokens) }) });
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));
    await waitFor(() => reported.length === 1);
    expect(reported).toEqual([10]);
  });
  test("execute returns a handle without waiting for the run to finish", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);

    const started = Date.now();
    const result = await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));
    // Non-blocking is the property: the tool answers before the run completes.
    expect(Date.now() - started).toBeLessThan(2_000);

    expect(result.content[0].text).toContain("started");
    expect(result.details.status).toBe("running");
    expect(result.details.runId).toMatch(/^wf_/);
    expect(result.content[0].text).toContain("/workflows");
  });

  test("the settled result is delivered back into the conversation", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    await waitFor(() => captured.delivered.length === 1);
    expect(captured.delivered[0].customType).toBe("workflow-result");
    // The delivered body carries the run's value, which is the point of
    // delivering at all.
    expect(String(captured.delivered[0].content)).toContain("echo:hi");
  });

  test("a workflow result after agent_end reaches Pi at agent_settled", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ctx = fakeCtx(cwd);
    ctx.isIdle = () => false;
    workflowExtension({ executor: async () => {
      await gate;
      return { status: "completed", text: "done", usage: { input: 1, output: 1 } };
    }, cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);
    for (const handler of captured.events.get("agent_end") ?? []) handler({}, ctx);
    release();
    await waitForStatus(captured, cwd, "Settled runs:");
    expect(captured.delivered).toHaveLength(0);
    ctx.isIdle = () => true;
    for (const handler of captured.events.get("agent_settled") ?? []) handler({}, ctx);
    await waitFor(() => captured.delivered.length === 1);
    expect(captured.delivered[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("a queued workflow result is discarded when its session leaves before agent_settled", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const ctx = fakeCtx(cwd);
    ctx.isIdle = () => false;
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);
    await waitForStatus(captured, cwd, "Settled runs:");
    expect(captured.delivered).toHaveLength(0);
    for (const handler of captured.events.get("session_before_switch") ?? []) handler({}, ctx);
    ctx.isIdle = () => true;
    for (const handler of captured.events.get("agent_settled") ?? []) handler({}, ctx);
    expect(captured.delivered).toHaveLength(0);
  });

  test("a workflow result settling after a session switch is discarded", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const ctx = fakeCtx(cwd);
    ctx.isIdle = () => false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    workflowExtension({ executor: async () => {
      await gate;
      return { status: "completed", text: "late", usage: { input: 1, output: 1 } };
    }, cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);
    for (const handler of captured.events.get("session_before_switch") ?? []) handler({}, ctx);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured.delivered).toHaveLength(0);
  });

  test("a failing goal spend lease does not swallow a workflow result", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: () => { throw new Error("lease failed"); } }) });
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd, notices));
    await waitFor(() => captured.delivered.length === 1);
    expect(notices.some((notice) => notice.includes("lease failed"))).toBe(true);
  });

  test("a failing goal spend lease cannot prevent session cleanup", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    workflowExtension({ cwd, executor: async () => {
      await gate;
      return { status: "completed", text: "late", usage: { input: 1, output: 1 } };
    } })(pi);
    pi.events.emit("pi-goal:spend-service:v1", { begin: () => ({ finish: () => { throw new Error("lease failed"); } }) });
    const ctx = fakeCtx(cwd);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);
    try {
      for (const handler of captured.events.get("session_before_switch") ?? []) handler({}, ctx);
      expect(await statusText(captured, cwd)).toContain("No workflow runs in this session");
    } finally {
      release();
    }
  });

  test("a non-JSON script result delivers a failed run rather than disappearing", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    await captured.tool.execute("call", { script: "return 1n;" }, undefined, undefined, fakeCtx(cwd));

    await waitFor(() => captured.delivered.length === 1);
    expect(captured.delivered[0].customType).toBe("workflow-result");
    const record = captured.delivered[0].details as { result: { status: string } };
    expect(record.result.status).toBe("failed");
    expect(String(captured.delivered[0].content)).toContain("JSON");
  });

  test("a multiline workflow answer is delivered as readable text with an expandable TUI renderer", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({
      cwd,
      executor: async () => ({ status: "completed", text: "## Assessment\n\n- first\n- second", usage: { input: 1, output: 1 } }),
    })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));
    await waitFor(() => captured.delivered.length === 1);
    const body = String(captured.delivered[0].content);
    expect(body).toContain("## Assessment\n\n- first\n- second");
    expect(body).not.toContain("\\n");
    expect(body).not.toContain('"value":');
    const render = captured.messageRenderers.get("workflow-result");
    expect(render).toBeDefined();
    const theme = { fg: (_color: string, text: string) => text };
    const message = { ...captured.delivered[0], content: body };
    const collapsed = render!(message, { expanded: false, outputPad: 0 }, theme).render(120).join("\n");
    expect(collapsed).toContain("Workflow completed");
    expect(collapsed).not.toContain("## Assessment");
    initTheme("dark", false);
    const expanded = render!(message, { expanded: true, outputPad: 0 }, theme).render(120).join("\n");
    expect(expanded).toContain("Assessment");
    expect(expanded).toContain("first");
  });

  test("the handle's runId is the run's own id", async () => {
    // Regression: execute() and executeWorkflow() each minted an id, so the
    // handle named a run that had no journal and resumeFromRunId could not
    // find it. The delivered record must carry the same id the tool returned.
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    const handle = await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    await waitFor(() => captured.delivered.length === 1);
    const record = (captured.delivered[0] as { details?: { result?: { runId?: string } } }).details;
    expect(record?.result?.runId).toBe(handle.details.runId);
  });

  test("concurrent runs each deliver their own result", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    await Promise.all([
      captured.tool.execute("a", { script: "return await agent('one', {});" }, undefined, undefined, fakeCtx(cwd)),
      captured.tool.execute("b", { script: "return await agent('two', {});" }, undefined, undefined, fakeCtx(cwd)),
    ]);

    await waitFor(() => captured.delivered.length === 2);
    const bodies = captured.delivered.map((entry) => String(entry.content)).join("\n");
    expect(bodies).toContain("echo:one");
    expect(bodies).toContain("echo:two");
  });

  test("a bad script name fails the tool call, not a background run", async () => {
    // Resolution happens before launch, so the model sees the error where it can
    // act on it rather than discovering a silent background failure.
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    await expect(
      captured.tool.execute("call", { name: "does-not-exist" }, undefined, undefined, fakeCtx(cwd)),
    ).rejects.toThrow(/not found/);
    expect(captured.delivered).toHaveLength(0);
  });
});

describe("workflow run control", () => {
  test("/workflows reports active runs and keeps the history", async () => {
    // The disk listing used to be skipped while something was live, so a run in
    // flight — exactly when a reader wants the previous runs' outcomes — showed
    // nothing but the active one.
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    await captured.command.handler("", fakeCtx(cwd, notices));
    const text = notices.join("\n");
    expect(text).toContain("Active workflows");
    expect(text).toContain("running");
    expect(text).toContain("Recent runs");
  });

  test("/workflows describes the active run instead of naming it", async () => {
    // The live section used to be one `formatRun` line — "wf_x running name
    // 18.8s" — so the command answered "a run exists" and nothing else. It now
    // renders the same detail `workflow_status` gives the model.
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    const handle = await captured.tool.execute(
      "call",
      { script: "phase('review'); return await agent('hi', {});", agentTimeoutMs: 120_000 },
      undefined,
      undefined,
      fakeCtx(cwd),
    );
    await waitForStatus(captured, cwd, "running now");

    await captured.command.handler("", fakeCtx(cwd, notices));
    const text = notices.join("\n");
    expect(text).toContain("Active workflows (1):");
    expect(text).toContain("phase: review");
    expect(text).toContain("running now:");
    expect(text).toContain("tokens:");
    expect(text).toContain("per-agent timeout: 2m 0s");
    // And only once: the run's own journal is still half-written, so repeating
    // it below as `unfinished`/`empty` with a 0s span would describe the same
    // run worse, not more.
    expect(text.split(handle.details.runId).length - 1).toBe(1);
  });

  test("/workflows <runId> answers about that one run", async () => {
    // The listing is a summary of many; "what is it doing right now" is a
    // question about one, and the run id is already the handle the user holds.
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    const handle = await captured.tool.execute(
      "call",
      { script: "phase('review'); return await agent('hi', {});" },
      undefined,
      undefined,
      fakeCtx(cwd),
    );
    await waitForStatus(captured, cwd, "running now");

    await captured.command.handler(handle.details.runId, fakeCtx(cwd, notices));
    expect(notices.join("\n")).toContain("running now:");

    await captured.command.handler("wf_not_a_run", fakeCtx(cwd, notices));
    expect(notices.at(-1)).toContain("No workflow run wf_not_a_run");
  });

  test("the footer entry appears while a run is live and is handed back at shutdown", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const statuses: Array<[string, string | undefined]> = [];
    const ctx = {
      ...fakeCtx(cwd),
      hasUI: true,
      mode: "tui",
      ui: {
        notify: () => {},
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      },
    };
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, ctx);

    // A run lasts minutes; the notification that announces it scrolls away.
    expect(statuses.at(-1)?.[0]).toBe("workflow");
    expect(statuses.at(-1)?.[1]).toContain("wf ");

    // Settlement after a shutdown may never arrive, so the slot is released here.
    captured.shutdown[0]!();
    expect(statuses.at(-1)).toEqual(["workflow", undefined]);
  });

  test("/workflows live falls back to a listing where no component can be drawn", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    await captured.command.handler("live", fakeCtx(cwd, notices));
    expect(notices.join("\n")).toContain("Active workflows (1):");
  });

  test("/workflows stop <runId> ends that run", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    const run = await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    await captured.command.handler(`stop ${run.details.runId}`, fakeCtx(cwd, notices));
    expect(notices.join("\n")).toContain("Stopping");
    // The stop must reach the run: an aborted run settles and reports.
    await waitFor(() => captured.delivered.length >= 1);
  });

  test("stopping with no active run says so", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    const notices: string[] = [];
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    await captured.command.handler("stop", fakeCtx(cwd, notices));
    expect(notices.join("\n")).toContain("No workflow runs are active");
  });

  test("session shutdown stops every active run", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));
    expect(captured.shutdown).toHaveLength(1);
    // Must not throw: shutdown runs on paths where the session is already gone.
    expect(() => captured.shutdown[0]!()).not.toThrow();
  });
});

/**
 * Observability: a running workflow must be inspectable from the model side, and
 * the wait-poll that a model falls back to must become a clean stop.
 *
 * `/workflows` is the user surface and cannot answer "is this alive?" for the
 * model, and a run's settlement is minutes away. These tests pin the two halves
 * of the replacement: a status tool over live progress, and a poll guard that
 * turns a bare sleep into an ended turn.
 */
async function statusText(captured: Captured, cwd: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = captured.tools.get("workflow_status")!;
  const result = await tool.execute("status", args, undefined, undefined, fakeCtx(cwd));
  return String(result.content[0].text);
}

/** `waitFor` takes a sync predicate; this needs to await the status tool. */
async function waitForStatus(captured: Captured, cwd: string, needle: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await statusText(captured, cwd);
    if (last.includes(needle)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`status never contained ${needle}; last: ${last}`);
}

describe("workflow observability", () => {
  test("a status tool reports what an active run is doing", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: "phase('review'); return await agent('hi', {});" }, undefined, undefined, fakeCtx(cwd));

    const text = await waitForStatus(captured, cwd, "running now");
    expect(text).toContain("Active workflows (1):");
    expect(text).toContain("phase: review");
    expect(text).toContain("running now:");
    expect(text).toContain("tokens:");
    expect(text).toContain("last progress:");
  });

  test("the status tool reports the per-agent timeout as the bound on a hung child", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT, agentTimeoutMs: 120_000 }, undefined, undefined, fakeCtx(cwd));

    const text = await waitForStatus(captured, cwd, "running now");
    expect(text).toContain("per-agent timeout: 2m 0s");
  });

  test("the status tool says so when nothing is running", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);
    expect(await statusText(captured, cwd)).toContain("Active workflows: none.");
  });
});

describe("poll guard", () => {
  test("a bare sleep while a run is active is blocked and ends the turn", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    const guard = captured.toolCalls[0]!;
    const result = guard({ toolName: "bash", input: { command: "sleep 30" } });
    expect(result.block).toBe(true);
    // Terminating is what turns a poll into "end your turn and be woken".
    expect(result.terminate).toBe(true);
    expect(result.reason).toContain("workflow_status");
  });

  test("a sleep with a purpose is left alone", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: () => new Promise(() => {}), cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT }, undefined, undefined, fakeCtx(cwd));

    const guard = captured.toolCalls[0]!;
    expect(guard({ toolName: "bash", input: { command: "sleep 5 && npm test" } })).toBeUndefined();
  });

  test("nothing is blocked when no run is active", async () => {
    const cwd = await tempCwd();
    const { pi, captured } = fakePi();
    workflowExtension({ executor: fakeExecutor, cwd })(pi);

    const guard = captured.toolCalls[0]!;
    expect(guard({ toolName: "bash", input: { command: "sleep 30" } })).toBeUndefined();
  });
});

describe("timeout and evidence wiring", () => {
  test("agentTimeoutMs reaches every agent; runTimeoutMs does not replace it", async () => {
    // Regression: the tool mapped `agentTimeoutMs` onto the *whole-run* timeout,
    // so the per-agent cap could not be set and a hung child was bounded only by
    // the executor default.
    const cwd = await tempCwd();
    const inputs: Array<{ timeoutMs?: number; evidencePath?: string }> = [];
    const recordingExecutor = async (input: { timeoutMs?: number; evidencePath?: string }) => {
      inputs.push(input);
      return { status: "completed" as const, value: "ok", text: "ok", usage: { input: 1, output: 1 } };
    };
    const { pi, captured } = fakePi();
    workflowExtension({ executor: recordingExecutor as never, cwd })(pi);
    await captured.tool.execute("call", { script: SCRIPT, agentTimeoutMs: 4_321 }, undefined, undefined, fakeCtx(cwd));

    await waitFor(() => inputs.length > 0);
    expect(inputs[0]!.timeoutMs).toBe(4_321);
    // The evidence file lives under the run directory, so a hung agent is
    // diagnosable after the fact.
    expect(inputs[0]!.evidencePath).toContain("agents");
    expect(inputs[0]!.evidencePath).toContain(".jsonl");
  });
});
