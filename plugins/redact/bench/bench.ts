/**
 * Honest performance harness for pi-redact.
 *
 * Run: bun bench/bench.ts
 *
 * Key rules to avoid self-deception:
 *   - never average a cold first pass with cached repeats
 *   - measure per-string-size compute separately from cache hits
 *   - report both throughput and absolute ms, since absolute ms is what a
 *     user actually waits for on top of an LLM request
 */

import { createRedactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";
import { redactJson } from "../src/pi-bridge.ts";
import * as FX from "../test/fixtures.ts";

const CODE_LINE =
  "const result = items.filter((item) => item.enabled).map((item) => item.value * 2);";
const PROSE =
  "The quick brown fox jumps over the lazy dog while reviewing the authentication middleware implementation.";
const SECRET = FX.GITHUB_PAT;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Time `fn` once, after a warmup that does not touch the measured path. */
function timeOnce(fn: () => void, warmup = 2): number {
  for (let i = 0; i < warmup; i++) fn();
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// ---------------------------------------------------------------------------
// 1. Single-string compute cost (the true hot path)
// ---------------------------------------------------------------------------

console.log("=== single-string compute (fresh redactor, cache miss) ===\n");
console.log("     size      first pass     throughput");
console.log("  " + "-".repeat(46));

for (const kb of [4, 16, 64, 256, 512, 1024]) {
  // Rebuild text so it is not interned/shared between sizes.
  const text = (CODE_LINE + "\n").repeat(Math.max(1, Math.floor((kb * 1024) / (CODE_LINE.length + 1))));
  const len = Buffer.byteLength(text, "utf8");

  // Fresh redactor per measurement => guaranteed cache miss.
  let ms = 0;
  const runs = kb <= 64 ? 20 : 5;
  for (let i = 0; i < runs; i++) {
    const redactor = createRedactor(SECRET_PATTERNS);
    const t0 = performance.now();
    redactor.string(text);
    ms += performance.now() - t0;
  }
  ms /= runs;

  console.log(
    `  ${fmtBytes(len).padStart(9)}  ${ms.toFixed(2).padStart(10)} ms   ${(len / 1024 / 1024 / (ms / 1000)).toFixed(1).padStart(7)} MB/s`,
  );
}

// ---------------------------------------------------------------------------
// 2. Cache effectiveness (the same history resent on every turn)
// ---------------------------------------------------------------------------

console.log("\n=== repeat-pass cost (same string, same redactor) ===\n");
console.log("     size      first pass     2nd pass      speedup");
console.log("  " + "-".repeat(56));

for (const kb of [4, 64, 256, 512, 1024]) {
  const text = (CODE_LINE + "\n").repeat(Math.max(1, Math.floor((kb * 1024) / (CODE_LINE.length + 1))));
  const len = Buffer.byteLength(text, "utf8");
  const redactor = createRedactor(SECRET_PATTERNS);

  const t0 = performance.now();
  redactor.string(text);
  const first = performance.now() - t0;

  const t1 = performance.now();
  redactor.string(text);
  const second = performance.now() - t1;

  console.log(
    `  ${fmtBytes(len).padStart(9)}  ${first.toFixed(2).padStart(9)} ms  ${second.toFixed(3).padStart(9)} ms  ${(first / Math.max(second, 0.0001)).toFixed(0).padStart(6)}x`,
  );
}

// ---------------------------------------------------------------------------
// 3. Realistic provider payloads
// ---------------------------------------------------------------------------

function makeMessage(index: number): unknown {
  const body: string[] = [];
  for (let i = 0; i < 40; i++) body.push(i % 3 === 0 ? PROSE : CODE_LINE);
  if (index > 0 && index % 12 === 0) body.push(`token ${SECRET}`);
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: body.join("\n") }],
    usage: { input: 100, output: 100 },
  };
}

function makePayload(messageCount: number): any {
  const messages = [makeMessage(0)];
  for (let i = 1; i < messageCount; i++) messages.push(makeMessage(i));
  return {
    model: "deepseek-v4.1-flash",
    stream: true,
    temperature: 0,
    messages,
    tools: Array.from({ length: 16 }, (_, i) => ({
      type: "function",
      function: { name: `tool_${i}`, description: PROSE, parameters: { type: "object" } },
    })),
  };
}

console.log("\n=== realistic provider payload (deep walk) ===\n");
console.log("  messages     payload      cold pass     warm pass     secrets");
console.log("  " + "-".repeat(64));

for (const count of [4, 60, 300, 900, 2500]) {
  const payload = makePayload(count);
  const size = bytes(payload);

  // cold: fresh redactor each measurement
  let cold = 0;
  const runs = count <= 300 ? 5 : 3;
  for (let i = 0; i < runs; i++) {
    const redactor = createRedactor(SECRET_PATTERNS);
    const t0 = performance.now();
    redactJson(payload, redactor);
    cold += performance.now() - t0;
  }
  cold /= runs;

  // warm: same redactor, simulating next turn re-sending prior history
  const redactor = createRedactor(SECRET_PATTERNS);
  redactJson(payload, redactor);
  const t0 = performance.now();
  const hits = redactJson(payload, redactor).hits;
  const warm = performance.now() - t0;

  console.log(
    `  ${String(count).padStart(8)}  ${fmtBytes(size).padStart(10)}  ${cold.toFixed(2).padStart(9)} ms  ${warm.toFixed(2).padStart(9)} ms  ${String(hits).padStart(7)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Memory: cache growth under a long session with large file reads
// ---------------------------------------------------------------------------

console.log("\n=== cache memory (1000 distinct 64KB strings) ===\n");
{
  const redactor = createRedactor(SECRET_PATTERNS);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 1000; i++) {
    redactor.string(`/* file ${i} */\n` + (CODE_LINE + "\n").repeat(1500));
  }
  const after = process.memoryUsage().heapUsed;
  console.log(`  heap growth: ${fmtBytes(after - before)}`);
}

// ---------------------------------------------------------------------------
// 5. Adversarial: pathological regex input
// ---------------------------------------------------------------------------

console.log("\n=== adversarial input (no keyword match, long single line) ===\n");
{
  const blob = "a".repeat(2_000_000);
  const redactor = createRedactor(SECRET_PATTERNS);
  const t0 = performance.now();
  redactor.string(blob);
  console.log(`  2 MB single-token line: ${(performance.now() - t0).toFixed(2)} ms`);
}
