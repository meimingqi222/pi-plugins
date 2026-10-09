import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

const SERVICE = "pi-work:task-navigation:v1";
const WIDGET = "pi-task-navigation";

export interface TaskEntry {
	key: string;
	label: string;
	count(): number;
	open(ctx: ExtensionContext): Promise<void>;
}

interface NavigationService {
	register(entry: TaskEntry): void;
	sync(key: string, ctx: ExtensionContext): void;
	clear(key: string): void;
}

/** One input listener across independently installed plugins, discovered via Pi's event bus. */
export function connectTaskNavigation(pi: ExtensionAPI, entry: TaskEntry): { sync(ctx: ExtensionContext): void; clear(): void } {
	if (!pi.events) return { sync(): void {}, clear(): void {} };
	let service: NavigationService | undefined;
	pi.events.emit(SERVICE, (value: NavigationService) => { service = value; });
	if (!service) {
		service = createTaskNavigation(pi);
		const shared = service;
		pi.events.on(SERVICE, (request: unknown) => {
			if (typeof request === "function") request(shared);
		});
	}
	service.register(entry);
	const connected = service;
	return { sync: (ctx) => connected.sync(entry.key, ctx), clear: () => connected.clear(entry.key) };
}

function createTaskNavigation(pi: ExtensionAPI): NavigationService {
	const entries = new Map<string, TaskEntry>();
	const enabled = new Set<string>();
	let ctx: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let tui: (TUI & { getFocusedComponent?(): Component | null }) | undefined;
	let selected: string | undefined;
	let opening = false;
	let prompts = 0;
	let mounted = false;
	function available(): TaskEntry[] {
		return [...entries.values()].filter((entry) => enabled.has(entry.key) && entry.count() > 0)
			.sort((a, b) => a.key.localeCompare(b.key));
	}
	function repaint(): void { tui?.requestRender(); }
	pi.on("ui_prompt_start", () => { prompts += 1; selected = undefined; repaint(); });
	pi.on("ui_prompt_end", () => { prompts = Math.max(0, prompts - 1); });

	function handleInput(data: string): { consume: true } | undefined {
		if (!ctx || opening || prompts > 0 || tui?.hasOverlay() || isKeyRelease(data)) return;
		const focus = tui?.getFocusedComponent?.();
		if (focus && !("getText" in focus)) return;
		if (ctx.ui.getEditorText().length > 0) { selected = undefined; repaint(); return; }
		const list = available();
		if (list.length === 0) { selected = undefined; return; }
		if (selected && !list.some((entry) => entry.key === selected)) { selected = undefined; repaint(); return; }
		if (matchesKey(data, "down")) {
			const index = list.findIndex((entry) => entry.key === selected);
			selected = list[(index + 1) % list.length]!.key;
		} else if (selected && matchesKey(data, "up")) {
			const index = list.findIndex((entry) => entry.key === selected);
			selected = index > 0 ? list[index - 1]!.key : undefined;
		} else if (selected && matchesKey(data, "escape")) {
			selected = undefined;
		} else if (selected && matchesKey(data, "enter")) {
			const entry = list.find((entry) => entry.key === selected)!;
			selected = undefined;
			opening = true;
			const source = ctx;
			void Promise.resolve().then(() => {
				if (ctx !== source || !enabled.has(entry.key)) return;
				return entry.open(source);
			}).catch((error: unknown) => {
				source.ui.notify(`Cannot open tasks: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}).finally(() => { opening = false; repaint(); });
		} else {
			if (selected) { selected = undefined; repaint(); }
			return;
		}
		repaint();
		return { consume: true };
	}

	function unmount(): void {
		unsubscribe?.(); unsubscribe = undefined;
		if (mounted) ctx?.ui.setWidget(WIDGET, undefined);
		mounted = false; tui = undefined; selected = undefined;
	}

	return {
		register(entry): void { entries.set(entry.key, entry); },
		sync(key, source): void {
			if (source.mode !== "tui" || !source.hasUI || typeof source.ui.onTerminalInput !== "function") return;
			if (ctx && ctx.sessionManager.getSessionId() !== source.sessionManager.getSessionId()) { unmount(); enabled.clear(); prompts = 0; }
			ctx = source;
			enabled.add(key);
			if (available().length === 0) { unmount(); return; }
			if (!unsubscribe) unsubscribe = source.ui.onTerminalInput(handleInput);
			if (!mounted) {
				source.ui.setWidget(WIDGET, (instance, theme) => {
					tui = instance;
					return {
						invalidate(): void {},
						render(width: number): string[] {
							const list = available();
							if (selected && !list.some((entry) => entry.key === selected)) selected = undefined;
							const tabs = list.map((entry) => {
								const label = `${entry.label} (${entry.count()})`;
								return selected === entry.key ? theme.bold(theme.fg("accent", `› ${label}`)) : theme.fg("muted", label);
							});
							const hint = selected ? "↑/↓ select · Enter open · Esc input" : "↓ select tasks";
							return list.length ? [truncateToWidth(` ${tabs.join("  ·  ")}  ${theme.fg("dim", hint)}`, width)] : [];
						},
					};
				}, { placement: "belowEditor" });
				mounted = true;
			}
			repaint();
		},
		clear(key): void {
			enabled.delete(key);
			if (selected === key) selected = undefined;
			if (available().length === 0) {
				unmount();
				if (enabled.size === 0) { ctx = undefined; prompts = 0; }
			} else repaint();
		},
	};
}
