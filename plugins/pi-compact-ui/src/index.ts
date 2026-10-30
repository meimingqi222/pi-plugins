/**
 * pi-compact-ui — make the pi conversation read as a list instead of a stack of
 * boxes.
 *
 * The model this is after: one line per event, with the expensive content behind
 * a click. Assistant prose stays plain. A tool call is `Ran <what> · N output
 * lines`. Thinking is a single dim line.
 *
 * That shape is reachable from an extension, but only partly, and the limits
 * decide what this plugin is:
 *
 * - **Thinking collapses, but the label is one global string.** `hideThinkingBlock`
 *   is a *setting*, not an API — pi reads it from settings.json and an extension
 *   cannot set it. What an extension can do is `setHiddenThinkingLabel`, which
 *   replaces the text every collapsed block shows. So the duration each block
 *   spent (the `2.65s` / `6.8s` in the reference UI) is not reachable: there is
 *   no per-block label, and no renderer registration for assistant messages
 *   (`registerMessageRenderer` covers `custom` messages only). This plugin sets
 *   the label and, when the setting is off, says so once rather than leaving the
 *   user to wonder why nothing changed.
 * - **Tool calls redraw entirely, but stay a separate list.** `registerToolRenderer`
 *   resolves for any tool name — built-ins included, because `next()` *is* the
 *   built-in renderer — and `renderShell: "self"` hands the whole frame over.
 *   With `"self"` the renderer owns its padding and its disclosure. Thinking,
 *   though, is rendered *inside* the assistant message component, which cannot
 *   be replaced, so thinking and tool rows cannot share one connector tree the
 *   way the reference UI does. They are two lists that each read as a list.
 * - **The footer is replaceable** via `setFooter`.
 *
 * Nothing here touches colour — that is `pi-theme-mytheme`'s job, and mixing the
 * two would make neither retunable on its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Config, so a user can turn a piece off without editing the plugin. */
export interface CompactUiOptions {
	/** Label every collapsed thinking block shows. */
	thinkingLabel?: string;
	/** Redraw tool calls as one row each. */
	compactTools?: boolean;
	/** Replace the footer with a labelled status line. */
	statusLine?: boolean;
	/** Frames for the working spinner. `[]` hides it; one frame makes it static. */
	workingFrames?: string[];
	/** Frame interval for the working spinner. */
	workingIntervalMs?: number;
}

/**
 * `registerToolRenderer` exists in the pi release a session runs but not in the
 * `@earendil-works/pi-coding-agent` this workspace resolves for typechecking, so
 * the type cannot be imported. Declaring the slice this plugin uses keeps the
 * call honest; the runtime capability check below means an older host simply
 * does not get compact tool rows rather than failing to load.
 */
interface ToolRendererHost {
	registerToolRenderer(resolver: (toolName: string, next: () => ToolRenderers | undefined) => ToolRenderers | undefined): void;
}

/** The slice of pi's theme a row needs. */
interface ThemeLike {
	fg(color: string, text: string): string;
}

/** The slice of pi's tool render context a row needs. */
interface ToolRenderContextLike {
	args: unknown;
	outputPad: number;
	isError: boolean;
	expanded: boolean;
	durationMs: number | undefined;
}

interface ToolRenderResultOptionsLike {
	expanded: boolean;
	isPartial: boolean;
}

interface ToolResultLike {
	content?: unknown;
	isError?: boolean;
}

interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: unknown, theme: ThemeLike, context: ToolRenderContextLike) => Component;
	renderResult?: (
		result: ToolResultLike,
		options: ToolRenderResultOptionsLike,
		theme: ThemeLike,
		context: ToolRenderContextLike,
	) => Component;
}

const DEFAULT_THINKING_LABEL = "Thought";
const DEFAULT_WORKING_FRAMES = ["◐", "◓", "◑", "◒"];
const DEFAULT_WORKING_INTERVAL_MS = 220;

/** Glyph per tool state, chosen to survive a 16-colour terminal. */
const TOOL_GLYPH = { running: "●", ok: "✓", error: "×" } as const;

/** A tool's one-line identity. `bash` shows its command; path tools show the path. */
export function summarizeToolCall(toolName: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
		return undefined;
	};
	// Ordered by what identifies the call, not alphabetically: a search tool's
	// query comes before the path it searches, or every `grep -r token ~/.kube`
	// would be summarised as `~/.kube` and two different calls would read alike.
	const raw =
		pick("command", "pattern", "query", "path", "file_path", "filePath", "prompt", "url") ??
		(Object.keys(record).length > 0 ? JSON.stringify(record) : toolName);
	return raw.replace(/\s+/gu, " ").trim();
}

/** Lines of model-facing text a result carries, for the `· N output lines` tail. */
export function countOutputLines(content: unknown): number {
	const blocks = Array.isArray(content) ? content : [];
	let lines = 0;
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text !== "string" || text.length === 0) continue;
		// A trailing newline ends the last line rather than starting an empty one,
		// so it must not add to the count the row advertises.
		lines += text.replace(/\n$/u, "").split("\n").length;
	}
	return lines;
}

/** `2.6s` / `1m04s`, for the tool row's trailing duration. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function compactUiExtension(options: CompactUiOptions = {}) {
	const thinkingLabel = options.thinkingLabel ?? DEFAULT_THINKING_LABEL;
	const compactTools = options.compactTools ?? true;
	const statusLine = options.statusLine ?? true;
	const workingFrames = options.workingFrames ?? DEFAULT_WORKING_FRAMES;
	const workingIntervalMs = options.workingIntervalMs ?? DEFAULT_WORKING_INTERVAL_MS;

	return function compactUi(pi: ExtensionAPI): void {
		// --- thinking: the label is the only part an extension owns -------------
		const readHideThinking = (): boolean => {
			try {
				return pi.getSettings().hideThinkingBlock === true;
			} catch {
				// A host without the setting, or an older one: assume off.
				return false;
			}
		};

		pi.on("session_start", (_event, ctx) => {
			// The spinner lives on the UI context, not on the extension API, and a
			// host without it simply keeps its own.
			// A four-frame quarter-circle sweep at 220ms reads as "working" without
			// the 80ms braille flicker the default uses, which is the most movement
			// on a screen that is otherwise still.
			try {
				ctx.ui.setWorkingIndicator({ frames: workingFrames, intervalMs: workingIntervalMs });
			} catch { /* Not every host exposes it. */ }
			try {
				ctx.ui.setHiddenThinkingLabel(thinkingLabel);
			} catch {
				// A non-interactive host has no label to set; the rest still applies.
			}
			// The footer, like the spinner, belongs to the UI context: an extension
			// cannot replace it before a session gives it one.
			if (statusLine) {
				try {
					// A footer is a `Component`, so it needs `invalidate` as well as
					// `render`. Nothing here caches, so invalidation is a no-op.
					ctx.ui.setFooter((_tui, theme, footerData) => ({
						invalidate(): void { /* Stateless: every render reads fresh. */ },
						render(width: number): string[] {
							return [renderStatusLine(width, theme, footerData)];
						},
					}));
				} catch { /* A host without footer replacement keeps its own. */ }
			}
			if (!readHideThinking()) {
				try {
					ctx.ui.notify(
						`pi-compact-ui: thinking blocks are still shown in full. Add "hideThinkingBlock": true to settings.json to collapse them to "${thinkingLabel}".`,
						"info",
					);
				} catch { /* A closed UI must not fail startup. */ }
			}
		});

		// --- one row per tool call ---------------------------------------------
		if (compactTools && typeof (pi as Partial<ToolRendererHost>).registerToolRenderer === "function") {
			(pi as unknown as ToolRendererHost).registerToolRenderer((toolName, next) => {
				const builtIn = next();
				if (!builtIn) return undefined;
				// The built-in renderers are captured so the expanded state can fall
				// back to them. Collapsing must not cost the full view.
				const row = (theme: { fg(color: string, text: string): string }, pad: number) =>
					(text: string): Component => new Text(theme.fg("muted", text), pad, 0);
				return {
					...builtIn,
					renderShell: "self",
					renderCall: (args, theme, context) => {
						const pad = context.outputPad;
						const glyph = theme.fg("accent", TOOL_GLYPH.running);
						const summary = summarizeToolCall(toolName, args);
						return row(theme, pad)(`${glyph} ${summary}`);
					},
					renderResult: (result, options, theme, context) => {
						const pad = context.outputPad;
						// Expanded: hand back to the built-in renderer, so nothing is lost.
						if (options.expanded && builtIn.renderResult) {
							return builtIn.renderResult(result, options, theme, context);
						}
						const failed = context.isError || result.isError === true;
						const glyph = theme.fg(failed ? "error" : "success", failed ? TOOL_GLYPH.error : TOOL_GLYPH.ok);
						const summary = summarizeToolCall(toolName, context.args);
						const lines = countOutputLines(result.content);
						const duration = context.durationMs === undefined ? "" : ` · ${formatDuration(context.durationMs)}`;
						const tail = lines > 0 ? ` · ${lines} output line${lines === 1 ? "" : "s"}` : duration;
						const text = truncateToWidth(`${glyph} ${summary}${tail}`, Math.max(1, 200 - pad), "…");
						return row(theme, pad)(text);
					},
				};
			});
		}

	};
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

interface StatusSegment {
	/** Leading glyph or short label; omitted for bare values. */
	label?: string;
	value: string;
}

function renderStatusLine(
	width: number,
	theme: { fg(color: string, text: string): string },
	footerData: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
	},
): string {
	const branch = safe(() => footerData.getGitBranch());
	const statuses = safe(() => [...footerData.getExtensionStatuses().values()]) ?? [];

	const segments: StatusSegment[] = [];
	if (branch) segments.push({ label: "⎇", value: branch });
	for (const status of statuses) segments.push({ value: status });

	const parts = segments.map((segment) => (segment.label ? `${segment.label} ${segment.value}` : segment.value));
	const line = ` ${parts.join("  ")}`;
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : theme.fg("muted", line);
}

/** A footer provider that throws must not take the whole line down. */
function safe<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

export default compactUiExtension;
