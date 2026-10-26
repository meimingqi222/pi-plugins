import { expect, test } from "bun:test";
import {
  ADMISSION_RECOVERY_SUCCESSES,
  createAdmission,
  isAdmissionThrottle,
  processAdmission,
  resetProcessAdmission,
} from "../src/admission.ts";

test("the cap is process-wide across run ids", async () => {
  const admission = createAdmission({ ceiling: 2 });
  const first = await admission.acquire({ runId: "wf-1" });
  const second = await admission.acquire({ runId: "sa-1" });

  let thirdResolved = false;
  const third = admission.acquire({ runId: "wf-2" }).then((ticket) => {
    thirdResolved = true;
    return ticket;
  });
  await Promise.resolve();

  expect(thirdResolved).toBe(false);
  expect(admission.snapshot()).toMatchObject({ cap: 2, inFlight: 2, queued: 1 });

  first.release();
  const thirdTicket = await third;
  expect(thirdResolved).toBe(true);
  expect(admission.snapshot().inFlight).toBe(2);

  second.release();
  thirdTicket.release();
  expect(admission.snapshot().inFlight).toBe(0);
});

test("waiters are served round-robin across runs", async () => {
  const admission = createAdmission({ ceiling: 1 });
  const held = await admission.acquire({ runId: "r1" });
  const order: string[] = [];
  // Each granted ticket releases immediately, so one held slot cascades through
  // the queue and the recorded order is the scheduler's order.
  const waiting = [
    admission.acquire({ runId: "r1" }).then((t) => { order.push("r1-a"); t.release(); }),
    admission.acquire({ runId: "r2" }).then((t) => { order.push("r2-a"); t.release(); }),
    admission.acquire({ runId: "r1" }).then((t) => { order.push("r1-b"); t.release(); }),
    admission.acquire({ runId: "r2" }).then((t) => { order.push("r2-b"); t.release(); }),
  ];

  held.release();
  await Promise.all(waiting);

  expect(order).toEqual(["r2-a", "r1-a", "r2-b", "r1-b"]);
});

test("an aborted waiter leaves the queue and rejects", async () => {
  const admission = createAdmission({ ceiling: 1 });
  const held = await admission.acquire({ runId: "held" });
  const controller = new AbortController();
  const waiting = admission.acquire({ runId: "queued", signal: controller.signal });

  controller.abort(new Error("stopped"));
  await expect(waiting).rejects.toThrow("stopped");
  expect(admission.snapshot().queued).toBe(0);

  held.release();
  expect(admission.snapshot().inFlight).toBe(0);
});

test("tryAcquire never jumps a queue", async () => {
  const admission = createAdmission({ ceiling: 1 });
  const held = await admission.acquire({ runId: "held" });

  expect(admission.tryAcquire({ runId: "fast" })).toBeUndefined();

  const waiting = admission.acquire({ runId: "queued" });
  expect(admission.tryAcquire({ runId: "fast" })).toBeUndefined();

  held.release();
  const queuedTicket = await waiting;
  expect(admission.tryAcquire({ runId: "fast" })).toBeUndefined();
  queuedTicket.release();
  expect(admission.tryAcquire({ runId: "fast" })).toBeDefined();
});

test("a throttle lowers the cap, pauses admission, and recovers gradually", async () => {
  let nowValue = 0;
  const timers: Array<{ run: () => void; at: number }> = [];
  const admission = createAdmission({
    ceiling: 4,
    now: () => nowValue,
    schedule: (run, delayMs) => {
      timers.push({ run, at: nowValue + delayMs });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearSchedule: () => {},
  });

  const held = await Promise.all([1, 2, 3, 4].map((index) => admission.acquire({ runId: `r${index}` })));
  admission.observe("provider", "throttled", 1_000);

  expect(admission.snapshot().cap).toBe(3);
  expect(admission.snapshot().throttled).toBe(true);
  expect(admission.snapshot().cooldownUntil).toBe(1_000);

  let admitted = false;
  const waiting = admission.acquire({ runId: "blocked" }).then((ticket) => {
    admitted = true;
    return ticket;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);

  held[0]!.release();
  await Promise.resolve();
  expect(admitted).toBe(false);

  nowValue = 1_000;
  timers.shift()?.run();
  await Promise.resolve();
  expect(admitted).toBe(false);

  held[1]!.release();
  const waitingTicket = await waiting;
  expect(admitted).toBe(true);

  // Recovery needs the configured streak *and* someone waiting for the slot:
  // the third in-flight call fills the reduced cap, so this one queues.
  const secondWaiting = admission.acquire({ runId: "next" });
  for (let index = 0; index < ADMISSION_RECOVERY_SUCCESSES; index += 1) admission.observe("provider", "succeeded");
  expect(admission.snapshot().cap).toBe(4);

  const secondWaitingTicket = await secondWaiting;
  secondWaitingTicket.release();
  waitingTicket.release();
  held[2]!.release();
  held[3]!.release();
  expect(admission.snapshot().inFlight).toBe(0);
});

test("the process controller is a singleton and can be reset for tests", () => {
  const first = processAdmission({ PI_ADMISSION_MAX_CONCURRENCY: "2" });
  const second = processAdmission({ PI_ADMISSION_MAX_CONCURRENCY: "9" });
  expect(second).toBe(first);
  expect(first.snapshot().ceiling).toBe(2);

  resetProcessAdmission();
  const rebuilt = processAdmission({ PI_ADMISSION_MAX_CONCURRENCY: "3" });
  expect(rebuilt).not.toBe(first);
  expect(rebuilt.snapshot().ceiling).toBe(3);
  resetProcessAdmission();
});

test("throttle classification covers the provider's own wording", () => {
  expect(isAdmissionThrottle("HTTP 429 Too Many Requests")).toBe(true);
  expect(isAdmissionThrottle("rate limited by provider")).toBe(true);
  expect(isAdmissionThrottle("concurrency reached; try later")).toBe(true);
  expect(isAdmissionThrottle("Connection error.")).toBe(false);
  expect(isAdmissionThrottle("agent timed out after 900000ms")).toBe(false);
});
