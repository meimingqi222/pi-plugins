import { describe, expect, test } from "bun:test";
import { ActiveTimer, readTokenUsage } from "../src/usage.ts";
import { RunGuard } from "../src/guard.ts";
import { RunBudget, RunBudgetExceeded } from "../src/budget.ts";
import { ContinuationChannel } from "../src/deliver.ts";

describe("readTokenUsage", () => {
  test("totalTokens wins over the derived sum", () => {
    // A provider that reports a total has already decided what belongs in it;
    // re-deriving would double-count cache reads.
    expect(readTokenUsage({ usage: { totalTokens: 10, input: 100, output: 100 } })).toBe(10);
  });
  test("derives from all four fields when no total is present", () => {
    expect(readTokenUsage({ usage: { input: 1, output: 2, cacheRead: 4, cacheWrite: 8 } })).toBe(15);
  });
  test("missing or malformed usage is zero, not NaN", () => {
    for (const message of [undefined, null, 42, {}, { usage: null }, { usage: { totalTokens: -1 } }]) {
      expect(readTokenUsage(message)).toBe(0);
    }
  });
});

describe("ActiveTimer", () => {
  test("does not count while stopped", () => {
    let now = 0;
    const timer = new ActiveTimer(0, () => now);
    now = 5_000;
    expect(timer.elapsedMs()).toBe(0);
  });
  test("counts only the running span", () => {
    let now = 0;
    const timer = new ActiveTimer(0, () => now);
    timer.start();
    now = 3_000;
    timer.stop();
    now = 90_000;
    expect(timer.elapsedMs()).toBe(3_000);
  });
  test("carries the sub-second remainder across boundaries", () => {
    // Three 700ms spans floor to zero each if the remainder is dropped, which
    // would under-report a goal that pauses often.
    let now = 0;
    const timer = new ActiveTimer(0, () => now);
    for (let i = 0; i < 3; i += 1) {
      timer.start();
      now += 700;
      timer.capture();
      timer.stop();
    }
    expect(timer.elapsedMs()).toBe(2_000);
  });
  test("restart seeds from a persisted total and resumes counting", () => {
    let now = 0;
    const timer = new ActiveTimer(0, () => now);
    timer.restart(10_000);
    now = 1_500;
    expect(timer.elapsedMs()).toBe(11_500);
    expect(timer.elapsedSeconds()).toBe(11);
  });
  test("a throwing clock degrades to Date.now instead of propagating", () => {
    const timer = new ActiveTimer(0, () => { throw new Error("clock unavailable"); });
    timer.start();
    expect(timer.elapsedMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("RunGuard", () => {
  test("a token is current until invalidated", () => {
    const guard = new RunGuard();
    const token = guard.issue();
    expect(guard.isCurrent(token)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(token)).toBe(false);
  });
  test("nextSession invalidates outstanding tokens", () => {
    const guard = new RunGuard();
    const token = guard.issue();
    guard.nextSession();
    expect(guard.isCurrent(token)).toBe(false);
  });
  test("an earlier token cannot be revived by a later issue", () => {
    const guard = new RunGuard();
    const stale = guard.issue();
    guard.invalidate();
    guard.issue();
    expect(guard.isCurrent(stale)).toBe(false);
  });
});

describe("RunBudget", () => {
  test("unbounded admits without limit", () => {
    const budget = new RunBudget();
    for (let i = 0; i < 1_000; i += 1) budget.admit();
    expect(budget.bounded).toBe(false);
    expect(budget.refused).toBe(false);
  });
  test("agent axis refuses the call that would cross it", () => {
    const budget = new RunBudget({ agents: 2 });
    budget.admit();
    budget.admit();
    expect(() => budget.admit()).toThrow(RunBudgetExceeded);
    expect(budget.admit).toBeDefined();
  });
  test("a panel is refused whole, not partially, when it would cross the cap", () => {
    // `admit(agentCalls)` is how a panel reserves; the throw must land before
    // any child starts rather than after a prefix has run.
    const budget = new RunBudget({ agents: 3 });
    budget.admit(2);
    expect(() => budget.admit(2)).toThrow(RunBudgetExceeded);
    expect(budget.state().agents).toBe(2);
  });
  test("token axis stops admission once spent", () => {
    const budget = new RunBudget({ tokens: 100 });
    budget.record(100);
    expect(() => budget.admit()).toThrow(RunBudgetExceeded);
    expect(budget.refused).toBe(true);
  });
  test("overshoot is reported rather than undone", () => {
    const budget = new RunBudget({ tokens: 100 });
    budget.admit();
    budget.record(150);
    expect(budget.overspent).toBe(true);
    expect(budget.state().overspentTokens).toBe(150);
  });
  test("refused and overspent are the two facts a run reports, and they are distinct", () => {
    // A run that spends exactly its budget and finishes did nothing wrong, so
    // "no further call could be admitted" is not a signal worth reporting. What
    // matters is whether work was turned away, and whether the limit was crossed
    // after admission — those settle differently and are reported separately.
    const spent = new RunBudget({ agents: 1 });
    spent.admit();
    expect(spent.refused).toBe(false);
    expect(spent.overspent).toBe(false);

    const refused = new RunBudget({ agents: 1 });
    refused.admit();
    expect(() => refused.admit()).toThrow(RunBudgetExceeded);
    expect(refused.refused).toBe(true);
    expect(refused.overspent).toBe(false);

    const crossed = new RunBudget({ tokens: 10 });
    crossed.admit();
    crossed.record(40);
    expect(crossed.overspent).toBe(true);
    expect(crossed.refused).toBe(false);
  });
  test("restore brings back the admission counter so a resume cannot double the budget", () => {
    const budget = new RunBudget({ agents: 2 });
    budget.restore({ agents: 2, tokens: 50 });
    expect(budget.exhausted).toBe(true);
    expect(budget.state().tokens).toBe(50);
  });
  test("check refuses nothing that admit would accept, and reserves nothing", () => {
    // The panel's preview. It must not reserve, because the panel's own tasks
    // admit their calls afterwards and a reservation here would count them twice.
    const budget = new RunBudget({ agents: 2 });
    budget.check(2);
    expect(budget.state().agents).toBe(0);
    expect(budget.refused).toBe(false);
    expect(() => budget.check(3)).toThrow(RunBudgetExceeded);
    expect(budget.state().agents).toBe(0);
    // A refused preview is a refusal: the panel it belonged to never ran, and
    // the run must be able to say the budget turned work away.
    expect(budget.refused).toBe(true);
  });
  test("check honours the token axis too", () => {
    const budget = new RunBudget({ tokens: 10 });
    expect(() => budget.check(1)).not.toThrow();
    budget.record(10);
    expect(() => budget.check(1)).toThrow(RunBudgetExceeded);
  });
  test("release gives back a slot that cost nothing, and never goes negative", () => {
    // A resumed call is admitted by the host before the caller can tell it is a
    // cache hit, so the slot has to come back or a resume spends budget on work
    // it did not do.
    const budget = new RunBudget({ agents: 1 });
    budget.admit();
    budget.release();
    expect(budget.refused).toBe(false);
    expect(() => budget.admit()).not.toThrow();
    budget.release(5);
    expect(budget.state().agents).toBe(0);
  });
});

describe("ContinuationChannel", () => {
  function fakePi() {
    const sent: Array<{ message: any; options: any }> = [];
    return {
      sent,
      sendMessage(message: any, options: any) { sent.push({ message, options }); },
    };
  }
  test("flags outstanding until consumed, then reports user-driven", () => {
    const pi = fakePi();
    const channel = new ContinuationChannel(pi as any);
    expect(channel.isOutstanding).toBe(false);
    expect(channel.deliver("queued", { customType: "x" }, "body")).toBe(true);
    expect(channel.isOutstanding).toBe(true);
    expect(channel.consume()).toBe(true);
    expect(channel.consume()).toBe(false);
  });
  test("queued deliveries are follow-ups, immediate ones start a turn now", () => {
    const pi = fakePi();
    const channel = new ContinuationChannel(pi as any);
    channel.deliver("queued", { customType: "a" }, "one");
    channel.deliver("immediate", { customType: "b" }, "two");
    expect(pi.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(pi.sent[1].options).toEqual({ triggerTurn: true });
  });
  test("a refused send clears the flag so the run is not left waiting", () => {
    const channel = new ContinuationChannel({
      sendMessage() { throw new Error("no session"); },
    } as any);
    expect(channel.deliver("queued", { customType: "x" }, "body")).toBe(false);
    expect(channel.isOutstanding).toBe(false);
  });
  test("reset drops a pending delivery at a session boundary", () => {
    const pi = fakePi();
    const channel = new ContinuationChannel(pi as any);
    channel.deliver("queued", { customType: "x" }, "body");
    channel.reset();
    expect(channel.isOutstanding).toBe(false);
  });
});
