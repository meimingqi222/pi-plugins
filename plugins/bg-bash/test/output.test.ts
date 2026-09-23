import { describe, expect, test } from "bun:test";
import { TailBuffer } from "../src/core/output.ts";

describe("TailBuffer", () => {
	test("keeps everything under the cap and reports no drops", () => {
		const buffer = new TailBuffer(64);
		buffer.append("line one\n");
		buffer.append("line two\n");
		expect(buffer.text()).toBe("line one\nline two\n");
		expect(buffer.dropped()).toEqual({ bytes: 0, lines: 0 });
	});

	test("drops whole leading lines once the cap is exceeded", () => {
		const buffer = new TailBuffer(30);
		buffer.append("aaaaaaaaaa\n");
		buffer.append("bbbbbbbbbb\n");
		buffer.append("cccccccccc\n");
		expect(buffer.text()).toBe("bbbbbbbbbb\ncccccccccc\n");
		expect(buffer.dropped()).toEqual({ bytes: 11, lines: 1 });
		expect(buffer.byteLength()).toBeLessThanOrEqual(30);
	});

	test("keeps a byte tail of a single oversized line", () => {
		const buffer = new TailBuffer(10);
		buffer.append("0123456789ABCDEF");
		expect(buffer.text()).toBe("6789ABCDEF");
		expect(buffer.dropped().lines).toBe(0);
		expect(buffer.byteLength()).toBeLessThanOrEqual(10);
	});

	test("cuts on code-point boundaries for multi-byte text", () => {
		const buffer = new TailBuffer(7);
		buffer.append("h\u00e9llo w\u00f6rld");
		// 7 bytes must not split the 2-byte "ö" into a lone surrogate.
		expect(buffer.text()).toBe(" w\u00f6rld");
		expect(buffer.byteLength()).toBeLessThanOrEqual(7);
		expect(buffer.text().includes("\uFFFD")).toBe(false);
	});
});
