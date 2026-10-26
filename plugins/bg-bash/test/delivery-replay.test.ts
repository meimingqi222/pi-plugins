import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bgBashExtension, { BG_BASH_CUSTOM_TYPE } from "../src/index.ts";

/**
 * Durable completion replay: only a completion that was allowed to wake the
 * model is offered, and a branch that holds that offer but not the message
 * delivers it once when reopened.
 *
 * No shell is spawned here: the branch is seeded with the offer a previous
 * process would have written, which is exactly the recovery input.
 */

let logDir: string;
let previousLogDir: string | undefined;
beforeEach(() => {
  previousLogDir = process.env.PI_BG_BASH_LOG_DIR;
  logDir = mkdtempSync(join(tmpdir(), "pi-bg-replay-"));
  process.env.PI_BG_BASH_LOG_DIR = logDir;
});
afterEach(() => {
  if (previousLogDir === undefined) delete process.env.PI_BG_BASH_LOG_DIR;
  else process.env.PI_BG_BASH_LOG_DIR = previousLogDir;
  rmSync(logDir, { recursive: true, force: true });
});

function harness(entries: any[] = []) {
  const messages: Array<{ message: any; options: any }> = [];
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
    events: { on() {}, emit() {} },
  };
  const ctx: any = {
    cwd: process.cwd(),
    isIdle: () => true,
    hasUI: false,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => entries,
    },
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
  };
  bgBashExtension(pi);
  return { entries, messages, tools, pi, ctx, emit };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    id: "bg:bg001",
    runId: "bg001",
    sessionId: "test-session",
    customType: BG_BASH_CUSTOM_TYPE,
    content: "Background commands finished:\n- bg001: failed (exit 7), 1.2s\nStatus only. Output: bg_tasks result <id>.",
    display: false,
    wake: true,
    details: { jobId: "bg001", status: "failed", exitCode: 7, durationMs: 1_200 },
    createdAt: 1,
    ...overrides,
  };
}

test("an unacknowledged completion notice is delivered once when the branch reopens", async () => {
  const entries = [{ type: "custom", customType: "bg-bash-delivery-offer", data: offer() }];
  const first = harness(entries);
  await first.emit("session_start");

  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]!.message).toMatchObject({
    customType: BG_BASH_CUSTOM_TYPE,
    display: false,
    content: "Background commands finished:\n- bg001: failed (exit 7), 1.2s\nStatus only. Output: bg_tasks result <id>.",
    details: { deliveryIds: ["bg:bg001"] },
  });
  expect(first.messages[0]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  expect(entries.some((entry) => entry.customType === "bg-bash-delivery-ack" && entry.data.id === "bg:bg001")).toBe(true);

  await first.emit("session_start");
  expect(first.messages).toHaveLength(1);
});

test("a notice already in the transcript is not replayed without an ack", async () => {
  const entries = [
    { type: "custom", customType: "bg-bash-delivery-offer", data: offer() },
    // The crash window: the host accepted the batched message, the process died
    // before the ack entry reached the branch.
    { type: "custom_message", customType: BG_BASH_CUSTOM_TYPE, details: { deliveryIds: ["bg:bg001"] } },
  ];
  const host = harness(entries);
  await host.emit("session_start");
  expect(host.messages).toHaveLength(0);
});

test("an offer from another session is not delivered here", async () => {
  const entries = [{ type: "custom", customType: "bg-bash-delivery-offer", data: offer({ sessionId: "other-session" }) }];
  const host = harness(entries);
  await host.emit("session_start");
  expect(host.messages).toHaveLength(0);
});

test("a real failing job offers its completion before a reload", async () => {
  const first = harness();
  // Busy: the settled-boundary flush cannot run yet, which is the window a
  // reload is simulated in.
  first.ctx.isIdle = () => false;
  await first.tools.get("bash").execute(
    "call",
    { command: "echo diagnostic-detail; exit 7", background: true, notify: "always" },
    undefined,
    undefined,
    first.ctx,
  );
  await waitFor(() => first.entries.some((entry) => entry.customType === "bg-bash-delivery-offer"));
  const offerEntry = first.entries.find((entry) => entry.customType === "bg-bash-delivery-offer")!;
  await first.emit("session_shutdown");

  const second = harness(first.entries);
  await second.emit("session_start");
  expect(second.messages).toHaveLength(1);
  expect(second.messages[0]!.message.content).toContain(`${offerEntry.data.runId}: failed (exit 7)`);
  expect(second.messages[0]!.message.details.deliveryIds).toEqual([`bg:${offerEntry.data.runId}`]);
  await second.emit("session_shutdown");
});

test("a malformed offer is acknowledged instead of retried forever", async () => {
  const entries = [{ type: "custom", customType: "bg-bash-delivery-offer", data: offer({ details: { jobId: "bg001" } }) }];
  const host = harness(entries);
  await host.emit("session_start");
  expect(host.messages).toHaveLength(0);
  expect(entries.some((entry) => entry.customType === "bg-bash-delivery-ack" && entry.data.id === "bg:bg001")).toBe(true);
});
