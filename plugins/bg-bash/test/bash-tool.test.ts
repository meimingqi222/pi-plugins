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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		started: () => {},
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

	test("returns terminal details for a completed foreground command", async () => {
		const tool = createBgBashTool(runtimeWith(new JobRegistry()));
		const result = await tool.execute("c3", { command: "echo completed" }, undefined, undefined, ctx);

		expect(result.details).toMatchObject({ status: "exited", exitCode: 0, mode: "foreground" });
	});
});

describe("shell settings", () => {
	test("prepends the configured shellCommandPrefix like the builtin tool", async () => {
		const tool = createBgBashTool({
			...runtimeWith(new JobRegistry()),
			shellSettings: () => ({ commandPrefix: "export BG_PREFIX_PROBE=ok" }),
		});
		const result = await tool.execute("p1", { command: "echo $BG_PREFIX_PROBE" }, undefined, undefined, ctx);
		expect(result.content.map((part: any) => part.text).join("")).toContain("ok");
		// The prefix is environment setup; the recorded command is the user's.
		expect(result.details).toMatchObject({ command: "echo $BG_PREFIX_PROBE" });
	});

	test("passes the configured shellPath through to the runner", async () => {
		if (process.platform === "win32") return;
		// A stand-in shell that ignores its arguments and prints a marker, so
		// the output proves which executable ran the command.
		const dir = mkdtempSync(join(tmpdir(), "bg-bash-shell-"));
		try {
			const fakeShell = join(dir, "probe-shell");
			writeFileSync(fakeShell, "#!/bin/sh\nprintf 'PROBE-SHELL-RAN\\n'\n");
			chmodSync(fakeShell, 0o755);
			const tool = createBgBashTool({
				...runtimeWith(new JobRegistry()),
				shellSettings: () => ({ shellPath: fakeShell }),
			});
			const result = await tool.execute("p2", { command: "echo not-the-real-shell" }, undefined, undefined, ctx);
			const text = result.content.map((part: any) => part.text).join("");
			expect(text).toContain("PROBE-SHELL-RAN");
			expect(text).not.toContain("not-the-real-shell");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("runs without a settings reader, as before the seam existed", async () => {
		const tool = createBgBashTool(runtimeWith(new JobRegistry()));
		const result = await tool.execute("p3", { command: "echo no-settings" }, undefined, undefined, ctx);
		expect(result.content.map((part: any) => part.text).join("")).toContain("no-settings");
	});
});
