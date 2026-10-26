import { expect, test } from "bun:test";
import { DeliveryLedger } from "../src/delivery-ledger.ts";

function harness() {
  const entries: any[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx: any = { sessionManager: { getBranch: () => entries } };
  return { entries, pi, ctx };
}

const input = {
  id: "wf:1",
  runId: "wf_1",
  sessionId: "s1",
  customType: "workflow-result",
  content: "result",
  display: true,
  wake: true,
  details: { runId: "wf_1", name: "one", status: "completed" },
};

test("an offer is pending until an ack, then disappears", () => {
  const { pi, ctx, entries } = harness();
  const ledger = new DeliveryLedger(pi, { now: () => 42 });
  expect(ledger.offer(input)).toBe(true);
  expect(entries[0]!.data).toMatchObject({ schema: 1, id: "wf:1", createdAt: 42 });
  expect(ledger.pending(ctx, "s1")).toHaveLength(1);

  expect(ledger.ack("wf:1")).toBe(true);
  expect(ledger.pending(ctx, "s1")).toHaveLength(0);
});

test("an offer is scoped to the session that owns it", () => {
  const { pi, ctx } = harness();
  const ledger = new DeliveryLedger(pi);
  ledger.offer(input);
  expect(ledger.pending(ctx, "s1")).toHaveLength(1);
  expect(ledger.pending(ctx, "s2")).toHaveLength(0);
});

test("a message already in the transcript counts as delivered without an ack", () => {
  const { pi, ctx, entries } = harness();
  const ledger = new DeliveryLedger(pi);
  ledger.offer(input);
  entries.push({ type: "custom_message", customType: "workflow-result", details: { deliveryId: "wf:1" } });
  expect(ledger.pending(ctx, "s1")).toHaveLength(0);
});

test("one batched message can prove several offers delivered", () => {
  const { pi, ctx, entries } = harness();
  const ledger = new DeliveryLedger(pi);
  ledger.offer(input);
  ledger.offer({ ...input, id: "wf:2", runId: "wf_2" });
  entries.push({ type: "custom_message", customType: "bg_bash_result", details: { deliveryIds: ["wf:1", "wf:2"] } });
  expect(ledger.pending(ctx, "s1")).toHaveLength(0);
});

test("malformed entries are ignored rather than replaying a partial result", () => {
  const { pi, ctx, entries } = harness();
  const ledger = new DeliveryLedger(pi);
  entries.push({ type: "custom", customType: "delivery-offer", data: { schema: 1, id: "wf:1" } });
  entries.push({ type: "custom", customType: "delivery-offer", data: null });
  expect(ledger.pending(ctx, "s1")).toHaveLength(0);
  expect(ledger.pending({ sessionManager: { getBranch: () => { throw new Error("gone"); } } } as any, "s1")).toHaveLength(0);
});

test("a failed append does not throw and does not claim durability", () => {
  const ledger = new DeliveryLedger({ appendEntry() { throw new Error("disk full"); } });
  expect(ledger.offer(input)).toBe(false);
  expect(ledger.ack("wf:1")).toBe(false);
});
