import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectTaskNavigation } from "../src/task-navigation.ts";

function harness() {
	const events = new Map<string, Array<(value: any) => void>>();
	const on = (key: string, fn: (value: any) => void) => { events.set(key, [...(events.get(key) ?? []), fn]); };
	const emit = (key: string, value?: any) => { for (const fn of events.get(key) ?? []) fn(value); };
	const pi = { on, events: { on, emit } } as unknown as ExtensionAPI;
	const inputs = new Set<(data: string) => unknown>();
	let text = "";
	let overlay = false;
	let focus: any = { getText: () => text };
	let component: any;
	const ctx = {
		mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "a" },
		ui: {
			getEditorText: () => text, notify: () => {},
			onTerminalInput: (fn: (data: string) => unknown) => { inputs.add(fn); return () => inputs.delete(fn); },
			setWidget: (_key: string, factory: any) => {
				component = factory?.({ requestRender: () => {}, hasOverlay: () => overlay, getFocusedComponent: () => focus }, { fg: (_c: string, s: string) => s, bold: (s: string) => s });
			},
		},
	} as unknown as ExtensionContext;
	const input = (key: string) => [...inputs][0]?.(key);
	return { pi, ctx, emit, inputs, input, render: () => component?.render(100).join("\n") ?? "", text: (value: string) => { text = value; }, overlay: (value: boolean) => { overlay = value; }, focus: (value: any) => { focus = value; } };
}

const DOWN = "\x1b[B", UP = "\x1b[A", ENTER = "\r", ESC = "\x1b";

test("both plugins share one selector and enter opens only the highlighted category", async () => {
	const h = harness();
	const opened: string[] = [];
	const agents = connectTaskNavigation(h.pi, { key: "subagents", label: "Subagents", count: () => 2, open: async () => { opened.push("agents"); } });
	const bash = connectTaskNavigation(h.pi, { key: "background", label: "Background tasks", count: () => 1, open: async () => { opened.push("bash"); } });
	agents.sync(h.ctx); bash.sync(h.ctx);
	expect(h.inputs.size).toBe(1);
	expect(h.input(ENTER)).toBeUndefined();
	expect(h.input(DOWN)).toEqual({ consume: true });
	expect(opened).toEqual([]);
	expect(h.render()).toContain("› Background tasks (1)");
	h.input(DOWN);
	expect(h.render()).toContain("› Subagents (2)");
	h.input(ENTER);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(opened).toEqual(["agents"]);
	agents.clear(); bash.clear();
	expect(h.inputs.size).toBe(0);
});

test("typed prompts, dialogs, overlays and key releases retain their keys", () => {
	const h = harness();
	const nav = connectTaskNavigation(h.pi, { key: "subagents", label: "Subagents", count: () => 1, open: async () => {} });
	nav.sync(h.ctx);
	h.text("draft"); expect(h.input(DOWN)).toBeUndefined(); h.text("");
	h.emit("ui_prompt_start"); expect(h.input(DOWN)).toBeUndefined(); h.emit("ui_prompt_end");
	h.overlay(true); expect(h.input(DOWN)).toBeUndefined(); h.overlay(false);
	h.focus({ render: () => [] }); expect(h.input(DOWN)).toBeUndefined(); h.focus({ getText: () => "" });
	expect(h.input("\x1b[57353;1:3u")).toBeUndefined();
	expect(h.input(DOWN)).toEqual({ consume: true });
	expect(h.input(UP)).toEqual({ consume: true });
	expect(h.input(ENTER)).toBeUndefined();
	h.input(DOWN); h.input(ESC); expect(h.input(ENTER)).toBeUndefined();
	nav.clear();
});

test("settlement and teardown remove stale selection without opening another category", () => {
	const h = harness(); let count = 1;
	const nav = connectTaskNavigation(h.pi, { key: "subagents", label: "Subagents", count: () => count, open: async () => { throw new Error("must not open"); } });
	nav.sync(h.ctx); h.input(DOWN);
	count = 0; nav.sync(h.ctx);
	expect(h.input(ENTER)).toBeUndefined();
	expect(h.inputs.size).toBe(0);
	count = 1; nav.sync(h.ctx);
	expect(h.input(ENTER)).toBeUndefined();
	nav.clear();
});
