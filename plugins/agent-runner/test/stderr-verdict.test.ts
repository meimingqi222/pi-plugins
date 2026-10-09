/**
 * A child's stderr is a verdict only when the run has no reply to stand on.
 *
 * Ambient extensions load in a child, and one of them printing a startup
 * warning used to be enough to report a run that replied and exited 0 as
 * failed: the answer was discarded and the warning text became the error.
 */
import { describe, expect, test } from "bun:test";
import { mapRunOutcome } from "../src/child-io.ts";
import { emptyStreamState } from "../src/executor.ts";

const STARTUP_WARNING = 'Warning: Extension package "/tmp/ext/package.json": host-provided package is in dependencies.';

function replied(text = "the answer") {
	return { ...emptyStreamState(), finalText: text, stopReason: "stop" };
}

describe("mapRunOutcome treats stderr as diagnostics, not a verdict, after a reply", () => {
	test("a startup warning does not fail a run that replied and exited 0", () => {
		const result = mapRunOutcome({ timeoutMs: 1_000, stderr: STARTUP_WARNING, exitCode: 0, state: replied() });
		expect(result.status).toBe("completed");
		expect(result.errorMessage).toBeUndefined();
		expect(result.text).toBe("the answer");
	});

	test("stderr still explains a child that exited 0 without a reply", () => {
		const result = mapRunOutcome({ timeoutMs: 1_000, stderr: STARTUP_WARNING, exitCode: 0, state: emptyStreamState() });
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("Warning: Extension package");
	});

	test("stderr still explains a non-zero exit that left a partial reply", () => {
		const result = mapRunOutcome({ timeoutMs: 1_000, stderr: "panic: boom", exitCode: 3, state: replied("partial") });
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toBe("panic: boom");
	});

	test("a non-zero exit without stderr keeps the exit-code message", () => {
		const result = mapRunOutcome({ timeoutMs: 1_000, exitCode: 3, state: replied("partial") });
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toBe("The agent exited with code 3.");
	});

	test("an abort stays an abort even with stderr present", () => {
		const result = mapRunOutcome({ timeoutMs: 1_000, killedBy: "abort", stderr: STARTUP_WARNING, exitCode: null, state: replied() });
		expect(result.status).toBe("aborted");
	});
});
