/**
 * End-to-end wiring against a fake pi.
 *
 * These tests spawn real shells, because the failure this plugin guards against
 * — a command that outlives the tool call without blocking it — only exists once
 * a real process is involved. Thresholds are env-driven and short, and every
 * test tears the session down so no `sleep` outlives the suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bgBashExtension, { BG_BASH_COMPLETION_ENTRY, BG_BASH_CUSTOM_TYPE } from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
	tools: Map<string, any>;
	messages: Array<{ message: any; options: any }>;
	notices: string[];
	entries: Array<{ type: string; customType: string; data: any }>;
	messageRenderers: Map<string, any>;
	entryRenderers: Map<string, any>;
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

function setup(onSend?: (message: any, options: any) => void): Harness {
	const tools = new Map<string, any>();
	const messages: Array<{ message: any; options: any }> = [];
	const notices: string[] = [];
	const entries: Array<{ type: string; customType: string; data: any }> = [];
	const messageRenderers = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
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
		registerMessageRenderer(customType: string, renderer: any) {
			messageRenderers.set(customType, renderer);
		},
		registerEntryRenderer(customType: string, renderer: any) {
			entryRenderers.set(customType, renderer);
		},
		appendEntry(customType: string, data: any) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: any, options: any) {
			if (onSend) return onSend(message, options);
			messages.push({ message, options });
		},
	};
	let sessionId = "test-session";
	const ctx: any = {
		cwd: process.cwd(),
		isIdle: () => true,
		hasUI: false,
		ui: { notify(message: string) { notices.push(message); } },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getBranch: () => sessionId === "test-session" ? entries : [],
			setSessionId(next: string) { sessionId = next; },
		},
		model: undefined,
		thinkingLevel: undefined,
	};
	bgBashExtension(pi);
	const harness: Harness = {
		tools,
		messages,
		notices,
		entries,
		messageRenderers,
		entryRenderers,
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

function completions(harness: Harness) {
	return harness.entries.filter((entry) => entry.customType === BG_BASH_COMPLETION_ENTRY);
}

/** The completion renderer only needs `fg`/`bg`/`bold`; a real Theme is not needed here. */
const themeStub = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await predicate()) return;
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

	test("moves a long command to the background and records success without waking", async () => {
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

		await waitFor(() => completions(harness).length === 1);
		expect(completions(harness)[0].data.status).toBe("exited");
		expect(harness.messages).toHaveLength(0);
		expect(textOf(await tasks(harness).execute("result", { action: "result", id: "bg001" }, undefined, undefined, harness.ctx))).toContain("auto-done");
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
		await waitFor(() => completions(harness).length === 1);
		expect(harness.messages).toHaveLength(0);
		expect(textOf(await tasks(harness).execute("result", { action: "result", id: "bg001" }, undefined, undefined, harness.ctx))).toContain("explicit-bg");
	});

	test("the terminal record renders as one status line without injecting stdout", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t25", { command: "echo rendered-for-humans", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		const render = harness.entryRenderers.get(BG_BASH_COMPLETION_ENTRY);
		expect(render).toBeDefined();
		const view = render(completions(harness)[0], { expanded: false }, themeStub).render(120).join("\n");
		expect(view).toContain("finished");
		expect(view).toContain("bg001");
		expect(view).not.toContain("rendered-for-humans");
		expect(harness.messages).toHaveLength(0);
	}, 15000);
});

describe("bg_tasks tool", () => {
	test("default failure wakes with metadata while full output stays queryable", async () => {
		const harness = setup();
		await bash(harness).execute("failed", { command: "echo diagnostic-detail; exit 7", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => harness.messages.length === 1);
		expect(harness.messages[0].message.customType).toBe(BG_BASH_CUSTOM_TYPE);
		expect(harness.messages[0].message.display).toBe(false);
		expect(harness.messages[0].message.content).toContain("bg001: failed (exit 7)");
		expect(harness.messages[0].message.content).not.toContain("diagnostic-detail");
		expect(textOf(await tasks(harness).execute("result", { action: "result", id: "bg001" }, undefined, undefined, harness.ctx))).toContain("diagnostic-detail");
	}, 15000);

	test("quiet suppresses even a failed completion", async () => {
		const harness = setup();
		await bash(harness).execute("quiet", { command: "exit 3", background: true, notify: "quiet" }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(harness.messages).toHaveLength(0);
		expect(completions(harness)[0].data.status).toBe("failed");
	}, 15000);

	test("explicit always batches simultaneous successes into one short notification", async () => {
		const harness = setup();
		await bash(harness).execute("one", { command: "echo one-output", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await bash(harness).execute("two", { command: "echo two-output", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 2);
		await waitFor(() => harness.messages.length === 1);
		expect(harness.messages[0].message.content).toContain("bg001: exited");
		expect(harness.messages[0].message.content).toContain("bg002: exited");
		expect(harness.messages[0].message.content).not.toContain("one-output");
	}, 15000);

	test("wait returns a bounded result when the required job settles", async () => {
		const harness = setup();
		await bash(harness).execute("waited", { command: "sleep 0.1; echo waited-output", background: true }, undefined, undefined, harness.ctx);
		const result = await tasks(harness).execute("wait", { action: "wait", id: "bg001", timeout: 2 }, undefined, undefined, harness.ctx);
		expect(textOf(result)).toContain("Requested job state reached.");
		expect(textOf(result)).toContain("bg001: exited");
		expect(textOf(result)).toContain("waited-output");
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("wait supports any of several jobs and reports unfinished peers", async () => {
		const harness = setup();
		await bash(harness).execute("first", { command: "sleep 0.1; echo first-ready", background: true }, undefined, undefined, harness.ctx);
		await bash(harness).execute("second", { command: "sleep 5", background: true }, undefined, undefined, harness.ctx);
		const output = textOf(await tasks(harness).execute("wait", { action: "wait", ids: ["bg001", "bg002"], mode: "any", timeout: 2 }, undefined, undefined, harness.ctx));
		expect(output).toContain("bg001: exited");
		expect(output).toContain("bg002: running");
	}, 15000);

	test("wait can be cancelled without stopping the background process", async () => {
		const harness = setup();
		await bash(harness).execute("waited", { command: "sleep 5", background: true }, undefined, undefined, harness.ctx);
		const controller = new AbortController();
		const waiting = tasks(harness).execute("wait", { action: "wait", id: "bg001" }, controller.signal, undefined, harness.ctx);
		controller.abort();
		expect(textOf(await waiting)).toContain("Wait cancelled.");
		expect(textOf(await tasks(harness).execute("status", { action: "status", id: "bg001" }, undefined, undefined, harness.ctx))).toContain("running");
	}, 15000);

	test("wait honours a fractional-second timeout", async () => {
		const harness = setup();
		await bash(harness).execute("slow", { command: "sleep 5", background: true }, undefined, undefined, harness.ctx);
		const started = Date.now();
		const output = textOf(await tasks(harness).execute("wait", { action: "wait", id: "bg001", timeout: 0.05 }, undefined, undefined, harness.ctx));
		expect(output).toContain("Wait timed out after 0.05s.");
		expect(Date.now() - started).toBeGreaterThanOrEqual(35);
	}, 15000);

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
		await waitFor(() => completions(harness).length === 1);

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
		expect(kill).toContain(`Job ${id} killed`);

		await waitFor(() => completions(harness).length === 1);
		expect(harness.messages).toHaveLength(0);
		const list = textOf(await tasks(harness).execute("l2", { action: "list" }, undefined, undefined, harness.ctx));
		expect(list).toContain(`${id} [killed`);
	}, 15000);

	test("log prefers the in-memory tail over a stale file", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t13", { command: "echo fresh-buffer-line", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);

		const status = textOf(await tasks(harness).execute("s3", { action: "status", id: "bg001" }, undefined, undefined, harness.ctx));
		const logPath = status.match(/Log: (.+)$/)?.[1]?.trim();
		expect(logPath).toBeDefined();
		writeFileSync(logPath!, "STALE-FILE-CONTENT\n");

		const log = textOf(await tasks(harness).execute("g2", { action: "log", id: "bg001" }, undefined, undefined, harness.ctx));
		expect(log).toContain("fresh-buffer-line");
		expect(log).not.toContain("STALE-FILE-CONTENT");
	});

	test("requires an id for status/log/kill", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await expect(tasks(harness).execute("s2", { action: "status" }, undefined, undefined, harness.ctx)).rejects.toThrow(/id/);
	});

	test("restored terminal metadata stays queryable and missing logs are explicit", async () => {
		const harness = setup();
		await bash(harness).execute("saved", { command: "echo saved-output", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		await harness.emit("session_start");
		const restored = textOf(await tasks(harness).execute("result", { action: "result", id: "bg001" }, undefined, undefined, harness.ctx));
		expect(restored).toContain("bg001: exited");
		expect(restored).toContain("saved-output");
		const path = completions(harness)[0].data.logPath;
		unlinkSync(path);
		expect(textOf(await tasks(harness).execute("result", { action: "result", id: "bg001" }, undefined, undefined, harness.ctx))).toContain("Output unavailable");
	}, 15000);

	test("log clamps a single oversized line to 50KB", async () => {
		const harness = setup();
		await bash(harness).execute("large", { command: "echo done", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		await harness.emit("session_start");
		writeFileSync(completions(harness)[0].data.logPath, "x".repeat(100000));
		const output = textOf(await tasks(harness).execute("log", { action: "log", id: "bg001", lines: 1000000 }, undefined, undefined, harness.ctx));
		expect(Buffer.byteLength(output)).toBeLessThan(52 * 1024);
		expect(output).toContain("[Truncated;");
	}, 15000);
});

/**
 * The wait-poll guard: a bare `sleep` while a job is running must end the turn
 * rather than let the model poll a result that will be delivered on its own.
 */
describe("session lifecycle", () => {
	test("completion waits through idle compaction instead of starting an agent run", async () => {
		const harness = setup();
		harness.ctx.isIdle = () => false;
		await bash(harness).execute("compacting", { command: "echo completed", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(harness.messages).toHaveLength(0);
		harness.ctx.isIdle = () => true;
		await waitFor(() => harness.messages.length === 1, 1000);
		expect(harness.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(harness.messages).toHaveLength(1);
	}, 15000);

	test("a completion held during compaction is dropped on session switch", async () => {
		const harness = setup();
		harness.ctx.isIdle = () => false;
		await bash(harness).execute("compacting", { command: "echo completed", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 80));
		await harness.emit("session_before_switch");
		harness.ctx.isIdle = () => true;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("a successful background job does not wake the agent after it has settled", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("quiet-success", { command: "echo finished", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);
		await harness.emit("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("session_start restores completed jobs and continues the id sequence", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t9", { command: "echo first-session", background: true }, undefined, undefined, harness.ctx);
		await waitFor(() => completions(harness).length === 1);

		await harness.emit("session_start");

		const list = textOf(await tasks(harness).execute("l3", { action: "list" }, undefined, undefined, harness.ctx));
		expect(list).toContain("bg001 [exited");

		const result = await bash(harness).execute("t10", { command: "echo second-session", background: true }, undefined, undefined, harness.ctx);
		expect(textOf(result)).toContain("bg002");
	});

	test("a formerly running job is restored as interrupted, not live", async () => {
		const harness = setup();
		await bash(harness).execute("old", { command: "sleep 5", background: true }, undefined, undefined, harness.ctx);
		await harness.emit("session_start");
		const status = textOf(await tasks(harness).execute("status", { action: "status", id: "bg001" }, undefined, undefined, harness.ctx));
		expect(status).toContain("bg001: interrupted");
		expect(status).toContain("Elapsed: unknown");
		expect(status).not.toContain("still running");
		const result = textOf(await tasks(harness).execute("result", { action: "result", id: "bg001" }, undefined, undefined, harness.ctx));
		expect(result).toContain("Ended: unknown");
		expect(result).toContain("Duration: unknown");
		expect(textOf(await bash(harness).execute("next", { command: "echo next", background: true }, undefined, undefined, harness.ctx))).toContain("bg002");
	}, 15000);

	test("a background job cannot deliver into a later session", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute(
			"t20",
			{ command: "sleep 0.2; echo stale-delivery", background: true },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.ctx.sessionManager.setSessionId("later-session");
		// The process finishes on its own; the completion must not arrive.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("an old job cannot settle a reused id after session_start", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("old", { command: "sleep 5", background: true }, undefined, undefined, harness.ctx);
		harness.ctx.sessionManager.setSessionId("new-session");
		await harness.emit("session_start");
		await bash(harness).execute("new", { command: "sleep 5", background: true }, undefined, undefined, harness.ctx);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const list = textOf(await tasks(harness).execute("list", { action: "list" }, undefined, undefined, harness.ctx));
		expect(list).toContain("bg001");
		expect(list).toContain("running");
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("auto-backgrounding keeps the session where the command started", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "0.1";
		const harness = setup();
		const result = bash(harness).execute(
			"auto-origin", { command: "sleep 0.3; echo old-session" },
			undefined, undefined, harness.ctx,
		);
		harness.ctx.sessionManager.setSessionId("later-session");
		expect(textOf(await result)).toContain("running in the background");
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("leaving a session kills its background jobs and drops the completion", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute(
			"t21",
			{ command: "sleep 5; echo leftover", background: true },
			undefined,
			undefined,
			harness.ctx,
		);
		await harness.emit("session_before_tree");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(harness.messages).toHaveLength(0);
		const list = textOf(await tasks(harness).execute("l4", { action: "list" }, undefined, undefined, harness.ctx));
		expect(list).not.toContain("running");
	}, 15000);

	test("a busy agent's background job cannot report after its session leaves", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		harness.ctx.isIdle = () => false;
		await bash(harness).execute(
			"t22",
			{ command: "sleep 0.2; echo queued-then-dropped", background: true },
			undefined,
			undefined,
			harness.ctx,
		);
		await harness.emit("session_before_switch");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("a completion after agent_end is handed to Pi at agent_settled", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		harness.ctx.isIdle = () => false;
		await harness.emit("agent_end");
		await bash(harness).execute("queued", { command: "echo completed", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(async () => textOf(await tasks(harness).execute("status", { action: "status", id: "bg001" }, undefined, undefined, harness.ctx)).includes("exited"));
		expect(harness.messages).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		harness.ctx.isIdle = () => true;
		await harness.emit("agent_settled");
		await waitFor(() => harness.messages.length === 1, 500);
		expect(harness.messages[0].message.content).toContain("bg001: exited");
		expect(harness.messages[0].message.content).not.toContain("completed");
		expect(harness.messages[0].message.display).toBe(false);
		expect(harness.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	}, 15000);

	test("an active agent receives an opted-in completion as a short steer", async () => {
		const harness = setup();
		harness.ctx.isIdle = () => false;
		await harness.emit("agent_start");
		await bash(harness).execute("steered", { command: "echo steer-output", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(() => harness.messages.length === 1);
		expect(harness.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(harness.messages[0].message.content).not.toContain("steer-output");
	}, 15000);

	test("a queued completion is discarded when its session leaves before agent_settled", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		harness.ctx.isIdle = () => false;
		await harness.emit("agent_end");
		await bash(harness).execute("queued", { command: "echo completed", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(async () => textOf(await tasks(harness).execute("status", { action: "status", id: "bg001" }, undefined, undefined, harness.ctx)).includes("exited"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		await harness.emit("session_before_switch");
		harness.ctx.isIdle = () => true;
		await harness.emit("agent_settled");
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("a failed follow-up delivery is reported without escaping the completion callback", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup(() => { throw new Error("delivery failed"); });
		await bash(harness).execute("undelivered", { command: "echo done", background: true, notify: "always" }, undefined, undefined, harness.ctx);
		await waitFor(() => harness.notices.length === 1);
		expect(harness.notices[0]).toContain("delivery failed");
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("a completion from a torn-down session manager is dropped, not thrown", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute(
			"t23",
			{ command: "sleep 0.2; echo after-teardown", background: true },
			undefined,
			undefined,
			harness.ctx,
		);
		// The launching context is torn down before the process settles.
		harness.ctx.sessionManager.getSessionId = () => { throw new Error("session manager unavailable"); };
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(harness.messages).toHaveLength(0);
	}, 15000);

	test("a completion does not depend on the origin's idle probe", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const escaped: unknown[] = [];
		const onUnhandled = (reason: unknown) => { escaped.push(reason); };
		process.on("unhandledRejection", onUnhandled);
		try {
			await bash(harness).execute(
				"t24",
				{ command: "sleep 0.2; echo after-idle-teardown", background: true, notify: "always" },
				undefined,
				undefined,
				harness.ctx,
			);
			// Session identity still matches; Pi's follow-up scheduler owns the
			// idle boundary, so this stale probe must not suppress delivery.
			harness.ctx.isIdle = () => { throw new Error("context torn down"); };
			await waitFor(() => harness.messages.length === 1);
			expect(escaped).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	}, 15000);
});

describe("poll guard", () => {
	test("a bare sleep while a job runs is blocked without ending the turn", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t7", { command: "sleep 30", background: true }, undefined, undefined, harness.ctx);

		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 30" } });
		expect((result as any).block).toBe(true);
		expect((result as any).terminate).toBeUndefined();
		expect((result as any).reason).toContain("bg_tasks");
	}, 15000);

	test("a sleep with a purpose is left alone", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t8", { command: "sleep 30", background: true }, undefined, undefined, harness.ctx);

		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 5 && npm test" } });
		expect(result).toBeUndefined();
	}, 15000);

	test("a powershell sleep is also recognised as a poll", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		await bash(harness).execute("t11", { command: "sleep 30", background: true }, undefined, undefined, harness.ctx);

		const result = await harness.emit("tool_call", { toolName: "powershell", input: { command: "sleep 30" } });
		expect((result as any).block).toBe(true);
	}, 15000);

	test("a running foreground job does not make a sleep a poll", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		// The foreground sleep is still in flight when the tool_call event fires.
		const pending = bash(harness).execute("t12", { command: "sleep 0.5" }, undefined, undefined, harness.ctx);
		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 30" } });
		expect(result).toBeUndefined();
		await pending;
	}, 15000);

	test("nothing is blocked when no job is running", async () => {
		process.env.PI_BG_BASH_THRESHOLD = "30";
		const harness = setup();
		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "sleep 30" } });
		expect(result).toBeUndefined();
	});
});
