import { describe, expect, test } from "bun:test";
import {
	DEFAULT_AUTO_BACKGROUND_SECONDS,
	parseSeconds,
	resolveAutoBackgroundSeconds,
} from "../src/core/config.ts";

describe("parseSeconds", () => {
	test("accepts finite numbers, including zero", () => {
		expect(parseSeconds("12")).toBe(12);
		expect(parseSeconds("0")).toBe(0);
		expect(parseSeconds(" 2.5 ")).toBe(2.5);
	});

	test("rejects missing and non-numeric input", () => {
		expect(parseSeconds(undefined)).toBeUndefined();
		expect(parseSeconds("")).toBeUndefined();
		expect(parseSeconds("soon")).toBeUndefined();
		expect(parseSeconds("Infinity")).toBeUndefined();
	});
});

describe("resolveAutoBackgroundSeconds", () => {
	test("falls back to the default when nothing is configured", () => {
		expect(resolveAutoBackgroundSeconds({})).toBe(DEFAULT_AUTO_BACKGROUND_SECONDS);
	});

	test("prefers the environment over both files", () => {
		expect(resolveAutoBackgroundSeconds({ env: "1", project: 2, global: 3 })).toBe(1);
	});

	test("prefers the project file over the user file", () => {
		expect(resolveAutoBackgroundSeconds({ project: 2, global: 3 })).toBe(2);
	});

	test("treats a zero threshold as 'auto-background disabled'", () => {
		expect(resolveAutoBackgroundSeconds({ project: 0 })).toBe(0);
		expect(resolveAutoBackgroundSeconds({ env: "0", project: 5 })).toBe(0);
	});

	test("ignores unusable values instead of producing NaN", () => {
		expect(resolveAutoBackgroundSeconds({ env: "nope", project: -1, global: 7 })).toBe(7);
		expect(resolveAutoBackgroundSeconds({ project: "2" as unknown })).toBe(DEFAULT_AUTO_BACKGROUND_SECONDS);
	});
});
