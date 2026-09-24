/**
 * Extension wiring: registry, lifecycle, and the follow-up queue.
 *
 * The follow-up cannot be sent the instant a job finishes. If the agent is
 * mid-request, injecting a `triggerTurn` races with the in-flight provider call,
 * so completions that arrive while the agent is busy are queued and flushed on
 * `agent_end`, which is the event-driven idle boundary.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JobRegistry, type Job } from "../core/jobs.ts";
import { resolveAutoBackgroundSeconds } from "../core/config.ts";
import type { RunOutcome } from "../core/types.ts";
import { createBgBashTool } from "./bash-tool.ts";
import { createBgTasksTool } from "./tasks-tool.ts";
import { formatCompletionMessage, detailsFor, type BgBashDetails } from "./format.ts";
import { loadThresholdSources, sweepLogDir } from "./settings.ts";
import { isPureWaitCommand, pollBlockReason } from "./poll-guard.ts";
import type { Runtime } from "./runtime.ts";

export { DEFAULT_AUTO_BACKGROUND_SECONDS, parseSeconds, resolveAutoBackgroundSeconds } from "../core/config.ts";
export { TailBuffer } from "../core/output.ts";
export { JobRegistry } from "../core/jobs.ts";
export { statusFromOutcome } from "../core/types.ts";
export type { Job } from "../core/jobs.ts";
export type { JobMode, JobStatus, RunOutcome, RunningCommand } from "../core/types.ts";
export type { BgBashDetails } from "./format.ts";

/** Custom message type used for background completions. */
export const BG_BASH_CUSTOM_TYPE = "bg_bash_result";

export const BACKGROUND_JOB_LIMIT = 20;

export default function bgBashExtension(pi: ExtensionAPI): void {
	const registry = new JobRegistry({ runningLimit: BACKGROUND_JOB_LIMIT });
	const pendingFollowUps: Array<() => void> = [];
	let shuttingDown = false;

	const sendFollowUp = (job: Job, ctx: ExtensionContext | undefined): void => {
		if (shuttingDown) return;
		const content = formatCompletionMessage(job);
		const details: BgBashDetails = detailsFor(job);
		const deliver = (): void => {
			if (shuttingDown) return;
			pi.sendMessage(
				{ customType: BG_BASH_CUSTOM_TYPE, content, display: true, details },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		};
		if (ctx && !ctx.isIdle()) {
			pendingFollowUps.push(deliver);
			return;
		}
		deliver();
	};

	const runtime: Runtime = {
		pi,
		registry,
		autoBackgroundSeconds: (cwd) => resolveAutoBackgroundSeconds(loadThresholdSources(cwd)),
		backgroundLimit: () => BACKGROUND_JOB_LIMIT,
		deliver: (job, _outcome: RunOutcome, ctx) => sendFollowUp(job, ctx),
	};

	pi.on("session_start", () => {
		shuttingDown = false;
		// A new session must not inherit the previous one's job list or id
		// counter; shutdown already killed anything still running.
		registry.reset();
		// Bound the log directory: files past the retention window are deleted,
		// then the newest MAX_LOG_FILES are kept.
		sweepLogDir();
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		pendingFollowUps.length = 0;
		registry.killAll();
	});

	pi.on("agent_end", () => {
		if (pendingFollowUps.length === 0) return;
		const queued = pendingFollowUps.splice(0);
		// Defer a macrotask so pi can finish unwinding the just-ended turn.
		const handle = setTimeout(() => {
			for (const deliver of queued) deliver();
		}, 0);
		handle.unref?.();
	});

	pi.registerTool(createBgBashTool(runtime));
	pi.registerTool(createBgTasksTool(runtime));

	// A bare `sleep` while a background job is running is a poll. Blocking it and
	// terminating the batch ends the turn cleanly; the job's completion wakes the
	// model. A command with a purpose (`sleep 5 && npm test`) is untouched, and the
	// batch early-termination rule means a poll batched with real work does not
	// stop that work.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		// Only background jobs make a bare sleep a poll: a foreground job ends
		// its own tool call, so sleeping alongside it is not waiting on us.
		const running = registry.list().filter((job) => job.status === "running" && job.mode === "background");
		if (running.length === 0) return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !isPureWaitCommand(command)) return;
		return { block: true, terminate: true, reason: pollBlockReason(running.map((job) => job.id)) };
	});
}
