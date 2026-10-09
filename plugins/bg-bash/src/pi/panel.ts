import { isKeyRelease, matchesKey, wrapTextWithAnsi, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatWorkRow, type WorkTheme } from "pi-run-core";
import type { Job } from "../core/jobs.ts";
import { jobWorkItem } from "./surface.ts";
import { readLogTail } from "./settings.ts";

export interface BgPanelDeps {
	tui: Pick<TUI, "requestRender">;
	theme: WorkTheme;
	list(): Job[];
	bodyRows?(): number;
	kill(id: string): void;
}

/** Selection follows job identity, and output remains a bounded tail. */
export function createBgTasksPanel(deps: BgPanelDeps, close: () => void): Component & { dispose(): void } {
	let selected: string | undefined;
	let detail: string | undefined;
	let scroll = 0;
	let disposed = false;
	const bodyRows = () => Math.max(1, deps.bodyRows?.() ?? 16);
	const timer = setInterval(() => deps.tui.requestRender(), 1_000);
	timer.unref?.();
	function dispose(): void {
		if (disposed) return;
		disposed = true;
		clearInterval(timer);
	}
	function jobs(): Job[] { return deps.list().filter((job) => job.mode === "background"); }
	function output(job: Job): string[] {
		const text = job.output.text() || (job.logPath ? readLogTail(job.logPath) : "");
		return text.slice(-32_000).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, " ").split("\n");
	}
	return {
		invalidate(): void {}, dispose,
		render(width): string[] {
			const list = jobs();
			const rows = bodyRows();
			selected = list.find((job) => job.id === selected)?.id ?? list[0]?.id;
			let body: string[];
			if (detail) {
				const job = list.find((job) => job.id === detail);
				const lines = job ? [job.command, `${job.status} · exit ${job.exitCode ?? "—"}`, "", ...output(job)]
					.flatMap((line) => wrapTextWithAnsi(line, width)) : ["Task unavailable"];
				scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - rows)));
				body = lines.slice(scroll, scroll + rows);
			} else {
				const index = Math.max(0, list.findIndex((job) => job.id === selected));
				const start = Math.max(0, index - rows + 1);
				body = list.slice(start, start + rows).map((job) => {
					const item = { ...jobWorkItem(job, Date.now()), kind: job.id };
					return `${job.id === selected ? "›" : " "}${formatWorkRow(item, deps.theme, Date.now(), width - 1)}`;
				});
				if (!body.length) body = ["No background tasks"];
			}
			return [deps.theme.bold("Background tasks"), "", ...body, "", deps.theme.fg("dim", detail ? "↑/↓ scroll · k stop · Esc back · q close" : "↑/↓ select · Enter output · k stop · Esc close")]
				.map((line) => truncateToWidth(line, width));
		},
		handleInput(data): void {
			if (isKeyRelease(data)) return;
			const list = jobs();
			const index = Math.max(0, list.findIndex((job) => job.id === selected));
			if (matchesKey(data, "escape") && detail) {
				detail = undefined;
				scroll = 0;
			} else if (matchesKey(data, "escape") || data === "q") {
				dispose();
				close();
				return;
			} else if (matchesKey(data, "down")) {
				if (detail) scroll += 1;
				else selected = list[Math.min(index + 1, list.length - 1)]?.id;
			} else if (matchesKey(data, "up")) {
				if (detail) scroll -= 1;
				else selected = list[Math.max(index - 1, 0)]?.id;
			} else if (matchesKey(data, "enter")) {
				detail = selected ?? list[0]?.id;
				scroll = 0;
			} else if (data === "k") {
				const job = list.find((job) => job.id === (detail ?? selected));
				if (job?.status === "running") deps.kill(job.id);
			}
			deps.tui.requestRender();
		},
	};
}
