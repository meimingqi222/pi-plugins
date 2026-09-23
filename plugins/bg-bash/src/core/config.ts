/**
 * Auto-background threshold resolution.
 *
 * The threshold is the one decision this plugin makes on the user's behalf, so
 * the precedence is explicit and testable: environment override, then the
 * project file, then the user file, then the built-in default. `0` disables
 * automatic backgrounding (commands keep the plain blocking behaviour) while
 * `background: true` still works.
 */

/** Seconds a command may run before it is moved to the background. */
export const DEFAULT_AUTO_BACKGROUND_SECONDS = 30;

export interface ThresholdSources {
	/** `PI_BG_BASH_THRESHOLD`, in seconds. */
	env?: string;
	/** `autoBackgroundAfterSeconds` from `<cwd>/.pi/bg-bash.json`. */
	project?: unknown;
	/** `autoBackgroundAfterSeconds` from `~/.pi/bg-bash.json`. */
	global?: unknown;
}

/** Parse an environment value into seconds, or undefined when it is not a number. */
export function parseSeconds(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : undefined;
}

function usable(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Resolve the effective threshold in seconds. */
export function resolveAutoBackgroundSeconds(sources: ThresholdSources): number {
	const env = parseSeconds(sources.env);
	const fromEnv = env !== undefined && env >= 0 ? env : undefined;
	return fromEnv ?? usable(sources.project) ?? usable(sources.global) ?? DEFAULT_AUTO_BACKGROUND_SECONDS;
}
