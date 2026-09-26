import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subagentExtension } from "../src/index.ts";

function fakePi() {
	const tools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
	const pi = {
		registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
		on() {},
		events: { on() {}, emit: () => {} },
		sendMessage() {},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session-a" }, isIdle: () => true };

describe("transport selection", () => {
	test("a foreground call never touches the RPC spawn path", async () => {
		const { pi, tools } = fakePi();
		let executorCalls = 0;
		let rpcCalls = 0;
		subagentExtension({
			discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
			executor: async (input) => {
				executorCalls += 1;
				// A foreground caller passes no rpc block — but even if the wiring
				// ever did, the executor seam must win for this path.
				expect((input as { rpc?: unknown }).rpc).toBeUndefined();
				return { status: "completed" as const, text: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } };
			},
			spawnRpcChild: async () => {
				rpcCalls += 1;
				throw new Error("foreground must not spawn RPC children");
			},
		})(pi);
		const result = await tools[0]!.execute!("call-1", { agent: "explore", task: "Check it" }, undefined, undefined, ctx);
		expect(result.details.status).toBe("completed");
		expect(executorCalls).toBe(1);
		expect(rpcCalls).toBe(0);
	});

	test("a background call rides RPC but an injected executor seam still wins", async () => {
		const { pi, tools } = fakePi();
		let executorCalls = 0;
		let rpcCalls = 0;
		subagentExtension({
			discover: () => [{ name: "explore", description: "read", systemPrompt: "E", filePath: "e.md" }],
			executor: async () => {
				executorCalls += 1;
				return { status: "completed" as const, text: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 } };
			},
			spawnRpcChild: async () => {
				rpcCalls += 1;
				throw new Error("the executor seam must win over the rpc block");
			},
		})(pi);
		await tools[0]!.execute!("call-1", { agent: "explore", task: "Check it", background: true }, undefined, undefined, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(executorCalls).toBe(1);
		expect(rpcCalls).toBe(0);
	});
});
