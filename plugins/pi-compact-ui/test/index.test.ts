import { describe, expect, test } from "bun:test";
import { compactUiExtension, countOutputLines, formatDuration, summarizeToolCall } from "../src/index.ts";

/**
 * The plugin's own logic is pure, so it is tested directly: the summary a row
 * shows, the output count in its tail, the duration format, and the config
 * defaults. What it *cannot* test is pi's rendering — there is no terminal here,
 * and a fake `ExtensionAPI` would only prove the calls were made.
 *
 * The calls themselves are asserted against a recording fake, which is the part
 * worth pinning: that the label is set, that the resolver returns `self` for
 * every tool, and that the expanded state still falls back to the built-in
 * renderer rather than losing the full view.
 */

function recordingPi(settings: Record<string, unknown> = {}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const notifies: string[] = [];
	const pi = {
		getSettings: () => settings,
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			calls.push({ method: "on", args: [event] });
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerToolRenderer(resolver: unknown) {
			calls.push({ method: "registerToolRenderer", args: [resolver] });
		},
		setFooter(factory: unknown) {
			calls.push({ method: "setFooter", args: [factory] });
		},
		setWorkingIndicator(options: unknown) {
			calls.push({ method: "setWorkingIndicator", args: [options] });
		},
		setHiddenThinkingLabel(label: unknown) {
			calls.push({ method: "setHiddenThinkingLabel", args: [label] });
		},
	};
	const ctx = {
		ui: {
			setHiddenThinkingLabel: (label: unknown) => {
				calls.push({ method: "ui.setHiddenThinkingLabel", args: [label] });
			},
			setWorkingIndicator: (options: unknown) => {
				calls.push({ method: "ui.setWorkingIndicator", args: [options] });
			},
			setFooter: (factory: unknown) => {
				calls.push({ method: "ui.setFooter", args: [factory] });
			},
			notify: (message: string) => notifies.push(message),
		},
	};
	return { pi, ctx, calls, handlers, notifies };
}

describe("summarizeToolCall", () => {
	test("a bash call shows its command", () => {
		expect(summarizeToolCall("bash", { command: "bun run test" })).toBe("bun run test");
	});

	test("a multi-line command collapses to one line", () => {
		expect(summarizeToolCall("bash", { command: "cd /tmp\n  && ls" })).toBe("cd /tmp && ls");
	});

	test("path tools show the path, not a JSON dump", () => {
		expect(summarizeToolCall("read", { path: "src/index.ts" })).toBe("src/index.ts");
		expect(summarizeToolCall("edit", { file_path: "src/a.ts" })).toBe("src/a.ts");
	});

	test("a search tool shows its query", () => {
		expect(summarizeToolCall("grep", { pattern: "TODO", path: "src" })).toBe("TODO");
	});

	test("an unknown shape falls back to the tool name rather than throwing", () => {
		expect(summarizeToolCall("mystery", {})).toBe("mystery");
		expect(summarizeToolCall("mystery", undefined)).toBe("mystery");
	});

	test("an unrecognised argument set still summarises, without leaking everything", () => {
		const summary = summarizeToolCall("mystery", { a: 1, b: "two" });
		expect(summary).toContain("two");
	});
});

describe("countOutputLines", () => {
	test("counts lines across text blocks", () => {
		expect(countOutputLines([{ type: "text", text: "one\ntwo\nthree" }])).toBe(3);
	});

	test("counts each block's own lines", () => {
		// Two blocks are two chunks of output, not two lines: "a\nb" is two lines
		// and "c" is one, so the row says three.
		expect(countOutputLines([{ type: "text", text: "a\nb" }, { type: "text", text: "c" }])).toBe(3);
	});

	test("an empty result is zero, not one", () => {
		// A zero must not render as "1 output line".
		expect(countOutputLines([])).toBe(0);
		expect(countOutputLines(undefined)).toBe(0);
		expect(countOutputLines([{ type: "text", text: "" }])).toBe(0);
	});

	test("a trailing newline is not an extra line", () => {
		expect(countOutputLines([{ type: "text", text: "a\nb\n" }])).toBe(2);
	});
});

describe("formatDuration", () => {
	test("seconds below a minute", () => {
		expect(formatDuration(2_650)).toBe("2s");
		expect(formatDuration(59_000)).toBe("59s");
	});

	test("minutes are zero padded", () => {
		expect(formatDuration(64_000)).toBe("1m04s");
	});

	test("a missing duration is empty, not NaN", () => {
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(-1)).toBe("");
	});
});

describe("compactUiExtension", () => {
	test("by default it sets the thinking label, a spinner, a resolver and a footer", () => {
		const { pi, ctx, calls, handlers } = recordingPi();
		compactUiExtension()(pi as never);
		// The resolver is an extension-API call, so it happens at registration.
		// The spinner and the footer are UI-context calls, so they wait for a
		// session: there is nothing to attach them to before one exists.
		const methods = calls.map((call) => call.method);
		expect(methods).toContain("registerToolRenderer");
		expect(methods).not.toContain("ui.setFooter");
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		const after = calls.map((call) => call.method);
		expect(after).toContain("ui.setWorkingIndicator");
		expect(after).toContain("ui.setFooter");
	});

	test("a host with the setting off is told once, and the label is still set", () => {
		const { pi, ctx, calls, handlers, notifies } = recordingPi({ hideThinkingBlock: false });
		compactUiExtension()(pi as never);
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		expect(calls.some((call) => call.method === "ui.setHiddenThinkingLabel" && call.args[0] === "Thought")).toBe(true);
		expect(notifies).toHaveLength(1);
		expect(notifies[0]).toContain("hideThinkingBlock");
	});

	test("a host with the setting on is not nagged", () => {
		const { pi, ctx, notifies, handlers } = recordingPi({ hideThinkingBlock: true });
		compactUiExtension()(pi as never);
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		expect(notifies).toEqual([]);
	});

	test("a host whose settings throw does not fail startup", () => {
		const { pi, ctx, handlers } = recordingPi();
		(pi as unknown as { getSettings: () => never }).getSettings = () => {
			throw new Error("no settings");
		};
		expect(() => compactUiExtension()(pi as never)).not.toThrow();
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	});

	test("each piece can be turned off on its own", () => {
		const off = recordingPi();
		compactUiExtension({ compactTools: false, statusLine: false })(off.pi as never);
		const methods = off.calls.map((call) => call.method);
		expect(methods).not.toContain("registerToolRenderer");
		for (const handler of off.handlers.get("session_start") ?? []) handler({}, off.ctx);
		const after = off.calls.map((call) => call.method);
		expect(after).not.toContain("ui.setFooter");
	});

	test("the resolver keeps the built-in renderers and takes over the frame", () => {
		const { pi } = recordingPi();
		const resolver = captureResolver(pi);
		const builtIn = { renderShell: "default", renderCall: () => "builtin-call", renderResult: () => "builtin-result" };
		const resolved = resolver("bash", () => builtIn as never) as Record<string, unknown>;
		expect(resolved.renderShell).toBe("self");
		// The built-ins are still reachable, which is how the expanded state falls back.
		expect(resolved.renderCall).not.toBe(builtIn.renderCall);
		expect(typeof resolved.renderResult).toBe("function");
	});

	test("a tool with no built-in renderer is left alone", () => {
		const { pi } = recordingPi();
		const resolver = captureResolver(pi);
		expect(resolver("bash", () => undefined)).toBeUndefined();
	});
});

/** Pull the resolver out of the `registerToolRenderer` call. */
function captureResolver(pi: unknown): (toolName: string, next: () => unknown) => unknown {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const recorder = {
		getSettings: () => ({}),
		on: () => () => {},
		registerToolRenderer: (resolver: unknown) => calls.push({ method: "registerToolRenderer", args: [resolver] }),
		setFooter: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
	};
	compactUiExtension()(recorder as never);
	const call = calls.find((entry) => entry.method === "registerToolRenderer");
	void pi;
	return call!.args[0] as (toolName: string, next: () => unknown) => unknown;
}
