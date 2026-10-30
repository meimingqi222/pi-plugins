/** States shared by work renderers and their status icons. */
export type WorkState = "queued" | "running" | "idle" | "stalled" | "succeeded" | "failed" | "stopped";

export const WORK_ICONS: Record<WorkState, string> = {
	queued: "·",
	running: "●",
	idle: "◌",
	stalled: "◉",
	succeeded: "✓",
	failed: "×",
	stopped: "■",
};
