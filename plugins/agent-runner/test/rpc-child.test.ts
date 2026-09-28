import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcRunArgs, spawnRpcChild } from "../src/rpc-child.ts";

class FakeChild extends EventEmitter {
	// No pid: teardown calls `process.kill(-pid)`, and a fixed fake id can
	// name a real process group on someone's machine. `process-tree.test.ts`
	// exercises the real kill against real children.
	pid = undefined;
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killedSignal: string | undefined;
	writes: string[] = [];

	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => this.writes.push(chunk.toString()));
	}
	kill(signal?: string): boolean {
		this.killedSignal = signal ?? "SIGTERM";
		return true;
	}
	unref(): void {}
	writeLine(line: object | string): void {
		this.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
	}
}

type SpawnFn = typeof import("node:child_process").spawn;

function fakeSpawn(child: FakeChild): SpawnFn {
	return ((_command: string, _args: readonly string[]) => child) as unknown as SpawnFn;
}

const doneUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };

/**
 * The grace windows exist so a real Pi child can clean up detached shells before
 * SIGKILL. A `FakeChild` never exits on SIGTERM, so every kill path here would
 * wait the production second out in full — ~13s across this file, for time no
 * assertion observes. The production values are measured against real children
 * in `process-tree.test.ts`; these tests only need the escalation to happen.
 */
const FAST = { terminationGraceMs: 20, stdioGraceMs: 20 };

describe("rpcRunArgs", () => {
	test("selects the RPC protocol without a session store", () => {
		expect(rpcRunArgs()).toEqual(["--mode", "rpc", "--no-session"]);
	});
});

describe("spawnRpcChild", () => {
	test("writes the initial prompt as a stdin command, not argv", async () => {
		const child = new FakeChild();
		const spawnArgs: string[][] = [];
		const spawnFn = ((command: string, args: readonly string[]) => { spawnArgs.push([command, ...args]); return child; }) as unknown as SpawnFn;
		const handle = await spawnRpcChild(
			{ prompt: "Task: hello", cwd: "/tmp" },
			{ spawnFn, invocation: { command: "pi", args: [] }, ...FAST },
		);
		expect(spawnArgs[0]).toContain("--mode");
		expect(spawnArgs[0]).toContain("rpc");
		// The prompt is never on the command line — it goes over stdin.
		expect(spawnArgs[0]).not.toContain("Task: hello");
		expect(child.writes.join("")).toContain('"type":"prompt"');
		expect(child.writes.join("")).toContain("Task: hello");
		handle.terminate();
		await handle.done;
	});

	test("agent_end does not settle the run; end() does, mapping to completed", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp" },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "message_start", message: { role: "assistant" } });
		child.writeLine({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "first answer" }], usage: doneUsage },
		});
		child.writeLine({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "first answer" }], usage: doneUsage }] });
		// The turn ended; the run must not have — done is still pending.
		const raced = await Promise.race([handle.done.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
		expect(raced).toBe("pending");
		handle.end();
		child.writeLine({ type: "response" }); // protocol ack lines are dropped
		const result = await handle.done;
		expect(result.status).toBe("completed");
		expect(result.text).toContain("first answer");
	});

	(process.platform === "win32" ? test.skip : test)("the evidence log is written private: directory 0o700, file 0o600", async () => {
		// The log holds prompts and tool output; the JSON transport already
		// writes it owner-only and the RPC transport must not be the laxer copy.
		const root = await mkdtemp(join(tmpdir(), "pi-rpc-evidence-"));
		try {
			const dir = join(root, "ev");
			const evidencePath = join(dir, "events.jsonl");
			const child = new FakeChild();
			const handle = await spawnRpcChild(
				{ prompt: "Task: hi", cwd: "/tmp", evidencePath },
				{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
			);
			child.writeLine({ type: "agent_start" });
			handle.end();
			await handle.done;
			expect((await stat(dir)).mode & 0o777).toBe(0o700);
			expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("terminate() resolves done as aborted and kills the child", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp" },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		handle.terminate();
		const result = await handle.done;
		expect(result.status).toBe("aborted");
		expect(child.killedSignal).toBe("SIGTERM");
	});

	test("idle change fires on turn boundaries, and send() follows the protocol shapes", async () => {
		const child = new FakeChild();
		const idle: boolean[] = [];
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", onIdleChange: (value) => idle.push(value) },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		expect(idle).toEqual([false]);
		// agent_end is not the turn's end: pi may still retry, compact, or drain a
		// queue. Only agent_settled marks the lane idle.
		child.writeLine({ type: "agent_end", messages: [] });
		expect(idle).toEqual([false]);
		child.writeLine({ type: "agent_settled" });
		expect(idle).toEqual([false, true]);
		expect(handle.send({ type: "steer", message: "now do Y" })).toBe(true);
		expect(handle.send({ type: "follow_up", message: "queued Q" })).toBe(true);
		expect(child.writes.join("")).toContain('"type":"steer"');
		expect(child.writes.join("")).toContain('"type":"follow_up"');
		expect(child.writes.join("")).toContain("now do Y");
		handle.terminate();
		await handle.done;
	});

	test("send() refuses after the run is finished", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp" },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		handle.terminate();
		await handle.done;
		expect(handle.send({ type: "prompt", message: "too late" })).toBe(false);
	});

	test("a turn that goes quiet is failed by the stall bound, naming the last event", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", stallMs: 100 },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "find", args: { path: "/home/someone" } });
		const result = await handle.done;
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("produced no output");
		expect(result.errorMessage).toContain("tool_start find");
		expect(child.killedSignal).toBe("SIGTERM");
	}, 10_000);

	test("a parallel sibling finishing does not strip a long call's declared budget", async () => {
		// The RPC twin of the executor test, and the reason the bookkeeping is keyed
		// per call: pi runs a batch in parallel, so a fast sibling ends while the long
		// silent call is still in flight.
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", stallMs: 80, timeoutMs: 200 },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { timeout: 30 } });
		child.writeLine({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "/tmp/x" } });
		child.writeLine({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", result: { content: [] } });
		const result = await handle.done;
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("timed out");
		expect(result.errorMessage).not.toContain("produced no output");
	}, 10_000);

	test("the first bound to fire owns the label, even when the wall clock expires during the grace period", async () => {
		// Termination has a 1s grace, so a shorter deadline can expire inside it. The
		// wall clock used to relabel whatever the silence bound had already decided,
		// reporting a stalled child as "timed out".
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", stallMs: 80, timeoutMs: 200 },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "find", args: {} });
		const result = await handle.done;
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("produced no output");
		expect(result.errorMessage).not.toContain("timed out");
	}, 10_000);

	test("a turn whose tool declared its own timeout is not killed by the silence bound", async () => {
		// The RPC call site of the composition rule, pinned separately: two copies of
		// process handling is exactly what this package's shared helpers exist to
		// avoid, and a rule wired on one transport only would be the same mistake.
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", stallMs: 80, timeoutMs: 400 },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { timeout: 30 } });
		const result = await handle.done;
		expect(result.status).toBe("failed");
		// The wall clock ended it; the declared 30s budget outranked the 80ms bound.
		expect(result.errorMessage).toContain("timed out");
		expect(result.errorMessage).not.toContain("produced no output");
	}, 10_000);

	test("an idle lane is not stalled: silence between turns is expected", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", stallMs: 60 },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		// Several stall windows pass while the child waits for its owner.
		await new Promise((resolve) => setTimeout(resolve, 250));
		const raced = await Promise.race([handle.done.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 10))]);
		expect(raced).toBe("pending");
		// A new turn re-arms the bound, so the lane is still bounded after a reply.
		child.writeLine({ type: "agent_start" });
		const result = await handle.done;
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("produced no output");
	}, 10_000);

	test("onTurnSettled fires once per agent_settled with that turn's outcome", async () => {
		const child = new FakeChild();
		const turns: Array<{ status: string; text?: string; errorMessage?: string }> = [];
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", onTurnSettled: (result) => turns.push(result) },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], usage: doneUsage } });
		child.writeLine({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "first answer" }], usage: doneUsage }] });
		child.writeLine({ type: "agent_settled" });
		expect(turns).toHaveLength(1);
		expect(turns[0]!.status).toBe("completed");
		expect(turns[0]!.text).toBe("first answer");
		// A second turn produces a second result, with the second turn's text.
		handle.send({ type: "prompt", message: "again" });
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second answer" }], usage: doneUsage } });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		expect(turns).toHaveLength(2);
		expect(turns[1]!.text).toBe("second answer");
		handle.terminate();
		await handle.done;
	});

	test("a turn with an error settles as failed, and a recovered turn clears it", async () => {
		const child = new FakeChild();
		const turns: Array<{ status: string; errorMessage?: string }> = [];
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", onTurnSettled: (result) => turns.push(result) },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "error", message: "provider exploded" });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		expect(turns).toHaveLength(1);
		expect(turns[0]!.status).toBe("failed");
		expect(turns[0]!.errorMessage).toBe("provider exploded");
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }], usage: doneUsage } });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		expect(turns).toHaveLength(2);
		expect(turns[1]!.status).toBe("completed");
		handle.terminate();
		await handle.done;
	});

	test("a new turn does not re-report the previous turn's text", async () => {
		const child = new FakeChild();
		const turns: Array<{ status: string; text?: string }> = [];
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", onTurnSettled: (result) => turns.push(result) },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], usage: doneUsage } });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		expect(turns[0]!.text).toBe("first answer");
		// A turn that produced no assistant text reports none — not the
		// previous turn's answer again.
		handle.send({ type: "prompt", message: "again" });
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		expect(turns).toHaveLength(2);
		expect(turns[1]!.text).toBe("");
		handle.terminate();
		// And the final outcome carries the last turn's text — empty here.
		expect((await handle.done).text).toBe("");
	});

	test("the run's final text survives an idle gap between turns", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp" },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the answer" }], usage: doneUsage } });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		// Keepalive end: no new turn started, so the answer is still the outcome.
		await new Promise((resolve) => setTimeout(resolve, 30));
		handle.end();
		expect((await handle.done).text).toBe("the answer");
	});

	test("a failed command response reaches onCommandError instead of being dropped", async () => {
		const child = new FakeChild();
		const errors: Array<{ command: string; error: string }> = [];
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", onCommandError: (info) => errors.push(info) },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		handle.send({ type: "prompt", message: "reply turn" });
		const writes = child.writes.join("").trim().split("\n").map((line) => JSON.parse(line) as { id: string; type: string });
		const prompt = writes.filter((write) => write.type === "prompt").at(-1)!;
		child.writeLine({ type: "response", id: prompt.id, command: "prompt", success: false, error: "Agent is already processing" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(errors).toContainEqual({ command: "prompt", error: "Agent is already processing" });
		handle.terminate();
		await handle.done;
	});

	test("prompt commands carry streamingBehavior followUp so pi queues them mid-turn", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp" },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		handle.send({ type: "prompt", message: "next question" });
		handle.send({ type: "steer", message: "no flag on steer" });
		const writes = child.writes.join("").trim().split("\n").map((line) => JSON.parse(line) as { type: string; streamingBehavior?: string });
		expect(writes.filter((write) => write.type === "prompt")).toHaveLength(2);
		for (const write of writes.filter((entry) => entry.type === "prompt")) {
			expect(write.streamingBehavior).toBe("followUp");
		}
		expect(writes.find((write) => write.type === "steer")!.streamingBehavior).toBeUndefined();
		handle.terminate();
		await handle.done;
	});

	test("the wall clock is per-turn: idle time does not spend it, a long turn does", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp", timeoutMs: 150 },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "agent_start" });
		child.writeLine({ type: "agent_end", messages: [] });
		child.writeLine({ type: "agent_settled" });
		// Well past timeoutMs, but the lane is idle awaiting a reply: still alive.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const raced = await Promise.race([handle.done.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 10))]);
		expect(raced).toBe("pending");
		// The reply turn gets a fresh budget; exceeding it fails with a timeout.
		handle.send({ type: "prompt", message: "again" });
		child.writeLine({ type: "agent_start" });
		const result = await handle.done;
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("timed out");
	}, 10_000);

	test("a dialog request is cancelled instead of pinning the child forever", async () => {
		const child = new FakeChild();
		const handle = await spawnRpcChild(
			{ prompt: "Task: hi", cwd: "/tmp" },
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] }, ...FAST },
		);
		child.writeLine({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Trust?" });
		child.writeLine({ type: "extension_ui_request", id: "ui-2", method: "select", title: "Pick" });
		// Fire-and-forget requests must not be answered — there is no pending entry.
		child.writeLine({ type: "extension_ui_request", id: "ui-3", method: "notify", message: "hi" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const written = child.writes.join("");
		expect(written).toContain('"type":"extension_ui_response"');
		expect(written).toContain('"id":"ui-1"');
		expect(written).toContain('"cancelled":true');
		expect(written).toContain('"id":"ui-2"');
		expect(written).not.toContain('"id":"ui-3"');
		handle.terminate();
		await handle.done;
	});
});
