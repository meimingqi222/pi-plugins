import { expect, test } from "bun:test";
import type { Lane } from "../src/lane.ts";
import { SubagentResultDelivery } from "../src/result-delivery.ts";

/**
 * Durable subagent delivery: a lane answer that was offered but never accepted
 * by the host survives a reload or branch switch and is replayed once, newest
 * revision first.
 *
 * Each harness is one extension lifetime: a reload is simulated by constructing
 * a second delivery instance over the same branch entries.
 */

function harness(entries: any[] = []) {
  const sent: Array<{ message: any; options: any }> = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx: any = {
    sessionManager: {
      getSessionId: () => "s1",
      getBranch: () => entries,
    },
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
  };
  return { entries, sent, pi, ctx, emit };
}

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "sa-1",
    agent: "explore",
    alias: "scout",
    task: "inspect",
    sessionId: "s1",
    kind: "background",
    status: "completed",
    startedAt: Date.now() - 1_000,
    resultRevision: 1,
    result: {
      content: [{ type: "text", text: overrides.resultRevision === 2 ? "second answer" : "the answer" }],
      details: { status: "completed", usage: {}, output: "" },
    } as any,
    ...overrides,
  } as Lane;
}

const origin = (sessionId: string | undefined = "s1") => ({
  isCurrent: () => true,
  isIdle: () => false,
  ...(sessionId ? { sessionId } : {}),
});

test("an offered answer is replayed once after a reload", async () => {
  const first = harness();
  const delivery = new SubagentResultDelivery(first.pi);
  delivery.offer(lane(), origin());

  expect(first.entries.some((entry) => entry.customType === "subagent-delivery-offer")).toBe(true);
  expect(first.sent).toHaveLength(0);

  const second = harness(first.entries);
  new SubagentResultDelivery(second.pi);
  await second.emit("session_start");

  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]!.message).toMatchObject({
    customType: "subagent-result",
    details: { deliveryId: "sa:sa-1:1" },
  });
  expect(second.sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  expect(second.entries.some((entry) => entry.customType === "subagent-delivery-ack" && entry.data.id === "sa:sa-1:1")).toBe(true);

  await second.emit("session_start");
  expect(second.sent).toHaveLength(1);
});

test("only the newest revision per lane is replayed", async () => {
  const first = harness();
  const delivery = new SubagentResultDelivery(first.pi);
  delivery.offer(lane({ resultRevision: 1 }), origin());
  delivery.offer(lane({ resultRevision: 2 }), origin());

  const second = harness(first.entries);
  new SubagentResultDelivery(second.pi);
  await second.emit("session_start");

  expect(second.sent).toHaveLength(1);
  expect(second.sent[0]!.message.content).toContain("second answer");
  expect(second.sent[0]!.message.details.deliveryId).toBe("sa:sa-1:2");
  const acked = second.entries
    .filter((entry) => entry.customType === "subagent-delivery-ack")
    .map((entry) => entry.data.id);
  expect(acked).toEqual(expect.arrayContaining(["sa:sa-1:1", "sa:sa-1:2"]));
});

test("a result the model already read is acknowledged and not replayed", async () => {
  const first = harness();
  const delivery = new SubagentResultDelivery(first.pi);
  const record = lane();
  delivery.offer(record, origin());
  delivery.consume(record);

  const second = harness(first.entries);
  new SubagentResultDelivery(second.pi);
  await second.emit("session_start");
  expect(second.sent).toHaveLength(0);
});

test("an offer from another session is not replayed here", async () => {
  const first = harness();
  const delivery = new SubagentResultDelivery(first.pi);
  delivery.offer(lane(), origin("other"));

  const second = harness(first.entries);
  new SubagentResultDelivery(second.pi);
  await second.emit("session_start");
  expect(second.sent).toHaveLength(0);
});
