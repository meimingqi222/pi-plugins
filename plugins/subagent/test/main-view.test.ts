import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	AgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices,
	InteractiveMode, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { subagentExtension } from "../src/index.ts";

class TestTerminal implements Terminal {
	columns = 100;
	rows = 32;
	kittyProtocolActive = false;
	input?: (data: string) => void;
	resize?: () => void;
	writes = "";
	start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void { this.writes += data; }
	moveBy(): void {} hideCursor(): void {} showCursor(): void {} clearLine(): void {}
	clearFromCursor(): void {} clearScreen(): void {} setTitle(): void {} setProgress(): void {}
}

const model = {
	id: "main-view-test", name: "main view test", api: "openai-completions", provider: "openai",
	baseUrl: "http://localhost.invalid", reasoning: false, input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
} as const;

for (const mode of ["regular", "fullscreen"] as const) {
	test(`native ${mode} Enter replaces parent messages and Escape restores live parent updates`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-main-view-"));
		const terminal = new TestTerminal();
		const previousLogDir = process.env.PI_SUBAGENT_LOG_DIR;
		process.env.PI_SUBAGENT_LOG_DIR = join(dir, "logs");
		let runtime: AgentSessionRuntime | undefined;
		let interactive: InteractiveMode | undefined;
		let tui!: TUI;
		let ctx!: ExtensionContext;
		let resolveChild!: (result: any) => void;
		let evidence!: string;
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 };
		const task = "Inspect the project structure";
		const factory: ExtensionFactory = (pi) => {
			subagentExtension({
				discover: () => [{ name: "explore", description: "explore", systemPrompt: "inspect", filePath: "explore.md" }],
				executor: (input) => {
					evidence = input.evidencePath!;
					mkdirSync(dirname(evidence), { recursive: true });
					writeFileSync(evidence, JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Child inspection in progress" }] } }) + "\n");
					return new Promise((resolve) => { resolveChild = resolve; });
				},
			})(pi);
			pi.on("session_start", (_event, source) => {
				ctx = source;
				source.ui.setWidget("capture-native-tui", (instance) => {
					tui = instance;
					return { render: () => [], invalidate(): void {} };
				});
			});
		};
		try {
			const settingsManager = SettingsManager.inMemory({ quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } });
			const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
			await modelRuntime.setRuntimeApiKey("openai", "offline-test");
			const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, settingsManager, modelRuntime,
				resourceLoaderOptions: { extensionFactories: [factory], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
			const created = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: { ...model }, noTools: "builtin" });
			runtime = new AgentSessionRuntime(created.session, services, async () => { throw new Error("No session replacement in this test"); });
			interactive = new InteractiveMode(runtime, { terminal, tuiMode: mode });
			await interactive.init();
			let calls = 0;
			created.session.agent.streamFunction = async () => {
				const toolCall = calls++ === 0;
				const message = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
					content: toolCall ? [{ type: "toolCall", id: "native-child", name: "subagent", arguments: { subagent_type: "explore", prompt: task, background: true } }]
						: [{ type: "text", text: "PARENT-MESSAGE" }],
					stopReason: toolCall ? "toolUse" : "stop",
					usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message } as any;
			};
			await created.session.prompt("Parent inspect request", { expandPromptTemplates: false });
			const frame = () => {
				tui.renderNow(true);
				const renderer = tui as TUI & { getScreenLines?(): string[] };
				return (renderer.getScreenLines?.() ?? tui.render(terminal.columns)).map(stripTerminalSequences).join("\n");
			};
			expect(frame()).toContain("PARENT-MESSAGE");
			terminal.input!("\x1b[B");
			terminal.input!("\r");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(tui.hasOverlay()).toBe(false);
			expect(frame()).toContain("Child inspection in progress");
			expect(frame()).toContain("· explore · running");
			expect(frame()).not.toContain("PARENT-MESSAGE");
			expect(frame()).not.toContain("Parent inspect request");
			const report = "## Project overview\n\nThis is the child message view.\n\n- The main conversation is hidden.\n- Live updates continue here.\n";
			writeFileSync(evidence, JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: report }] } }) + "\n");
			created.session.sendCustomMessage({ customType: "native-parent-update", content: "PARENT-LIVE-UPDATE", display: true });
			expect(frame()).toContain("Project overview");
			expect(frame()).toContain("· explore · running");
			expect(frame()).not.toContain("PARENT-LIVE-UPDATE");
			terminal.rows = 42;
			terminal.resize?.();
			frame();
			expect(frame().split("\n")).toHaveLength(42);
			if (process.env.PI_TASK_VIEW_SNAPSHOT_DIR) {
				mkdirSync(process.env.PI_TASK_VIEW_SNAPSHOT_DIR, { recursive: true });
				writeFileSync(join(process.env.PI_TASK_VIEW_SNAPSHOT_DIR, `${mode}.txt`), frame());
			}
			terminal.input!("\x1b");
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(frame()).toContain("PARENT-MESSAGE");
			expect(frame()).toContain("PARENT-LIVE-UPDATE");
			expect(frame()).not.toContain("Project overview");
			ctx.ui.setEditorText("restored draft");
			expect(ctx.ui.getEditorText()).toBe("restored draft");
			resolveChild({ status: "completed", text: report, usage });
		} finally {
			resolveChild?.({ status: "completed", text: "done", usage });
			await runtime?.dispose();
			interactive?.stop();
			if (previousLogDir === undefined) delete process.env.PI_SUBAGENT_LOG_DIR;
			else process.env.PI_SUBAGENT_LOG_DIR = previousLogDir;
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);
}
