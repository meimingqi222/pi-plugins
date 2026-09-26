/**
 * The `bash` tool override.
 *
 * It keeps the built-in tool's contract — same name, same output truncation,
 * same "throw on non-zero exit" — and adds two things: a `background` flag and
 * an auto-background threshold. A command still running when the threshold
 * elapses is registered as a background job, the tool call returns immediately,
 * and the result is delivered later as a follow-up. That is what turns an
 * unforeseen deadlock into something the model can observe and stop, instead of
 * a tool call that never returns.
 */

import { createBashToolDefinition, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { allocateLogPath } from "./settings.ts";
import { startCommand } from "../runner/run.ts";
import type { RunOutcome } from "../core/types.ts";
import {
	appendStatus,
	detailsFor,
	formatBackgroundNotice,
	formatForegroundOutput,
	outcomeReason,
	truncateOutput,
	type BgBashDetails,
} from "./format.ts";
import type { Runtime } from "./runtime.ts";

const UPDATE_THROTTLE_MS = 100;

const schema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	background: Type.Optional(Type.Boolean({ description: "Run immediately in the background and return a job id" })),
});

const BACKGROUND = Symbol("bg-bash:background");

export function createBgBashTool(runtime: Runtime): ToolDefinition<typeof schema, BgBashDetails> {
	// Reuse the built-in shell renderers so results look native. The tool's own
	// execute is discarded; only presentation is borrowed.
	const native = createBashToolDefinition(process.cwd());
	const description =
		"Execute a shell command in the current working directory. Returns stdout and stderr, truncated to the last " +
		"2000 lines or 50KB. Set background: true to detach immediately, or let a command exceed the auto-background " +
		"threshold to detach automatically; a follow-up with the final result arrives when it finishes. Optionally " +
		"provide a timeout in seconds.";

	return {
		name: "bash",
		label: "bash",
		description,
		promptSnippet:
			"Execute shell commands. Long commands detach automatically after the auto-background threshold and report back; set background: true to detach immediately.",
		promptGuidelines: [
			"Use bash normally for short commands; commands that outlive the auto-background threshold are moved to the background and produce a follow-up result.",
			"Set background: true for long-running commands you do not need to finish before the next step, such as builds, full test suites, dev servers, watchers, downloads, or deploys.",
			"When bash reports a job moved to the background, do not retry it just to wait; continue independent work or inspect it with bg_tasks.",
			"Use bg_tasks to list running jobs, read a job's full log, check status, or stop a job that looks stuck.",
			"Treat the follow-up message for a background job as the final result of the original bash call.",
		],
		parameters: schema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall: native.renderCall,
		renderResult: native.renderResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const thresholdSeconds = runtime.autoBackgroundSeconds(ctx.cwd);
			const explicitBackground = params.background === true;

			// The cap guards explicit backgrounding only. A foreground command
			// must still run — refusing `echo hi` because 20 jobs are up would be
			// wrong — and if it outlives the threshold it may exceed the limit,
			// which is preferable to blocking the tool call forever.
			if (explicitBackground && runtime.registry.atCapacity()) {
				throw new Error(
					`Too many background jobs are running (limit ${runtime.backgroundLimit()}). ` +
						`Inspect them with bg_tasks list and stop one with bg_tasks kill <id> before starting more.`,
				);
			}

				const job = runtime.registry.create({
				command: params.command,
				cwd: ctx.cwd,
					mode: explicitBackground ? "background" : "foreground",
				});
				// Capture before the first await. A session can change while a
				// foreground command waits for the auto-background threshold.
				const isCurrent = runtime.captureOrigin(ctx);
				const sessionId = sessionIdOf(ctx);
			job.logPath = allocateLogPath(job.id, sessionId);

			let streaming = true;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			const emitUpdate = (): void => {
				if (!onUpdate || !streaming) return;
				// Push the same capped tail the final result renders, not the whole
				// 256KB buffer, on every throttled update.
				const truncated = truncateOutput(job.output.text());
				onUpdate({
					content: [{ type: "text", text: truncated.text }],
					details: detailsFor(job, Date.now(), truncated.result),
				});
			};
			const clearUpdate = (): void => {
				if (updateTimer) clearTimeout(updateTimer);
				updateTimer = undefined;
			};

			let running;
			try {
				running = startCommand({
					command: params.command,
					cwd: ctx.cwd,
					env: buildEnv(ctx),
					logPath: job.logPath,
					logHeader: logHeader(job, sessionId),
					timeoutMs: params.timeout && params.timeout > 0 ? params.timeout * 1000 : undefined,
					signal,
					onSpawn: (pid) => {
						job.pid = pid;
					},
					onData: (chunk) => {
						job.output.append(chunk);
						if (!streaming || updateTimer) return;
						updateTimer = setTimeout(() => {
							updateTimer = undefined;
							emitUpdate();
						}, UPDATE_THROTTLE_MS);
					},
				});
			} catch (error) {
				runtime.registry.remove(job.id);
				throw new Error(`Failed to start bash: ${error instanceof Error ? error.message : String(error)}`);
			}
			job.kill = (killSignal) => running.kill(killSignal);

			const winner = await raceCommand(running.result, thresholdSeconds, explicitBackground);
			streaming = false;
			clearUpdate();
			running.detach();

			if (winner === BACKGROUND) {
				runtime.registry.promote(job.id);
					void running.result.then((outcome) => {
						// A new session resets ids to bg001. An old completion must
						// not settle the new job that inherited the same id.
						if (runtime.registry.get(job.id) !== job) return;
						runtime.registry.finish(job.id, outcome);
					runtime.deliver(job, outcome, ctx, isCurrent);
				});
				return { content: [{ type: "text", text: formatBackgroundNotice(job) }], details: detailsFor(job) };
			}

			runtime.registry.finish(job.id, winner);
			runtime.registry.remove(job.id);
			const body = formatForegroundOutput(job);
			const reason = outcomeReason(winner, params.timeout);
			if (reason) throw new Error(appendStatus(body, reason));
			return { content: [{ type: "text", text: body }], details: detailsFor(job) };
		},
	};
}

/**
 * Resolve either the command's outcome or the `BACKGROUND` marker.
 *
 * `timeoutSeconds <= 0` means auto-backgrounding is disabled, so the command is
 * awaited to completion unless the caller opted in explicitly.
 */
async function raceCommand(
	result: Promise<RunOutcome>,
	timeoutSeconds: number,
	explicitBackground: boolean,
): Promise<RunOutcome | typeof BACKGROUND> {
	if (explicitBackground) return BACKGROUND;
	if (timeoutSeconds <= 0) return result;
	const threshold = startThresholdTimer(timeoutSeconds * 1000);
	try {
		return await Promise.race([result, threshold.promise]);
	} finally {
		threshold.cancel();
	}
}

function startThresholdTimer(ms: number): { promise: Promise<typeof BACKGROUND>; cancel: () => void } {
	let handle: ReturnType<typeof setTimeout>;
	const promise = new Promise<typeof BACKGROUND>((resolve) => {
		handle = setTimeout(() => resolve(BACKGROUND), ms);
	});
	return {
		promise,
		cancel: () => clearTimeout(handle),
	};
}

/** Session id for log file naming; undefined when the context cannot provide one. */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

/** A `#`-prefixed provenance line at the top of each log file. */
function logHeader(job: { id: string; command: string; cwd: string }, sessionId: string | undefined): string {
	const command = job.command.replace(/\r?\n/g, " ⏎ ");
	return `# job ${job.id} session ${sessionId ?? "unknown"} cwd ${job.cwd}\n# command ${command}\n`;
}

/** Mirror pi's session environment exposure for the spawned shell. */
function buildEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	try {
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (ctx.model) {
			env.PI_PROVIDER = ctx.model.provider;
			env.PI_MODEL = ctx.model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	} catch {
		// The context can be torn down while a detached command is still starting.
	}
	return env;
}
