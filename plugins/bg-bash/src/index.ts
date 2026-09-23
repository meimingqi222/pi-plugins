/**
 * pi-bg-bash — cross-platform background bash for pi.
 *
 * The extension entry lives in `src/pi/`, because `package.json` names this
 * file as the extension. `core/` is pure bookkeeping, `runner/` owns process
 * spawning and termination, and `pi/` registers tools and session events.
 */

export { default } from "./pi/index.ts";
export {
	BG_BASH_CUSTOM_TYPE,
	BACKGROUND_JOB_LIMIT,
	DEFAULT_AUTO_BACKGROUND_SECONDS,
	JobRegistry,
	TailBuffer,
	parseSeconds,
	resolveAutoBackgroundSeconds,
	statusFromOutcome,
} from "./pi/index.ts";
export type { BgBashDetails, Job, JobMode, JobStatus, RunOutcome, RunningCommand } from "./pi/index.ts";
