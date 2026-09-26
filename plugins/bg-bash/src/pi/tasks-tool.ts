/** Bounded inspection, waiting, and control for detached shell jobs. */
import { existsSync } from "node:fs";
import { truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Job } from "../core/jobs.ts";
import { formatElapsed, formatEndedAt, formatJobList, formatJobStatus } from "./format.ts";
import { readLogTail } from "./settings.ts";
import type { Runtime } from "./runtime.ts";

const MAX_LOG_LINES = 2000;
const MAX_LOG_BYTES = 50 * 1024;
const RESULT_LINES = 40;
const RESULT_BYTES = 4 * 1024;
const MAX_WAIT_SECONDS = 30;
const MAX_WAIT_JOBS = 8;

const schema = Type.Object({
	action: Type.Union([
		Type.Literal("list"), Type.Literal("status"), Type.Literal("result"),
		Type.Literal("log"), Type.Literal("wait"), Type.Literal("kill"),
	]),
	id: Type.Optional(Type.String({ description: "Job id for status/result/log/kill, or one job to wait for" })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "Up to 8 job ids for wait" })),
	lines: Type.Optional(Type.Number({ description: "Trailing log lines, clamped to 1–2000 (default 200)" })),
	timeout: Type.Optional(Type.Number({ description: "Wait timeout in seconds, clamped to 0–30 (default 30)" })),
	mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { description: "Wait for any or all ids (default all)" })),
});

export function createBgTasksTool(runtime: Runtime): ToolDefinition<typeof schema, undefined> {
	return {
		name: "bg_tasks",
		label: "bg_tasks",
		description: "List, inspect, wait for, or stop background bash jobs. result gives bounded status and output; log reads a bounded tail. Success does not wake the agent by default.",
		promptSnippet: "Inspect or wait for background bash jobs before relying on their results.",
		parameters: schema,
		async execute(_toolCallId, params, signal) {
			const { registry } = runtime;
			switch (params.action) {
				case "list": return answer(formatJobList(registry.list()));
				case "status": return answer(formatJobStatus(requireJob(runtime, params.id)));
				case "result": return answer(formatResult(requireJob(runtime, params.id)));
				case "log": {
					const job = requireJob(runtime, params.id);
					const output = jobOutput(job);
					if (output === undefined) return answer(`Job ${job.id}: output unavailable (log missing or expired).`);
					if (!output.trim()) return answer(`Job ${job.id} has produced no output yet.`);
					const tail = truncateTail(output, { maxLines: clamp(params.lines ?? 200, 1, MAX_LOG_LINES), maxBytes: MAX_LOG_BYTES });
					return answer(tail.content + (tail.truncated ? `\n[Truncated; full log: ${job.logPath ?? "unavailable"}]` : ""));
				}
				case "wait": {
					const ids = params.ids ?? (params.id ? [params.id] : []);
					if (ids.length === 0 || ids.length > MAX_WAIT_JOBS || new Set(ids).size !== ids.length) throw new Error(`bg_tasks wait requires 1–${MAX_WAIT_JOBS} distinct job ids.`);
					const jobs = ids.map((id) => requireJob(runtime, id));
					const seconds = boundedSeconds(params.timeout ?? MAX_WAIT_SECONDS);
					const outcome = await waitForJobs(runtime, jobs, params.mode ?? "all", seconds * 1000, signal);
					if (outcome === "changed") return answer("Background job registry changed while waiting; query bg_tasks list before relying on a result.");
					const headline = outcome === "timeout" ? `Wait timed out after ${seconds}s. For long jobs that should resume the agent, start them with notify: "always".` : outcome === "aborted" ? "Wait cancelled." : "Requested job state reached.";
					return answer(`${headline}\n${jobs.map(formatResult).join("\n\n")}`);
				}
				case "kill": {
					const job = requireJob(runtime, params.id);
					if (job.status !== "running") return answer(`Job ${job.id} is not running (status: ${job.status}).`);
					registry.kill(job.id);
					await waitForJobs(runtime, [job], "all", 2000, signal);
					return answer(job.status === "running"
						? `Stop requested for job ${job.id} (${job.command}); it is still terminating.`
						: `Job ${job.id} ${job.status} (${job.command}).`);
				}
			}
		},
	};
}

function answer(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function requireJob(runtime: Runtime, id: string | undefined): Job {
	if (!id) throw new Error("bg_tasks: `id` is required for this action.");
	const job = runtime.registry.get(id);
	if (!job) throw new Error(`bg_tasks: no job named ${id}. Use bg_tasks list to see tracked jobs.`);
	return job;
}

function clamp(value: number, low: number, high: number): number {
	return Number.isFinite(value) ? Math.min(high, Math.max(low, Math.floor(value))) : high;
}

function boundedSeconds(value: number): number {
	return Number.isFinite(value) ? Math.min(MAX_WAIT_SECONDS, Math.max(0, value)) : MAX_WAIT_SECONDS;
}

function jobOutput(job: Job): string | undefined {
	let output = job.output.text();
	if (job.restored && (!job.logPath || !existsSync(job.logPath))) return undefined;
	if (job.logPath && (job.restored || !output.trim() || job.output.dropped().bytes > 0)) {
		const fromFile = readLogTail(job.logPath);
		if (fromFile.trim()) output = fromFile;
	}
	if (!output && job.status !== "running" && (!job.logPath || !existsSync(job.logPath))) return undefined;
	return output;
}

function formatResult(job: Job): string {
	const lines = [
		`Job ${job.id}: ${job.status}${job.exitCode === null ? "" : ` (exit ${job.exitCode})`}`,
		`Started: ${new Date(job.startedAt).toISOString()}`,
		`Ended: ${formatEndedAt(job)}`,
		`Duration: ${formatElapsed(job)}`,
		`Log: ${job.logPath ?? "unavailable"}`,
	];
	const output = jobOutput(job);
	if (output === undefined) lines.push("Output unavailable (log missing or expired).");
	else if (!output.trim()) lines.push("Output: (none yet)");
	else {
		const preview = truncateTail(output, { maxLines: RESULT_LINES, maxBytes: RESULT_BYTES });
		lines.push(`Output preview${preview.truncated ? " (truncated)" : ""}:\n${preview.content}`);
	}
	return lines.join("\n");
}

function waitForJobs(runtime: Runtime, jobs: Job[], mode: "any" | "all", timeoutMs: number, signal: AbortSignal | undefined): Promise<"ready" | "timeout" | "aborted" | "changed"> {
	const state = (): "ready" | "changed" | undefined => {
		if (jobs.some((job) => runtime.registry.get(job.id) !== job)) return "changed";
		const terminal = jobs.map((job) => job.status !== "running");
		if (mode === "any" ? terminal.some(Boolean) : terminal.every(Boolean)) return "ready";
		return undefined;
	};
	const immediate = state();
	if (immediate) return Promise.resolve(immediate);
	if (signal?.aborted) return Promise.resolve("aborted");
	if (timeoutMs <= 0) return Promise.resolve("timeout");
	return new Promise((resolve) => {
		let finished = false;
		let unsubscribe = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (result: "ready" | "timeout" | "aborted" | "changed") => {
			if (finished) return;
			finished = true;
			unsubscribe();
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => done("aborted");
		unsubscribe = runtime.registry.onChange(() => {
			const result = state();
			if (result) done(result);
		});
		timer = setTimeout(() => done("timeout"), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		const result = state();
		if (result) done(result);
	});
}
