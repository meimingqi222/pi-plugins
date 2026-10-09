import { describe, expect, test } from "bun:test";
import type { AgentRunResult, RpcChild, RpcChildInput } from "pi-agent-runner";
import { subagentExtension } from "../src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CapturedTool {
	name: string;
	execute?: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: any) => Promise<any>;
}

function fakePi() {
	const tools: CapturedTool[] = [];
	const messages: Array<{ message: any; options: any }> = [];
	const listeners = new Map<string, Array<(v: any) => void>>();
	const pi = {
		registerTool(tool: CapturedTool) { tools.push(tool); },
		on(name: string, handler: (v: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
		events: { on(name: string, handler: (v: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit: () => {} },
		sendMessage(message: any, options: any) { if (message.customType !== "subagent-update") messages.push({ message, options }); },
	} as unknown as ExtensionAPI;
	return { pi, tools, messages, emit: (name: string) => { for (const handler of listeners.get(name) ?? []) handler({}); } };
}

class FakeRpcChild implements RpcChild {
	readonly pid = 1;
	readonly done: Promise<AgentRunResult>;
	readonly sent: Array<{ type: string; message?: string }> = [];
	sendsSucceed = true;
	ended = false;
	private resolveDone!: (value: AgentRunResult) => void;
	constructor(readonly input: RpcChildInput) {
		this.done = new Promise((resolve) => { this.resolveDone = resolve; });
	}
	send(command: { type: "prompt" | "steer" | "follow_up" | "abort"; message?: string }): boolean {
		if (!this.sendsSucceed) return false;
		this.sent.push(command);
		return true;
	}
	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.resolveDone({ status: "completed", text: "last answer", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } });
	}
	terminate(): void {
		this.resolveDone({ status: "aborted", text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } });
	}
}

function ctx(sessionId = "session-a") {
	return { cwd: "/repo", sessionManager: { getSessionId: () => sessionId }, isIdle: () => true };
}

const doneUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };

/** Launch a background lane over the fake RPC transport; returns the lane id and the fake child. */
async function launchRpcLane() {
	const { pi, tools, messages } = fakePi();
	const children: FakeRpcChild[] = [];
	subagentExtension({
		discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
		spawnRpcChild: async (input) => {
			const child = new FakeRpcChild(input);
			children.push(child);
			return child;
		},
	})(pi);
	const subagent = tools[0]!;
	const tasks = tools[1]!;
	const launch = async (task = "Map it") =>
		subagent.execute!("call-1", { agent: "explore", task, background: true }, undefined, undefined, ctx());
	await launch();
	const launched = (await tasks.execute!("t-1", { action: "list" }, undefined, undefined, ctx())).details as Array<{ id: string }>;
	return { tasks, launch, children, messages, child: children[0]!, id: launched[0]!.id };
}

describe("subagent_tasks reply", () => {
	test("an idle reply cannot exceed the cap and can retry after a slot frees", async () => {
		const { tasks, launch, children, child, id } = await launchRpcLane();
		try {
			await launch(); await launch(); await launch();
			child.input.onIdleChange?.(true);
			await launch();
			const refused = await tasks.execute!("reply-1", { action: "reply", id, prompt: "next" }, undefined, undefined, ctx());
			expect(refused.content[0].text).toContain("At most 4 subagents");
			expect(child.sent).toEqual([]);
			expect((await tasks.execute!("show", { action: "show", id }, undefined, undefined, ctx())).details.idleSince).toBeDefined();
			children[4]!.end();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await tasks.execute!("reply-2", { action: "reply", id, prompt: "next" }, undefined, undefined, ctx());
			expect(child.sent).toEqual([{ type: "prompt", message: "next" }]);
			const extra = await launch();
			expect(extra.content[0].text).toContain("At most 4 subagents");
		} finally {
			for (const item of children) item.end();
			await Promise.all(children.map((item) => item.done));
		}
	});

	test("an unsuccessful idle reply preserves its idle slot and keepalive", async () => {
		const { tasks, launch, children, child, id } = await launchRpcLane();
		try {
			await launch(); await launch(); await launch();
			child.input.onIdleChange?.(true);
			const idleSince = (await tasks.execute!("before", { action: "show", id }, undefined, undefined, ctx())).details.idleSince;
			child.sendsSucceed = false;
			const refused = await tasks.execute!("reply", { action: "reply", id, prompt: "next" }, undefined, undefined, ctx());
			expect(refused.content[0].text).toContain("control channel is already closed");
			expect((await tasks.execute!("after", { action: "show", id }, undefined, undefined, ctx())).details.idleSince).toBe(idleSince);
			expect((await launch()).details.nativeStatus).toBe("running");
		} finally {
			for (const item of children) item.end();
			await Promise.all(children.map((item) => item.done));
		}
	});

	test("a mid-turn reply with interrupt sends steer", async () => {
		const { tasks, child, id } = await launchRpcLane();
		const res = await tasks.execute!("t-2", { action: "reply", id, prompt: "also check the retry path", interrupt: true }, undefined, undefined, ctx());
		expect(child.sent).toContainEqual({ type: "steer", message: "also check the retry path" });
		expect(res.content[0].text).toContain("steer");
	});

	test("a mid-turn reply without interrupt queues a follow_up", async () => {
		const { tasks, child, id } = await launchRpcLane();
		await tasks.execute!("t-2", { action: "reply", id, prompt: "when done, summarize" }, undefined, undefined, ctx());
		expect(child.sent).toContainEqual({ type: "follow_up", message: "when done, summarize" });
	});

	test("an idle lane takes a prompt and clears its idle mark", async () => {
		const { tasks, child, id } = await launchRpcLane();
		child.input.onIdleChange?.(true); // agent_end: the lane went idle
		const res = await tasks.execute!("t-2", { action: "reply", id, prompt: "next question" }, undefined, undefined, ctx());
		expect(child.sent).toContainEqual({ type: "prompt", message: "next question" });
		expect(res.content[0].text).toContain("new turn");
		expect((await tasks.execute!("t-3", { action: "show", id }, undefined, undefined, ctx())).details.idleSince).toBeUndefined();
	});

	test("reply requires a prompt, refuses a settled lane, and reports a dead channel", async () => {
		const { tasks, child, id } = await launchRpcLane();
		const noPrompt = await tasks.execute!("t-2", { action: "reply", id }, undefined, undefined, ctx());
		expect(noPrompt.content[0].text).toContain("prompt is required");

		child.sendsSucceed = false;
		const dead = await tasks.execute!("t-3", { action: "reply", id, prompt: "hi" }, undefined, undefined, ctx());
		expect(dead.content[0].text).toContain("control channel is already closed");
		child.sendsSucceed = true;

		child.end();
		await child.done;
		// `done` resolving and the lane's settle run in separate microtask turns;
		// yield so the registry sees the settled status before we assert on it.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const settled = await tasks.execute!("t-4", { action: "reply", id, prompt: "hi" }, undefined, undefined, ctx());
		expect(settled.content[0].text).toContain("cannot take a reply");
	});

	test("keepAlive ends an idle lane without a reply", async () => {
		const previous = process.env.PI_SUBAGENT_KEEPALIVE_MS;
		process.env.PI_SUBAGENT_KEEPALIVE_MS = "30";
		try {
			const { child } = await launchRpcLane();
			child.input.onIdleChange?.(true);
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(child.ended).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_KEEPALIVE_MS;
			else process.env.PI_SUBAGENT_KEEPALIVE_MS = previous;
		}
	});
});

describe("turn-settle delivery", () => {
	const settleTurn = (child: FakeRpcChild, text = "the answer", status: "completed" | "failed" = "completed") =>
		child.input.onTurnSettled?.({ status, text, usage: doneUsage });

	test("a settled turn delivers its answer immediately and wait/show can see it", async () => {
		const { tasks, child, id, messages } = await launchRpcLane();
		settleTurn(child);
		child.input.onIdleChange?.(true); // agent_settled marks the lane idle
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(messages).toHaveLength(1);
		expect(messages[0]!.message.customType).toBe("subagent-result");
		expect(messages[0]!.message.content).toContain("the answer");
		expect(messages[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		// The lane stays running — the process is alive awaiting a reply — but
		// its result is already visible.
		const shown = await tasks.execute!("t-2", { action: "show", id }, undefined, undefined, ctx());
		expect(shown.details.status).toBe("running");
		expect(shown.content[0].text).toContain("the answer");
		const waited = await tasks.execute!("t-3", { action: "wait", id, timeout: 5 }, undefined, undefined, ctx());
		expect(waited.content[0].text).toContain("the answer");
	});

	test("keepalive end() after a delivered answer does not deliver twice", async () => {
		const previous = process.env.PI_SUBAGENT_KEEPALIVE_MS;
		process.env.PI_SUBAGENT_KEEPALIVE_MS = "30";
		try {
			const { child, messages } = await launchRpcLane();
			settleTurn(child);
			child.input.onIdleChange?.(true);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(messages).toHaveLength(1);
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(child.ended).toBe(true);
			await child.done;
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(messages).toHaveLength(1);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_KEEPALIVE_MS;
			else process.env.PI_SUBAGENT_KEEPALIVE_MS = previous;
		}
	});

	test("a reply after idle then a second turn settle delivers again", async () => {
		const { tasks, child, id, messages } = await launchRpcLane();
		settleTurn(child, "first answer");
		child.input.onIdleChange?.(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(messages).toHaveLength(1);
		await tasks.execute!("t-2", { action: "reply", id, prompt: "next question" }, undefined, undefined, ctx());
		expect(child.sent).toContainEqual({ type: "prompt", message: "next question" });
		settleTurn(child, "second answer");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(messages).toHaveLength(2);
		expect(messages[1]!.message.content).toContain("second answer");
	});

	test("a mid-turn failure still delivers on final settle", async () => {
		const { child, messages } = await launchRpcLane();
		child.terminate();
		await child.done;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(messages).toHaveLength(1);
	});

	test("an idle lane does not hold a capacity slot", async () => {
		const { launch, children } = await launchRpcLane();
		await launch(); await launch(); await launch();
		// Four lanes are up; parking one leaves a slot for the fifth.
		children[0]!.input.onIdleChange?.(true);
		const fifth = await launch();
		expect(fifth.content[0].text).toContain("started in the background");
	});

	test("a wait on a busy next turn does not return the previous turn's answer", async () => {
		const { tasks, child, id } = await launchRpcLane();
		settleTurn(child, "first answer");
		child.input.onIdleChange?.(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await tasks.execute!("t-2", { action: "reply", id, prompt: "next question" }, undefined, undefined, ctx());
		// The lane is busy on turn 2 but still holds turn 1's result — a wait
		// must not resolve on the stale answer.
		const waiting = tasks.execute!("t-3", { action: "wait", id, timeout: 30 }, undefined, undefined, ctx());
		const raced = await Promise.race([waiting.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
		expect(raced).toBe("pending");
		settleTurn(child, "second answer");
		const waited = await waiting;
		expect(waited.content[0].text).toContain("second answer");
		expect(waited.content[0].text).not.toContain("first answer");
	});

	test("a failed command is reported on the lane, not swallowed", async () => {
		const { tasks, child, id } = await launchRpcLane();
		child.input.onCommandError?.({ command: "prompt", error: "Agent is already processing" });
		const shown = await tasks.execute!("t-2", { action: "show", id }, undefined, undefined, ctx());
		expect(shown.content[0].text).toContain("Agent is already processing");
	});
});

describe("foreground concurrency", () => {
	/** A rig whose executor blocks each call until released, so overlap is observable. */
	function fgRig() {
		const { pi, tools, emit } = fakePi();
		const calls: string[] = [];
		const gates = new Map<string, () => void>();
		const updates = new Map<string, string[]>();
		subagentExtension({
			discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
			executor: async (input) => {
				calls.push(input.prompt);
				await new Promise<void>((resolve) => {
					gates.set(input.prompt, resolve);
					if (input.signal?.aborted) resolve();
					else input.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { status: input.signal?.aborted ? "aborted" : "completed", text: `done ${input.prompt}`, usage: doneUsage };
			},
		})(pi);
		const call = (id: string, task: string, signal?: AbortSignal, sessionId = "session-a") =>
			tools[0]!.execute!(
				id,
				{ agent: "explore", task, background: false },
				signal,
				(update: any) => {
					const text = update?.content?.[0]?.text;
					if (typeof text === "string") updates.set(task, [...(updates.get(task) ?? []), text]);
				},
				ctx(sessionId),
			);
		return { tools, call, calls, gates, updates, emit };
	}

	async function withLimit<T>(limit: string, run: () => Promise<T>): Promise<T> {
		const previous = process.env.PI_SUBAGENT_MAX_CONCURRENCY;
		process.env.PI_SUBAGENT_MAX_CONCURRENCY = limit;
		try {
			return await run();
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_MAX_CONCURRENCY;
			else process.env.PI_SUBAGENT_MAX_CONCURRENCY = previous;
		}
	}

	test("session teardown cancels queued foreground calls without a host abort signal", async () => {
		await withLimit("1", async () => {
			const { call, calls, gates, emit } = fgRig();
			const first = call("first", "a");
			const queued = call("queued", "b");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(calls).toEqual(["Task: a"]);
			emit("session_before_switch");
			try {
				const result = await Promise.race([queued, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))]);
				expect(result?.details.nativeStatus).toBe("aborted");
				expect(calls).toEqual(["Task: a"]);
			} finally {
				for (const finish of gates.values()) finish();
				await Promise.all([first, queued]);
			}
			const next = call("new-session", "c", undefined, "session-b");
			await new Promise((resolve) => setTimeout(resolve, 0));
			gates.get("Task: c")!();
			expect((await next).details.nativeStatus).toBe("completed");
		});
	});

	test("session teardown rejects an already granted foreground reservation", async () => {
		await withLimit("1", async () => {
			const { call, calls, gates, emit } = fgRig();
			const pending = call("old", "a");
			emit("session_before_switch");
			await new Promise((resolve) => setTimeout(resolve, 0));
			try {
				expect(calls).toEqual([]);
			} finally {
				for (const finish of gates.values()) finish();
			}
			expect((await pending).details.nativeStatus).toBe("aborted");
		});
	});

	test("a third foreground call waits for a slot instead of spawning past the cap", async () => {
		await withLimit("2", async () => {
			const { call, calls, gates, updates } = fgRig();
			const p1 = call("c1", "a");
			const p2 = call("c2", "b");
			const p3 = call("c3", "c");
			await new Promise((resolve) => setTimeout(resolve, 20));
			// Only two children exist; the third call parked on the fleet.
			expect(calls).toEqual(["Task: a", "Task: b"]);
			expect(updates.get("c")).toEqual(["waiting for a subagent slot (2 busy)"]);
			gates.get("Task: a")!();
			await p1;
			const deadline = Date.now() + 2_000;
			while (!calls.includes("Task: c") && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(calls).toContain("Task: c");
			gates.get("Task: b")!();
			gates.get("Task: c")!();
			const r3 = await p3;
			await p2;
			expect(r3.details.status).toBe("completed");
			expect(r3.details.output).toContain("done Task: c");
		});
	});

	test("aborting a queued call returns aborted and spawns nothing", async () => {
		await withLimit("2", async () => {
			const { call, calls, gates } = fgRig();
			const p1 = call("c1", "a");
			const p2 = call("c2", "b");
			const controller = new AbortController();
			const p3 = call("c3", "c", controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();
			const r3 = await p3;
			expect(r3.details.status).toBe("aborted");
			expect(r3.content[0].text).toContain("cancelled");
			expect(calls).toEqual(["Task: a", "Task: b"]);
			// Freeing a slot afterwards must not resurrect the aborted call.
			gates.get("Task: a")!();
			gates.get("Task: b")!();
			await p1;
			await p2;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(calls).toEqual(["Task: a", "Task: b"]);
		});
	});

	test("a background launch is refused while foreground calls hold the fleet", async () => {
		await withLimit("2", async () => {
			const { tools, call, gates } = fgRig();
			const p1 = call("c1", "a");
			const p2 = call("c2", "b");
			await new Promise((resolve) => setTimeout(resolve, 20));
			const refused = await tools[0]!.execute!("c4", { agent: "explore", task: "bg", background: true }, undefined, undefined, ctx());
			expect(refused.details.nativeStatus).toBe("failed");
			expect(refused.content[0].text).toContain("At most 2 subagents may run at once");
			gates.get("Task: a")!();
			gates.get("Task: b")!();
			await p1;
			await p2;
		});
	});
});
