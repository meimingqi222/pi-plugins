/**
 * One shell command, from spawn to a settled outcome.
 *
 * `startCommand` returns synchronously with a handle, so the caller can race the
 * command against an auto-background threshold, kill it on abort/timeout, or
 * detach from abort when it moves to the background.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { RunOutcome, RunningCommand } from "../core/types.ts";
import { killTree, spawnShell } from "./process.ts";
import { resolveShell } from "./shell.ts";

/** How long to keep reading after `exit` when a descendant still holds the pipe. */
const EXIT_STDIO_GRACE_MS = 100;

export interface StartCommandOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Append every chunk here as well as to memory. Directory is created. */
	logPath?: string;
	shellPath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onData?: (chunk: string) => void;
	onSpawn?: (pid: number | undefined) => void;
}

export function startCommand(options: StartCommandOptions): RunningCommand {
	const shell = resolveShell(options.shellPath);
	const logStream = options.logPath ? openLog(options.logPath) : undefined;

	const child = spawnShell({
		shell,
		command: options.command,
		cwd: options.cwd,
		env: options.env ?? process.env,
	});
	const pid = child.pid;
	options.onSpawn?.(pid);

	let timedOut = false;
	let aborted = false;
	let killed = false;
	let spawnError: string | undefined;
	let settled = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let resolveResult!: (outcome: RunOutcome) => void;
	const result = new Promise<RunOutcome>((resolve) => {
		resolveResult = resolve;
	});

	const kill = (signal: NodeJS.Signals = "SIGKILL"): void => {
		killed = true;
		killTree(pid, signal);
	};

	const onAbort = (): void => {
		aborted = true;
		kill();
	};

	const detach = (): void => {
		options.signal?.removeEventListener("abort", onAbort);
	};

	const finish = (exitCode: number | null): void => {
		if (settled) return;
		settled = true;
		if (timeoutHandle) clearTimeout(timeoutHandle);
		detach();
		logStream?.end();
		resolveResult({ exitCode, timedOut, aborted, killed, spawnError });
	};

	const forward = (chunk: Buffer): void => {
		const text = chunk.toString("utf8");
		options.onData?.(text);
		logStream?.write(text);
	};
	child.stdout?.on("data", forward);
	child.stderr?.on("data", forward);
	child.on("error", (error) => {
		spawnError = error instanceof Error ? error.message : String(error);
	});

	void waitForTermination(child)
		.then((exitCode) => finish(exitCode))
		.catch((error: unknown) => {
			spawnError = error instanceof Error ? error.message : String(error);
			finish(null);
		});

	if (options.timeoutMs && options.timeoutMs > 0) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
	}

	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	return { pid, result, kill, detach };
}

function openLog(path: string): WriteStream | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		return createWriteStream(path, { flags: "a" });
	} catch {
		return undefined;
	}
}

/**
 * Wait for a child to terminate without hanging on inherited stdio handles.
 *
 * A short-lived shell can `exit` while a detached descendant keeps the
 * stdout/stderr pipe open. Resolving on a fixed deadline measured from `exit`
 * would truncate output still being written, so after `exit` the grace timer is
 * re-armed on every chunk: an actively writing descendant keeps us reading,
 * while a quiet inherited handle still releases us. Ported in spirit from pi's
 * `utils/child-process.ts`, which is not exported.
 */
function waitForTermination(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (graceTimer) clearTimeout(graceTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};
		const finalize = (code: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const maybeAfterExit = (): void => {
			if (exited && !settled && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		const armGrace = (): void => {
			if (graceTimer) clearTimeout(graceTimer);
			graceTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		function onData(): void {
			if (exited && !settled) armGrace();
		}
		function onStdoutEnd(): void {
			stdoutEnded = true;
			maybeAfterExit();
		}
		function onStderrEnd(): void {
			stderrEnded = true;
			maybeAfterExit();
		}
		function onError(error: Error): void {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		}
		function onExit(code: number | null): void {
			exited = true;
			exitCode = code;
			maybeAfterExit();
			if (!settled) armGrace();
		}
		function onClose(code: number | null): void {
			finalize(code);
		}

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
