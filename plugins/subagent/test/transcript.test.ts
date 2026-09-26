import { describe, expect, test } from "bun:test";
import { foldSubagentLog, renderTranscript } from "../src/transcript.ts";

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const assistantMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "I found the reducer." },
		{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/x.ts" } },
	],
};

describe("foldSubagentLog", () => {
	test("folds a finished assistant message with its tool call and result", () => {
		const lines = [
			JSON.stringify({ type: "message_end", message: assistantMessage }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "file body" }] } }),
		];
		const { blocks } = foldSubagentLog(lines, false);
		expect(blocks.map((block) => block.kind)).toEqual(["assistant", "tool"]);
		expect(blocks[0]!.text).toBe("I found the reducer.");
		expect(blocks[1]!.name).toBe("read");
		expect(blocks[1]!.text).toContain("src/x.ts");
		expect(blocks[1]!.result).toBe("file body");
	});

	test("streaming text deltas fold into a live assistant block", () => {
		const lines = [
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "work" } }),
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ing on it" } }),
		];
		const { blocks } = foldSubagentLog(lines, false);
		expect(blocks).toEqual([{ kind: "assistant", text: "working on it", live: true, name: undefined, result: undefined, isError: undefined }]);
		expect(blocks[0]!.live).toBe(true);
	});

	test("a tool start without a message part still earns a row, and its end pairs to it", () => {
		const lines = [
			JSON.stringify({ type: "tool_execution_start", toolCallId: "call_9", toolName: "bash", args: { command: "npm test" } }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "call_9", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "exit 1" }] } }),
		];
		const { blocks } = foldSubagentLog(lines, false);
		expect(blocks.length).toBe(1);
		expect(blocks[0]!.kind).toBe("tool");
		expect(blocks[0]!.isError).toBe(true);
		expect(blocks[0]!.result).toBe("exit 1");
	});

	test("non-JSON lines and a truncation marker never crash the fold", () => {
		const { blocks, earlierDataOmitted } = foldSubagentLog(["not json", "{\"broken\":", JSON.stringify({ type: "evidence_truncated" })], true);
		expect(earlierDataOmitted).toBe(true);
		expect(blocks.some((block) => block.kind === "note")).toBe(true);
	});

	test("long text is bounded per block", () => {
		const long = "x".repeat(5_000);
		const lines = [JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: long }] } })];
		const { blocks } = foldSubagentLog(lines, false);
		expect(blocks[0]!.text.length).toBeLessThanOrEqual(1_501);
	});
});

describe("renderTranscript", () => {
	test("renders bounded lines with the omission marker up front", () => {
		const folded = foldSubagentLog([JSON.stringify({ type: "message_end", message: assistantMessage })], true);
		const lines = renderTranscript(folded, THEME);
		expect(lines[0]).toContain("earlier log omitted");
		expect(lines.join("\n")).toContain("assistant");
		expect(lines.join("\n")).toContain("I found the reducer.");
	});

	test("an empty fold says so rather than rendering nothing", () => {
		expect(renderTranscript({ blocks: [], earlierDataOmitted: false }, THEME).join("\n")).toContain("no readable events");
	});
});
