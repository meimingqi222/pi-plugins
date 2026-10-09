import { expect, test } from "bun:test";
import { approvalKey, decodeSessionContext, encodeSessionContext, type SessionContext } from "../src/session-context.ts";

const context: SessionContext = {
  version: 1, cwd: "/workspace", rules: ["bash(npm test:*)"],
  exactCalls: [approvalKey("bash", { command: 'npm test "$SUITE"' }, "/workspace", { dialect: "bash" })],
  sandboxOverride: false,
};

test("session snapshot validates scope and schema without widening malformed grants", () => {
  const raw = encodeSessionContext(context)!;
  expect(decodeSessionContext(raw, "/workspace")).toEqual(context);
  expect(decodeSessionContext(raw, "/other")).toBeUndefined();
  for (const value of [null, 7, { ...context, version: 2 }, { ...context, rules: [7] },
    { ...context, exactCalls: ["not-a-digest"] }, { ...context, sandboxOverride: "false" }]) {
    expect(decodeSessionContext(JSON.stringify(value), "/workspace")).toBeUndefined();
  }
  expect(decodeSessionContext("invalid json", "/workspace")).toBeUndefined();
  expect(encodeSessionContext({ ...context, rules: ["x".repeat(8192)] })).toBeUndefined();
  expect(decodeSessionContext("x".repeat(8193), "/workspace")).toBeUndefined();
});

test("exact approval hashes stable input order and distinguishes execution context", () => {
  const key = approvalKey("bash", { command: 'npm test "$SUITE"', timeout: 30 }, "/workspace", { dialect: "bash" });
  expect(approvalKey("bash", { timeout: 30, command: 'npm test "$SUITE"' }, "/workspace", { dialect: "bash" })).toBe(key);
  expect(approvalKey("bash", { command: 'npm test "$OTHER"', timeout: 30 }, "/workspace", { dialect: "bash" })).not.toBe(key);
  expect(approvalKey("bash", { command: 'npm test "$SUITE"', timeout: 31 }, "/workspace", { dialect: "bash" })).not.toBe(key);
  expect(approvalKey("bash", { command: 'npm test "$SUITE"', timeout: 30 }, "/other", { dialect: "bash" })).not.toBe(key);
  expect(approvalKey("bash", { command: 'npm test "$SUITE"', timeout: 30 }, "/workspace", { dialect: "powershell" })).not.toBe(key);
});
