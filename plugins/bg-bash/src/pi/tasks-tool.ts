/**
 * `bg_tasks`: the escape hatch for background jobs.
 *
 * The auto-background flow delivers a follow-up on its own, so this tool exists
 * for the questions that follow-up cannot answer: which jobs are running, what
 * has a stuck job printed so far, and how do I stop it.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatJobList, formatJobStatus } from "./format.ts";
import { readLogTail } from "./settings.ts";
import type { Runtime } from "./runtime.ts";

const schema = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("status"),
		Type.Literal("log"),
		Type.Literal("kill"),
	]),
	id: Type.Optional(Type.String({ description: "Job id, for status/log/kill" })),
	lines: Type.Optional(Type.Number({ description: "How many trailing lines of the log to return (default 200)" })),
});

export function createBgTasksTool(runtime: Runtime): ToolDefinition<typeof schema, undefined> {
	return {
		name: "bg_tasks",
		label: "bg_tasks",
		description:
			"Inspect and control bash jobs started by the bash tool. Actions: list all jobs, show one job's status, " +
			"read a job's full log tail, or kill a job's process tree.",
		promptSnippet: "List, inspect, or stop background bash jobs.",
		parameters: schema,
		async execute(_toolCallId, params) {
			const { registry } = runtime;
			switch (params.action) {
				case "list":
					return { content: [{ type: "text", text: formatJobList(registry.list()) }], details: undefined };
				case "status": {
					const job = requireJob(registry, params.id);
					return { content: [{ type: "text", text: formatJobStatus(job) }], details: undefined };
				}
				case "log": {
					const job = requireJob(registry, params.id);
					if (!job.logPath) {
						return { content: [{ type: "text", text: `Job ${job.id} has no log file.` }], details: undefined };
					}
					const text = readLogTail(job.logPath);
					if (!text.trim()) {
						return { content: [{ type: "text", text: `Job ${job.id} has produced no output yet.` }], details: undefined };
					}
					const lineCount = params.lines && params.lines > 0 ? Math.floor(params.lines) : 200;
					return { content: [{ type: "text", text: tailLines(text, lineCount) }], details: undefined };
				}
				case "kill": {
					const job = requireJob(registry, params.id);
					if (job.status !== "running") {
						return {
							content: [{ type: "text", text: `Job ${job.id} is not running (status: ${job.status}).` }],
							details: undefined,
						};
					}
					registry.kill(job.id);
					return {
						content: [{ type: "text", text: `Stopping job ${job.id} (${job.command}).` }],
						details: undefined,
					};
				}
			}
		},
	};
}

function requireJob(registry: Runtime["registry"], id: string | undefined) {
	if (!id) throw new Error("bg_tasks: `id` is required for this action.");
	const job = registry.get(id);
	if (!job) throw new Error(`bg_tasks: no job named ${id}. Use bg_tasks list to see tracked jobs.`);
	return job;
}

function tailLines(text: string, count: number): string {
	const lines = text.split("\n");
	if (lines.length <= count) return text;
	return lines.slice(lines.length - count).join("\n");
}
