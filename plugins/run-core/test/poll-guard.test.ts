import { expect, test } from "bun:test";
import { createPollGuard, isPureWaitCommand } from "../src/poll-guard.ts";

test("only a bare sleep is a poll", () => {
  for (const command of ["sleep 30", "sleep 1.5s", "sleep 2m;", "  sleep 5  # wait", "Start-Sleep 3"]) {
    expect(isPureWaitCommand(command)).toBe(true);
  }
  for (const command of ["sleep 5 && npm test", "echo sleep 30", "npm test", "sleep", "sleep abc"]) {
    expect(isPureWaitCommand(command)).toBe(false);
  }
});

function guard(options: { active: string[]; terminate?: boolean }) {
  let handler: ((event: any) => unknown) | undefined;
  const pi = { on(name: string, value: (event: any) => unknown) { if (name === "tool_call") handler = value; } };
  createPollGuard(pi as any, {
    active: () => options.active,
    reason: (ids) => `running: ${ids.join(", ")}`,
    ...(options.terminate === undefined ? {} : { terminate: options.terminate }),
  });
  return (event: any) => handler!(event);
}

test("nothing is blocked when no work is active", () => {
  const run = guard({ active: [] });
  expect(run({ toolName: "bash", input: { command: "sleep 30" } })).toBeUndefined();
});

test("a bare sleep is blocked and names the live work", () => {
  const run = guard({ active: ["wf_1"] });
  expect(run({ toolName: "bash", input: { command: "sleep 30" } })).toEqual({
    block: true,
    reason: "running: wf_1",
  });
});

test("the caller decides whether blocking also ends the batch", () => {
  const run = guard({ active: ["wf_1"], terminate: true });
  expect(run({ toolName: "powershell", input: { command: "Start-Sleep 2" } })).toEqual({
    block: true,
    terminate: true,
    reason: "running: wf_1",
  });
});

test("a command with a purpose and a non-shell tool are left alone", () => {
  const run = guard({ active: ["wf_1"], terminate: true });
  expect(run({ toolName: "bash", input: { command: "sleep 5 && npm test" } })).toBeUndefined();
  expect(run({ toolName: "read", input: { command: "sleep 30" } })).toBeUndefined();
});
