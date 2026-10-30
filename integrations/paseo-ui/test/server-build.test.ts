import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("server build avoids the run-core barrel and its unrelated dependencies", async () => {
  const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../index.server.ts")], target: "bun", metafile: true });
  expect(result.success).toBe(true);
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.some(path => /run-core[/\\]src[/\\]index\.ts$/.test(path))).toBe(false);
});
