import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRedactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";
import { PEM_PRIVATE_KEY } from "./fixtures.ts";

test("an unterminated PEM with whitespace finishes in a bounded child", () => {
  const script = String.raw`import { createRedactor } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
    import { SECRET_PATTERNS } from ${JSON.stringify(new URL('../src/patterns.ts', import.meta.url).href)};
    const redactor = createRedactor(SECRET_PATTERNS);
    const head = ${JSON.stringify(PEM_PRIVATE_KEY.split('\n')[0])};
    for (const body of [' '.repeat(20000), '\n'.repeat(20000), 'A'.repeat(7800) + ' '.repeat(20000)]) {
      const input = head + body;
      if (redactor.string(input) !== input) throw new Error('truncated input changed');
    }`;
  const child = spawnSync(process.execPath, ['--eval', script], { timeout: 2000, encoding: 'utf8' });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
});

test("PEM redaction preserves single-line and varied-width base64 bodies", () => {
  const redactor = createRedactor(SECRET_PATTERNS);
  const [head, , end] = PEM_PRIVATE_KEY.split('\n');
  for (const body of ['A'.repeat(128), 'A'.repeat(76) + '\r\n' + 'B'.repeat(12), 'AAAA\n\nBBBB']) {
    expect(redactor.string(`${head}\n${body}\n${end}`)).not.toContain(body);
  }
});
