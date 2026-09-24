/**
 * One shell command, from spawn to a settled outcome.
 *
 * `startCommand` returns synchronously with a handle, so the caller can race the
 * command against an auto-background threshold, kill it on abort/timeout, or
 * detach from abort when it moves to the background.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import type { RunOutcome, RunningCommand } from "../core/types.ts";
import { killTree, spawnShell } from "./process.ts";
import { resolveShell } from "./shell.ts";

/** How long to keep reading after `exit` when a descendant still holds the pipe. */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Hard bound on post-`exit` draining. The quiet-grace re-arms on every chunk,
 * so a descendant that writes forever (a daemonized `tail -f`, a watcher) would
 * otherwise keep the outcome pending for the life of the descendant.
 */
const EXIT_STDIO_DEADLINE_MS = 5000;

export interface StartCommandOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Append every chunk here as well as to memory. Directory is created. */
	logPath?: string;
	/** Provenance lines written at the top of the log file before any output. */
	logHeader?: string;
	shellPath?: string;
	timeoutMs?: number;
	/** Cap on post-`exit` stdio draining; defaults to EXIT_STDIO_DEADLINE_MS. */
	exitGraceDeadlineMs?: number;
	signal?: AbortSignal;
	onData?: (chunk: string) => void;
	onSpawn?: (pid: number | undefined) => void;
}

export function startCommand(options: StartCommandOptions): RunningCommand {
	const shell = resolveShell(options.shellPath);
	const logStream = options.logPath ? openLog(options.logPath) : undefined;
	if (logStream && options.logHeader) logStream.write(options.logHeader);

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
		// A kill racing a natural exit must not relabel it: once settled, the
		// outcome is already decided.
		if (settled) return;
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
		// Windows has no process signals: a `taskkill`-terminated process reports a
		// real exit code (usually 1), so a killed run would say "exit code 1"
		// where the contract is a signalled process with no exit code. Normalize
		// only when we are the ones who killed it.
		resolveResult({ exitCode: killed ? null : exitCode, timedOut, aborted, killed, spawnError });
	};

	// One decoder per stream: a multi-byte character split across chunks must
	// not surface as U+FFFD in the tail buffer or the log file.
	const forward = (stream: NodeJS.ReadableStream | null): void => {
		if (!stream) return;
		const decoder = new StringDecoder("utf8");
		stream.on("data", (chunk: Buffer) => {
			const text = decoder.write(chunk);
			options.onData?.(text);
			if (logStream && !logStream.destroyed) logStream.write(text);
		});
		stream.once("end", () => {
			const rest = decoder.end();
			if (!rest) return;
			options.onData?.(rest);
			if (logStream && !logStream.destroyed) logStream.write(rest);
		});
	};
	forward(child.stdout);
	forward(child.stderr);
	child.on("error", (error) => {
		spawnError = error instanceof Error ? error.message : String(error);
	});

	void waitForTermination(child, options.exitGraceDeadlineMs)
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
		// "w", not "a": a log path is unique to one job in one session, so an
		// existing file is stale output from an earlier session, not history.
		const stream = createWriteStream(path, { flags: "w" });
		// An asynchronous stream error (ENOSPC, deleted directory) would
		// otherwise surface as an uncaught exception and take down the host.
		stream.on("error", () => stream.destroy());
		return stream;
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
export function waitForTermination(
	child: ChildProcess,
	exitGraceDeadlineMs = EXIT_STDIO_DEADLINE_MS,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (graceTimer) clearTimeout(graceTimer);
			if (deadlineTimer) clearTimeout(deadlineTimer);
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
			if (!settled) {
				armGrace();
				// The quiet-grace re-arms on every chunk; this deadline does not,
				// so a descendant that never stops writing cannot hold the run open.
				deadlineTimer = setTimeout(() => finalize(exitCode), exitGraceDeadlineMs);
			}
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
