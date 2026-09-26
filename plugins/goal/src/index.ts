import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ActiveTimer,
  appendRunSnapshot,
  ContinuationChannel,
  GOAL_SPEND_REQUEST,
  GOAL_SPEND_SERVICE,
  readTokenUsage,
  RunGuard,
  type GoalSpendService,
  type RunToken,
} from "pi-run-core";
import { installRedactBridge } from "./redact.ts";
import { GOAL_ENTRY, MAX_OBJECTIVE, goalDisabled, goalLimits, goalPrompt, isResumable, isRetired, nextActionKey, parseObjective, planEnabled, resolveVerifierModel, restoreGoal, type Goal, type GoalStatus } from "./state.ts";
import { parseVerdict, verifyGoal, type VerifierPlanInput } from "./verifier.ts";
import { compareCriteria, firstUnchecked, parsePlannerPlan, planPathFor, planPathIsSafe, planProgress, readPlan, renderPlan, runPlanner } from "./plan.ts";

interface Flight {
  token: RunToken;
  goalId: string;
  candidateGeneration: number;
  runEpoch: number;
  abort: AbortController;
}
interface WorkRun {
  goalId: string;
  session: number;
  index: number;
  seen: Set<string>;
  /** The message objects already counted, so a replay cannot be billed twice. */
  objects: WeakSet<object>;
  /**
   * True when this attempt was started by the plugin's own continuation, not by
   * a user turn that merely happened to run while a goal was active.
   * Interruption is scoped to goal-driven turns, so a user turn is never killed
   * by `/goal pause` or `/goal clear`.
   */
  continuationDriven: boolean;
  /** The starting plan hint is shown once, before the run can edit the file. */
  contextSeen: boolean;
  /** Turns attempted after a completion claim, including plugin continuations. */
  postCandidateTurns: number;
  /** Goal blocked a tool call after the candidate and requested batch termination. */
  candidateToolBlocked: boolean;
  stopReason?: string;
}

export default function goalPlugin(pi: ExtensionAPI): void {
  // A child process spawned for one delegated job has no user and no goal of its
  // own; registering here would inject the parent's objective into a context
  // that cannot act on it. The spawner sets the flag — see `goalDisabled`.
  if (goalDisabled()) return;
  let goal: Goal | undefined;
  let flight: Flight | undefined;
  let planFlight: { goalId: string; abort: AbortController } | undefined;
  let work: WorkRun | undefined;
  let endedRun: WorkRun | undefined;
  let deferredRun: WorkRun | undefined;
  const pendingDelegations = new Set<string>();
  const settledDelegations = new Set<string>();
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  // Persistence failures are surfaced once per streak rather than per boundary:
  // checkpointing runs at every run boundary, and a full disk would otherwise
  // turn one problem into a notification per turn.
  let persistFailure: string | undefined;
  let persistReported = false;
  // A fallback is a standing configuration state, not a per-round event, so it
  // is announced once per goal rather than on every verification round. Keyed
  // by goal id, so a replace re-announces and a resume does not.
  let verifierFallbackNotified: string | undefined;
  // Epoch x session staleness guard and the continuation channel are shared with
  // any other run-oriented extension; both encode bugs already paid for once.
  const guard = new RunGuard();
  const continuation = new ContinuationChannel(pi);
  // Wall-clock accounting that survives pause and resume without dropping the
  // sub-second remainder at each boundary.
  const timer = new ActiveTimer();
  const redactor = installRedactBridge(pi);

  function elapsed(): number {
    return timer.elapsedMs();
  }
  function checkpoint(): void {
    if (!goal) return;
    goal.elapsedMs = timer.capture();
    try {
      appendRunSnapshot(pi, GOAL_ENTRY, goal);
      persistFailure = undefined;
      persistReported = false;
    } catch (error) {
      // A snapshot that cannot be written must not take the lifecycle handler
      // down with it. The in-memory goal is still the truth for this session,
      // the next boundary retries the write, and the user is told — silently
      // continuing would mean a goal that looks persisted and is not.
      persistFailure = `Could not persist the goal snapshot (${error instanceof Error ? error.message : String(error)}).`;
    }
  }
  function display(ctx: ExtensionContext): void {
    // A retired goal leaves the status bar. The objective text it carries only
    // invites the model to keep talking about a goal that is already finished.
    ctx.ui.setStatus("pi-goal", goal && !isRetired(goal)
      ? `Goal ${goal.status} · ${goal.workRuns} runs · ${goal.used}${goal.budget ? `/${goal.budget}` : ""} tokens · ${goal.objective.slice(0, 60)}`
      : undefined);
    if (persistFailure && !persistReported) {
      persistReported = true;
      ctx.ui.notify(`pi-goal: ${persistFailure}`, "warning");
    }
  }
  function invalidate(): void {
    guard.invalidate();
    // A paused, replaced or interrupted turn must not be verified when an old
    // background delegation eventually settles. Its cost is still attributed
    // to the same goal by the lease.
    deferredRun = undefined;
    if (scheduled !== undefined) clearTimeout(scheduled);
    scheduled = undefined;
    // The planner is a model call like the verifier and needs the same
    // cancellation. Without it, `/goal replace` or `/goal clear` during planning
    // left the call running to completion, and its tokens were then billed to a
    // goal that no longer existed — the cost was paid and recorded nowhere.
    planFlight?.abort.abort(new Error("Goal operation superseded"));
    planFlight = undefined;
    const previous = flight;
    flight = undefined;
    previous?.abort.abort(new Error("Goal operation superseded"));
  }
  function finish(ctx: ExtensionContext, status: Exclude<GoalStatus, "active" | "verifying">, reason: string): void {
    if (!goal) return;
    if (goal.candidateState?.phase === "verifying") goal.candidateState.phase = "interrupted";
    goal.elapsedMs = timer.capture();
    timer.stop();
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
  const spendService: GoalSpendService = {
    begin(ctx, callId) {
      if (goal?.status === "budget_limited" && work?.goalId === goal.id) {
        throw new Error("Goal token budget exhausted; no new delegation may start.");
      }
      if (!goal || goal.status !== "active" || !work || work.goalId !== goal.id ||
        work.session !== guard.sessionId) return undefined;
      if (budgetReached(ctx)) throw new Error("Goal token budget exhausted; no new delegation may start.");
      const goalId = goal.id;
      const session = guard.sessionId;
      const sessionIdAtLaunch = ctx.sessionManager.getSessionId();
      const key = `${goalId}:${callId}`;
      if (pendingDelegations.has(key) || settledDelegations.has(key)) throw new Error(`Duplicate delegated call ${callId}`);
      pendingDelegations.add(key);
      const continuationDriven = work.continuationDriven;
      let done = false;
      return {
        finish(tokens) {
          if (done) return;
          done = true;
          pendingDelegations.delete(key);
          settledDelegations.add(key);
          if (!goal || goal.id !== goalId || guard.sessionId !== session ||
            ctx.sessionManager.getSessionId() !== sessionIdAtLaunch) return;
          goal.used += Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
          if (goal.status === "active" && budgetReached(ctx) && continuationDriven) {
            try { ctx.abort(); } catch { /* The goal is already budget limited. */ }
          }
          checkpoint();
          display(ctx);
          if (![...pendingDelegations].some((pending) => pending.startsWith(`${goalId}:`)) && deferredRun) {
            const owner = deferredRun;
            deferredRun = undefined;
            queueMicrotask(() => { void settleGoalRun(owner, ctx); });
          }
        },
      };
    },
  };
  pi.events?.on(GOAL_SPEND_REQUEST, () => pi.events?.emit(GOAL_SPEND_SERVICE, spendService));
  pi.events?.emit(GOAL_SPEND_SERVICE, spendService);
  function schedule(ctx: ExtensionContext): void {
    if (!goal || goal.status !== "active" || scheduled !== undefined || flight || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (budgetReached(ctx)) return;
    const token = guard.issue();
    const goalId = goal.id;
    const sessionId = ctx.sessionManager.getSessionId();
    // Let pi finish the preceding run cleanup before starting another prompt.
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (!goal || goal.id !== goalId || goal.status !== "active" || !guard.isCurrent(token) ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        !ctx.isIdle() || ctx.hasPendingMessages()) return;
      // The context handler supplies the fresh goal state after agent_start
      // refreshes the plan. Duplicating it here stores stale plan text in the
      // transcript and wastes context on every continuation.
      if (!continuation.deliver("queued", { customType: "goal-continuation" }, "Continue the active goal.")) {
        finish(ctx, "paused", "Continuation could not start.");
      }
    }, 0);
  }
  function current(call: Flight): boolean {
    return flight === call && guard.isCurrent(call.token) && goal?.id === call.goalId &&
      goal.workRuns === call.runEpoch && goal.candidateState?.generation === call.candidateGeneration &&
      goal.candidateState.phase === "verifying";
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
    planFlight = { goalId, abort: controller };
    ctx.ui.setWorkingMessage("pi-goal: planning the goal…");
    try {
      const result = await runPlanner(ctx, goal.objective, controller, redactor());
      // A replace or clear during the planner call must not inherit this plan.
      if (!goal || goal.id !== goalId || goal.status !== "active") return;
      // Bill the response before validating it: a malformed or interrupted
      // planner reply still consumed tokens, just like a rejected verifier reply.
      goal.used += readTokenUsage(result);
      checkpoint();
      // The planner's own cost can exhaust a small budget; check before
      // writing a plan for a goal that is already over.
      if (budgetReached(ctx)) return;
      if (result.stopReason !== "stop" || result.content.some((part) => part.type === "toolCall")) {
        throw new Error(`Planner ended with ${result.stopReason}, not a plan`);
      }
      const raw = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const plan = parsePlannerPlan(raw);
      const path = planPathFor(ctx, goalId);
      // `writeFile` follows a symlink. The plan is the gating contract and its
      // path is predictable, so a symlink planted there would redirect the
      // contract outside the session while the plugin believed it wrote the plan.
      if (!(await planPathIsSafe(path))) {
        ctx.ui.notify(`pi-goal: refusing to write the plan — ${path} exists and is not a regular file.`, "warning");
        return;
      }
      await writeFile(path, renderPlan(goal.objective, plan), { encoding: "utf-8", mode: 0o600 });
      // Writing is an await too: a clear landing in it leaves no goal to attach
      // the plan to. The file stays because local session state cannot prove
      // that no branch or fork references it.
      if (!goal || goal.id !== goalId) return;
      goal.planPath = path;
      goal.planCriteria = plan.criteria;
      goal.planStep = firstUnchecked(plan);
      checkpoint();
      display(ctx);
      ctx.ui.notify(`Goal plan written: ${path}`, "info");
    } catch (error) {
      ctx.ui.notify(`Goal plan unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally {
      if (planFlight?.goalId === goalId) planFlight = undefined;
      ctx.ui.setWorkingMessage();
    }
  }
  /**
   * Re-reads the plan file and returns the facts the verifier judges against.
   *
   * The criteria come from the plugin-held baseline, never from the file, so an
   * implementer that edits its own acceptance criteria cannot narrow the
   * contract. Only the checklist is read as mutable — that is its purpose.
   *
   * The goal id is a parameter rather than read from the closure at each use
   * because the file read is an await: `/goal clear` sets the module-level goal
   * to undefined, and assigning `goal.planStep` after that threw a TypeError out
   * of whichever lifecycle handler called this; a `/goal replace` in the same
   * window attributed the old plan to the new goal. Both are now a `return`.
   */
  async function refreshPlan(goalId: string): Promise<VerifierPlanInput | undefined> {
    const atEntry = goal;
    if (!atEntry || atEntry.id !== goalId || !atEntry.planPath) return undefined;
    const path = atEntry.planPath;
    const parsed = await readPlan(path);
    if (!goal || goal.id !== goalId) return undefined;
    goal.planStep = firstUnchecked(parsed);
    const progress = planProgress(parsed);
    // A deleted or emptied file is "no plan" rather than "every criterion was
    // removed": the file is the implementer's working copy, and treating its
    // absence as a mass deletion would make the verdict about the file rather
    // than about the work.
    const criteriaEdited = !!goal.planCriteria && !!parsed &&
      JSON.stringify(parsed.criteria) !== JSON.stringify(goal.planCriteria);
    const criteriaChanges = goal.planCriteria && parsed
      ? compareCriteria(goal.planCriteria, parsed.criteria)
      : undefined;
    return {
      criteria: goal.planCriteria ?? [],
      step: goal.planStep,
      ...progress,
      criteriaEdited,
      ...(criteriaChanges ? { criteriaChanges } : {}),
    };
  }
  async function verify(ctx: ExtensionContext): Promise<void> {
    if (!goal || flight || goal.status !== "active" || goal.candidateState?.phase !== "ready" || budgetReached(ctx)) return;
    // Captured before the first await: `/goal replace` can land in the plan read
    // and leave a different goal in the closure, and the round must be abandoned
    // rather than judged against it.
    const goalId = goal.id;
    const candidateGeneration = goal.candidateState.generation;
    const runEpoch = goal.workRuns;
    const planInput = await refreshPlan(goalId);
    if (!goal || goal.id !== goalId || flight || goal.status !== "active" ||
      goal.candidateState?.generation !== candidateGeneration || goal.candidateState.phase !== "ready" ||
      goal.workRuns !== runEpoch || !ctx.isIdle() || ctx.hasPendingMessages() || budgetReached(ctx)) return;
    // Recorded on the snapshot so a verdict stays explainable after the fact:
    // the same transcript can be judged differently by a different model.
    const resolved = resolveVerifierModel(ctx);
    if (!resolved.model) {
      finish(ctx, "paused", "No model is available to verify this goal.");
      return;
    }
    goal.verifierModel = `${resolved.model.provider}/${resolved.model.id}`;
    const notice = `${goal.id}:${resolved.reason}`;
    if (resolved.reason && verifierFallbackNotified !== notice) {
      verifierFallbackNotified = notice;
      ctx.ui.notify(`pi-goal: ${resolved.reason}`, "warning");
    }
    checkpoint();
    goal.status = "verifying";
    goal.candidateState.phase = "verifying";
    const call: Flight = { token: guard.issue(), goalId: goal.id, candidateGeneration, runEpoch, abort: new AbortController() };
    flight = call;
    checkpoint();
    display(ctx);
    try {
      const result = await verifyGoal(ctx, structuredClone(goal), call.abort, redactor(), planInput, resolved.model);
      if (!current(call) || !goal) return;
      goal.used += readTokenUsage(result);
      checkpoint();
      if (budgetReached(ctx)) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        // The queue can change while the isolated verifier awaits its model.
        // Keep the same claim for the later settled transcript; its generation
        // remains unchanged and this verdict is intentionally discarded.
        goal.status = "active";
        goal.candidateState!.phase = "ready";
        checkpoint();
        display(ctx);
        return;
      }
      if (result.stopReason !== "stop" || result.content.some((part) => part.type === "toolCall")) {
        throw new Error(`Verifier ended with ${result.stopReason}, not a clean verdict`);
      }
      const raw = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const verdict = parseVerdict(raw);
      goal.verdict = { reason: verdict.reason, evidence: verdict.evidence };
      // Only the captured generation can be judged. `current` rejects a late
      // verdict after another plugin starts work or a new claim is reported.
      goal.candidateState = undefined;
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
    if (goal?.status === "active" && guard.isCurrent(call.token)) schedule(ctx);
  }
  function restore(ctx: ExtensionContext): void {
    invalidate();
    continuation.reset();
    guard.nextSession();
    work = undefined;
    endedRun = undefined;
    timer.stop();
    goal = restoreGoal(ctx);
    // The snapshot is the authority for elapsed time; without seeding it, a
    // reload would restart the counter and under-report a long goal.
    timer.restart(goal?.elapsedMs ?? 0);
    timer.stop();
    if (goal?.status === "active" || goal?.status === "verifying") {
      finish(ctx, "paused", "Recovered goal; use /goal resume to continue.");
    } else display(ctx);
  }
  function leave(ctx: ExtensionContext): void {
    if (goal?.status === "active" || goal?.status === "verifying") finish(ctx, "paused", "Session left.");
    else invalidate();
    continuation.reset();
    guard.nextSession();
    work = undefined;
    endedRun = undefined;
  }
  function account(message: unknown, owner: WorkRun | undefined, ctx: ExtensionContext): void {
    if (!goal || !owner || owner.goalId !== goal.id || owner.session !== guard.sessionId ||
      !message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return;
    // `message_end` and `agent_end` deliver the same assistant message twice, so
    // identity is what separates a replay from a second message. Three answers in
    // order of strength: the same object (WeakSet — the harness hands the stored
    // message to both events), the provider's response id, and finally the
    // serialized bytes for a copy that carries neither.
    if (typeof message === "object" && message !== null) {
      if (owner.objects.has(message)) return;
      owner.objects.add(message);
    }
    const identity = message as { responseId?: unknown };
    const key = typeof identity.responseId === "string" && identity.responseId
      ? identity.responseId
      : createHash("sha256").update(JSON.stringify(message)).digest("hex");
    if (owner.seen.has(key)) return;
    owner.seen.add(key);
    goal.used += readTokenUsage(message);
    // The budget used to be enforced only at a settled-run boundary, so a long
    // tool loop could overshoot it by an unbounded amount and the overshoot was
    // invisible until the run ended. Accounting is the moment the spend becomes
    // known, so it is the moment to act: the goal flips here, and a run the
    // plugin started is stopped instead of paying for the rest of the loop. A
    // user turn is left alone — it is the user's output, and the goal merely
    // stops being active.
    if (budgetReached(ctx) && owner.continuationDriven) {
      try {
        ctx.abort();
      } catch {
        // The run then just finishes; the goal is already budget_limited.
      }
    }
    // Deliberately no checkpoint here. One snapshot per assistant message grew
    // the session file without bound on a long goal; `agent_start`/`agent_end`
    // persist, and a budget stop persists through `finish`.
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
    // A retired goal is not injected at all. Only active/paused/blocked states
    // carry a decision the model must respect, so the injection condition has to
    // match the statuses whose prompt still says something beyond "this is done".
    if (goal && !isRetired(goal)) {
      // The current work run, when there is one, is what decides whether a
      // pending candidate is unjudged or merely awaiting its settle.
      messages.push({ role: "custom", customType: "goal-context", content: goalPrompt(goal, work?.index, !work?.contextSeen), display: false, timestamp: Date.now() });
      if (work) work.contextSeen = true;
    }
    return { messages };
  });
  pi.on("agent_start", async (_event, ctx) => {
    // Consumed per attempt, so a user follow-up inside a continuation-started
    // run is not itself mistaken for goal-driven work.
    const continuationDriven = continuation.consume();
    if (scheduled !== undefined) clearTimeout(scheduled);
    scheduled = undefined;
    endedRun = undefined;
    deferredRun = undefined;
    work = undefined;
    if (goal?.status === "verifying") {
      // Another extension can start a follow-up while the isolated verifier is
      // reading an older transcript. Keep the candidate, discard that verdict,
      // and judge again after this new turn has settled.
      invalidate();
      goal.status = "active";
      if (goal.candidateState?.phase === "verifying") goal.candidateState.phase = "ready";
      checkpoint();
      display(ctx);
    }
    if (goal?.status !== "active") {
      // The goal was paused or cleared after the continuation was queued. Pi
      // cannot unsend it, so the turn it starts is stopped instead: it would
      // otherwise pay for model work toward a goal the user already stopped.
      if (continuationDriven) {
        const status = goal?.status;
        try { ctx.abort(); } catch { /* the turn then just runs out */ }
        // Derived from the same classification `/goal resume` uses. The pair it
        // replaced (`paused || blocked`) happened to be equivalent here — the only
        // statuses reachable at this point are `paused` and "no goal", since every
        // other ending skips the continuation that would have queued this turn —
        // and that is exactly what made the second hand-written list a silent
        // hazard: it was right, and nothing kept it right.
        const resumable = goal !== undefined && isResumable(goal);
        ctx.ui.notify(
          `Stopped a queued goal turn (${status ? `goal is ${status}` : "no goal is set"}).${resumable ? " Run /goal resume to continue it." : ""}`,
          "info",
        );
      }
      return;
    }
    const { maxRuns } = goalLimits();
    if ((goal.attemptRuns ?? 0) >= maxRuns) {
      finish(ctx, "paused", `Work run cap of ${maxRuns} reached; /goal resume authorizes more.`);
      // An extension may start a user-owned turn at this boundary. Stop only
      // the continuation issued by this goal; never abort the user's turn.
      if (continuationDriven) {
        try { ctx.abort(); } catch { /* The goal is already paused. */ }
      }
      return;
    }
    timer.start();
    goal.workRuns++;
    goal.attemptRuns = (goal.attemptRuns ?? 0) + 1;
    work = { goalId: goal.id, session: guard.sessionId, index: goal.workRuns, seen: new Set(), objects: new WeakSet(), continuationDriven, contextSeen: false, postCandidateTurns: 0, candidateToolBlocked: false };
    // Refresh before the checkpoint so the run starts from the checklist's
    // current first unchecked item and that step is persisted with it.
    await refreshPlan(goal.id);
    checkpoint();
  });
  pi.on("message_end", (event, ctx) => account(event.message, work, ctx));
  function candidateAwaitsSettlement(): boolean {
    if (!goal || goal.status !== "active" || !work || work.goalId !== goal.id) return false;
    const state = goal.candidateState;
    return state?.phase === "ready" || (state?.phase === "reported" && state.reportedRun === work.index);
  }
  pi.on("turn_start", (_event, ctx) => {
    if (!candidateAwaitsSettlement() || !work) return;
    // A blocked tool only terminates the run when every call in the batch is
    // terminating. Other extensions can keep a batch alive, so bound the
    // post-candidate loop independently of Pi's tool scheduling.
    if (++work.postCandidateTurns < 3) return;
    const continuationDriven = work.continuationDriven;
    finish(ctx, "paused", "Completion candidate could not settle after two further turns; resume to re-report it.");
    if (continuationDriven) {
      try { ctx.abort(); } catch { /* The goal is already paused. */ }
    }
  });
  pi.on("tool_call", (event) => {
    if (!candidateAwaitsSettlement() || !work) return;
    work.candidateToolBlocked = true;
    return { block: true, terminate: true, reason: "A completion candidate is already pending. Further tool calls are blocked; the verifier will judge it after this run settles." };
  });
  pi.on("agent_end", (event, ctx) => {
    const owner = work;
    if (!owner || !goal || owner.goalId !== goal.id || owner.session !== guard.sessionId) return;
    for (const message of event.messages) account(message, owner, ctx);
    const final = [...event.messages].reverse().find((message) => message.role === "assistant");
    owner.stopReason = final?.stopReason;
    if (goal.candidateState?.phase === "reported" && goal.candidateState.reportedRun === owner.index) {
      // A goal-blocked tool batch terminates with stopReason "toolUse": Pi
      // does not make another model call for a final text response. Treat that
      // enforced stop as ready, but do not accept unrelated toolUse endings.
      const goalTerminatedBatch = final?.stopReason === "toolUse" && owner.candidateToolBlocked;
      goal.candidateState.phase = final?.stopReason === "stop" || goalTerminatedBatch ? "ready" : "interrupted";
    }
    endedRun = owner;
    work = undefined;
    if (goal.lastBlockerRun !== owner.index) {
      goal.blockerRuns = 0;
      goal.blocker = undefined;
    }
    if (goal.status === "active" && final?.stopReason === "aborted") {
      if (goal.candidateState) goal.candidateState.phase = "interrupted";
      finish(ctx, "paused", goal.candidateState
        ? "Agent cancelled; a reported candidate was never verified."
        : "Agent cancelled.");
      return;
    }
    // Persist the run's usage even when the goal already left `active` during
    // the run (a blocker report or a budget stop), so the total is not lost.
    // pi may retry provider errors before settling, so those are handled at
    // agent_settled rather than here.
    checkpoint();
    // The status bar reads `used`; without this it shows the pre-run count
    // until the next boundary.
    display(ctx);
  });
  async function settleGoalRun(owner: WorkRun | undefined, ctx: ExtensionContext): Promise<void> {
    if (!owner || !goal || owner.goalId !== goal.id || owner.session !== guard.sessionId ||
      goal.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages() || flight) return;
    const goalId = goal.id;
    if ([...pendingDelegations].some((pending) => pending.startsWith(`${goalId}:`))) {
      deferredRun = owner;
      return;
    }
    if (owner.stopReason === "error" || owner.stopReason === "aborted") {
      // A candidate reported in a run that ends here was never judged — the
      // verifier only sees clean stops. The pause reason says so, and the
      // The interrupted phase carries the same fact into the next prompt.
      if (goal.candidateState) goal.candidateState.phase = "interrupted";
      finish(ctx, "paused", goal.candidateState
        ? `Agent ${owner.stopReason}; a reported candidate was never verified.`
        : `Agent ${owner.stopReason}.`);
      return;
    }
    // Checked before verification so the cap never pays for a verifier round
    // whose verdict would be discarded. `/goal resume` is what authorizes more.
    const { maxRuns } = goalLimits();
    if ((goal.attemptRuns ?? 0) >= maxRuns) {
      finish(ctx, "paused", `Work run cap of ${maxRuns} reached; /goal resume authorizes more.`);
      return;
    }
    // A clean stop is not a completion claim. A candidate from an earlier
    // clean run can still be judged here when a queued follow-up delayed its
    // first settlement. Interrupted candidates need a fresh report.
    if (goal.candidateState?.phase !== "ready") {
      schedule(ctx);
      return;
    }
    await verify(ctx);
  }
  pi.on("agent_settled", (_event, ctx) => {
    const owner = endedRun;
    endedRun = undefined;
    // Pi awaits extension handlers in registration order. Yield so later
    // synchronous handlers can deliver follow-ups before we verify.
    if (owner) setTimeout(() => { void settleGoalRun(owner, ctx).catch((error) => {
      try { ctx.ui.notify(`Goal settlement failed: ${String(error)}`, "error"); }
      catch { /* The originating UI may already be gone. */ }
    }); }, 0);
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
        // Only a turn the plugin started is interrupted. A user turn that runs
        // while a goal is active is the user's output, not goal work, so it is
        // left to finish and merely stops being accounted as goal progress.
        const interruptsRun = !!work?.continuationDriven;
        finish(ctx, "paused", "Requested by user.");
        if (interruptsRun) ctx.abort();
        return;
      }
      if (verb === "clear") {
        const interruptsRun = !!work?.continuationDriven;
        invalidate();
        continuation.reset();
        goal = undefined;
        timer.stop();
        work = undefined;
        endedRun = undefined;
        pi.appendEntry(GOAL_ENTRY, { schema: 1, cleared: true });
        display(ctx);
        if (interruptsRun) ctx.abort();
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for current work to finish or use /goal pause before starting/resuming/replacing a goal.", "warning");
        return;
      }
      if (verb === "resume") {
        if (!goal || !isResumable(goal)) {
          ctx.ui.notify("Only paused, blocked or stalled goals can resume.", "warning");
          return;
        }
        invalidate();
        goal.status = "active";
        // `reason` is kept on purpose: the continuation prompt surfaces it as
        // "last paused with", which is how the agent learns whether the last
        // attempt was rejected by the verifier or never reached it.
        goal.blocker = undefined;
        goal.blockerRuns = 0;
        goal.lastBlockerRun = undefined;
        // A resume is the user authorizing another attempt, so the per-attempt
        // counters restart while the lifetime totals stay.
        goal.attemptRuns = 0;
        goal.stalledRuns = 0;
        goal.nextActionKey = undefined;
        timer.start();
        checkpoint();
        display(ctx);
        schedule(ctx);
        return;
      }
      if (goal && !isRetired(goal) && verb !== "replace") {
        ctx.ui.notify("A goal already exists; use /goal replace <objective> or /goal clear.", "warning");
        return;
      }
      let parsed: ReturnType<typeof parseObjective>;
      try { parsed = parseObjective(verb === "replace" ? input.slice(verb.length).trim() : input); }
      catch (error) { ctx.ui.notify(String(error), "warning"); return; }
      invalidate();
      work = undefined;
      endedRun = undefined;
      goal = { schema: 1, id: crypto.randomUUID(), ...parsed, status: "active", used: 0, elapsedMs: 0, workRuns: 0, attemptRuns: 0, blockerRuns: 0, stalledRuns: 0, candidateGeneration: 0 };
      timer.restart();
      timer.start();
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
      if (params.kind === "candidate_complete" && goal.candidateState &&
        (goal.candidateState.phase === "ready" || goal.candidateState.phase === "verifying" ||
          (goal.candidateState.phase === "reported" && goal.candidateState.reportedRun === work.index))) {
        return {
          content: [{ type: "text", text: "A candidate is already awaiting verification. Finish this run with a final response so verification can start; do not call update_goal again." }],
          details: structuredClone(goal),
        };
      }
      goal.progress = params.message;
      if (params.kind === "candidate_complete") {
        goal.candidate = params.message;
        goal.candidateGeneration = (goal.candidateGeneration ?? 0) + 1;
        goal.candidateState = { generation: goal.candidateGeneration, phase: "reported", reportedRun: work.index };
        work.postCandidateTurns = 0;
      }
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
      const reply = params.kind === "candidate_complete" && goal.status === "active"
        ? "Goal active; candidate recorded. Finish this run with a final response so the verifier can judge it. Do not call update_goal again in this run. If the run is interrupted first, re-report the candidate in the next run."
        : `Goal ${goal.status}; report recorded.`;
      return { content: [{ type: "text", text: reply }], details: structuredClone(goal) };
    },
  });
}
