import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export type TaskViewComponent = Component & { dispose?(): void };
export type TaskViewFactory = (tui: TUI, theme: Theme, close: () => void, bodyRows: () => number) => TaskViewComponent;

/** Pi 1.x has no main-view extension hook. Adapt its shared document/dock tree,
 * without moving or clearing message components that the live parent updates.
 * Both regular and fullscreen hosts render the same document container.
 */
export function createMainTaskView(tui: TUI, theme: Theme, factory: TaskViewFactory, done: () => void): TaskViewComponent {
	const [document, pending, status, above, editor, below, footer] = tui.children;
	if (![document, pending, status, above, editor, below, footer].every((part) => part && Array.isArray((part as { children?: unknown }).children))) {
		throw new Error("This Pi TUI layout does not support switching the main task view.");
	}
	let disposed = false;
	const restore: Array<() => void> = [];
	function height(): number {
		return Math.max(5, tui.terminal.rows - footer!.render(tui.terminal.columns).length - (tui.mode === "fullscreen" ? 3 : 0));
	}
	function close(): void {
		if (disposed) return;
		disposed = true;
		try {
			view.dispose?.();
		} finally {
			for (const undo of restore.reverse()) undo();
			tui.requestRender(true);
			done();
		}
	}
	const view = factory(tui, theme, close, () => Math.max(1, height() - 4));

	function replaceRender(part: Component, render: Component["render"]): void {
		const original = Object.getOwnPropertyDescriptor(part, "render");
		part.render = render;
		restore.push(() => {
			if (part.render !== render) return;
			if (original) Object.defineProperty(part, "render", original);
			else delete (part as Partial<Component>).render;
		});
	}
	// These containers can keep receiving parent updates while out of view.
	for (const part of [pending, status, above, below]) replaceRender(part!, () => []);
	replaceRender(document!, (width) => {
		const rows = height();
		const lines = view.render(width).slice(0, rows).map((line) => truncateToWidth(line, width));
		while (lines.length < rows) lines.push("");
		return lines;
	});
	// Avoid routing clicks to the hidden parent message components.
	const mouse = Object.getOwnPropertyDescriptor(document!, "handleMouse");
	const ignoreMouse: Component["handleMouse"] = () => undefined;
	document!.handleMouse = ignoreMouse;
	restore.push(() => {
		if (document!.handleMouse !== ignoreMouse) return;
		if (mouse) Object.defineProperty(document!, "handleMouse", mouse);
		else delete document!.handleMouse;
	});
	tui.requestRender(true);
	return {
		// custom() owns keyboard focus in the dock; all content renders in the document.
		render: () => [],
		handleInput: (data) => view.handleInput?.(data),
		invalidate: () => view.invalidate(),
		dispose: close,
	};
}

/** custom without an overlay is used only to lend focus and restore the editor. */
export async function openMainTaskView(ctx: ExtensionContext, factory: TaskViewFactory, onMount?: (view: TaskViewComponent) => void): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const view = createMainTaskView(tui, theme, factory, () => done());
		onMount?.(view);
		return view;
	});
}
