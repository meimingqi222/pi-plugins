import { describe, expect, test } from "bun:test";
import { isPureWaitCommand, pollBlockReason } from "../src/pi/poll-guard.ts";

describe("isPureWaitCommand", () => {
	test("recognises a bare sleep, which is the poll", () => {
		expect(isPureWaitCommand("sleep 30")).toBe(true);
		expect(isPureWaitCommand("  sleep 0.5  ")).toBe(true);
		expect(isPureWaitCommand("sleep 10;")).toBe(true);
		expect(isPureWaitCommand("sleep 30s")).toBe(true);
		expect(isPureWaitCommand("sleep 1m")).toBe(true);
		expect(isPureWaitCommand("sleep 30 # wait for the job")).toBe(true);
		expect(isPureWaitCommand("Start-Sleep 30")).toBe(true);
	});

	test("leaves a sleep with a purpose alone", () => {
		expect(isPureWaitCommand("sleep 5 && npm test")).toBe(false);
		expect(isPureWaitCommand("while true; do sleep 1; done")).toBe(false);
	});

	test("does not match a sleep-shaped non-command", () => {
		expect(isPureWaitCommand("")).toBe(false);
		expect(isPureWaitCommand("sleep")).toBe(false);
		expect(isPureWaitCommand("echo sleep 30")).toBe(false);
	});
});

describe("pollBlockReason", () => {
	test("names the jobs to inspect", () => {
		const reason = pollBlockReason(["bg001"]);
		expect(reason).toContain("bg001");
		expect(reason).toContain("bg_tasks");
		expect(reason).toContain("end your turn");
	});
});
