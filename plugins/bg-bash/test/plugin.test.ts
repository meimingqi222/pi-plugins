/**
 * End-to-end wiring against a fake pi.
 *
 * These tests spawn real shells, because the failure this plugin guards against
 * — a command that outlives the tool call without blocking it — only exists once
 * a real process is involved. Thresholds are env-driven and short, and every
 * test tears the session down so no `sleep` outlives the suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bgBashExtension, { BG_BASH_CUSTOM_TYPE } from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
	tools: Map<string, any>;
	messages: Array<{ message: any; options: any }>;
	ctx: any;
	emit(name: string, event?: any): Promise<unknown>;
}

const active: Harness[] = [];
let logDir: string;
let previousThreshold: string | undefined;
let previousLogDir: string | undefined;

beforeEach(() => {
	previousThreshold = process.env.PI_BG_BASH_THRESHOLD;
	previousLogDir = process.env.PI_BG_BASH_LOG_DIR;
	logDir = mkdtempSync(join(tmpdir(), "pi-bg-bash-"));
	process.env.PI_BG_BASH_LOG_DIR = logDir;
});

afterEach(async () => {
	for (const harness of active.splice(0)) await harness.emit("session_shutdown");
	if (previousThreshold === undefined) delete process.env.PI_BG_BASH_THRESHOLD;
	else process.env.PI_BG_BASH_THRESHOLD = previousThreshold;
	if (previousLogDir === undefined) delete process.env.PI_BG_BASH_LOG_DIR;
	else process.env.PI_BG_BASH_LOG_DIR = previousLogDir;
	rmSync(logDir, { recursive: true, force: true });
});

function setup(): Harness {
	const tools = new Map<string, any>();
	const messages: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, Handler[]>();
	const pi: any = {
		events: { on() {}, emit() {} },
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: any, options: any) {
			messages.push({ message, options });
		},
	};
	const ctx: any = {
		cwd: process.cwd(),
		isIdle: () => true,
		hasUI: false,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		model: undefined,
		thinkingLevel: undefined,
	};
	bgBashExtension(pi);
	const harness: Harness = {
		tools,
		messages,
		ctx,
		async emit(name: string, event: any = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
			return result;
		},
	};
	active.push(harness);
	return harness;
}

function bash(harness: Harness) {
	return harness.tools.get("bash");
}

function tasks(harness: Harness) {
	return harness.tools.get("bg_tasks");
}

function textOf(result: any): string {
	return result.content.map((part: any) => part.text ?? "").join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition not reached before timeout");
}

describe("bash tool", () => {
	test("returns output for a command that finishes before the threshold", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const result = await bash(harness).execute("t1", { command: "echo quick-foreground" }, undefined, undefined, harness.ctx);
		expect(textOf(result)).toContain("quick-foreground");
		expect(harness.messages).toHaveLength(0);
	});

	test("throws on a non-zero exit, carrying the output", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await expect(
			bash(harness).execute("t2", { command: "echo before-failure; exit 4" }, undefined, undefined, harness.ctx),
		).rejects.toThrow(/exited with code 4/);
	});

	test("moves a command that outlives the threshold to the background and reports back", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "0.2";
		const harness = setup();
		const result = await bash(harness).execute(
			"t3",
			{ command: "sleep 0.6; echo auto-done" },
			undefined,
			undefined,
			harness.ctx,
		);
		const notice = textOf(result);
		expect(notice).toContain("running in the background");
		expect(notice).toMatch(/bg\d{3}/);

		await waitFor(() => harness.messages.length > 0);
		const followUp = harness.messages[0];
		expect(followUp.message.customType).toBe(BG_BASH_CUSTOM_TYPE);
		expect(followUp.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(followUp.message.content).toContain("finished");
		expect(followUp.message.content).toContain("auto-done");
	}, 15000);

	test("background: true detaches immediately", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const result = await bash(harness).execute(
			"t4",
			{ command: "echo explicit-bg", background: true },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(textOf(result)).toContain("running in the background");
		await waitFor(() => harness.messages.length > 0);
		expect(harness.messages[0].message.content).toContain("explicit-bg");
	});
});

describe("bg_tasks tool", () => {
	test("lists nothing when no jobs exist", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const result = await tasks(harness).execute("l0", { action: "list" }, undefined, undefined, harness.ctx);
		expect(textOf(result)).toContain("No bash jobs");
	});

	test("reports status and full log of a finished background job", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t5", { command: "echo bg-log-line", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => harness.messages.length > 0);

		const list = textOf(await tasks(harness).execute("l1", { action: "list" }, undefined, undefined, harness.ctx));
		const id = list.match(/bg\d{3}/)?.[0];
		expect(id).toBeDefined();

		const status = textOf(await tasks(harness).execute("s1", { action: "status", id }, undefined, undefined, harness.ctx));
		expect(status).toContain(`${id}: exited`);

		const log = textOf(await tasks(harness).execute("g1", { action: "log", id }, undefined, undefined, harness.ctx));
		expect(log).toContain("bg-log-line");
	});

	test("kills a running job and records it as stopped", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const result = await bash(harness).execute("t6", { command: "sleep 30", background: true }, undefined, undefined, harness.ctx);
		const id = textOf(result).match(/bg\d{3}/)?.[0];
		expect(id).toBeDefined();

		const kill = textOf(await tasks(harness).execute("k1", { action: "kill", id }, undefined, undefined, harness.ctx));
		expect(kill).toContain(`Stopping job ${id}`);

		await waitFor(() => harness.messages.some((entry) => entry.message.content.includes("was stopped")));
		const list = textOf(await tasks(harness).execute("l2", { action: "list" }, undefined, undefined, harness.ctx));
		expect(list).toContain(`${id} [killed`);
	}, 15000);

	test("requires an id for status/log/kill", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await expect(tasks(harness).execute("s2", { action: "status" }, undefined, undefined, harness.ctx)).rejects.toThrow(/id/);
	});
});

/**
 * The wait-poll guard: a bare `sleep` while a job is running must end the turn
 * rather than let the model poll a result that will be delivered on its own.
 */
describe("poll guard", () => {
	test("a bare sleep while a job runs is blocked and ends the turn", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t7", { command: "sleep 30", background: true }, undefined, undefined, harness.ctx);

		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 30" } });
		expect((result as any).block).toBe(true);
		expect((result as any).terminate).toBe(true);
		expect((result as any).reason).toContain("bg_tasks");
	}, 15000);

	test("a sleep with a purpose is left alone", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t8", { command: "sleep 30", background: true }, undefined, undefined, harness.ctx);

		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 5 && npm test" } });
		expect(result).toBeUndefined();
	}, 15000);

	test("nothing is blocked when no job is running", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 30" } });
		expect(result).toBeUndefined();
	});
});
