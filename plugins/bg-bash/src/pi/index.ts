/**
 * Extension wiring: registry, lifecycle, and Pi follow-up delivery.
 *
 * Results completed during a run wait for agent_settled, when Pi can start a
 * follow-up turn. Idle completions are sent immediately.
 *
 * A background job is a real OS process owned by the conversation that launched
 * it. Leaving the session or switching history branch kills it and drops any
 * late completion, the same way a workflow run is stopped outside its origin.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettledDeliveryQueue } from "pi-run-core";
import { JobRegistry, type Job } from "../core/jobs.ts";
import { resolveAutoBackgroundSeconds } from "../core/config.ts";
import type { RunOutcome } from "../core/types.ts";
import { createBgBashTool } from "./bash-tool.ts";
import { createBgTasksTool } from "./tasks-tool.ts";
import { formatCompletionMessage, detailsFor, type BgBashDetails } from "./format.ts";
import { renderCompletion } from "./render.ts";
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
	let shuttingDown = false;
	let sessionGeneration = 0;
	const delivery = new SettledDeliveryQueue(pi);

	const captureOrigin = (ctx: ExtensionContext): (() => boolean) => {
		const generation = sessionGeneration;
		// The tool context can be torn down while the detached command is still
		// starting, so neither read may assume a live session manager. A failed
		// capture is permanently stale: suppressing a completion is safer than
		// injecting one into an unknown session.
		let sessionId: string;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return () => false;
		}
		return () => {
			if (generation !== sessionGeneration) return false;
			try {
				return ctx.sessionManager.getSessionId() === sessionId;
			} catch {
				return false;
			}
		};
	};

	const sendFollowUp = (job: Job, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void => {
		if (shuttingDown || !isCurrent()) return;
		const content = formatCompletionMessage(job);
		const details: BgBashDetails = detailsFor(job);
		try {
			pi.sendMessage(
				{ customType: BG_BASH_CUSTOM_TYPE, content, display: true, details },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			try { ctx?.ui.notify(`Background job ${job.id} finished, but its result could not be delivered: ${String(error)}`, "warning"); }
			catch { /* A torn-down UI cannot show the warning. */ }
		}
	};
	const deliver = (job: Job, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void => {
		if (shuttingDown || !isCurrent()) return;
		// Pi checks its native queue before it emits agent_settled. Enqueuing in
		// that gap can leave a follow-up with no run to wake it.
		delivery.deliver(() => ctx?.isIdle() ?? true, () => sendFollowUp(job, ctx, isCurrent));
	};

	const runtime: Runtime = {
		pi,
		registry,
		autoBackgroundSeconds: (cwd) => resolveAutoBackgroundSeconds(loadThresholdSources(cwd)),
		backgroundLimit: () => BACKGROUND_JOB_LIMIT,
		captureOrigin,
		deliver: (job, _outcome: RunOutcome, ctx, isCurrent) => deliver(job, ctx, isCurrent),
	};

	/**
	 * Leaving the conversation kills its background processes and drops any
	 * late completion. Jobs are not inherited by the next branch:
	 * they are owned by the context that launched them.
	 */
	const leaveSession = () => {
		sessionGeneration += 1;
		delivery.clear();
		registry.killAll();
	};

	pi.on("session_before_switch", leaveSession);
	pi.on("session_before_tree", leaveSession);
	pi.on("session_before_fork", leaveSession);

	pi.on("session_start", () => {
		shuttingDown = false;
		// A new session must not inherit the previous one's job list or id
		// counter; shutdown already killed anything still running.
		leaveSession();
		registry.reset();
		// Bound the log directory: files past the retention window are deleted,
		// then the newest MAX_LOG_FILES are kept.
		sweepLogDir();
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		leaveSession();
	});

	pi.registerTool(createBgBashTool(runtime));
	pi.registerTool(createBgTasksTool(runtime));

	// The follow-up content stays a flat report for the model; only the terminal
	// view is reshaped, so a person sees a status line and a bounded preview
	// instead of the report rendered as markdown.
	pi.registerMessageRenderer<BgBashDetails>(BG_BASH_CUSTOM_TYPE, renderCompletion);

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
