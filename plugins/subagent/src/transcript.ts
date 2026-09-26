/**
 * `transcript.ts` — fold a child's raw JSON-mode event log into something a
 * person can read as a transcript.
 *
 * The evidence log already carries every event the child emitted — assistant
 * text deltas, tool executions, finished messages — so the detail view does
 * not need a persisted child session to answer "what did it do". This file
 * turns the bounded tail `readSubagentLog` returns into flat blocks: finished
 * assistant messages with their tool calls paired to their results, plus the
 * in-flight text a still-running child is streaming.
 *
 * It is a tail, not a transcript: `readSubagentLog` bounds the scan, and the
 * caller surfaces `earlierDataOmitted` so a folded tail never pretends to be
 * the whole run.
 */

import { readText } from "pi-agent-runner";
import type { FleetTheme } from "./fleet.ts";

export type TranscriptBlockKind = "assistant" | "thinking" | "tool" | "error" | "note";

export interface TranscriptBlock {
	kind: TranscriptBlockKind;
	/** Assistant message text, the thinking excerpt, or the tool's one-line call. */
	text: string;
	/** For `tool`: the tool name; for `assistant`/`thinking`: whether the child is still streaming it. */
	name?: string;
	live?: boolean;
	/** For `tool`: a bounded preview of the result; `undefined` while it runs. */
	result?: string;
	isError?: boolean;
}

export interface FoldedTranscript {
	blocks: TranscriptBlock[];
	/** The log reader scanned a tail; blocks before it are absent, not missing. */
	earlierDataOmitted: boolean;
}

const ARGS_PREVIEW_CHARS = 120;
const TEXT_PREVIEW_CHARS = 1_500;
const RESULT_PREVIEW_CHARS = 800;
const THINKING_PREVIEW_CHARS = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Collapse a JSON event's control characters and whitespace to one readable line. */
function flat(value: string, max = ARGS_PREVIEW_CHARS): string {
	const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function boundText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** `readText` accepts the same content shapes executor uses for `finalText`. */
function contentText(content: unknown): string {
	try {
		return readText(content);
	} catch {
		return "";
	}
}

/** A one-line `name(args)` for a tool call; the args themselves are metadata, not output. */
function toolCallLine(name: string, args: unknown): string {
	if (!isRecord(args)) return name;
	const preview = flat(JSON.stringify(args));
	return preview === "{}" ? name : `${name} ${preview}`;
}

interface PendingTool {
	block: TranscriptBlock;
	name: string;
}

/**
 * Fold raw JSONL lines into transcript blocks. Lines that are not JSON events
 * (a truncation marker, a torn tail) become a `note`, never a crash.
 */
export function foldSubagentLog(lines: string[], earlierDataOmitted: boolean): FoldedTranscript {
	const blocks: TranscriptBlock[] = [];
	const pendingTools = new Map<string, PendingTool>();
	// In-flight assistant stream: text and thinking deltas accumulate until
	// `message_end` replaces them with the authoritative message.
	const streamText = new Map<number, string>();
	const streamThinking = new Map<number, string>();

	const flushStream = (): void => {
		const thinking = [...streamThinking.values()].join("");
		const text = [...streamText.entries()].sort(([a], [b]) => a - b).map(([, v]) => v).join("");
		if (thinking) blocks.push({ kind: "thinking", text: boundText(thinking, THINKING_PREVIEW_CHARS), live: true });
		if (text) blocks.push({ kind: "assistant", text: boundText(text, TEXT_PREVIEW_CHARS), live: true });
		streamText.clear();
		streamThinking.clear();
	};

	for (const line of lines) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event) || typeof event.type !== "string") {
			if (event === "evidence_truncated" || (isRecord(event) && event.type === "evidence_truncated")) {
				blocks.push({ kind: "note", text: "log truncated — earlier output is on disk only" });
			}
			continue;
		}

		switch (event.type) {
			case "message_update": {
				const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
				if (!update) break;
				if (update.type === "text_delta" && typeof update.contentIndex === "number" && typeof update.delta === "string") {
					streamText.set(update.contentIndex, (streamText.get(update.contentIndex) ?? "") + update.delta);
				} else if (update.type === "thinking_delta" && typeof update.contentIndex === "number" && typeof update.delta === "string") {
					streamThinking.set(update.contentIndex, (streamThinking.get(update.contentIndex) ?? "") + update.delta);
				}
				break;
			}
			case "message_end": {
				flushStream();
				const message = isRecord(event.message) ? event.message : undefined;
				if (!message || message.role !== "assistant") break;
				const content = Array.isArray(message.content) ? message.content : [];
				for (const part of content) {
					if (!isRecord(part)) continue;
					if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
						blocks.push({ kind: "assistant", text: boundText(part.text, TEXT_PREVIEW_CHARS) });
					} else if (part.type === "thinking" && typeof (part as { thinking?: unknown }).thinking === "string") {
						blocks.push({ kind: "thinking", text: boundText(String((part as { thinking: unknown }).thinking), THINKING_PREVIEW_CHARS) });
					} else if (part.type === "toolCall") {
						const name = typeof part.name === "string" ? part.name : "tool";
						const id = typeof part.id === "string" ? part.id : "";
						const block: TranscriptBlock = { kind: "tool", name, text: toolCallLine(name, part.arguments) };
						blocks.push(block);
						if (id) pendingTools.set(id, { block, name });
					}
				}
				if (typeof message.errorMessage === "string" && message.errorMessage) {
					blocks.push({ kind: "error", text: boundText(message.errorMessage, TEXT_PREVIEW_CHARS) });
				}
				break;
			}
			case "tool_execution_start": {
				// A start without a paired `toolCall` message part still earns a row:
				// the child ran the tool whether or not the log kept its arguments.
				const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
				if (id && pendingTools.has(id)) break;
				const name = typeof event.toolName === "string" ? event.toolName : "tool";
				const block: TranscriptBlock = { kind: "tool", name, text: toolCallLine(name, event.args) };
				blocks.push(block);
				if (id) pendingTools.set(id, { block, name });
				break;
			}
			case "tool_execution_end": {
				const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
				const pending = id ? pendingTools.get(id) : undefined;
				const name = pending?.name ?? (typeof event.toolName === "string" ? event.toolName : "tool");
				const resultText = contentText(isRecord(event.result) ? (event.result as { content?: unknown }).content : event.result);
				const isError = event.isError === true;
				const block: TranscriptBlock = pending?.block ?? { kind: "tool", name, text: name };
				if (!pending) blocks.push(block);
				block.result = boundText(resultText, RESULT_PREVIEW_CHARS) || (isError ? "(failed)" : "(done)");
				block.isError = isError;
				if (id) pendingTools.delete(id);
				break;
			}
			case "error": {
				flushStream();
				const message = isRecord(event.error) ? contentText((event.error as { content?: unknown }).content) : "";
				blocks.push({ kind: "error", text: boundText(message || flat(JSON.stringify(event)), TEXT_PREVIEW_CHARS) });
				break;
			}
			case "evidence_truncated": {
				blocks.push({ kind: "note", text: "log truncated — earlier output is on disk only" });
				break;
			}
			default:
				break;
		}
	}
	flushStream();
	return { blocks, earlierDataOmitted };
}

/**
 * Render folded blocks for the panel's transcript view. Assistant and thinking
 * text is sanitised here too — a child's output is untrusted terminal input.
 */
export function renderTranscript(folded: FoldedTranscript, theme: FleetTheme): string[] {
	const lines: string[] = [];
	if (folded.earlierDataOmitted) {
		lines.push(theme.fg("muted", "  (earlier log omitted — this is the bounded tail)"), "");
	}
	if (folded.blocks.length === 0) {
		lines.push(theme.fg("dim", "  The log has no readable events yet."));
		return lines;
	}
	for (const block of folded.blocks) {
		const body = block.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, " ");
		switch (block.kind) {
			case "assistant": {
				const tag = block.live ? theme.fg("accent", "assistant ·") : theme.fg("muted", "assistant");
				lines.push(tag);
				for (const line of body.split("\n")) lines.push(`  ${theme.fg("toolOutput", line)}`);
				break;
			}
			case "thinking": {
				const tag = block.live ? theme.fg("dim", "thinking ·") : theme.fg("dim", "thinking");
				lines.push(tag, `  ${theme.fg("muted", body)}`);
				break;
			}
			case "tool": {
				const marker = block.isError ? theme.fg("error", "  ✗") : block.result === undefined ? theme.fg("accent", "  ●") : theme.fg("success", "  ✓");
				lines.push(`${marker} ${theme.fg("dim", body)}`);
				if (block.result) {
					for (const line of block.result.split("\n").slice(0, 8)) {
						lines.push(`      ${theme.fg("muted", line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, " "))}`);
					}
				}
				break;
			}
			case "error":
				lines.push(theme.fg("error", `  error ${body}`));
				break;
			case "note":
				lines.push(theme.fg("muted", `  (${body})`));
				break;
		}
		lines.push("");
	}
	return lines;
}
