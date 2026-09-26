/**
 * Extension wiring: registry, lifecycle, durable terminal records, and the
 * deliberately small set of completions that warrant a model wake-up.
 *
 * A background job is a real OS process owned by the conversation that launched
 * it. Leaving the session or switching history branch kills it and drops any
 * late completion, the same way a workflow run is stopped outside its origin.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettledDeliveryQueue, createWorkReporter } from "pi-run-core";
import { JobRegistry, type Job } from "../core/jobs.ts";
import { resolveAutoBackgroundSeconds } from "../core/config.ts";
import type { RunOutcome } from "../core/types.ts";
import { createBgBashTool } from "./bash-tool.ts";
import { createBgTasksTool } from "./tasks-tool.ts";
import { formatCompletionNotice, type BgBashDetails } from "./format.ts";
import { renderCompletion, renderStatusEntry } from "./render.ts";
import { loadThresholdSources, sweepLogDir } from "./settings.ts";
import { BG_BASH_COMPLETION_ENTRY, BG_BASH_STATE_ENTRY, recordFor, recordsFromBranch } from "./records.ts";
import { isPureWaitCommand, pollBlockReason } from "./poll-guard.ts";
import { formatJobsListing, runningWorkItems } from "./surface.ts";
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
export { BG_BASH_COMPLETION_ENTRY } from "./records.ts";

export const BACKGROUND_JOB_LIMIT = 20;

export default function bgBashExtension(pi: ExtensionAPI): void {
	const registry = new JobRegistry({ runningLimit: BACKGROUND_JOB_LIMIT });
	let shuttingDown = false;
	let sessionGeneration = 0;
	const delivery = new SettledDeliveryQueue(pi);

	// The UI context the reporter draws on: refreshed by `session_start` and
	// lazily when a job detaches (a tool call can precede or survive one).
	let uiCtx: ExtensionContext | undefined;
	const reporter = createWorkReporter({
		key: "pi-bg-bash-jobs",
		ui: () => (uiCtx && uiCtx.mode === "tui" && uiCtx.hasUI && typeof uiCtx.ui?.setWidget === "function" ? uiCtx.ui : undefined),
		items: () => runningWorkItems(registry.list(), Date.now()),
		live: () => registry.list().some((job) => job.mode === "background" && job.status === "running"),
		title: "bg jobs",
		hint: "bg_tasks · /bg",
	});
	registry.onChange(() => reporter.sync());
	let afterAgentEnd = false;
	let agentRunActive = false;
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingNotices = new Map<Job, { ctx: ExtensionContext | undefined; isCurrent: () => boolean }>();
	const scheduleNotices = (delayMs: number): void => {
		if (!noticeTimer) noticeTimer = setTimeout(flushNotices, delayMs);
	};

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

	const persist = (job: Job, type: string, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void => {
		if (shuttingDown || !isCurrent()) return;
		try {
			pi.appendEntry(type, recordFor(job));
		} catch (error) {
			try { ctx?.ui.notify(`Background job ${job.id} state could not be saved: ${String(error)}`, "warning"); }
			catch { /* A torn-down UI cannot show the warning. */ }
		}
	};

	const flushNotices = (): void => {
		noticeTimer = undefined;
		for (const [job, origin] of pendingNotices) {
			if (!origin.isCurrent()) pendingNotices.delete(job);
		}
		const batch = [...pendingNotices.entries()];
		if (shuttingDown || batch.length === 0) return;
		const ctx = batch[0][1].ctx;
		const send = (deliverAs: "steer" | "followUp"): void => {
			const current = batch.map(([job, origin]) => origin.isCurrent() ? job : undefined).filter((job): job is Job => Boolean(job));
			if (shuttingDown || current.length === 0) return;
			try {
				pi.sendMessage(
					{ customType: BG_BASH_CUSTOM_TYPE, content: formatCompletionNotice(current), display: false },
					{ deliverAs, triggerTurn: true },
				);
			} catch (error) {
				try { ctx?.ui.notify(`Background job completion could not be delivered: ${String(error)}`, "warning"); }
				catch { /* A torn-down UI cannot show the warning. */ }
			}
		};
		let idle = true;
		try { idle = ctx?.isIdle() ?? true; } catch { /* Origin checks still guard the send. */ }
		if (idle) {
			pendingNotices.clear();
			send("followUp");
		}
		else if (afterAgentEnd) {
			pendingNotices.clear();
			// Pi has already checked its native queue here. Wait for settlement.
			delivery.defer(() => send("followUp"));
		} else if (agentRunActive) {
			pendingNotices.clear();
			send("steer");
		} else {
			// isIdle is also false during manual compaction, with no agent run
			// able to receive a steer. Retry until Pi becomes idle or a run starts.
			scheduleNotices(250);
		}
	};

	const routeCompletion = (job: Job, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void => {
		if (shuttingDown || !isCurrent()) return;
		persist(job, BG_BASH_COMPLETION_ENTRY, ctx, isCurrent);
		if (job.notify === "quiet" || (job.notify === "auto" && job.status !== "failed" && job.status !== "timedout")) return;
		pendingNotices.set(job, { ctx, isCurrent });
		scheduleNotices(25);
	};

	const runtime: Runtime = {
		pi,
		registry,
		autoBackgroundSeconds: (cwd) => resolveAutoBackgroundSeconds(loadThresholdSources(cwd)),
		backgroundLimit: () => BACKGROUND_JOB_LIMIT,
		captureOrigin,
		started: (job, ctx, isCurrent) => {
			// A job has just become live background work: bind the UI context here
			// because this is the earliest call guaranteed to carry one. `promote`
			// already fired the registry's onChange, possibly before this context
			// was bound, so sync again after binding.
			if (ctx.mode === "tui") uiCtx = ctx;
			reporter.sync();
			persist(job, BG_BASH_STATE_ENTRY, ctx, isCurrent);
		},
		deliver: (job, _outcome: RunOutcome, ctx, isCurrent) => routeCompletion(job, ctx, isCurrent),
	};

	/**
	 * Leaving the conversation kills its background processes and drops any
	 * late completion. Jobs are not inherited by the next branch:
	 * they are owned by the context that launched them.
	 */
	const leaveSession = () => {
		sessionGeneration += 1;
		delivery.clear();
		pendingNotices.clear();
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = undefined;
		afterAgentEnd = false;
		agentRunActive = false;
		registry.killAll();
		uiCtx = undefined;
		reporter.dispose();
	};

	pi.on("session_before_switch", leaveSession);
	pi.on("session_before_tree", leaveSession);
	pi.on("session_before_fork", leaveSession);

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		if (ctx.mode === "tui") uiCtx = ctx;
		// A new session must not inherit the previous one's job list or id
		// counter; shutdown already killed anything still running.
		leaveSession();
		registry.reset();
		// Bound the log directory: files past the retention window are deleted,
		// then the newest MAX_LOG_FILES are kept.
		sweepLogDir();
		try {
			for (const record of recordsFromBranch(ctx.sessionManager.getBranch())) registry.restore(record);
		} catch { /* A session without readable history still starts cleanly. */ }
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		leaveSession();
	});

	pi.registerTool(createBgBashTool(runtime));
	pi.registerTool(createBgTasksTool(runtime));
	pi.registerCommand?.("bg", {
		description: "List background jobs, or stop one: /bg [kill <id>]",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (ctx.mode === "tui" && ctx.hasUI) uiCtx = ctx;
			const input = args.trim();
			if (!input || input === "list") {
				ctx.ui.notify(formatJobsListing(registry.list(), Date.now()), "info");
				return;
			}
			const [verb, target] = input.split(/\s+/u).filter(Boolean);
			if (verb === "kill" || verb === "stop") {
				const job = target ? registry.get(target) : undefined;
				if (!job || job.status !== "running") {
					ctx.ui.notify(`No running job ${target ?? ""}. /bg lists live jobs.`, "warning");
					return;
				}
				registry.kill(job.id);
				ctx.ui.notify(`Stopping ${job.id}.`, "info");
				return;
			}
			const job = registry.get(input);
			ctx.ui.notify(
				job ? `- ${formatJobsListing([job], Date.now())}` : "Usage: /bg [list|kill <id>]",
				job ? "info" : "warning",
			);
		},
	});
	pi.registerEntryRenderer(BG_BASH_COMPLETION_ENTRY, renderStatusEntry);
	pi.on("agent_start", () => { agentRunActive = true; afterAgentEnd = false; });
	pi.on("agent_end", () => { afterAgentEnd = true; });
	pi.on("agent_settled", () => { agentRunActive = false; afterAgentEnd = false; });

	// Older session messages still need their original renderer. New completions
	// use a TUI-only entry and bounded hidden model notifications.
	pi.registerMessageRenderer<BgBashDetails>(BG_BASH_CUSTOM_TYPE, renderCompletion);

	// A bare sleep is not a useful wait. Block it without terminating the turn:
	// default successful jobs no longer wake the model, so it must be able to
	// call bg_tasks wait or continue other work.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		// Only background jobs make a bare sleep a poll: a foreground job ends
		// its own tool call, so sleeping alongside it is not waiting on us.
		const running = registry.list().filter((job) => job.status === "running" && job.mode === "background");
		if (running.length === 0) return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !isPureWaitCommand(command)) return;
		return { block: true, reason: pollBlockReason(running.map((job) => job.id)) };
	});
}
