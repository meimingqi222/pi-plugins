import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalPlugin from "../src/index.ts";
import { subagentExtension } from "../../subagent/src/index.ts";
import { parseObjective, restoreGoal } from "../src/state.ts";
import { parseVerdict } from "../src/verifier.ts";
import { withDeadline } from "pi-run-core";
import { GOAL_SPEND_REQUEST, GOAL_SPEND_SERVICE, type GoalSpendService } from "pi-run-core";
import { PLAN_FILE_NAME, renderPlan } from "../src/plan.ts";

const planFileIn = (sessionDir: string): string => join(sessionDir, PLAN_FILE_NAME);

/**
 * Whether this process may create a symlink at all.
 *
 * Windows grants `symlink` only to an elevated process or one with Developer
 * Mode enabled, and refuses it with `EPERM` otherwise. The guard the symlink
 * test pins cannot be exercised without one, so the test is skipped rather
 * than failing on a platform that genuinely cannot set up its precondition.
 */
const canCreateSymlinks = ((): boolean => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-symlink-"));
	try {
		const target = join(dir, "target");
		writeFileSync(target, "x");
		symlinkSync(target, join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

/**
 * Rewrites the checklist the way the agent would, by editing the file.
 *
 * `criteria` defaults to the standard planner reply's, so a test that stubs its
 * own criteria must pass them — otherwise the file legitimately reads as edited
 * and `criteriaEdited` reports true.
 */
async function checkOff(
  env: ReturnType<typeof setup>, labels: string[], done: boolean[],
  criteria: string[] = ["the objective is met"],
): Promise<void> {
  await writeFile(planFileIn(env.sessionDir), renderPlan("task", {
    criteria,
    checklist: labels.map((label, index) => ({ label, done: done[index] ?? false })),
  }), { encoding: "utf-8", mode: 0o600 });
}

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

/** Distinguishes the planner side call from the verifier side call. */
const PLANNER_MARK = "You turn one user objective";
const plannerReply = (criteria = ["the objective is met"], steps = ["do the work", "test the work"]) => ({
	stopReason: "stop",
	content: [{ type: "text", text: JSON.stringify({ criteria, checklist: steps }) }],
});

function setup(entries: any[] = [], complete?: (...args: any[]) => any, planner?: (...args: any[]) => any) {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Array<(value: unknown) => void>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const sent: Array<{ message: any; options: any }> = [];
	const appended: any[] = [];
	// The status bar is where a retired goal must disappear from; record every
	// call so a test can assert the key was cleared rather than merely rewritten.
	const statuses: Array<string | undefined> = [];
	// Warnings are the only place a refused plan write or a failed snapshot is
	// reported, so a test needs to see them.
	const notices: string[] = [];
	// Models the verifier may be pointed at, and every model a side call was
	// actually made with. `find` returns a model missing from `authless` only, so
	// a test can exercise the unknown-id and no-auth fallbacks.
	const catalogue = new Map<string, any>();
	const authless = new Set<string>();
	const judgedBy: string[] = [];
	// A real directory, so the plan file is written and re-read as in production.
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-"));
	const ctx: any = {
		ui: {
			setStatus(_key: string, value?: string) { statuses.push(value); },
			notify(message: string) { notices.push(message); },
			setWorkingMessage() {},
		}, mode: "tui", hasUI: true,
		isIdle: () => true, hasPendingMessages: () => false, abort() {},
		sessionManager: { getBranch: () => entries, getSessionId: () => "test-session", getSessionDir: () => sessionDir },
		model: { provider: "test", id: "model" },
		modelRegistry: {
			hasConfiguredAuth: (model: any) => !authless.has(`${model?.provider}/${model?.id}`),
			find: (provider: string, id: string) => catalogue.get(`${provider}/${id}`),
			// The planner and the verifier are separate side calls; routing is by
			// system prompt so a test that stubs one never stubs the other. Arguments
			// are forwarded, because a stub may inspect the context.
			complete: async (...args: any[]) => {
				const context = args[1];
				judgedBy.push(`${args[0]?.provider}/${args[0]?.id}`);
				if (typeof context?.systemPrompt === "string" && context.systemPrompt.includes(PLANNER_MARK)) {
					// Arguments are forwarded to a custom stub, which may want the
					// AbortSignal; the built-in reply takes (criteria, steps).
					return planner ? planner(...args) : plannerReply();
				}
				return complete
					? complete(...args)
					: { content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "work remains", nextAction: "continue" }) }] };
			},
		},
	};
	const pi: any = {
		events: {
			on(name: string, handler: (value: unknown) => void) {
				bus.set(name, [...(bus.get(name) ?? []), handler]);
			},
			emit(name: string, value: unknown) {
				for (const handler of bus.get(name) ?? []) handler(value);
			},
		},
		on(name: string, handler: Handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		appendEntry(type: string, data: any) { appended.push({ type, data }); entries.push({ type: "custom", customType: type, data }); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	};
	goalPlugin(pi);
	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, messages: [], ...event }, ctx);
		return result;
	};
	return { pi, ctx, commands, tools, sent, appended, sessionDir, statuses, notices, catalogue, authless, judgedBy, emit };
}

function goalSpend(env: ReturnType<typeof setup>): GoalSpendService {
  let service: GoalSpendService | undefined;
  env.pi.events.on(GOAL_SPEND_SERVICE, (value: GoalSpendService) => { service = value; });
  env.pi.events.emit(GOAL_SPEND_REQUEST, undefined);
  if (!service) throw new Error("goal spend service unavailable");
  return service;
}

async function run(command: any, args: string, ctx: any) { await command.handler(args, ctx); }
async function update(tool: any, kind: string, message: string, ctx: any) { return tool.execute("call", { kind, message }, undefined, undefined, ctx); }
async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)); }
/**
 * Wait for a state transition instead of guessing a tick count.
 *
 * The plugin now reads the plan file on the `agent_start` and verify paths, so
 * those handlers contain real async gaps. A fixed `tick()` can land before the
 * chain reaches verification, which makes a test that interleaves a command
 * between two of them race.
 */
async function waitFor(env: ReturnType<typeof setup>, predicate: (state: any) => boolean) {
  for (let i = 0; i < 100; i += 1) {
    const current = await state(env);
    if (predicate(current)) return current;
    await tick();
  }
  throw new Error(`condition not reached; last state: ${JSON.stringify(await state(env))}`);
}
async function round(env: ReturnType<typeof setup>, messages: any[] = []) {
  await env.emit("agent_start");
  await update(env.tools.get("update_goal"), "candidate_complete", "work ready for verification", env.ctx);
  await env.emit("agent_end", { messages });
  await env.emit("agent_settled");
  await tick();
}
const failing = (nextAction = "run remaining test", tokens = 0) => ({
  role: "assistant", stopReason: "stop", usage: { totalTokens: tokens },
  content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "checked", evidence: "tool output", nextAction }) }],
});

const verdict = (passed = true, tokens = 0) => ({
 role: "assistant", stopReason: "stop", usage: { totalTokens: tokens },
 content: [{ type: "text", text: JSON.stringify({ passed, reason: "checked", evidence: "test output", nextAction: "run remaining test" }) }],
});
async function state(env: ReturnType<typeof setup>) {
 return (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
}
async function endWork(env: ReturnType<typeof setup>, messages: any[] = []) {
 await env.emit("agent_start");
 await update(env.tools.get("update_goal"), "candidate_complete", "work ready for verification", env.ctx);
 await env.emit("agent_end", { messages });
 return env.emit("agent_settled");
}

// The limits are read per call, so a test may set one for its duration. Delete
// rather than restore: nothing in this suite depends on a pre-existing value,
// and `process.env.X = undefined` would store the string "undefined".
afterEach(() => {
  for (const key of ["PI_GOAL_MAX_RUNS", "PI_GOAL_STALL_RUNS", "PI_GOAL_PLAN", "PI_GOAL_VERIFIER_MODEL"]) delete process.env[key];
});

describe("goal safety boundaries", () => {
 test("context replaces stale goal messages even after pause and compaction", async () => {
  const env = setup();
  await run(env.commands.get("goal"), "current objective", env.ctx);
  await run(env.commands.get("goal"), "pause", env.ctx);
  const result = await env.emit("context", { messages: [
   { role: "user", content: "summary" },
   { role: "custom", customType: "goal-context", content: "old" },
   { role: "custom", customType: "goal-continuation", content: "old" },
  ] });
  expect(result.messages).toHaveLength(2);
  expect(result.messages[0].content).toBe("summary");
  expect(result.messages[1].content).toContain("current objective");
  expect(result.messages[1].content).toContain("not active");
 });
 test("failed verdict schedules once and duplicate settled does not verify again", async () => {
  let calls = 0;
  const env = setup([], async () => { calls++; return verdict(false); });
  await run(env.commands.get("goal"), "task", env.ctx);
  await endWork(env);
  await env.emit("agent_settled");
  await tick();
  expect(calls).toBe(1);
  expect(env.sent).toHaveLength(1);
  expect((await state(env)).status).toBe("active");
 });
 test("pause releases verifier even if provider ignores abort and ignores late completion", async () => {
  let resolve!: (value: any) => void;
  const env = setup([], () => new Promise((r) => { resolve = r; }), async () => plannerReply());
  await run(env.commands.get("goal"), "task", env.ctx);
  const pending = endWork(env);
  await waitFor(env, (s) => s.status === "verifying");
  await run(env.commands.get("goal"), "pause", env.ctx);
  await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel stuck")), 100))]);
  resolve(verdict());
  await tick();
  expect((await state(env)).status).toBe("paused");
  expect(env.sent).toHaveLength(0);
 });
 test("replacement cannot inherit stale verifier completion", async () => {
  let resolve!: (value: any) => void;
  const env = setup([], () => new Promise((r) => { resolve = r; }), async () => plannerReply());
  await run(env.commands.get("goal"), "old", env.ctx);
  const pending = endWork(env);
  await waitFor(env, (s) => s.status === "verifying");
  await run(env.commands.get("goal"), "replace new", env.ctx);
  resolve(verdict(true, 99));
  await pending;
  expect((await state(env)).objective).toBe("new");
  expect((await state(env)).used).toBe(0);
  expect((await state(env)).status).toBe("active");
  await run(env.commands.get("goal"), "clear", env.ctx);
 });
 test("usage deduplicates event copies and includes verifier before enforcing budget", async () => {
  const env = setup([], async () => verdict(true, 6));
  await run(env.commands.get("goal"), "task --tokens 10", env.ctx);
  await env.emit("agent_start");
  const message = verdict(true, 5);
  await env.emit("message_end", { message });
  await update(env.tools.get("update_goal"), "candidate_complete", "work ready for verification", env.ctx);
  await env.emit("agent_end", { messages: [structuredClone(message)] });
  await env.emit("agent_settled");
  expect((await state(env)).used).toBe(11);
  expect((await state(env)).status).toBe("budget_limited");
  await endWork(env, [verdict(true, 100)]);
  expect((await state(env)).used).toBe(11);
 });
 test("delegated spend is counted once and exhausts the active goal", async () => {
  const env = setup();
  await run(env.commands.get("goal"), "task --tokens 10", env.ctx);
  await env.emit("agent_start");
  const lease = goalSpend(env).begin(env.ctx, "child-1");
  expect(lease).toBeDefined();
  lease!.finish(12);
  lease!.finish(12);
  expect((await state(env)).used).toBe(12);
  expect((await state(env)).status).toBe("budget_limited");
  expect(() => goalSpend(env).begin(env.ctx, "child-2")).toThrow("budget exhausted");
 });
 test("a real subagent tool reports child usage through the goal service", async () => {
  const env = setup();
  subagentExtension({
   discover: () => [{ name: "scout", description: "Inspect code", systemPrompt: "Inspect code.", filePath: "scout.md" }],
   executor: async () => ({ status: "completed", text: "done", usage: { input: 3, output: 2, cacheRead: 4, cacheWrite: 0, cost: 0, totalTokens: 9 } }),
  })(env.pi);
  await run(env.commands.get("goal"), "task", env.ctx);
  await env.emit("agent_start");
  const result = await env.tools.get("subagent").execute("real-child", { agent: "scout", task: "inspect" }, undefined, undefined, env.ctx);
  expect(result.content[0].text).toBe("done");
  expect((await state(env)).used).toBe(9);
 });
 test("verification waits for a background delegation and ignores its late duplicate", async () => {
  let calls = 0;
  const env = setup([], async () => { calls++; return verdict(true); });
  await run(env.commands.get("goal"), "task", env.ctx);
  await env.emit("agent_start");
  const lease = goalSpend(env).begin(env.ctx, "workflow-1")!;
  await update(env.tools.get("update_goal"), "candidate_complete", "work ready for verification", env.ctx);
  await env.emit("agent_end", { messages: [] });
  await env.emit("agent_settled");
  expect(calls).toBe(0);
  lease.finish(7);
  await waitFor(env, (s) => s.status === "complete");
  lease.finish(7);
  expect(calls).toBe(1);
  expect((await state(env)).used).toBe(7);
 });
 test("pause and resume do not verify a stale settled run after its workflow finishes", async () => {
  let calls = 0;
  const env = setup([], async () => { calls++; return verdict(true); });
  await run(env.commands.get("goal"), "task", env.ctx);
  await env.emit("agent_start");
  const lease = goalSpend(env).begin(env.ctx, "workflow-old")!;
  await env.emit("agent_end", { messages: [] });
  await env.emit("agent_settled");
  await run(env.commands.get("goal"), "pause", env.ctx);
  await run(env.commands.get("goal"), "resume", env.ctx);
  lease.finish(7);
  await tick();
  expect(calls).toBe(0);
  expect((await state(env)).used).toBe(7);
 });
 test("a replaced goal never inherits a late child report", async () => {
  const env = setup();
  await run(env.commands.get("goal"), "old", env.ctx);
  await env.emit("agent_start");
  const lease = goalSpend(env).begin(env.ctx, "old-child")!;
  await run(env.commands.get("goal"), "replace new", env.ctx);
  lease.finish(100);
  expect((await state(env)).objective).toBe("new");
  expect((await state(env)).used).toBe(0);
 });
 test("pending input wins over continuation and verifier", async () => {
  let calls = 0;
  const env = setup([], async () => { calls++; return verdict(); });
  await run(env.commands.get("goal"), "task", env.ctx);
  env.ctx.hasPendingMessages = () => true;
  await endWork(env);
  await tick();
  expect(calls).toBe(0);
  expect(env.sent).toHaveLength(0);
 });
 test("provider error with plausible JSON cannot complete", async () => {
  const env = setup([], async () => ({ ...verdict(), stopReason: "error" }));
  await run(env.commands.get("goal"), "task", env.ctx);
  await endWork(env);
  expect((await state(env)).status).toBe("paused");
 });
 test("agent abort pauses without invoking verifier", async () => {
  let calls = 0;
  const env = setup([], async () => { calls++; return verdict(); });
  await run(env.commands.get("goal"), "task", env.ctx);
  await endWork(env, [{ ...verdict(), stopReason: "aborted" }]);
  expect((await state(env)).status).toBe("paused");
  expect(calls).toBe(0);
 });
 test("session tree recovery pauses active snapshot", async () => {
  const env = setup();
  await run(env.commands.get("goal"), "task", env.ctx);
  await env.emit("session_tree");
  await tick();
  expect((await state(env)).status).toBe("paused");
  expect(env.sent).toHaveLength(0);
 });
 test("deadline aborts an uncooperative provider", async () => {
  const controller = new AbortController();
  await expect(withDeadline(() => new Promise(() => {}), controller, 5)).rejects.toThrow("timed out");
  expect(controller.signal.aborted).toBe(true);
 });
 test("strict verdict requires evidence and actionable failure", () => {
  expect(() => parseVerdict('{"passed":true,"reason":"done"}')).toThrow();
  expect(() => parseVerdict('{"passed":false,"reason":"no","evidence":"missing"}')).toThrow();
 });
 test("objective flags reject invalid budgets", () => {
  for (const input of ["task --tokens 0", "task --tokens NaN", "task --tokens=3", "task --tokens -1"]) {
   expect(() => parseObjective(input)).toThrow();
  }
 });
 test("invalid latest snapshot does not resurrect older state", async () => {
  const entries: any[] = [];
  const env = setup(entries);
  await run(env.commands.get("goal"), "task", env.ctx);
  entries.push({ type: "custom", customType: "goal-state", data: { schema: 1 } });
  expect(restoreGoal(env.ctx)).toBeUndefined();
  await run(env.commands.get("goal"), "clear", env.ctx);
 });
 test("a status from a newer build pauses the goal instead of deleting it", async () => {
  // The branch walk takes the newest snapshot, so rejecting the status discards
  // the objective, the budget and every counter — the whole goal lost to one word
  // this build has not heard of. Unknown means paused, and it says why.
  const entries: any[] = [];
  const env = setup(entries);
  await run(env.commands.get("goal"), "task --tokens 50", env.ctx);
  const live = await state(env);
  entries.push({
   type: "custom", customType: "goal-state",
   data: { ...live, status: "frozen", used: 7, workRuns: 3 },
  });
  const restored = restoreGoal(env.ctx)!;
  expect(restored.status).toBe("paused");
  expect(restored.objective).toBe("task");
  expect(restored.budget).toBe(50);
  expect(restored.used).toBe(7);
  expect(restored.reason).toContain("frozen");
  await run(env.commands.get("goal"), "clear", env.ctx);
 });
});

describe("goal continuation provenance", () => {
  /**
   * A user turn while a goal is active. It is accounted as goal progress, but
   * it was not started by the plugin, so pausing must not interrupt it.
   */
  test("pausing during a user turn does not interrupt the user's own output", async () => {
    const env = setup([], async () => verdict(false));
    await run(env.commands.get("goal"), "task", env.ctx);
    let aborted = false;
    env.ctx.abort = () => { aborted = true; };
    await env.emit("agent_start");
    await run(env.commands.get("goal"), "pause", env.ctx);
    expect(aborted).toBe(false);
    expect((await state(env)).status).toBe("paused");
  });
  test("pausing during a continuation turn interrupts the goal-driven run", async () => {
    const env = setup([], async () => verdict(false));
    await run(env.commands.get("goal"), "task", env.ctx);
    await endWork(env);
    await tick();
    expect(env.sent.length).toBeGreaterThan(0);
    // The plugin's own continuation is what starts this attempt.
    let aborted = false;
    env.ctx.abort = () => { aborted = true; };
    await env.emit("agent_start");
    await run(env.commands.get("goal"), "pause", env.ctx);
    expect(aborted).toBe(true);
    expect((await state(env)).status).toBe("paused");
  });
  test("a continuation queued before pause is stopped when it starts", async () => {
    const env = setup([], async () => verdict(false));
    await run(env.commands.get("goal"), "task", env.ctx);
    await endWork(env);
    await tick();
    expect(env.sent.length).toBeGreaterThan(0);
    // Pause before the queued continuation turn begins: Pi cannot unsend it.
    await run(env.commands.get("goal"), "pause", env.ctx);
    let aborted = false;
    env.ctx.abort = () => { aborted = true; };
    await env.emit("agent_start");
    expect(aborted).toBe(true);
    expect((await state(env)).status).toBe("paused");
  });
  test("clear also leaves a user turn running", async () => {
    const env = setup([], async () => verdict(false));
    await run(env.commands.get("goal"), "task", env.ctx);
    let aborted = false;
    env.ctx.abort = () => { aborted = true; };
    await env.emit("agent_start");
    await run(env.commands.get("goal"), "clear", env.ctx);
    expect(aborted).toBe(false);
    expect((await state(env)).state).toBe("none");
  });
  test("a user follow-up inside a continuation run is not goal-driven", async () => {
    const env = setup([], async () => verdict(false));
    await run(env.commands.get("goal"), "task", env.ctx);
    await endWork(env);
    await tick();
    // Attempt 1 is the plugin's continuation; attempt 2 is the user's follow-up
    // arriving in the same run. Pausing must not interrupt the latter.
    await env.emit("agent_start");
    await env.emit("agent_end", { messages: [] });
    await env.emit("agent_start");
    let aborted = false;
    env.ctx.abort = () => { aborted = true; };
    await run(env.commands.get("goal"), "pause", env.ctx);
    expect(aborted).toBe(false);
  });
});

describe("goal continuation bounds", () => {

  test("unfinished runs still stop at the run cap without verifier calls", async () => {
    process.env.PI_GOAL_MAX_RUNS = "2";
    let calls = 0;
    const env = setup([], async () => { calls++; return verdict(true); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    for (let index = 0; index < 2; index += 1) {
      await env.emit("agent_start");
      await update(env.tools.get("update_goal"), "progress", `unfinished run ${index + 1}`, env.ctx);
      await env.emit("agent_end", { messages: [verdict(false, 1)] });
      await env.emit("agent_settled");
      await tick();
    }
    expect(calls).toBe(0);
    expect((await state(env)).status).toBe("paused");
    expect((await state(env)).used).toBe(2);
  });

  test("work run cap pauses before paying for another verification", async () => {
    process.env.PI_GOAL_MAX_RUNS = "2";
    let calls = 0;
    const env = setup([], async () => { calls++; return failing(); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    expect(env.sent).toHaveLength(1);
    await round(env);
    expect(calls).toBe(1);
    expect(env.sent).toHaveLength(2);
    await round(env);
    // The cap is checked before a verifier round is paid for.
    expect(calls).toBe(1);
    expect((await state(env)).status).toBe("paused");
    expect((await state(env)).attemptRuns).toBe(2);
    expect(env.sent).toHaveLength(2);
  });

  test("repeated next action pauses as no_progress and resume restarts the attempt", async () => {
    process.env.PI_GOAL_MAX_RUNS = "20";
    process.env.PI_GOAL_STALL_RUNS = "2";
    const env = setup([], async () => failing());
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await round(env);
    expect((await state(env)).status).toBe("active");
    expect((await state(env)).stalledRuns).toBe(1);
    await round(env);
    expect((await state(env)).status).toBe("no_progress");
    const sentBeforeResume = env.sent.length;
    await run(env.commands.get("goal"), "resume", env.ctx);
    await tick();
    const resumed = await state(env);
    expect(resumed.status).toBe("active");
    expect(resumed.attemptRuns).toBe(0);
    expect(resumed.stalledRuns).toBe(0);
    expect(env.sent.length).toBe(sentBeforeResume + 1);
  });

  test("a reworded next action counts as progress", async () => {
    process.env.PI_GOAL_MAX_RUNS = "20";
    process.env.PI_GOAL_STALL_RUNS = "2";
    let n = 0;
    const env = setup([], async () => failing(`step ${++n}`));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await round(env);
    await round(env);
    await round(env);
    expect((await state(env)).status).toBe("active");
    expect((await state(env)).stalledRuns).toBe(1);
  });

  test("an advancing checklist does not count as a stall", async () => {
    process.env.PI_GOAL_STALL_RUNS = "2";
    process.env.PI_GOAL_MAX_RUNS = "20";
    // The verifier words its nudge identically every round; the plan moves instead.
    const env = setup([], async () => failing("run the remaining test"), () => plannerReply(["c"], ["one", "two", "three"]));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await checkOff(env, ["one", "two", "three"], [true, false, false]);
    await round(env);
    expect((await state(env)).stalledRuns).toBe(1);
    await checkOff(env, ["one", "two", "three"], [true, true, false]);
    await round(env);
    expect((await state(env)).status).toBe("active");
    expect((await state(env)).stalledRuns).toBe(1);
  });

  test("a checklist that stops moving still stalls", async () => {
    process.env.PI_GOAL_STALL_RUNS = "2";
    process.env.PI_GOAL_MAX_RUNS = "20";
    const env = setup([], async () => failing("run the remaining test"), () => plannerReply(["c"], ["one", "two"]));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await round(env);
    await round(env);
    expect((await state(env)).status).toBe("no_progress");
  });

  test("a next action whose only change is a per-attempt token still stalls", async () => {
    process.env.PI_GOAL_STALL_RUNS = "2";
    process.env.PI_GOAL_MAX_RUNS = "20";
    // The same request reworded only by a scratch path and a generated id. If
    // the fingerprint kept those tokens, every round would look like new work
    // and the goal would run to the cap instead of pausing as no_progress.
    let n = 0;
    const env = setup([], async () => failing(
      `Investigate the failing run in /tmp/grok-goal-${(n++).toString(16).padStart(12, "0")}/out.log`,
    ), () => plannerReply(["c"], ["one", "two"]));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await round(env);
    expect((await state(env)).status).toBe("active");
    await round(env);
    expect((await state(env)).status).toBe("no_progress");
  });

  test("a next action naming a different numbered step is not a stall", async () => {
    process.env.PI_GOAL_STALL_RUNS = "2";
    process.env.PI_GOAL_MAX_RUNS = "20";
    // Plain integers must keep distinguishing work, or a progressing goal would
    // be paused as stalled on its second round.
    let n = 0;
    const env = setup([], async () => failing(`Run test ${++n} of the suite`), () => plannerReply(["c"], ["one", "two"]));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await round(env);
    await round(env);
    await round(env);
    expect((await state(env)).status).toBe("active");
    expect((await state(env)).stalledRuns).toBe(1);
  });

  test("usage is persisted at run boundaries, not per assistant message", async () => {
    const env = setup([], async () => failing("", 0));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await env.emit("agent_start");
    const afterStart = env.appended.length;
    for (let i = 0; i < 4; i += 1) await env.emit("message_end", { message: failing("", 3) });
    // message_end must not snapshot the goal.
    expect(env.appended.length).toBe(afterStart);
    await env.emit("agent_end", { messages: [] });
    expect(env.appended.length).toBeGreaterThan(afterStart);
  });

  test("snapshots written before the run cap still restore", async () => {
    const entries: any[] = [{
      type: "custom", customType: "goal-state",
      data: { schema: 1, id: "g1", objective: "legacy", status: "paused", used: 7, elapsedMs: 5, workRuns: 2, blockerRuns: 0 },
    }];
    const env = setup(entries);
    await env.emit("session_start");
    const restored = await state(env);
    expect(restored.objective).toBe("legacy");
    expect(restored.used).toBe(7);
    expect(restored.attemptRuns).toBe(0);
    expect(restored.stalledRuns).toBe(0);
  });
});

describe("goal candidate verification status", () => {
  test("an unfinished work run continues without paying for verification", async () => {
    let calls = 0;
    const env = setup([], async () => { calls++; return verdict(true, 100); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "progress", "first step done; more work remains", env.ctx);
    await env.emit("agent_end", { messages: [verdict(false, 5)] });
    await env.emit("agent_settled");
    await tick();
    expect(calls).toBe(0);
    expect((await state(env)).status).toBe("active");
    expect((await state(env)).used).toBe(5);
    expect(env.sent).toHaveLength(2);
  });

  // Regression: a candidate_complete reported in a run that then errored was
  // indistinguishable from a rejected one — `candidate` was set either way and
  // the prompt said nothing about it, so the agent re-ran the whole attempt
  // blind after every resume.
  test("a candidate in a run that errors is flagged unjudged, and the prompt says so", async () => {
    let calls = 0;
    const env = setup([], async () => { calls++; return verdict(false); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    const reply = await update(env.tools.get("update_goal"), "candidate_complete", "all done", env.ctx);
    expect(reply.content[0].text).toContain("Finish this run with a final response");
    await env.emit("agent_end", { messages: [{ ...verdict(), stopReason: "error" }] });
    await env.emit("agent_settled");
    const paused = await state(env);
    expect(paused.status).toBe("paused");
    expect(paused.candidatePending).toBe(true);
    expect(paused.reason).toContain("never verified");
    // The verifier must not have run on an errored run.
    expect(calls).toBe(0);
    // After resume the prompt distinguishes "unjudged" from "rejected".
    await run(env.commands.get("goal"), "resume", env.ctx);
    const result = await env.emit("context", { messages: [] });
    expect(result.messages[0].content).toContain("has NOT been judged");
    expect(result.messages[0].content).toContain("never verified");
    expect(result.messages[0].content).not.toContain("Required next action");
  });

  test("a rejected candidate clears pending and the prompt names the verdict and next action", async () => {
    const env = setup([], async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "tests missing", evidence: "no test run in transcript", nextAction: "run the suite" }) }],
    }));
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "all done", env.ctx);
    await env.emit("agent_end", { messages: [verdict()] });
    await env.emit("agent_settled");
    await tick();
    const active = await state(env);
    expect(active.status).toBe("active");
    expect(active.candidatePending).toBe(false);
    expect(active.candidate).toBe("run the suite");
    const result = await env.emit("context", { messages: [] });
    expect(result.messages[0].content).toContain("verdict was not passed: tests missing");
    expect(result.messages[0].content).toContain("Required next action: run the suite");
    expect(result.messages[0].content).not.toContain("has NOT been judged");
  });

  test("a new candidate after a rejection is pending again and the old verdict is marked as predating it", async () => {
    const env = setup([], async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "tests missing", evidence: "e", nextAction: "run the suite" }) }],
    }));
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "done", env.ctx);
    await env.emit("agent_end", { messages: [verdict()] });
    await env.emit("agent_settled");
    await tick();
    // The continuation run starts; the agent reports a fresh candidate.
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "done for real", env.ctx);
    const result = await env.emit("context", { messages: [] });
    // Reported in *this* run, so the prompt waits for the settle instead of
    // asking for a re-report — see the loop regression below.
    expect(result.messages[0].content).toContain("This run reported a candidate completion");
    expect(result.messages[0].content).toContain("predates the pending candidate");
  });

  test("a candidate reported inside the running run is not met with a re-report instruction", async () => {
    // Regression: the prompt told the reporting run that its candidate "was
    // reported but the run ended before verification … Re-report". The run had
    // not ended — `context` fires on every turn of a run — so a model that
    // followed the line kept re-reporting, the run never settled, and
    // `agent_settled` (and therefore the verifier) never ran. Observed in a
    // real session: seven re-reports, 19M tokens, one run, no verdict.
    let calls = 0;
    const env = setup([], async () => { calls++; return verdict(true); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "all done", env.ctx);
    const first = await env.emit("context", { messages: [] });
    // A second turn of the same run sees the same state; it must not escalate.
    const second = await env.emit("context", { messages: [] });
    for (const result of [first, second]) {
      expect(result.messages[0].content).toContain("This run reported a candidate completion");
      expect(result.messages[0].content).not.toContain("Re-report candidate_complete");
      // The claim that drove the loop: the run had not ended, so saying it did
      // was both false and an instruction the model could only obey by looping.
      expect(result.messages[0].content).not.toContain("the run ended before verification");
    }
    // One run, one candidate, and the run still settles into exactly one verdict.
    await env.emit("agent_end", { messages: [verdict()] });
    await env.emit("agent_settled");
    await tick();
    expect(calls).toBe(1);
    expect((await state(env)).status).toBe("complete");
  });

  test("repeating candidate_complete in one run does not replace the pending claim", async () => {
    const env = setup([], async () => verdict(true));
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    const first = await update(env.tools.get("update_goal"), "candidate_complete", "first claim", env.ctx);
    expect(first.content[0].text).toContain("Finish this run with a final response");
    const repeated = await update(env.tools.get("update_goal"), "candidate_complete", "second claim", env.ctx);
    expect(repeated.content[0].text).toContain("already recorded in this run");
    expect((await state(env)).candidate).toBe("first claim");
  });

  test("a pending candidate from an earlier run is still re-reported after resume", async () => {
    // The counterpart to the loop fix: a candidate whose run really did end
    // unverified must still be re-reported, or the fix would silently drop the
    // guarantee that an unjudged claim reaches the verifier.
    const env = setup([], async () => verdict(true));
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "all done", env.ctx);
    await env.emit("agent_end", { messages: [{ ...verdict(), stopReason: "error" }] });
    await env.emit("agent_settled");
    await run(env.commands.get("goal"), "resume", env.ctx);
    await env.emit("agent_start");
    const result = await env.emit("context", { messages: [] });
    expect(result.messages[0].content).toContain("Re-report candidate_complete");
  });

  test("a paused goal keeps its pause reason visible after resume", async () => {
    const env = setup([], async () => verdict(false));
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await env.emit("agent_end", { messages: [{ ...verdict(), stopReason: "error" }] });
    await env.emit("agent_settled");
    await run(env.commands.get("goal"), "resume", env.ctx);
    const result = await env.emit("context", { messages: [] });
    expect(result.messages[0].content).toContain("last paused with: Agent error");
  });

  test("the verifier sees a pending claim and a required action as different fields", async () => {
    // `goal.candidate` is overloaded: the implementer's claim while unjudged,
    // the verifier's demanded next action after a rejection. Sent under one
    // name, the verifier would read its own instruction as a fresh claim.
    const captured: any[] = [];
    const env = setup([], async (_model: any, context: any) => {
      captured.push(JSON.parse(context.messages[0].content[0].text));
      return {
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "r", evidence: "e", nextAction: "run the suite" }) }],
      };
    });
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "first claim", env.ctx);
    await env.emit("agent_end", { messages: [verdict()] });
    await env.emit("agent_settled");
    await tick();
    // Round 1: the pending claim is `candidate`; nothing is required yet.
    expect(captured[0].candidate).toBe("first claim");
    expect(captured[0].requiredAction).toBeUndefined();
    // Round 2: a fresh claim arrives while the old verdict's action stands.
    await env.emit("agent_start");
    await update(env.tools.get("update_goal"), "candidate_complete", "second claim", env.ctx);
    await env.emit("agent_end", { messages: [verdict()] });
    await env.emit("agent_settled");
    await tick();
    expect(captured[1].candidate).toBe("second claim");
    expect(captured[1].requiredAction).toBeUndefined();
    expect(captured[1].previousVerdict.reason).toBe("r");
  });

  test("the planner's tokens are billed to the goal", async () => {
    const env = setup([], undefined, async () => ({
      stopReason: "stop",
      usage: { totalTokens: 42 },
      content: [{ type: "text", text: JSON.stringify({ criteria: ["c"], checklist: ["s"] }) }],
    }));
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    expect((await state(env)).used).toBe(42);
  });

  test("an invalid paid planner reply still exhausts the goal budget", async () => {
    const env = setup([], undefined, async () => ({
      stopReason: "stop", usage: { totalTokens: 42 },
      content: [{ type: "text", text: "not json" }],
    }));
    await run(env.commands.get("goal"), "task --tokens 10", env.ctx);
    await tick();
    const created = await state(env);
    expect(created.used).toBe(42);
    expect(created.status).toBe("budget_limited");
    expect(created.planPath).toBeUndefined();
    expect(env.sent).toHaveLength(0);
  });

  test("the status bar reflects usage at the end of a run", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    await env.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 7 } } });
    await env.emit("agent_end", { messages: [] });
    expect(env.statuses.at(-1)).toContain("7");
  });
});

describe("goal plan", () => {
  const criteria = ["the objective is met"];

  test("an edited checklist does not receive a stale authoritative step during the same run", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    await env.emit("agent_start");
    const initial = await env.emit("context", { messages: [] });
    expect(initial.messages[0].content).toContain("Starting point (first unchecked checklist item): do the work");
    await checkOff(env, ["do the work", "test the work"], [true, false]);
    const result = await env.emit("context", { messages: [] });
    const prompt = result.messages[0].content;
    expect(prompt).not.toContain("Next step (first unchecked item");
    expect(prompt).not.toContain('"planStep":"do the work"');
    expect(prompt).toContain("continue through the checklist in this run");
  });

  test("a plan is written before the first run and its step reaches the first context", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    const file = planFileIn(env.sessionDir);
    expect(existsSync(file)).toBe(true);
    const body = await readFile(file, "utf8");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("## Task checklist");
    expect(body).toContain("- [ ] do the work");
    const created = await state(env);
    expect(created.planPath).toBe(file);
    expect(created.planCriteria).toEqual(criteria);
    expect(created.planStep).toBe("do the work");
    // The queued message only starts a turn. The context hook gets the step
    // after agent_start refreshes it, and does not carry an obsolete snapshot.
    expect(env.sent[0].message.content).toBe("Continue the active goal.");
    await env.emit("agent_start");
    const context = await env.emit("context", { messages: [] });
    expect(context.messages[0].content).toContain(file);
    expect(context.messages[0].content).toContain("Starting point (first unchecked checklist item): do the work");
  });

  test("checking a box advances the step the next run is given", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    expect((await state(env)).planStep).toBe("do the work");
    await env.emit("agent_start");
    await env.emit("context", { messages: [] });
    await checkOff(env, ["do the work", "test the work"], [true, false]);
    await env.emit("agent_end", { messages: [] });
    await env.emit("agent_settled");
    await tick();
    expect(env.sent.at(-1)?.message.content).toBe("Continue the active goal.");
    await env.emit("agent_start");
    expect((await state(env)).planStep).toBe("test the work");
    const context = await env.emit("context", { messages: [] });
    expect(context.messages[0].content).toContain("Starting point (first unchecked checklist item): test the work");
  });

  test("deleting the plan clears the step instead of nagging a stale one", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    await Bun.write(planFileIn(env.sessionDir), "## Unrelated\n\nno plan here\n");
    await env.emit("agent_start");
    await tick();
    expect((await state(env)).planStep).toBeUndefined();
  });

  test("the verifier judges the held criteria and the checklist progress", async () => {
    let captured: any;
    const env = setup(
      [],
      async (_model: any, context: any) => {
        captured = context;
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "r", evidence: "e", nextAction: "keep going" }) }] };
      },
      () => plannerReply(["first criterion", "second criterion"], ["step one", "step two"]),
    );
    await run(env.commands.get("goal"), "task", env.ctx);
    await checkOff(env, ["step one", "step two"], [true, false], ["first criterion", "second criterion"]);
    await endWork(env);
    const evidence = JSON.parse(captured.messages[0].content[0].text);
    expect(evidence.criteria).toEqual(["first criterion", "second criterion"]);
    expect(evidence.planProgress).toBe("1/2");
    expect(evidence.planStep).toBe("step two");
    expect(evidence.criteriaEdited).toBe(false);
  });

  test("editing the plan's criteria cannot narrow what the verifier judges", async () => {
    let captured: any;
    const env = setup(
      [],
      async (_model: any, context: any) => {
        captured = context;
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "r", evidence: "e", nextAction: "keep going" }) }] };
      },
      () => plannerReply(["the real bar"], ["step one"]),
    );
    await run(env.commands.get("goal"), "task", env.ctx);
    // The implementer rewrites its own acceptance criteria to something easier.
    await writeFile(planFileIn(env.sessionDir), renderPlan("task", {
      criteria: ["weakened"],
      checklist: [{ label: "step one", done: false }],
    }), { encoding: "utf-8", mode: 0o600 });
    await endWork(env);
    const evidence = JSON.parse(captured.messages[0].content[0].text);
    expect(evidence.criteria).toEqual(["the real bar"]);
    expect(evidence.criteriaEdited).toBe(true);
  });

  test("a planner failure leaves the goal running without a plan", async () => {
    const env = setup([], undefined, async () => { throw new Error("planner down"); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    const created = await state(env);
    expect(created.status).toBe("active");
    expect(created.planPath).toBeUndefined();
    expect(created.planStep).toBeUndefined();
    // Continuation still happens; only the plan is missing.
    expect(env.sent).toHaveLength(1);
    expect(existsSync(planFileIn(env.sessionDir))).toBe(false);
  });

  test("PI_GOAL_PLAN=false skips planning entirely", async () => {
    process.env.PI_GOAL_PLAN = "false";
    let plannerCalls = 0;
    const env = setup([], undefined, async () => { plannerCalls += 1; return plannerReply(); });
    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    expect(plannerCalls).toBe(0);
    expect((await state(env)).planPath).toBeUndefined();
    expect(env.sent).toHaveLength(1);
  });

  test("a replace during planning does not inherit the old plan", async () => {
    let releaseFirst!: (value: any) => void;
    let calls = 0;
    const env = setup([], undefined, () => {
      calls += 1;
      // The first goal's planner is held open across the replace.
      return calls === 1
        ? new Promise((resolve) => { releaseFirst = resolve; })
        : Promise.resolve(plannerReply(["for new"], ["new step"]));
    });
    const planning = run(env.commands.get("goal"), "old", env.ctx);
    await tick();
    await run(env.commands.get("goal"), "replace new", env.ctx);
    expect(calls).toBe(2);
    // The stale result lands after the goal it belonged to is gone.
    releaseFirst(plannerReply(["for old"], ["old step"]));
    await planning;
    const replaced = await state(env);
    expect(replaced.objective).toBe("new");
    expect(replaced.planCriteria).toEqual(["for new"]);
    expect(replaced.planStep).toBe("new step");
  });
});

describe("goal lifecycle", () => {
	test("set dispatches immediately and never queues as nextTurn", async () => {
		const env = setup();
		await run(env.commands.get("goal"), "ship the fix --tokens 25", env.ctx);
		await tick();
		expect(env.sent).toHaveLength(1);
		expect(env.sent[0].options.triggerTurn).toBe(true);
		expect(env.sent[0].options.deliverAs).toBe("followUp");
	});

	test("clear writes a tombstone and cannot resurrect an earlier snapshot", async () => {
		const env = setup();
		await run(env.commands.get("goal"), "keep me", env.ctx);
		await run(env.commands.get("goal"), "clear", env.ctx);
		await env.emit("session_start");
		const result = await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx);
		expect(result.details).toEqual({ state: "none" });
		expect(env.appended.at(-1).data).toEqual({ schema: 1, cleared: true });
	});

	test("three repeated blocker calls in one work run do not block", async () => {
		const env = setup();
		await run(env.commands.get("goal"), "task", env.ctx);
		await env.emit("agent_start");
		for (let i = 0; i < 3; i++) await update(env.tools.get("update_goal"), "blocked", "network unavailable", env.ctx);
		const state = (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
		expect(state.status).toBe("active");
		expect(state.blockerRuns).toBe(1);
	});

	test("same blocker across three distinct work runs blocks and resume restarts", async () => {
		const env = setup();
		await run(env.commands.get("goal"), "task", env.ctx);
		for (let i = 0; i < 3; i++) { await env.emit("agent_start"); await update(env.tools.get("update_goal"), "blocked", "network unavailable", env.ctx); }
		let state = (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
		expect(state.status).toBe("blocked");
		await run(env.commands.get("goal"), "resume", env.ctx);
		state = (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
		expect(state.status).toBe("active");
		expect(state.blockerRuns).toBe(0);
	});

	test("valid completion verdict becomes terminal complete", async () => {
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "tests pass", evidence: "tool output" }) }] }));
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		const state = (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
		expect(state.status).toBe("complete");
	});

	test("a completed goal stops being injected and leaves the status bar", async () => {
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "tests pass", evidence: "tool output" }) }] }));
		await run(env.commands.get("goal"), "task", env.ctx);
		// Still injected while the goal is live, so the assertion below is about
		// completion rather than about the injection never happening.
		const live = await env.emit("context", { messages: [] });
		expect(live.messages).toHaveLength(1);
		expect(live.messages[0].content).toContain("task");
		await endWork(env);
		expect((await state(env)).status).toBe("complete");
		// The completed goal is withheld entirely: no "goal complete" line for the
		// model to narrate on the user's next unrelated request.
		const after = await env.emit("context", { messages: [{ role: "user", content: "unrelated question" }] });
		expect(after.messages).toHaveLength(1);
		expect(after.messages[0].content).toBe("unrelated question");
		expect(env.statuses.at(-1)).toBeUndefined();
		// The snapshot survives, so the user can still inspect what happened.
		expect((await state(env)).objective).toBe("task");
	});

	test("a budget limited goal is also retired from context and the status bar", async () => {
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: false, reason: "checked", evidence: "tool output", nextAction: "keep going" }) }] }));
		await run(env.commands.get("goal"), "task --tokens 1", env.ctx);
		await endWork(env, [failing("keep going", 5)]);
		expect((await state(env)).status).toBe("budget_limited");
		const after = await env.emit("context", { messages: [{ role: "user", content: "next question" }] });
		expect(after.messages).toHaveLength(1);
		expect(env.statuses.at(-1)).toBeUndefined();
	});

	test("a paused goal still reaches the model, since it is resumable", async () => {
		const env = setup();
		await run(env.commands.get("goal"), "task", env.ctx);
		await run(env.commands.get("goal"), "pause", env.ctx);
		const after = await env.emit("context", { messages: [] });
		expect(after.messages).toHaveLength(1);
		expect(after.messages[0].content).toContain("not active");
		expect(env.statuses.at(-1)).toContain("Goal paused");
	});

	test("a paused goal is not told to work through a plan it must not resume", async () => {
		const env = setup();
		await run(env.commands.get("goal"), "task", env.ctx);
		await run(env.commands.get("goal"), "pause", env.ctx);
		const result = await env.emit("context", { messages: [] });
		expect(result.messages[0].content).not.toContain("## Task checklist");
		expect(result.messages[0].content).not.toContain("check each item off");
	});

	test("a configured verifier model judges instead of the active model", async () => {
		process.env.PI_GOAL_VERIFIER_MODEL = "other/judge";
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "ok", evidence: "e" }) }] }));
		env.catalogue.set("other/judge", { provider: "other", id: "judge" });
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		expect(env.judgedBy.at(-1)).toBe("other/judge");
		expect((await state(env)).verifierModel).toBe("other/judge");
	});

	test("no configured verifier model keeps the active model", async () => {
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "ok", evidence: "e" }) }] }));
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		expect(env.judgedBy.at(-1)).toBe("test/model");
		expect((await state(env)).verifierModel).toBe("test/model");
	});

	test("an unknown verifier model falls back to the active model", async () => {
		process.env.PI_GOAL_VERIFIER_MODEL = "other/typo";
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "ok", evidence: "e" }) }] }));
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		expect(env.judgedBy.at(-1)).toBe("test/model");
		expect((await state(env)).verifierModel).toBe("test/model");
		expect((await state(env)).status).toBe("complete");
	});

	test("a verifier model without auth falls back instead of failing the goal", async () => {
		process.env.PI_GOAL_VERIFIER_MODEL = "other/nokey";
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "ok", evidence: "e" }) }] }));
		env.catalogue.set("other/nokey", { provider: "other", id: "nokey" });
		env.authless.add("other/nokey");
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		expect(env.judgedBy.at(-1)).toBe("test/model");
		expect((await state(env)).status).toBe("complete");
	});

	test("a verifier model spec without a provider prefix is ignored", async () => {
		process.env.PI_GOAL_VERIFIER_MODEL = "judge";
		const env = setup([], async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ passed: true, reason: "ok", evidence: "e" }) }] }));
		env.catalogue.set("test/judge", { provider: "test", id: "judge" });
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		expect(env.judgedBy.at(-1)).toBe("test/model");
	});

	test("malformed verifier output pauses instead of completing", async () => {
		const env = setup([], async () => ({ content: [{ type: "text", text: "not json" }] }));
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		const state = (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
		expect(state.status).toBe("paused");
	});

	test("provider rejection pauses instead of completing", async () => {
		const env = setup([], async () => { throw new Error("provider unavailable"); });
		await run(env.commands.get("goal"), "task", env.ctx);
		await endWork(env);
		const state = (await env.tools.get("get_goal").execute("id", {}, undefined, undefined, env.ctx)).details;
		expect(state.status).toBe("paused");
	});
});



/**
 * The await windows.
 *
 * Every `await` in a lifecycle handler is a moment the user can pause, clear,
 * replace or switch sessions. These pin that a command landing in one of those
 * windows is honored rather than crashing the handler or being attributed to the
 * wrong goal.
 */
describe("goal await windows", () => {
  test("clearing during the plan read does not throw out of the handler", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    // Not awaited: the handler is parked inside the plan read when the clear
    // lands, which is exactly the window. Assigning `goal.planStep` after it used
    // to be a TypeError out of `agent_start`.
    const started = env.emit("agent_start");
    await run(env.commands.get("goal"), "clear", env.ctx);
    await expect(started).resolves.toBeUndefined();
    expect(env.appended.at(-1).data).toEqual({ schema: 1, cleared: true });
    expect(env.sent).toHaveLength(0);
  });

  test("replacing a goal while the planner runs cancels the planner", async () => {
    const signals: AbortSignal[] = [];
    let releaseFirst!: (value: unknown) => void;
    const env = setup([], undefined, ((_model: any, _context: any, options: any) => {
      const index = signals.length;
      signals.push(options?.signal);
      // The first planner is held open so the replace lands while it is running.
      return index === 0 ? new Promise((resolve) => { releaseFirst = resolve; }) : plannerReply();
    }) as any);

    const first = run(env.commands.get("goal"), "first objective", env.ctx);
    await tick();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    await run(env.commands.get("goal"), "replace second objective", env.ctx);
    // The superseded planner is aborted rather than left to finish: its result
    // belongs to a goal that no longer exists, so the tokens were paid for and
    // recorded nowhere.
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(2);

    releaseFirst(plannerReply(["stale criterion"], ["stale step"]));
    await first;
    const settled = await state(env);
    expect(settled.objective).toBe("second objective");
    // The stale plan is not attributed to the new goal.
    expect(settled.planCriteria).toEqual(["the objective is met"]);
  });

  test.skipIf(!canCreateSymlinks)("a plan path squatted by a symlink is refused, not written through", async () => {
    const env = setup();
    const target = join(env.sessionDir, "outside.md");
    await writeFile(target, "untouched", { encoding: "utf-8" });
    await symlink(target, planFileIn(env.sessionDir));

    await run(env.commands.get("goal"), "task", env.ctx);
    await tick();
    // `writeFile` follows the link, so without the lstat check the gating
    // contract would have been written outside the session directory.
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect((await state(env)).planPath).toBeUndefined();
    expect(env.notices.join("\n")).toContain("not a regular file");
  });
});

describe("goal robustness", () => {
  test("a mid-run report that exhausts the budget flips the goal there", async () => {
    // The budget used to be enforced only at a settled-run boundary, so a long
    // tool loop could overshoot it by an unbounded amount with nothing visible
    // until the run ended.
    const env = setup([], async () => verdict(true, 0));
    await run(env.commands.get("goal"), "task --tokens 5", env.ctx);
    await env.emit("agent_start");
    await env.emit("message_end", { message: verdict(true, 5) });
    expect((await state(env)).status).toBe("budget_limited");
    // The run was not plugin-driven, so it is left to finish: a user turn is the
    // user's output, and the goal merely stops being active.
    await env.emit("agent_end", { messages: [] });
    expect((await state(env)).status).toBe("budget_limited");
  });

  test("the same message object delivered twice is counted once even if it changed", async () => {
    // `message_end` and `agent_end` hand over the same stored object. The byte
    // hash alone misses it the moment any field differs between the two events,
    // and the goal then pays for its own transcript twice.
    const env = setup([], async () => verdict(true, 0));
    await run(env.commands.get("goal"), "task --tokens 1000", env.ctx);
    await env.emit("agent_start");
    const message = verdict(true, 7);
    await env.emit("message_end", { message });
    message.usage.totalTokens = 700;
    await env.emit("agent_end", { messages: [message] });
    expect((await state(env)).used).toBe(7);
  });

  test("a snapshot that cannot be persisted does not take the handler down", async () => {
    const env = setup();
    await run(env.commands.get("goal"), "task", env.ctx);
    env.pi.appendEntry = () => {
      throw new Error("disk full");
    };
    // `finish` persists before it reports; a throw there used to escape the
    // command handler and skip the status bar, the notification and the reason.
    await run(env.commands.get("goal"), "pause", env.ctx);
    expect((await state(env)).status).toBe("paused");
    expect(env.notices.join("\n")).toContain("Could not persist the goal snapshot");
  });
});
