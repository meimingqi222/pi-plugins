import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installRedactBridge } from "./redact.ts";
import { GOAL_ENTRY, MAX_OBJECTIVE, goalLimits, goalPrompt, nextActionKey, parseObjective, planEnabled, readTokenUsage, restoreGoal, type Goal, type GoalStatus } from "./state.ts";
import { parseVerdict, verifyGoal, type VerifierPlanInput } from "./verifier.ts";
import { firstUnchecked, planPathFor, planProgress, readPlan, renderPlan, runPlanner } from "./plan.ts";

interface Flight {
  epoch: number;
  session: number;
  goalId: string;
  abort: AbortController;
}
interface WorkRun {
  goalId: string;
  session: number;
  index: number;
  seen: Set<string>;
  stopReason?: string;
}

export default function goalPlugin(pi: ExtensionAPI): void {
  let goal: Goal | undefined;
  let epoch = 0;
  let session = 0;
  let activeSince: number | undefined;
  let flight: Flight | undefined;
  let work: WorkRun | undefined;
  let endedRun: WorkRun | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const redactor = installRedactBridge(pi);

  function elapsed(): number {
    return (goal?.elapsedMs ?? 0) + (activeSince === undefined ? 0 : Math.max(0, Date.now() - activeSince));
  }
  function checkpoint(): void {
    if (!goal) return;
    goal.elapsedMs = elapsed();
    if (activeSince !== undefined) activeSince = Date.now();
    pi.appendEntry(GOAL_ENTRY, structuredClone(goal));
  }
  function display(ctx: ExtensionContext): void {
    ctx.ui.setStatus("pi-goal", goal
      ? `Goal ${goal.status} · ${goal.workRuns} runs · ${goal.used}${goal.budget ? `/${goal.budget}` : ""} tokens · ${goal.objective.slice(0, 60)}`
      : undefined);
  }
  function invalidate(): void {
    epoch++;
    if (scheduled !== undefined) clearTimeout(scheduled);
    scheduled = undefined;
    const previous = flight;
    flight = undefined;
    previous?.abort.abort(new Error("Goal operation superseded"));
  }
  function finish(ctx: ExtensionContext, status: Exclude<GoalStatus, "active" | "verifying">, reason: string): void {
    if (!goal) return;
    goal.elapsedMs = elapsed();
    activeSince = undefined;
    goal.status = status;
    goal.reason = reason;
    invalidate();
    checkpoint();
    display(ctx);
    ctx.ui.notify(`Goal ${status}: ${reason}`, status === "complete" ? "info" : "warning");
  }
  function budgetReached(ctx: ExtensionContext): boolean {
    if (!goal?.budget || goal.used < goal.budget) return false;
    finish(ctx, "budget_limited", "Token budget exhausted; set a new goal to authorize more work.");
    return true;
  }
  function schedule(ctx: ExtensionContext): void {
    if (!goal || goal.status !== "active" || scheduled !== undefined || flight || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (budgetReached(ctx)) return;
    const token = epoch;
    const generation = session;
    const goalId = goal.id;
    const sessionId = ctx.sessionManager.getSessionId();
    // Let pi finish the preceding run cleanup before starting another prompt.
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (!goal || goal.id !== goalId || goal.status !== "active" || token !== epoch ||
        generation !== session || ctx.sessionManager.getSessionId() !== sessionId ||
        !ctx.isIdle() || ctx.hasPendingMessages()) return;
      try {
        pi.sendMessage({ customType: "goal-continuation", content: goalPrompt(goal), display: false },
          { triggerTurn: true, deliverAs: "followUp" });
      } catch (error) {
        finish(ctx, "paused", `Continuation could not start: ${String(error)}`);
      }
    }, 0);
  }
  function current(call: Flight): boolean {
    return flight === call && call.epoch === epoch && call.session === session && goal?.id === call.goalId;
  }
  /**
   * Writes the plan once, at goal creation. Best-effort by design: a goal with
   * no plan still runs, it just falls back to the verifier's own next action
   * instead of a mined checklist step.
   */
  async function startPlan(ctx: ExtensionContext): Promise<void> {
    if (!goal || goal.status !== "active" || !planEnabled()) return;
    const goalId = goal.id;
    const controller = new AbortController();
    ctx.ui.setWorkingMessage("pi-goal: planning the goal…");
    try {
      const plan = await runPlanner(ctx, goal.objective, controller, redactor());
      // A replace or clear during the planner call must not inherit this plan.
      if (!goal || goal.id !== goalId || goal.status !== "active") return;
      const path = planPathFor(ctx);
      await writeFile(path, renderPlan(goal.objective, plan), { encoding: "utf-8", mode: 0o600 });
      goal.planPath = path;
      goal.planCriteria = plan.criteria;
      goal.planStep = firstUnchecked(plan);
      checkpoint();
      display(ctx);
      ctx.ui.notify(`Goal plan written: ${path}`, "info");
    } catch (error) {
      ctx.ui.notify(`Goal plan unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally {
      ctx.ui.setWorkingMessage();
    }
  }
  /**
   * Re-reads the plan file and returns the facts the verifier judges against.
   *
   * The criteria come from the plugin-held baseline, never from the file, so an
   * implementer that edits its own acceptance criteria cannot narrow the
   * contract. Only the checklist is read as mutable — that is its purpose.
   */
  async function refreshPlan(): Promise<VerifierPlanInput | undefined> {
    if (!goal?.planPath) return undefined;
    const parsed = await readPlan(goal.planPath);
    goal.planStep = firstUnchecked(parsed);
    const progress = planProgress(parsed);
    const criteriaEdited = !!goal.planCriteria && !!parsed &&
      JSON.stringify(parsed.criteria) !== JSON.stringify(goal.planCriteria);
    return { criteria: goal.planCriteria ?? [], step: goal.planStep, ...progress, criteriaEdited };
  }
  async function verify(ctx: ExtensionContext): Promise<void> {
    if (!goal || flight || goal.status !== "active" || budgetReached(ctx)) return;
    const planInput = await refreshPlan();
    if (!goal || flight || goal.status !== "active" || budgetReached(ctx)) return;
    checkpoint();
    goal.status = "verifying";
    const call: Flight = { epoch, session, goalId: goal.id, abort: new AbortController() };
    flight = call;
    checkpoint();
    display(ctx);
    try {
      const result = await verifyGoal(ctx, structuredClone(goal), call.abort, redactor(), planInput);
      if (!current(call) || !goal) return;
      goal.used += readTokenUsage(result);
      checkpoint();
      if (budgetReached(ctx)) return;
      if (result.stopReason !== "stop" || result.content.some((part) => part.type === "toolCall")) {
        throw new Error(`Verifier ended with ${result.stopReason}, not a clean verdict`);
      }
      const raw = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const verdict = parseVerdict(raw);
      goal.verdict = { reason: verdict.reason, evidence: verdict.evidence };
      if (verdict.passed) {
        finish(ctx, "complete", verdict.reason);
        return;
      }
      // `parseVerdict` already rejects a failure without `nextAction`; this is
      // the second half of that rule at the point of use, so a future caller
      // cannot turn an internal verdict into an unbounded continuation.
      const nextAction = verdict.nextAction?.trim();
      if (!nextAction) {
        finish(ctx, "paused", "Verification failed without an actionable next step.");
        return;
      }
      goal.status = "active";
      goal.candidate = nextAction;
      // Fingerprint the whole guidance the continuation depends on: the
      // checklist's first unchecked box when there is one, plus the verifier's
      // own action. Either one moving is progress — an implementer working
      // through the plan is not stalled by a verifier that words its nudge the
      // same way twice, and a verifier naming genuinely new work is not stalled
      // by a checklist that has not caught up yet.
      const key = nextActionKey(`${goal.planStep ?? ""} | ${nextAction}`);
      goal.stalledRuns = key === goal.nextActionKey ? (goal.stalledRuns ?? 0) + 1 : 1;
      goal.nextActionKey = key;
      // A verifier that names the same next action every round is not making
      // progress, it is re-litigating. Pausing here beats burning the run cap on
      // nudges that cannot change the outcome.
      const { stallRuns } = goalLimits();
      if (goal.stalledRuns >= stallRuns) {
        finish(ctx, "no_progress", `Verification named the same next action ${goal.stalledRuns} times: ${nextAction}`);
        return;
      }
      checkpoint();
      display(ctx);
    } catch (error) {
      if (current(call)) finish(ctx, "paused", `Verification failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (flight === call) flight = undefined;
    }
    if (goal?.status === "active" && call.epoch === epoch && call.session === session) schedule(ctx);
  }
  function restore(ctx: ExtensionContext): void {
    invalidate();
    session++;
    work = undefined;
    endedRun = undefined;
    activeSince = undefined;
    goal = restoreGoal(ctx);
    if (goal?.status === "active" || goal?.status === "verifying") {
      finish(ctx, "paused", "Recovered goal; use /goal resume to continue.");
    } else display(ctx);
  }
  function leave(ctx: ExtensionContext): void {
    if (goal?.status === "active" || goal?.status === "verifying") finish(ctx, "paused", "Session left.");
    else invalidate();
    session++;
    work = undefined;
    endedRun = undefined;
  }
  function account(message: unknown, owner: WorkRun | undefined): void {
    if (!goal || !owner || owner.goalId !== goal.id || owner.session !== session ||
      !message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return;
    // `message_end` and `agent_end` deliver the same assistant message twice, so
    // identity is what separates a replay from a second message. The provider's
    // own response id is the canonical answer; a message without one falls back
    // to its serialized bytes, which still distinguishes messages that differ in
    // any field including the timestamp.
    const identity = message as { responseId?: unknown };
    const key = typeof identity.responseId === "string" && identity.responseId
      ? identity.responseId
      : createHash("sha256").update(JSON.stringify(message)).digest("hex");
    if (owner.seen.has(key)) return;
    owner.seen.add(key);
    goal.used += readTokenUsage(message);
    // Deliberately no checkpoint here. One snapshot per assistant message grew
    // the session file without bound on a long goal, and the budget is only
    // enforced at a settled-run boundary; `agent_start`/`agent_end` persist.
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_before_switch", (_event, ctx) => leave(ctx));
  pi.on("session_before_tree", (_event, ctx) => leave(ctx));
  pi.on("session_before_fork", (_event, ctx) => leave(ctx));
  pi.on("session_shutdown", (_event, ctx) => leave(ctx));
  pi.on("input", (_event, ctx) => {
    if (goal?.status === "verifying") finish(ctx, "paused", "User input interrupted verification; use /goal resume when ready.");
    else invalidate();
  });
  pi.on("context", (event) => {
    // Runs for automatic continuations, ordinary user prompts and after compaction.
    const messages = event.messages.filter((message) =>
      message.role !== "custom" || !["goal-context", "goal-continuation"].includes(message.customType),
    );
    if (goal) messages.push({ role: "custom", customType: "goal-context", content: goalPrompt(goal), display: false, timestamp: Date.now() });
    return { messages };
  });
  pi.on("agent_start", async () => {
    if (scheduled !== undefined) clearTimeout(scheduled);
    scheduled = undefined;
    endedRun = undefined;
    work = undefined;
    if (goal?.status !== "active") return;
    activeSince ??= Date.now();
    goal.workRuns++;
    goal.attemptRuns = (goal.attemptRuns ?? 0) + 1;
    work = { goalId: goal.id, session, index: goal.workRuns, seen: new Set() };
    // Refresh before the checkpoint so the run starts from the checklist's
    // current first unchecked item and that step is persisted with it.
    await refreshPlan();
    checkpoint();
  });
  pi.on("message_end", (event) => account(event.message, work));
  pi.on("agent_end", (event, ctx) => {
    const owner = work;
    if (!owner || !goal || owner.goalId !== goal.id || owner.session !== session) return;
    for (const message of event.messages) account(message, owner);
    const final = [...event.messages].reverse().find((message) => message.role === "assistant");
    owner.stopReason = final?.stopReason;
    endedRun = owner;
    work = undefined;
    if (goal.lastBlockerRun !== owner.index) {
      goal.blockerRuns = 0;
      goal.blocker = undefined;
    }
    if (goal.status === "active" && final?.stopReason === "aborted") {
      finish(ctx, "paused", "Agent cancelled.");
      return;
    }
    // Persist the run's usage even when the goal already left `active` during
    // the run (a blocker report or a budget stop), so the total is not lost.
    // pi may retry provider errors before settling, so those are handled at
    // agent_settled rather than here.
    checkpoint();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const owner = endedRun;
    endedRun = undefined;
    if (!owner || !goal || owner.goalId !== goal.id || owner.session !== session ||
      goal.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages() || flight) return;
    if (owner.stopReason === "error" || owner.stopReason === "aborted") {
      finish(ctx, "paused", `Agent ${owner.stopReason}.`);
      return;
    }
    // Checked before verification so the cap never pays for a verifier round
    // whose verdict would be discarded. `/goal resume` is what authorizes more.
    const { maxRuns } = goalLimits();
    if ((goal.attemptRuns ?? 0) >= maxRuns) {
      finish(ctx, "paused", `Work run cap of ${maxRuns} reached; /goal resume authorizes more.`);
      return;
    }
    await verify(ctx);
  });

  pi.registerCommand("goal", {
    description: "Manage a goal: /goal <objective> [--tokens N], status, pause, resume, clear, replace <objective>",
    handler: async (args, ctx) => {
      const input = args.trim();
      const verb = input.split(/\s+/, 1)[0];
      if (!input || verb === "status") {
        ctx.ui.notify(goal
          ? `${goal.status}: ${goal.objective}\n${goal.used}${goal.budget ? `/${goal.budget}` : ""} tokens · ${Math.round(elapsed() / 1000)}s${goal.planPath ? `\nplan: ${goal.planPath}` : ""}${goal.planStep ? `\nnext: ${goal.planStep}` : ""}${goal.reason ? `\n${goal.reason}` : ""}`
          : "No goal set.", "info");
        return;
      }
      if (verb === "pause") {
        if (!goal || !["active", "verifying"].includes(goal.status)) return;
        const abortWork = !!work;
        finish(ctx, "paused", "Requested by user.");
        if (abortWork) ctx.abort();
        return;
      }
      if (verb === "clear") {
        const abortWork = !!work;
        invalidate();
        goal = undefined;
        activeSince = undefined;
        work = undefined;
        endedRun = undefined;
        pi.appendEntry(GOAL_ENTRY, { schema: 1, cleared: true });
        display(ctx);
        if (abortWork) ctx.abort();
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for current work to finish or use /goal pause before starting/resuming/replacing a goal.", "warning");
        return;
      }
      if (verb === "resume") {
        if (!goal || !["paused", "blocked", "no_progress"].includes(goal.status)) {
          ctx.ui.notify("Only paused, blocked or stalled goals can resume.", "warning");
          return;
        }
        invalidate();
        goal.status = "active";
        goal.reason = undefined;
        goal.blocker = undefined;
        goal.blockerRuns = 0;
        goal.lastBlockerRun = undefined;
        // A resume is the user authorizing another attempt, so the per-attempt
        // counters restart while the lifetime totals stay.
        goal.attemptRuns = 0;
        goal.stalledRuns = 0;
        goal.nextActionKey = undefined;
        activeSince = Date.now();
        checkpoint();
        display(ctx);
        schedule(ctx);
        return;
      }
      if (goal && verb !== "replace") {
        ctx.ui.notify("A goal already exists; use /goal replace <objective> or /goal clear.", "warning");
        return;
      }
      let parsed: ReturnType<typeof parseObjective>;
      try { parsed = parseObjective(verb === "replace" ? input.slice(verb.length).trim() : input); }
      catch (error) { ctx.ui.notify(String(error), "warning"); return; }
      invalidate();
      work = undefined;
      endedRun = undefined;
      goal = { schema: 1, id: crypto.randomUUID(), ...parsed, status: "active", used: 0, elapsedMs: 0, workRuns: 0, attemptRuns: 0, blockerRuns: 0, stalledRuns: 0 };
      activeSince = Date.now();
      checkpoint();
      display(ctx);
      // The plan is written before the first work run so run 1 already has a
      // contract and a next step; a planner failure only costs the plan.
      await startPlan(ctx);
      schedule(ctx);
    },
  });
  pi.registerTool({
    name: "get_goal", label: "Get goal", description: "Read the current user-managed goal and verified status.", parameters: Type.Object({}),
    async execute() {
      const details = goal ? { ...structuredClone(goal), elapsedMs: elapsed() } : { state: "none" };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "update_goal", label: "Update goal",
    description: "Report progress, candidate completion or a blocker. Cannot complete, start or resume goals. Report the same stable blockerKey across genuinely blocked work runs.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("progress"), Type.Literal("candidate_complete"), Type.Literal("blocked")]),
      message: Type.String({ minLength: 1, maxLength: MAX_OBJECTIVE }),
      blockerKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!goal || goal.status !== "active" || !work || work.goalId !== goal.id) {
        return { content: [{ type: "text", text: "No active goal work run." }], details: { state: "none" } };
      }
      goal.progress = params.message;
      if (params.kind === "candidate_complete") goal.candidate = params.message;
      if (params.kind === "blocked") {
        const key = params.blockerKey?.trim() || params.message.trim();
        if (goal.lastBlockerRun !== work.index) {
          goal.blockerRuns = goal.blocker === key && goal.lastBlockerRun === work.index - 1 ? goal.blockerRuns + 1 : 1;
          goal.lastBlockerRun = work.index;
          goal.blocker = key;
          goal.blockerReason = params.message;
        }
        if (goal.blockerRuns >= 3) finish(ctx, "blocked", params.message);
      }
      checkpoint();
      display(ctx);
      return { content: [{ type: "text", text: `Goal ${goal.status}; report recorded.` }], details: structuredClone(goal) };
    },
  });
}
