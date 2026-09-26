import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { rpcRunArgs, spawnRpcChild } from "../src/rpc-child.ts";

class FakeChild extends EventEmitter {
	pid = 4242;
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
			{ spawnFn, invocation: { command: "pi", args: [] } },
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
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] } },
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
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] } },
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
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] } },
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
			{ spawnFn: fakeSpawn(child), invocation: { command: "pi", args: [] } },
		);
		handle.terminate();
		await handle.done;
		expect(handle.send({ type: "prompt", message: "too late" })).toBe(false);
	});
});
