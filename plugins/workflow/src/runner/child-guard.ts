/**
 * A guard loaded into every workflow child, not into the user's session.
 *
 * A child agent whose role allows `bash` (`qa` does, so it can run tests) has no
 * per-command timeout: pi's bash tool has no default. One hanging shell command
 * inside a child — a broad `find`, a `cat` on stdin, a probe that never returns —
 * therefore consumes the entire per-agent budget, and the agent is killed with
 * nothing to show. Bounding the command is the difference between "one tool call
 * failed and the agent recovered" and "fifteen minutes of work lost".
 *
 * It injects a default `timeout` by mutating the `tool_call` input, so it needs no
 * reimplementation of the shell tool. Two deliberate limits:
 *
 * - It touches the builtin shell tool, or an extension's shell tool whose
 *   parameters schema declares a `timeout` property with the same seconds
 *   semantics (`pi-bg-bash` does). The old "step aside for bg-bash" rule
 *   assumed a backgrounded command wakes the agent later — true in the user's
 *   interactive session, false in a headless child: spawned children run with
 *   `PI_BG_BASH_THRESHOLD=0` (auto-background off) and no session to wake, so
 *   an unbounded command is pure risk. An extension shell that declares no
 *   `timeout` is still left alone — guessing someone else's parameter shape is
 *   the worse failure.
 * - It only fills a timeout that is **absent**. A command that set its own keeps
 *   it, and a script that wants no bound can set
 *   `PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS=0`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Ten minutes: long enough for a real test run, short enough to free a stuck agent. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/** The timeout to inject, in seconds. `0` disables the guard. */
export function childShellTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS / 1_000;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value < 0) return DEFAULT_TIMEOUT_MS / 1_000;
	return value / 1_000;
}

/** Whether the registered shell tool is pi's own, rather than an extension's. */
export function ownsBuiltinShellTool(pi: Pick<ExtensionAPI, "getAllTools">, name: string): boolean {
	try {
		return pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo?.source === "builtin";
	} catch {
		// If the registry cannot be read, do not guess: leaving the command
		// unbounded is the status quo, and injecting into someone else's tool is
		// the worse failure.
		return false;
	}
}

/**
 * Fill in a missing timeout. Returns whether the input was changed.
 *
 * Mutates in place because that is what the `tool_call` event forwards to the
 * executor; `event.input` is explicitly documented as mutable for this purpose.
 */
export function injectShellTimeout(input: { timeout?: unknown }, seconds: number): boolean {
	if (seconds <= 0 || input.timeout !== undefined) return false;
	input.timeout = seconds;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Whether the registered shell tool accepts an injected `timeout`: pi's own
 * builtin tool, or an extension tool whose schema declares the property —
 * the contract that lets `pi-bg-bash`'s shell take the same bound.
 */
export function shellToolAcceptsTimeout(pi: Pick<ExtensionAPI, "getAllTools">, name: string): boolean {
	if (ownsBuiltinShellTool(pi, name)) return true;
	try {
		const tool = pi.getAllTools().find((candidate) => candidate.name === name);
		const parameters = (tool as { parameters?: unknown } | undefined)?.parameters;
		return isRecord(parameters) && isRecord(parameters.properties) && "timeout" in parameters.properties;
	} catch {
		return false;
	}
}

export default function childGuardExtension(pi: ExtensionAPI): void {
	const seconds = childShellTimeoutSeconds();
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		if (!shellToolAcceptsTimeout(pi, event.toolName)) return;
		injectShellTimeout(event.input as { timeout?: unknown }, seconds);
	});
}
