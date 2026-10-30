import { expect, test } from "bun:test";
import type { AgentRunResult, RpcChild, RpcChildInput } from "@meimingqi222/pi-agent-runner";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAdmission } from "@meimingqi222/pi-run-core";
import { subagentExtension } from "../src/index.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };

class FakeRpcChild implements RpcChild {
  readonly pid = 1;
  readonly done: Promise<AgentRunResult>;
  private resolveDone!: (value: AgentRunResult) => void;
  constructor(readonly input: RpcChildInput) {
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  send(): boolean { return true; }
  end(): void { this.resolveDone({ status: "completed", text: "ok", usage }); }
  terminate(): void { this.resolveDone({ status: "aborted", text: "", usage }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const tools: Array<{ execute: (...args: any[]) => Promise<any> }> = [];
  const listeners = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const children: FakeRpcChild[] = [];
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "admission-session" }, isIdle: () => true };
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    on(name: string, handler: (...args: any[]) => unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    },
    events: { on() {}, emit() {} },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  return {
    tools,
    children,
    ctx,
    pi,
    emit: async (name: string) => {
      for (const handler of listeners.get(name) ?? []) await handler({ type: name }, ctx);
    },
  };
}

test("a background lane waits for the process-wide provider ticket", async () => {
  const admission = createAdmission({ ceiling: 1 });
  const { tools, children, ctx, pi, emit } = harness();
  subagentExtension({
    admission,
    discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
    spawnRpcChild: async (input) => {
      const child = new FakeRpcChild(input);
      children.push(child);
      return child;
    },
  })(pi);

  const launch = (task: string) =>
    tools[0]!.execute!("call", { agent: "explore", task, background: true }, undefined, undefined, ctx);

  await launch("one");
  await tick();
  expect(children).toHaveLength(1);

  // The lane cap allows this launch; the provider ceiling does not. It must
  // queue rather than spawn, which is the thing a per-plugin cap cannot do.
  await launch("two");
  await tick();
  expect(children).toHaveLength(1);
  expect(admission.snapshot()).toMatchObject({ inFlight: 1, queued: 1 });

  // A parked lane is not doing provider work, so it releases the ticket and
  // the queued lane starts.
  children[0]!.input.onIdleChange?.(true);
  await tick();
  expect(children).toHaveLength(2);

  for (const child of children) child.end();
  await tick();
  await emit("session_shutdown");
});

test("a reply to a parked lane holds a provider ticket until the turn settles", async () => {
  const admission = createAdmission({ ceiling: 1 });
  const { tools, children, ctx, pi, emit } = harness();
  subagentExtension({
    admission,
    discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
    spawnRpcChild: async (input) => {
      const child = new FakeRpcChild(input);
      children.push(child);
      return child;
    },
  })(pi);

  const launched = await tools[0]!.execute!("call", { agent: "explore", task: "one", background: true }, undefined, undefined, ctx);
  await tick();
  const id = launched.details.taskId as string;

  // Park the lane: the launch ticket goes back, and nothing is in flight.
  children[0]!.input.onIdleChange?.(true);
  await tick();
  expect(admission.snapshot().inFlight).toBe(0);

  // A reply starts a fresh provider turn on the parked lane, so it must hold a
  // fresh ticket — otherwise four answered lanes run four live turns with the
  // ceiling holding none of them.
  const reply = await tools[1]!.execute!("call", { action: "reply", id, prompt: "again" }, undefined, undefined, ctx);
  expect(reply.content[0].text).toContain("Reply sent");
  expect(admission.snapshot().inFlight).toBe(1);

  // While the reply turn runs, a new launch queues on the provider ceiling
  // rather than spawning past it.
  await tools[0]!.execute!("call", { agent: "explore", task: "two", background: true }, undefined, undefined, ctx);
  await tick();
  expect(children).toHaveLength(1);

  // The reply turn parking again hands the ticket to the queued launch.
  children[0]!.input.onIdleChange?.(true);
  await tick();
  expect(children).toHaveLength(2);

  for (const child of children) child.end();
  await tick();
  await emit("session_shutdown");
});

test("cancelling a lane mid-reply-turn releases the reply ticket", async () => {
  const admission = createAdmission({ ceiling: 1 });
  const { tools, children, ctx, pi, emit } = harness();
  subagentExtension({
    admission,
    discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
    spawnRpcChild: async (input) => {
      const child = new FakeRpcChild(input);
      children.push(child);
      return child;
    },
  })(pi);

  const launched = await tools[0]!.execute!("call", { agent: "explore", task: "one", background: true }, undefined, undefined, ctx);
  await tick();
  const id = launched.details.taskId as string;
  children[0]!.input.onIdleChange?.(true);
  await tick();

  await tools[1]!.execute!("call", { action: "reply", id, prompt: "again" }, undefined, undefined, ctx);
  expect(admission.snapshot().inFlight).toBe(1);

  // A cancel between reply and turn end must not hold the ticket hostage while
  // the child winds down — the capacity belongs to whoever is still running.
  await tools[1]!.execute!("call", { action: "cancel", id }, undefined, undefined, ctx);
  expect(admission.snapshot().inFlight).toBe(0);

  for (const child of children) child.end();
  await tick();
  await emit("session_shutdown");
});
