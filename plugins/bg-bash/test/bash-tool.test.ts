/**
 * Capacity semantics of the bash tool.
 *
 * The running-job limit guards explicit `background: true` requests. A
 * foreground command must still run at capacity — it has not asked for a
 * background slot, and refusing `echo hi` because 20 jobs are up would be
 * wrong. If it outlives the threshold it may exceed the limit, which beats
 * blocking the tool call forever.
 */

import { describe, expect, test } from "bun:test";
import { JobRegistry } from "../src/core/jobs.ts";
import { createBgBashTool } from "../src/pi/bash-tool.ts";
import type { Runtime } from "../src/pi/runtime.ts";

function runtimeWith(registry: JobRegistry): Runtime {
	return {
		pi: {} as Runtime["pi"],
		registry,
		autoBackgroundSeconds: () => 30,
		backgroundLimit: () => 1,
		captureOrigin: () => () => true,
		deliver: () => {},
	};
}

const ctx: any = {
	cwd: process.cwd(),
	isIdle: () => true,
	hasUI: false,
	sessionManager: { getSessionId: () => "capacity-test", getSessionFile: () => undefined },
};

function registryAtCapacity(): JobRegistry {
	const registry = new JobRegistry({ runningLimit: 1 });
	registry.create({ command: "sleep 30", cwd: "/", mode: "background" });
	return registry;
}

describe("bash tool capacity", () => {
	test("refuses an explicit background job at capacity", async () => {
		const tool = createBgBashTool(runtimeWith(registryAtCapacity()));
		await expect(
			tool.execute("c1", { command: "sleep 30", background: true }, undefined, undefined, ctx),
		).rejects.toThrow(/Too many background jobs/);
	});

	test("still runs a foreground command at capacity", async () => {
		const tool = createBgBashTool(runtimeWith(registryAtCapacity()));
		const result = await tool.execute("c2", { command: "echo still-ran" }, undefined, undefined, ctx);
		expect(result.content.map((part: any) => part.text).join("")).toContain("still-ran");
	});
});
