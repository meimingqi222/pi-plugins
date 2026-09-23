import { describe, expect, test } from "bun:test";
import { isPureWaitCommand, pollBlockReason } from "../src/pi/poll-guard.ts";

describe("isPureWaitCommand", () => {
  test("recognises a bare sleep, which is the poll", () => {
    expect(isPureWaitCommand("sleep 30")).toBe(true);
    expect(isPureWaitCommand("  sleep 0.5  ")).toBe(true);
    expect(isPureWaitCommand("sleep 10;")).toBe(true);
    expect(isPureWaitCommand("sleep 1.25")).toBe(true);
  });

  test("leaves a sleep with a purpose alone", () => {
    // A command that does something after sleeping is not a poll of the run.
    expect(isPureWaitCommand("sleep 5 && npm test")).toBe(false);
    expect(isPureWaitCommand("sleep 5; npm test")).toBe(false);
    expect(isPureWaitCommand("timeout 5 sleep 1")).toBe(false);
    expect(isPureWaitCommand("while true; do sleep 1; done")).toBe(false);
  });

  test("does not match a sleep-shaped non-command", () => {
    expect(isPureWaitCommand("")).toBe(false);
    expect(isPureWaitCommand("sleep")).toBe(false);
    expect(isPureWaitCommand("sleep soon")).toBe(false);
    expect(isPureWaitCommand("echo sleep 30")).toBe(false);
    expect(isPureWaitCommand("npm test")).toBe(false);
  });
});

describe("pollBlockReason", () => {
  test("names the runs to inspect", () => {
    const reason = pollBlockReason(["wf_a", "wf_b"]);
    expect(reason).toContain("wf_a, wf_b");
    expect(reason).toContain("workflow_status");
    expect(reason).toContain("end your turn");
  });

  test("reads sensibly with no named run", () => {
    expect(pollBlockReason([])).toContain("A workflow is still running.");
  });
});
