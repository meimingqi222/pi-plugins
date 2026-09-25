import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withDeadline } from "pi-run-core";
import type { RedactService } from "./redact.ts";

/**
 * The goal plan: a short, plugin-owned contract plus a mutable checklist.
 *
 * The plan exists to answer two questions the verifier cannot answer from a
 * transcript alone — *what does done mean* and *what is left*. Everything else
 * a planner could write (verification procedure, non-goals, assumed scope,
 * implementation approach) exists in a larger harness to serve an adversarial
 * verification panel. Without a panel those sections are unread weight, so they
 * are not produced here.
 */

/**
 * Deadline for the one planner call, matching the verifier's.
 *
 * A plan is written once at goal creation, and a planner that hangs must not
 * hold the goal's first run open; the goal still runs without a plan.
 */
export const PLANNER_TIMEOUT_MS = 45_000;
export const MAX_CRITERIA = 8;
export const MAX_CHECKLIST = 12;
export const MAX_CRITERION_CHARS = 500;
export const MAX_STEP_CHARS = 300;
export const MAX_OBJECTIVE_IN_TITLE = 200;

export interface ChecklistItem {
  label: string;
  done: boolean;
}

export interface GoalPlan {
  criteria: string[];
  checklist: ChecklistItem[];
}

const PLANNER_SYSTEM_PROMPT = [
  "You turn one user objective into a short plan for an autonomous coding goal.",
  "You are not the agent that will do the work. Write for a reader that will check the result against your criteria.",
  "",
  'Return ONLY a JSON object: {"criteria": string[], "checklist": string[]}. No prose, no fences.',
  "",
  "**criteria** — the gating set. Every one must hold for the goal to pass.",
  "- State OUTCOMES, not architecture. Never name a file, function, class or signature: freezing the how lets a correct solution be rejected for diverging from it.",
  "- Keep it small: 2-5 items, one checkable outcome each.",
  "- Anchor to the literal objective. Do not invent scope; a reasonable-but-unrequested feature does not belong here.",
  "- Each criterion must be independently checkable from near its own start state. Never one holistic end-to-end gate.",
  "- Preserve the objective's must-have terms verbatim; never swap a named technique, technology or artifact for an easier one.",
  "",
  "**checklist** — 3-8 ordered concrete steps the implementer executes and checks off as it goes.",
  "- Each step small and completable in one sitting; end with a testing or evidence step.",
  "- Steps are guidance for the implementer, never part of the judged contract.",
  "",
  "If the objective is a conversational non-task (a greeting, thanks, small talk) with no deliverable, return one criterion that the request was acknowledged or answered, and a one-step checklist.",
].join("\n");

/** Session-scoped so the plan never lands in the user's workspace. */
export function planPathFor(ctx: ExtensionContext, goalId: string): string {
  // A session can contain several goals, and an old branch can be resumed after
  // a later goal was created. Keep each goal's mutable checklist independent.
  if (!/^[a-zA-Z0-9-]+$/.test(goalId)) throw new Error("Invalid goal id for plan path");
  return join(ctx.sessionManager.getSessionDir(), `goal-plan-${goalId}.md`);
}

/** The plugin renders the file, so its shape is stable regardless of who edits it. */
export function renderPlan(objective: string, plan: GoalPlan): string {
  const lines = [`# Plan: ${objective.slice(0, MAX_OBJECTIVE_IN_TITLE)}`, "", "## Acceptance criteria", ""];
  plan.criteria.forEach((criterion, index) => lines.push(`${index + 1}. ${criterion}`));
  lines.push("", "## Task checklist", "");
  for (const item of plan.checklist) lines.push(`- [${item.done ? "x" : " "}] ${item.label}`);
  lines.push("");
  return lines.join("\n");
}

function sections(body: string): Map<string, string> {
  const found = new Map<string, string>();
  let heading: string | undefined;
  let collected: string[] = [];
  const flush = () => {
    if (heading !== undefined) found.set(heading, collected.join("\n"));
    collected = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!.toLowerCase();
      continue;
    }
    collected.push(line);
  }
  flush();
  return found;
}

function numbered(body: string | undefined): string[] {
  if (!body) return [];
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);
    if (match) items.push(match[1]!);
  }
  return items;
}

function checkboxes(body: string | undefined): ChecklistItem[] {
  if (!body) return [];
  const items: ChecklistItem[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (match) items.push({ label: match[2]!, done: match[1] !== " " });
  }
  return items;
}

/** Parses the plugin's own plan format. `undefined` when neither section yields an item. */
export function parsePlan(body: string): GoalPlan | undefined {
  const found = sections(body);
  const criteria = numbered(found.get("acceptance criteria"));
  const checklist = checkboxes(found.get("task checklist"));
  if (criteria.length === 0 && checklist.length === 0) return undefined;
  return { criteria, checklist };
}

/** `undefined` for a missing, unreadable or structurally empty plan — never throws. */
export async function readPlan(path: string): Promise<GoalPlan | undefined> {
  let body: string;
  try {
    // `node:fs/promises`, not `Bun.file`. pi loads extensions under Node, so a
    // Bun-only global throws ReferenceError here and this catch turns it into
    // `undefined` — indistinguishable from "no plan".
    body = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  return parsePlan(body);
}

/**
 * Whether the plan path can be written without following something else.
 *
 * The plan file is the gating contract, and its path is predictable and inside
 * the session directory. `writeFile` follows a symlink, so anything that can
 * create one there first — a previous run with write access, a tool that ran with
 * the user's permissions — can redirect the contract outside the session while
 * the plugin believes it wrote the plan. `lstat` does not follow, so a symlink,
 * directory, fifo or device is refused instead of written through. Absent is the
 * normal case and is fine.
 *
 * Grok's PlanGuard makes the same check for the same reason, which is also why
 * its strategist's edits are reverted byte for byte.
 */
export async function planPathIsSafe(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    // ENOENT: nothing there, which is where a fresh plan goes.
    return true;
  }
}

/** The first unchecked box, or `undefined` when the checklist is finished or absent. */
export function firstUnchecked(plan: GoalPlan | undefined): string | undefined {
  return plan?.checklist.find((item) => !item.done)?.label;
}

export interface CriteriaChanges {
  /** Baselines the file no longer states — the criteria that were dropped or rewritten away. */
  removed: string[];
  /** Criteria the file states that the baseline never did. */
  added: string[];
}

/**
 * What the plan file's criteria section no longer says.
 *
 * An edit cannot weaken the contract — the verifier judges the plugin-held
 * baseline — but "the criteria section changed" does not tell it *what* was
 * weakened, which is the only part it can weigh. A criterion deleted from the
 * file is exactly that fact, and it used to be reduced to a boolean: the signal
 * was identical whether the implementer added a note or removed the test that
 * would have proved the work.
 *
 * Compared as trimmed, case-folded sets, so a reorder is not a change and a
 * reworded criterion reads as one removal plus one addition. Bounded by the same
 * caps as the plan itself: this is fed to a model call, and an unbounded diff of
 * an implementer-controlled file is a prompt-size hole.
 */
export function compareCriteria(baseline: readonly string[], current: readonly string[]): CriteriaChanges {
  const fold = (value: string): string => value.trim().toLowerCase();
  const before = new Set(baseline.map(fold));
  const after = new Set(current.map(fold));
  const cap = (value: string): string =>
    value.length > MAX_CRITERION_CHARS ? `${value.slice(0, MAX_CRITERION_CHARS)}…` : value;
  return {
    removed: baseline.filter((criterion) => !after.has(fold(criterion))).map(cap).slice(0, MAX_CRITERIA),
    added: current.filter((criterion) => !before.has(fold(criterion))).map(cap).slice(0, MAX_CRITERIA),
  };
}

export function planProgress(plan: GoalPlan | undefined): { done: number; total: number } {
  const checklist = plan?.checklist ?? [];
  return { done: checklist.filter((item) => item.done).length, total: checklist.length };
}

function stringList(value: unknown, max: number, cap: number, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new Error(`Invalid plan: ${field} must hold 1-${max} items`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`Invalid plan: ${field} items must be text`);
    const text = item.trim();
    if (text.length > cap) throw new Error(`Invalid plan: ${field} items are capped at ${cap} characters`);
    return text;
  });
}

/** Strict by construction: a malformed plan is a planner failure, not a bad file. */
export function parsePlannerPlan(raw: string): GoalPlan {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid plan object");
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !["criteria", "checklist"].includes(key))) {
    throw new Error("Invalid plan object");
  }
  const criteria = stringList(obj.criteria, MAX_CRITERIA, MAX_CRITERION_CHARS, "criteria");
  const steps = stringList(obj.checklist, MAX_CHECKLIST, MAX_STEP_CHARS, "checklist");
  return { criteria, checklist: steps.map((label) => ({ label, done: false })) };
}

/**
 * One tool-free side call at goal creation. Deliberately not a subagent: the
 * lite plan is a rewrite of the objective, not an investigation of the repo, so
 * paying for a tool-equipped run here buys nothing.
 */
export async function runPlanner(
  ctx: ExtensionContext, objective: string, controller: AbortController,
  redactor: RedactService | undefined,
) {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("Current model has no configured authentication");
  }
  const payload = redactor ? redactor.redactJson({ objective }) : { objective };
  const result = await withDeadline(
    () =>
      ctx.modelRegistry.complete(model, {
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(payload) }], timestamp: Date.now() }],
        tools: [],
      } as never, { signal: controller.signal } as never),
    controller,
    PLANNER_TIMEOUT_MS,
    "Planning",
  );
  return result;
}
