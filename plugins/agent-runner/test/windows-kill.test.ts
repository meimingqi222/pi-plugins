import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { killAgentTree } from "../src/process.ts";

test("Windows cleanup awaits taskkill completion", async () => {
  let closed = false;
  const child = Object.assign(new EventEmitter(), { unref() {}, kill() {} });
  const spawn = () => {
    setTimeout(() => { closed = true; child.emit('close', 0); }, 20);
    return child;
  };
  await killAgentTree(999999, { platform: 'win32', spawn: spawn as any, timeoutMs: 100 });
  expect(closed).toBe(true);
});

test("a stuck Windows taskkill cannot hang cleanup", async () => {
  let killed = false;
  const child = Object.assign(new EventEmitter(), { unref() {}, kill() { killed = true; } });
  await killAgentTree(999999, { platform: 'win32', spawn: (() => child) as any, timeoutMs: 5 });
  expect(killed).toBe(true);
});
