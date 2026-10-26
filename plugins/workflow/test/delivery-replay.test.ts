import { expect, test } from "bun:test";
import { workflowExtension } from "../src/pi/index.ts";

/**
 * A result that settled while the branch was current must survive a reload or
 * a switch away. These tests drive the session boundary directly: the branch
 * holds an offer the previous process wrote, and the plugin has to deliver it
 * once, then acknowledge it so a second boundary cannot deliver it again.
 */

function harness() {
  const entries: any[] = [];
  const sent: Array<{ message: any; options?: unknown }> = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: any, options?: unknown) {
      sent.push({ message, options });
    },
    events: { on() {}, emit() {} },
  };
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => entries,
    },
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
  };
  return { entries, sent, pi, ctx, emit };
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    id: "wf:old",
    runId: "wf_old",
    sessionId: "test-session",
    customType: "workflow-result",
    content: "old result body",
    display: true,
    wake: true,
    details: { runId: "wf_old", name: "old", status: "completed" },
    createdAt: 1,
    ...overrides,
  };
}

test("an unacknowledged result is delivered once when its branch reopens", async () => {
  const { entries, sent, pi, emit } = harness();
  entries.push({ type: "custom", customType: "workflow-delivery-offer", data: offer() });
  workflowExtension({ cwd: process.cwd(), executor: async () => ({ status: "completed", text: "", usage: {} }) })(pi);

  await emit("session_start");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatchObject({
    customType: "workflow-result",
    content: "old result body",
    details: { deliveryId: "wf:old" },
  });
  expect(sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  expect(entries.some((entry) => entry.customType === "workflow-delivery-ack" && entry.data.id === "wf:old")).toBe(true);

  // A second boundary must not deliver it again: the ack is the proof.
  await emit("session_start");
  expect(sent).toHaveLength(1);
});

test("a result already present in the transcript is not replayed without an ack", async () => {
  const { entries, sent, pi, emit } = harness();
  entries.push({ type: "custom", customType: "workflow-delivery-offer", data: offer() });
  // The crash window: the host accepted the message, the process died before
  // the ack entry reached the branch.
  entries.push({ type: "custom_message", customType: "workflow-result", details: { deliveryId: "wf:old" } });
  workflowExtension({ cwd: process.cwd(), executor: async () => ({ status: "completed", text: "", usage: {} }) })(pi);

  await emit("session_start");
  expect(sent).toHaveLength(0);
});

test("an offer from another session is not delivered into this one", async () => {
  const { entries, sent, pi, emit } = harness();
  entries.push({ type: "custom", customType: "workflow-delivery-offer", data: offer({ sessionId: "other-session" }) });
  workflowExtension({ cwd: process.cwd(), executor: async () => ({ status: "completed", text: "", usage: {} }) })(pi);

  await emit("session_start");
  expect(sent).toHaveLength(0);
});

test("a passive aborted result replays without waking a turn", async () => {
  const { entries, sent, pi, emit } = harness();
  entries.push({ type: "custom", customType: "workflow-delivery-offer", data: offer({ wake: false, content: "aborted" }) });
  workflowExtension({ cwd: process.cwd(), executor: async () => ({ status: "completed", text: "", usage: {} }) })(pi);

  await emit("session_start");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.options).toBeUndefined();
});
