import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Job, JobRegistry } from "../core/jobs.ts";
import type { RunOutcome } from "../core/types.ts";

/**
 * The small surface the tools need from the extension.
 *
 * Passing this instead of importing the extension entry keeps the tool modules
 * loadable in tests with a fake `pi`.
 */
export interface Runtime {
	pi: ExtensionAPI;
	registry: JobRegistry;
	/** Effective auto-background threshold in seconds for a working directory. */
	autoBackgroundSeconds(cwd: string): number;
	/** Maximum number of concurrent background jobs. */
	backgroundLimit(): number;
	/**
	 * pi's shell settings for a working directory (`shellPath`,
	 * `shellCommandPrefix`) — the overrides the builtin bash tool honours, so
	 * this plugin is a drop-in replacement only if it applies them too.
	 * Injectable: tests substitute a reader without constructing pi's
	 * SettingsManager.
	 */
	shellSettings?: (cwd: string) => { shellPath?: string; commandPrefix?: string };
	/**
	 * Snapshot the launching session identity, so a completion that arrives
	 * after a session or branch switch can be dropped instead of injected.
	 */
	captureOrigin(ctx: ExtensionContext): () => boolean;
	/** Persist the detached job before returning its id to the model. */
	started(job: Job, ctx: ExtensionContext, isCurrent: () => boolean): void;
	/** Persist and route a finished background job. */
	deliver(job: Job, outcome: RunOutcome, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void;
}
