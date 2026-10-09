import { expect, test } from "bun:test";
import { readTokenUsage } from "../src/usage.ts";
import { SettledDeliveryQueue } from "../src/settled-delivery.ts";
test("unknown usage is distinct from a measured zero-token response", () => {
  expect(readTokenUsage({})).toBeNull();
  expect(readTokenUsage({ usage: {} })).toBeNull();
  expect(readTokenUsage({ usage: { totalTokens: 0 } })).toBe(0);
  expect(readTokenUsage({ usage: { input: 1, output: 'unknown' } })).toBeNull();
});
test("a failed idle probe defers delivery until the settled event", () => {
  let settle!: () => void;
  const queue = new SettledDeliveryQueue({ on(_event: string, handler: () => void) { settle = handler; } } as any);
  let sent = 0;
  queue.deliver(() => { throw Error('torn context'); }, () => { sent++; });
  expect(sent).toBe(0);
  settle();
  expect(sent).toBe(1);
});
