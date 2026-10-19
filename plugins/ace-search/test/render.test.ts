import { expect, test } from "bun:test";
import { renderResult } from "../src/index.ts";
import type { AceSearchResult } from "../src/search.ts";

function result(text: string): AceSearchResult {
  return {
    text,
    projectRoot: "/work/app",
    query: "where is the parser",
    phases: [],
    totalDurationMs: 12,
    indexFormat: "v1",
    indexEntryCount: 3,
    includedFiles: 3,
    skippedFiles: 0,
    blobCount: 3,
    uploadedChunks: 0,
    indexWaitMs: 0,
  };
}

test("a huge retrieval body is truncated before it reaches the model", () => {
  // ACE returns as much as it has; without a bound this became a tool result
  // the size of the server's response and could blow the context window.
  const out = renderResult(result("x".repeat(5_000_000)));
  expect(out.length).toBeLessThan(100_000);
  expect(out).toContain("[Output truncated]");
});

test("a small result is unchanged", () => {
  const out = renderResult(result("src/index.ts:1: export function parse() {}"));
  expect(out).toContain("export function parse");
  expect(out).not.toContain("[Output truncated]");
});
