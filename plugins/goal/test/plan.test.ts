import { describe, expect, test } from "bun:test";
import {
  MAX_CHECKLIST,
  MAX_CRITERION_CHARS,
  MAX_CRITERIA,
  firstUnchecked,
  parsePlan,
  parsePlannerPlan,
  planProgress,
  planPathFor,
  readPlan,
  renderPlan,
} from "../src/plan.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plan = {
  criteria: ["the CLI prints the real output", "a test drives the shipped entry point"],
  checklist: [
    { label: "write the parser", done: false },
    { label: "wire the entry point", done: true },
    { label: "add a test", done: false },
  ],
};

describe("plan file", () => {
  test("separate goals in one session keep separate plan files", () => {
    const ctx = { sessionManager: { getSessionDir: () => "/tmp/pi-session" } } as any;
    expect(planPathFor(ctx, "goal-a")).not.toBe(planPathFor(ctx, "goal-b"));
  });
  test("render round-trips through parse with checkbox state intact", () => {
    const parsed = parsePlan(renderPlan("ship the CLI", plan));
    expect(parsed).toEqual(plan);
  });

  test("parse tolerates indentation, asterisk bullets and CRLF", () => {
    const body = [
      "## Acceptance criteria",
      "",
      "  1. first criterion",
      "  2) second criterion",
      "",
      "## Task checklist",
      "",
      "  * [X] done step",
      "  * [ ] open step",
      "",
    ].join("\r\n");
    const parsed = parsePlan(body);
    expect(parsed?.criteria).toEqual(["first criterion", "second criterion"]);
    expect(parsed?.checklist).toEqual([
      { label: "done step", done: true },
      { label: "open step", done: false },
    ]);
  });

  test("parse ignores checkboxes outside the checklist section", () => {
    const body = ["## Non-goals", "", "- [ ] not a plan step", "", "## Task checklist", "", "- [ ] real step"].join("\n");
    expect(parsePlan(body)?.checklist).toEqual([{ label: "real step", done: false }]);
  });

  test("parse returns undefined rather than throwing on unusable input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-goal-plan-"));
    const missing = join(dir, "absent.md");
    const garbage = join(dir, "garbage.md");
    writeFileSync(garbage, "no headings here at all");
    const headingsOnly = join(dir, "headings.md");
    writeFileSync(headingsOnly, "## Acceptance criteria\n\n## Task checklist\n");
    expect(await readPlan(missing)).toBeUndefined();
    expect(parsePlan("not markdown")).toBeUndefined();
    expect(await readPlan(garbage)).toBeUndefined();
    expect(await readPlan(headingsOnly)).toBeUndefined();
  });

  test("readPlan works under Node, where pi loads extensions and `Bun` does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-goal-plan-"));
    const path = join(dir, "goal-plan.md");
    writeFileSync(path, renderPlan("ship the CLI", plan));
    // pi loads extensions under Node (`#!/usr/bin/env node`), where the `Bun`
    // global is absent. `bun test` defines a non-configurable `Bun`, so an
    // in-process test cannot observe its absence — running the real read in a
    // Node child is the only faithful way to pin this. `Bun.file` threw
    // ReferenceError there, and `readPlan`'s own catch turned it into
    // `undefined`, so every caller saw "no plan".
    const moduleUrl = new URL("../src/plan.ts", import.meta.url).href;
    const script = [
      `const m = await import(${JSON.stringify(moduleUrl)});`,
      `const p = await m.readPlan(${JSON.stringify(path)});`,
      "console.log(JSON.stringify({ plan: p, first: m.firstUnchecked(p), progress: m.planProgress(p) }));",
    ].join(" ");
    const stdout = execFileSync(process.env.PI_GOAL_TEST_NODE ?? "node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    expect(JSON.parse(stdout)).toEqual({
      plan,
      first: "write the parser",
      progress: { done: 1, total: 3 },
    });
  });

  test("first unchecked skips done items and is undefined when finished", () => {
    expect(firstUnchecked(plan)).toBe("write the parser");
    expect(firstUnchecked({ criteria: [], checklist: [{ label: "a", done: true }] })).toBeUndefined();
    expect(firstUnchecked(undefined)).toBeUndefined();
  });

  test("plan progress counts done items", () => {
    expect(planProgress(plan)).toEqual({ done: 1, total: 3 });
    expect(planProgress(undefined)).toEqual({ done: 0, total: 0 });
  });
});

describe("planner payload", () => {
  test("accepts a well-formed plan", () => {
    const parsed = parsePlannerPlan(JSON.stringify({ criteria: ["one"], checklist: ["step"] }));
    expect(parsed.criteria).toEqual(["one"]);
    expect(parsed.checklist).toEqual([{ label: "step", done: false }]);
  });

  test("rejects anything that is not the exact shape", () => {
    const bad: unknown[] = [
      "not json",
      "[]",
      JSON.stringify({ criteria: ["one"] }),
      JSON.stringify({ checklist: ["step"] }),
      JSON.stringify({ criteria: [], checklist: ["step"] }),
      JSON.stringify({ criteria: ["one"], checklist: [] }),
      JSON.stringify({ criteria: ["one"], checklist: ["step"], extra: true }),
      JSON.stringify({ criteria: [""], checklist: ["step"] }),
      JSON.stringify({ criteria: ["one"], checklist: ["  "] }),
      JSON.stringify({ criteria: [1], checklist: ["step"] }),
      JSON.stringify({ criteria: ["x".repeat(MAX_CRITERION_CHARS + 1)], checklist: ["step"] }),
      JSON.stringify({ criteria: Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => `c${i}`), checklist: ["step"] }),
      JSON.stringify({ criteria: ["one"], checklist: Array.from({ length: MAX_CHECKLIST + 1 }, (_, i) => `s${i}`) }),
    ];
    for (const raw of bad) expect(() => parsePlannerPlan(raw as string)).toThrow();
  });

  test("trims whitespace but keeps the text", () => {
    const parsed = parsePlannerPlan(JSON.stringify({ criteria: ["  padded  "], checklist: [" step "] }));
    expect(parsed.criteria).toEqual(["padded"]);
    expect(parsed.checklist[0]!.label).toBe("step");
  });
});
