/**
 * Process spawn and tree termination.
 *
 * Both operations are platform branches because there is no portable way to do
 * them: Unix gets a detached process group so a negative-pid signal reaches the
 * whole tree, Windows gets `taskkill /F /T` from the trusted System32 copy.
 * These mirror pi's own `utils/shell.ts`, which is not part of the package's
 * public surface.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { ShellSpec } from "./shell.ts";

export interface SpawnShellInput {
	shell: ShellSpec;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export function spawnShell(input: SpawnShellInput): ChildProcess {
	const { shell } = input;
	const args = shell.commandFromStdin ? shell.args : [...shell.args, input.command];
	const child = spawn(shell.shell, args, {
		cwd: input.cwd,
		// On Unix a new process group is what makes `kill(-pid)` reach children.
		// On Windows `taskkill /T` walks the tree instead, so pi (and we) skip it.
		detached: process.platform !== "win32",
		env: input.env,
		stdio: [shell.commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (shell.commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(input.command);
	}
	return child;
}

/** Kill a process and every process it spawned. Errors are best-effort. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			const killer = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			// A failed spawn emits "error" asynchronously; consume it so it cannot crash us.
			killer.once("error", () => {});
			killer.unref();
		} catch {
			// Nothing else to try.
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already gone.
		}
	}
}
