/**
 * The process I/O both transports (`executor.ts`' JSON child and
 * `rpc-child.ts`' RPC child) share. Two copies of this code existed and had
 * already drifted: the RPC copy wrote its evidence log with default
 * permissions and truncated it differently. The log holds prompts and tool
 * output, so the laxer copy was the wrong one — there is one of each helper
 * now for the same reason the transports were unified in the first place.
 */

import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	stallFailureMessage,
	timeoutFailureMessage,
	type AgentRunResult,
	type StreamState,
} from "./executor.ts";

export const MAX_STDERR_CHARS = 8_000;
/** Bounded so a runaway child cannot grow the parent's heap through its own output. */
export const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/** Write the delegated system prompt to a private temp file, or return undefined. */
export async function writeSystemPromptFile(
	systemPrompt: string | undefined,
	root = tmpdir(),
	prefix = "pi-agent-",
): Promise<{ dir: string; file: string } | undefined> {
	if (!systemPrompt || !systemPrompt.trim()) return undefined;
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(root, prefix));
		const file = join(dir, "system-prompt.md");
		await writeFile(file, systemPrompt, { encoding: "utf-8", mode: 0o600 });
		return { dir, file };
	} catch (error) {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`Could not prepare delegated system prompt: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export interface EvidenceWriter {
	/** Append one raw line; best-effort, so a write failure never fails the run. */
	write(line: string): void;
	/** Resolves once every queued append has landed (or been dropped on error). */
	flush(): Promise<void>;
}

/**
 * A bounded, permission-tight append sink for a child's raw event stream.
 *
 * The log holds prompts and tool data, so the directory is 0o700 and every
 * append 0o600. Past `maxBytes` a truncation marker is written in place of
 * further lines — and only when the marker itself still fits inside the cap,
 * so the file never grows past it.
 */
export function createEvidenceWriter(options: { path?: string; maxBytes?: number }): EvidenceWriter {
	const path = options.path;
	const maxBytes = options.maxBytes !== undefined && options.maxBytes > 0 ? Math.floor(options.maxBytes) : undefined;
	const marker = maxBytes === undefined ? undefined : `${JSON.stringify({ type: "evidence_truncated", maxBytes })}\n`;
	const markerBytes = marker ? Buffer.byteLength(marker, "utf8") : 0;
	let bytes = 0;
	let truncated = false;
	// Appends are ordered through one queue so a fast event stream cannot
	// interleave partial lines.
	let queue: Promise<void> = path
		? mkdir(dirname(path), { recursive: true, mode: 0o700 })
				.then(async () => {
					try { bytes = (await stat(path)).size; } catch { /* New file. */ }
				})
				.catch(() => undefined)
		: Promise.resolve();
	return {
		write(line: string): void {
			if (!path) return;
			queue = queue.then(async () => {
				if (truncated) return;
				const record = `${line}\n`;
				const size = Buffer.byteLength(record, "utf8");
				if (maxBytes !== undefined && bytes + size > maxBytes - markerBytes) {
					truncated = true;
					if (marker && bytes + markerBytes <= maxBytes) {
						await appendFile(path, marker, { encoding: "utf8", mode: 0o600 });
						bytes += markerBytes;
					}
					return;
				}
				await appendFile(path, record, { encoding: "utf8", mode: 0o600 });
				bytes += size;
			}).catch(() => undefined);
		},
		flush: () => queue,
	};
}

/**
 * Split a UTF-8 stdout stream into JSON records.
 *
 * Splits only on LF — `readline` would treat Unicode line separators inside a
 * JSON string as record boundaries. The buffer is capped: a child that never
 * terminates a line must not grow the parent's heap, and the partial record
 * at the head of an over-cap buffer is unusable anyway, so the tail is kept.
 *
 * `onLine` fires once per raw line (trailing CR stripped, empty lines
 * included — an evidence sink wants those too) with the parsed event, or
 * `undefined` when the line is not JSON — diagnostics, not an event.
 */
export function createJsonLineReader(
	onLine: (line: string, event: unknown | undefined) => void,
): (chunk: string) => void {
	let buffer = "";
	return (chunk: string) => {
		buffer += chunk;
		if (buffer.length > MAX_BUFFER_CHARS) buffer = buffer.slice(-MAX_BUFFER_CHARS / 2);
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/u, "");
			buffer = buffer.slice(index + 1);
			let event: unknown | undefined;
			const text = line.trim();
			if (text) {
				try { event = JSON.parse(text); } catch { /* Diagnostics, not an event. */ }
			}
			onLine(line, event);
		}
	};
}

function tryParse(parse: ((text: string) => unknown) | undefined, text: string): unknown {
	if (!parse) return undefined;
	try {
		return parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The one outcome mapping for a finished child, shared so both transports
 * report the same shape for the same end state.
 *
 * `parse` is the JSON transport's optional structured-value step — an RPC
 * caller gets text only, so it passes none. Without `parse` the contract is
 * "the reply text is the value", and a reply that happens to be JSON-shaped
 * must still arrive as text.
 */
export function mapRunOutcome(input: {
	killedBy?: "timeout" | "abort" | "stalled";
	stalledForMs?: number;
	lastEventLabel?: string;
	quietMs?: number;
	timeoutMs: number;
	evidencePath?: string;
	stderr?: string;
	exitCode?: number | null;
	state: StreamState;
	parse?: (text: string) => unknown;
}): AgentRunResult {
	const { state } = input;
	const exitedWithFailure = input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0;
	// Ambient extensions load in the child, so a startup warning on stderr is
	// routine. It is a verdict only where nothing else can be: a run that
	// replied and exited 0 succeeded, whatever it wrote to stderr, and
	// promoting that text to `errorMessage` discards the answer it produced.
	if (state.errorMessage === undefined && input.stderr?.trim() && (exitedWithFailure || !state.finalText.trim())) {
		state.errorMessage = input.stderr.trim().slice(0, 2_000);
	}
	if (state.errorMessage === undefined && exitedWithFailure) {
		state.errorMessage = `The agent exited with code ${input.exitCode}.`;
	}
	if (input.killedBy) {
		if (input.killedBy === "abort") {
			return { status: "aborted", stopReason: "aborted", text: state.finalText, usage: state.usage };
		}
		return {
			status: "failed",
			text: state.finalText,
			errorMessage: input.killedBy === "stalled"
				? stallFailureMessage({
						stalledForMs: input.stalledForMs ?? 0,
						lastEvent: input.lastEventLabel ?? "event",
						...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
					})
				: timeoutFailureMessage({ timeoutMs: input.timeoutMs, lastEvent: input.lastEventLabel, quietMs: input.quietMs, ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}) }),
			usage: state.usage,
		};
	}
	if (state.errorMessage) {
		return { status: "failed", errorMessage: state.errorMessage, text: state.finalText, usage: state.usage };
	}
	const parsed = tryParse(input.parse, state.finalText);
	return {
		status: "completed",
		text: state.finalText,
		...(parsed === undefined ? {} : { value: parsed }),
		usage: state.usage,
		...(state.model ? { model: state.model } : {}),
		...(state.stopReason ? { stopReason: state.stopReason } : {}),
	};
}
