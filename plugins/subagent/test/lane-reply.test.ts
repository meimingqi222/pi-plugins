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
	const listeners = new Map<string, Array<(v: any) => void>>();
	const pi = {
		registerTool(tool: CapturedTool) { tools.push(tool); },
		on(name: string, handler: (v: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
		events: { on(name: string, handler: (v: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit: () => {} },
		sendMessage() {},
	} as unknown as ExtensionAPI;
	return { pi, tools };
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

/** Launch a background lane over the fake RPC transport; returns the lane id and the fake child. */
async function launchRpcLane() {
	const { pi, tools } = fakePi();
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
	await subagent.execute!("call-1", { agent: "explore", task: "Map it", background: true }, undefined, undefined, ctx());
	const launched = (await tasks.execute!("t-1", { action: "list" }, undefined, undefined, ctx())).details as Array<{ id: string }>;
	return { tasks, child: children[0]!, id: launched[0]!.id };
}

describe("subagent_tasks reply", () => {
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
