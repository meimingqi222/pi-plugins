import { describe, expect, test } from "bun:test";

import { formatCommandBlock, summarizeInput } from "../src/prompt.ts";

/**
 * The approval dialog is a security boundary, so its formatter is pinned here
 * rather than only through the wiring tests: what the dialog shows is what the
 * user is actually approving.
 */
describe("formatCommandBlock", () => {
  test("keeps a multi-line command's structure instead of flattening it", () => {
    const command = "cd /tmp && python3 - <<'PY'\nimport os\nprint(1)\nPY";
    const block = formatCommandBlock(command);
    // Each line on its own row, indented — a heredoc reads as a heredoc.
    expect(block.split("\n")).toEqual([
      "  cd /tmp && python3 - <<'PY'",
      "  import os",
      "  print(1)",
      "  PY",
    ]);
  });

  test("folds a long line rather than cutting it mid-token", () => {
    const block = formatCommandBlock(`echo ${"x".repeat(200)}`);
    const rows = block.split("\n");
    expect(rows.length).toBeGreaterThan(1);
    // Nothing is lost: the wrapped rows reassemble into the original line.
    expect(rows.map((row) => row.slice(2)).join("")).toBe(`echo ${"x".repeat(200)}`);
    expect(block).not.toContain("…");
  });

  test("states the elision when lines are dropped", () => {
    const command = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
    const block = formatCommandBlock(command);
    expect(block.split("\n")).toHaveLength(5); // 4 kept + the stated elision
    expect(block).toContain("… 5 more lines");
    expect(block).not.toContain("line 8");
  });

  test("states the elision when a single line is too long to show", () => {
    // The old contract cut at 240 characters and said nothing, so the dialog
    // displayed a command that was not the one about to run.
    const command = `mytool ${"x".repeat(900)} && echo TAIL`;
    const block = formatCommandBlock(command);
    expect(block).toContain("more characters");
    expect(block).not.toContain("TAIL");
  });

  test("a short command is shown whole, with no elision marker", () => {
    expect(formatCommandBlock("npm test")).toBe("  npm test");
  });
});

describe("summarizeInput", () => {
  test("takes the command, not a JSON dump of the whole input", () => {
    expect(summarizeInput("bash", { command: "ls -la", timeout: 5_000 })).toBe("  ls -la");
  });

  test("bounds a pathological input instead of rendering it all", () => {
    const summary = summarizeInput("bash", { command: "x".repeat(50_000) });
    expect(summary.length).toBeLessThan(2_000);
    expect(summary).toContain("more characters");
  });
});
