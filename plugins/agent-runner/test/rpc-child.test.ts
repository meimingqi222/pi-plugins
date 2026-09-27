import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
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
		child.writeLine({ type: "agent_end", messages: [] });
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
