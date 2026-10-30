/**
 * Extension wiring: registry, lifecycle, durable terminal records, and the
 * deliberately small set of completions that warrant a model wake-up.
 *
 * A background job is a real OS process owned by the conversation that launched
 * it. Leaving the session or switching history branch kills it and drops any
 * late completion, the same way a workflow run is stopped outside its origin.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { connectTaskNavigation, openMainTaskView, createHostWorkReporter, createPollGuard, createWorkReporter, renderWorkSurface, DeliveryLedger } from "@meimingqi222/pi-run-core";
import { createBgTasksPanel } from "./panel.ts";
import { JobRegistry, type Job } from "../core/jobs.ts";
import { resolveAutoBackgroundSeconds } from "../core/config.ts";
import type { JobStatus, RunOutcome } from "../core/types.ts";
import { createBgBashTool } from "./bash-tool.ts";
import { createBgTasksTool } from "./tasks-tool.ts";
import {
	completionSummary,
	formatCompletionNotice,
	formatCompletionNoticeSummaries,
	type BgBashDetails,
	type CompletionSummary,
} from "./format.ts";
import { renderCompletion, renderStatusEntry } from "./render.ts";
import { loadThresholdSources, sweepLogDir } from "./settings.ts";
import { BG_BASH_COMPLETION_ENTRY, BG_BASH_STATE_ENTRY, recordFor, recordsFromBranch } from "./records.ts";
import { pollBlockReason } from "./poll-guard.ts";
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

	// The UI context the reporter draws on: refreshed by `session_start` and
	// lazily when a job detaches (a tool call can precede or survive one).
	let uiCtx: ExtensionContext | undefined;
	const hostWork = createHostWorkReporter(pi);
	// A completion that qualifies for a model wake is offered before the send,
	// so a reload or branch switch between finish and flush replays it once.
	const ledger = new DeliveryLedger(pi, {
		offerType: "bg-bash-delivery-offer",
		ackType: "bg-bash-delivery-ack",
	});
	/** Delivery ids offered by this process; a quiet/auto-success job is never offered. */
	const offered = new Set<string>();
	let panelOpen = false;
	let panel: { dispose?(): void } | undefined;
	const navigation = connectTaskNavigation(pi, {
		key: "background", label: "Background tasks",
		count: () => runningWorkItems(registry.list(), Date.now()).length,
		open: openPanel,
	});
	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (panelOpen || ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") return;
		panelOpen = true;
		try {
			await openMainTaskView(ctx, (tui, theme, close, bodyRows) =>
				createBgTasksPanel({ tui, theme, bodyRows, list: () => registry.list(), kill: (id) => registry.kill(id) }, close),
				(view) => { panel = view; },
			);
		} finally { panel?.dispose?.(); panel = undefined; panelOpen = false; }
	}

	const reporter = createWorkReporter({
		key: "pi-bg-bash-jobs",
		ui: () => (uiCtx && uiCtx.mode === "tui" && uiCtx.hasUI && typeof uiCtx.ui?.setWidget === "function" ? uiCtx.ui : undefined),
		items: () => runningWorkItems(registry.list(), Date.now()),
		live: () => registry.list().some((job) => job.mode === "background" && job.status === "running"),
		title: "bg jobs",
		hint: "bg_tasks · /bg",
		render: (items, theme, now, width) => pi.events && typeof uiCtx?.ui?.onTerminalInput === "function"
			? [] : renderWorkSurface(items, theme, now, width, { title: "bg jobs", hint: "bg_tasks · /bg" }),
	});
	function syncSurfaces(): void {
		reporter.sync();
        if (uiCtx) navigation.sync(uiCtx);
		if (!uiCtx || shuttingDown) return;
		for (const job of registry.list()) {
			if (job.mode !== "background") continue;
			hostWork.publish({ kind: "bash", id: job.id, title: job.command, status: job.status, description: "Background command", activity: job.status === "running" ? "running" : `exit ${job.exitCode ?? "unknown"}`, metric: job.pid === undefined ? "" : `pid ${job.pid}` }, uiCtx);
		}
	}
	registry.onChange(syncSurfaces);
	let afterAgentEnd = false;
	let agentRunActive = false;
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingNotices = new Map<Job, { ctx: ExtensionContext | undefined; isCurrent: () => boolean }>();
	let consumed = new WeakSet<Job>();
	let submitted = new WeakSet<Job>();
	let warned = new WeakSet<Job>();
	const scheduleNotices = (delayMs: number): void => {
		if (!noticeTimer) noticeTimer = setTimeout(() => flushNotices(), delayMs);
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

	const flushNotices = (boundary?: "steer" | "followUp"): void => {
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = undefined;
		for (const [job, origin] of pendingNotices) {
			if (!origin.isCurrent() || consumed.has(job) || submitted.has(job)) pendingNotices.delete(job);
		}
		const batch = [...pendingNotices.entries()];
		if (shuttingDown || batch.length === 0) return;
		const ctx = batch[0][1].ctx;
		if (!boundary) {
			if (agentRunActive || afterAgentEnd) return;
			let idle = true;
			try { idle = ctx?.isIdle() ?? true; } catch {}
			if (!idle) {
				scheduleNotices(250);
				return;
			}
		}
		const current = batch.filter(([job, origin]) => origin.isCurrent() && !consumed.has(job) && !submitted.has(job)).map(([job]) => job);
		if (shuttingDown || current.length === 0) return;
		try {
			const deliveryIds = current.map(deliveryId).filter((id) => offered.has(id));
			pi.sendMessage(
				{
					customType: BG_BASH_CUSTOM_TYPE,
					content: formatCompletionNotice(current),
					display: false,
					// A batched notice covers several offers; the ids let the
					// ledger prove all of them from the transcript alone.
					details: { deliveryIds },
				},
				{ deliverAs: boundary ?? "followUp", triggerTurn: true },
			);
			for (const job of current) {
				submitted.add(job);
				pendingNotices.delete(job);
				warned.delete(job);
				const id = deliveryId(job);
				if (offered.delete(id)) ledger.ack(id);
			}
		} catch (error) {
			if (current.some((job) => !warned.has(job))) {
				for (const job of current) warned.add(job);
				try { ctx?.ui.notify(`Background job completion could not be delivered: ${String(error)}`, "warning"); }
				catch {}
			}
			if (!agentRunActive && !afterAgentEnd) scheduleNotices(250);
		}
	};

	const deliveryId = (job: Job): string => `bg:${job.id}`;

	const routeCompletion = (job: Job, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void => {
		if (shuttingDown || !isCurrent()) return;
		persist(job, BG_BASH_COMPLETION_ENTRY, ctx, isCurrent);
		if (job.notify === "quiet" || (job.notify === "auto" && job.status !== "failed" && job.status !== "timedout")) return;
		if (consumed.has(job) || submitted.has(job)) return;
		const sessionId = (() => {
			try { return ctx?.sessionManager.getSessionId(); } catch { return undefined; }
		})();
		// Only a completion that is allowed to wake the model is offered. A
		// quiet or auto-success job must not come back as a replayed wake.
		if (sessionId) {
			const id = deliveryId(job);
			ledger.offer({
				id,
				runId: job.id,
				sessionId,
				customType: BG_BASH_CUSTOM_TYPE,
				content: formatCompletionNotice([job]),
				display: false,
				wake: true,
				details: { ...completionSummary(job) },
			});
			offered.add(id);
		}
		pendingNotices.set(job, { ctx, isCurrent });
		scheduleNotices(25);
	};

	const runtime: Runtime = {
		pi,
		registry,
		autoBackgroundSeconds: (cwd) => resolveAutoBackgroundSeconds(loadThresholdSources(cwd)),
		backgroundLimit: () => BACKGROUND_JOB_LIMIT,
		// Resolved per call: cheap, and a project-level settings file written
		// mid-session takes effect immediately. `create` only reads — settings
		// are persisted by explicit mutation, not by construction — and a
		// settings file that cannot be read must not fail the command.
		shellSettings: (cwd) => {
			try {
				const settings = SettingsManager.create(cwd, getAgentDir());
				return {
					shellPath: settings.getShellPath(),
					commandPrefix: settings.getShellCommandPrefix(),
				};
			} catch {
				return {};
			}
		},
		captureOrigin,
		consumeResult: (job, signal) => {
			if (signal?.aborted || job.status === "running" || registry.get(job.id) !== job) return;
			consumed.add(job);
			pendingNotices.delete(job);
			// The model read the status through bg_tasks, so a replay would only
			// repeat it. A quiet or auto-success job was never offered.
			const id = deliveryId(job);
			if (offered.delete(id)) ledger.ack(id);
		},
		started: (job, ctx, isCurrent) => {
			// A job has just become live background work: bind the UI context here
			// because this is the earliest call guaranteed to carry one. `promote`
			// already fired the registry's onChange, possibly before this context
			// was bound, so sync again after binding.
			if (!isCurrent()) return;
			uiCtx = ctx;
			syncSurfaces();
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
        navigation.clear();
        panel?.dispose?.();
        panel = undefined;
        panelOpen = false;
		sessionGeneration += 1;
		uiCtx = undefined;
		hostWork.clear();
		pendingNotices.clear();
		offered.clear();
		consumed = new WeakSet<Job>();
		submitted = new WeakSet<Job>();
		warned = new WeakSet<Job>();
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
		// A new session must not inherit the previous one's job list or id
		// counter; shutdown already killed anything still running.
		leaveSession();
		registry.reset();
		uiCtx = ctx;
		// Bound the log directory: files past the retention window are deleted,
		// then the newest MAX_LOG_FILES are kept.
		sweepLogDir();
		try {
			for (const record of recordsFromBranch(ctx.sessionManager.getBranch())) registry.restore(record);
		} catch { /* A session without readable history still starts cleanly. */ }
	});

	const offeredSummary = (value: unknown): CompletionSummary | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const item = value as Record<string, unknown>;
		const statuses: JobStatus[] = ["exited", "failed", "killed", "timedout", "interrupted"];
		if (typeof item.jobId !== "string" || !item.jobId) return undefined;
		if (typeof item.status !== "string" || !statuses.includes(item.status as JobStatus)) return undefined;
		if (typeof item.durationMs !== "number" || !Number.isFinite(item.durationMs) || item.durationMs < 0) return undefined;
		const exitCode = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? item.exitCode : null;
		return { jobId: item.jobId, status: item.status as JobStatus, exitCode, durationMs: item.durationMs };
	};

	/**
	 * Deliver completions that qualified for a wake but were never accepted by
	 * the host — a reload between finish and flush, or a switch away before the
	 * settled boundary fired.
	 *
	 * Only waking completions are offered, so every replay keeps the same
	 * `triggerTurn: true` policy. A malformed offer is acknowledged rather than
	 * retried forever.
	 */
	const replayNotices = (ctx: ExtensionContext): void => {
		let sessionId: string;
		try { sessionId = ctx.sessionManager.getSessionId(); } catch { return; }
		const offers = ledger.pending(ctx, sessionId);
		if (offers.length === 0) return;
		const summaries: CompletionSummary[] = [];
		const ids: string[] = [];
		for (const offer of offers) {
			const summary = offeredSummary(offer.details);
			if (!summary) {
				ledger.ack(offer.id);
				continue;
			}
			summaries.push(summary);
			ids.push(offer.id);
		}
		if (ids.length === 0) return;
		try {
			pi.sendMessage(
				{
					customType: BG_BASH_CUSTOM_TYPE,
					content: formatCompletionNoticeSummaries(summaries),
					display: false,
					details: { deliveryIds: ids },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			for (const id of ids) ledger.ack(id);
		} catch {
			// Keep the offers; the next start/tree boundary is the retry.
		}
	};
	// Registered after the restore handler above, so the job list exists before
	// a replay message points the model at `bg_tasks result <id>`.
	pi.on("session_start", (_event, ctx) => replayNotices(ctx));
	pi.on("session_tree", (_event, ctx) => replayNotices(ctx));

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		leaveSession();
	});

	pi.registerTool(createBgBashTool(runtime));
	pi.registerTool(createBgTasksTool(runtime));
	pi.registerCommand?.("bg", {
		description: "Inspect background jobs: /bg [live|kill <id>]",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			if (ctx.mode === "tui" && ctx.hasUI) uiCtx = ctx;
			const input = args.trim();
            if (input === "live") { await openPanel(ctx); return; }
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
	pi.on("turn_end", (_event, ctx) => {
		if (agentRunActive && !afterAgentEnd && !ctx.signal?.aborted) flushNotices("steer");
	});
	pi.on("agent_settled", () => {
		agentRunActive = false;
		afterAgentEnd = false;
		flushNotices("followUp");
	});

	// Older session messages still need their original renderer. New completions
	// use a TUI-only entry and bounded hidden model notifications.
	pi.registerMessageRenderer<BgBashDetails>(BG_BASH_CUSTOM_TYPE, renderCompletion);

	// A bare sleep is not a useful wait. Block it without terminating the turn:
	// default successful jobs no longer wake the model, so it must be able to
	// call bg_tasks wait or continue other work.
	createPollGuard(pi, {
		// Only background jobs make a bare sleep a poll: a foreground job ends
		// its own tool call, so sleeping alongside it is not waiting on us.
		active: () => registry.list()
			.filter((job) => job.status === "running" && job.mode === "background")
			.map((job) => job.id),
		reason: pollBlockReason,
		// A default successful job does not wake the model, so the turn must
		// stay alive for bg_tasks wait.
	});
}
