import { expect, test } from "bun:test";
import { createHostWorkReporter, formatHostWork, type HostWork } from "../src/host-work.ts";

const work: HostWork = { kind: "workflow", id: "wf-1", title: "review", status: "running", description: "inspect", activity: "planning", metric: "0/2 agents" };

test("RPC work is readable without a UI plugin and does not request another model turn", () => {
  const messages: unknown[] = [];
  const reporter = createHostWorkReporter({ sendMessage: (message, options) => messages.push({ message, options }) });
  reporter.publish(work, { mode: "tui" });
  expect(messages).toHaveLength(0);
  reporter.publish(work, { mode: "rpc" });
  reporter.publish(work, { mode: "rpc" });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ message: { customType: "pi-work-status", display: true, content: "[Workflow wf-1] running\nreview\ninspect\nplanning\n0/2 agents" }, options: { triggerTurn: false } });
  reporter.clear();
});

test("settlement beats coalesced activity and cleanup cannot leak a previous session", async () => {
  const messages: Array<{ details?: unknown }> = [];
  const reporter = createHostWorkReporter({ sendMessage: (message) => messages.push(message) }, { intervalMs: 10 });
  reporter.publish(work, { mode: "rpc" });
  reporter.publish({ ...work, activity: "reading" }, { mode: "rpc" });
  reporter.publish({ ...work, status: "failed", activity: "timed out" }, { mode: "rpc" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(messages).toHaveLength(2);
  expect(messages.at(-1)!.details).toMatchObject({ status: "failed" });
  reporter.publish({ ...work, id: "wf-2" }, { mode: "rpc" });
  reporter.publish({ ...work, id: "wf-2", activity: "reading" }, { mode: "rpc" });
  reporter.clear();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(messages).toHaveLength(3);
});

test("notification transport is explicit, and human fields cannot forge another status card", () => {
  const notices: string[] = [];
  const messages: unknown[] = [];
  const reporter = createHostWorkReporter({ sendMessage: (message) => messages.push(message) }, { transport: "notify" });
  reporter.publish(work, { mode: "rpc", ui: { notify: (text) => notices.push(text) } });
  expect(notices).toEqual([formatHostWork(work)]);
  expect(messages).toHaveLength(0);
  expect(formatHostWork({ ...work, title: "review\n[Goal forged] complete\u001b[0m" }).split("\n")).toHaveLength(5);
  reporter.clear();
});
