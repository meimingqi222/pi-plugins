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
	 * Snapshot the launching session identity, so a completion that arrives
	 * after a session or branch switch can be dropped instead of injected.
	 */
	captureOrigin(ctx: ExtensionContext): () => boolean;
	/** Hand a finished background job to the session as a follow-up message. */
	deliver(job: Job, outcome: RunOutcome, ctx: ExtensionContext | undefined, isCurrent: () => boolean): void;
}
