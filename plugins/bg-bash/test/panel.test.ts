import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JobRegistry } from "../src/core/jobs.ts";
import { createBgTasksPanel } from "../src/pi/panel.ts";

test("background panel navigates by identity and opens live bounded output", () => {
	const registry = new JobRegistry();
	const a = registry.create({ command: "first", cwd: "/tmp", mode: "background" });
	const b = registry.create({ command: "second", cwd: "/tmp", mode: "background" });
	b.output.append(Array.from({ length: 40 }, (_, i) => `result ${i}`).join("\n"));
	const stopped: string[] = []; let closed = false;
	const panel = createBgTasksPanel({ tui: { requestRender: () => {} }, theme: { fg: (_c, s) => s, bold: (s) => s }, list: () => registry.list(), kill: (id) => { stopped.push(id); } }, () => { closed = true; });
	try {
		panel.render(80);
		// The registry's order, rather than an assumed creation order, is authoritative.
		const initial = registry.list().filter((job) => job.mode === "background");
		const target = initial[1]!;
		target.output.append("known output");
		panel.handleInput?.("\x1b[B");
		panel.handleInput?.("\r");
		expect(panel.render(80).join("\n")).toContain(target.command);
		panel.handleInput?.("k"); expect(stopped).toEqual([target.id]);
		for (let i = 0; i < 50; i++) panel.handleInput?.("\x1b[B");
		expect(panel.render(80).join("\n")).toContain("known output");
		panel.handleInput?.("\x1b"); expect(closed).toBe(false);
		for (const width of [10, 24, 80]) for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		panel.handleInput?.("\x1b"); expect(closed).toBe(true);
	} finally { panel.dispose(); }
});
