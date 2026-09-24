import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import childGuardExtension, {
	childShellTimeoutSeconds,
	injectShellTimeout,
	ownsBuiltinShellTool,
} from "../src/runner/child-guard.ts";

/**
 * The guard is loaded into every child agent, so a bug here breaks every agent.
 * These tests cover the two decisions that keep it safe: it only fills a missing
 * timeout, and it only touches pi's own shell tool.
 */

describe("childShellTimeoutSeconds", () => {
	test("defaults to ten minutes", () => {
		expect(childShellTimeoutSeconds({} as NodeJS.ProcessEnv)).toBe(600);
	});

	test("honours an override, including zero to disable", () => {
		expect(childShellTimeoutSeconds({ PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS: "30000" } as NodeJS.ProcessEnv)).toBe(30);
		expect(childShellTimeoutSeconds({ PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toBe(0);
	});

	test("falls back on a malformed value rather than disabling the guard", () => {
		expect(childShellTimeoutSeconds({ PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS: "soon" } as NodeJS.ProcessEnv)).toBe(600);
		expect(childShellTimeoutSeconds({ PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv)).toBe(600);
	});
});

describe("injectShellTimeout", () => {
	test("fills a missing timeout", () => {
		const input: { timeout?: unknown } = {};
		expect(injectShellTimeout(input, 600)).toBe(true);
		expect(input.timeout).toBe(600);
	});

	test("never overwrites a timeout the command chose", () => {
		const input: { timeout?: unknown } = { timeout: 5 };
		expect(injectShellTimeout(input, 600)).toBe(false);
		expect(input.timeout).toBe(5);
	});

	test("zero disables the guard", () => {
		const input: { timeout?: unknown } = {};
		expect(injectShellTimeout(input, 0)).toBe(false);
		expect(input.timeout).toBeUndefined();
	});
});

describe("ownsBuiltinShellTool", () => {
	test("is true only for the builtin source", () => {
		expect(ownsBuiltinShellTool({ getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }] } as never, "bash")).toBe(true);
		expect(ownsBuiltinShellTool({ getAllTools: () => [{ name: "bash", sourceInfo: { source: "extension" } }] } as never, "bash")).toBe(false);
		expect(ownsBuiltinShellTool({ getAllTools: () => [] } as never, "bash")).toBe(false);
	});

	test("never guesses when the registry cannot be read", () => {
		expect(
			ownsBuiltinShellTool(
				{
					getAllTools: () => {
						throw new Error("not ready");
					},
				} as never,
				"bash",
			),
		).toBe(false);
	});
});

describe("child guard extension", () => {
	function withHandlers(tools: Array<{ name: string; sourceInfo: { source: string } }>) {
		const handlers: Array<(event: { toolName: string; input: unknown }) => unknown> = [];
		const pi = {
			on: (_name: string, handler: (event: { toolName: string; input: unknown }) => unknown) => {
				handlers.push(handler);
			},
			getAllTools: () => tools,
		};
		childGuardExtension(pi as never);
		return handlers;
	}

	test("injects a positive default into a bounded command on the builtin tool", () => {
		const handlers = withHandlers([{ name: "bash", sourceInfo: { source: "builtin" } }]);
		const input: { timeout?: unknown } = {};
		handlers[0]!({ toolName: "bash", input });
		expect(typeof input.timeout).toBe("number");
		expect(input.timeout as number).toBeGreaterThan(0);
	});

	test("leaves a command that set its own timeout", () => {
		const handlers = withHandlers([{ name: "bash", sourceInfo: { source: "builtin" } }]);
		const input: { timeout?: unknown } = { timeout: 3 };
		handlers[0]!({ toolName: "bash", input });
		expect(input.timeout).toBe(3);
	});

	test("steps aside when another extension owns bash", () => {
		// e.g. pi-bg-bash backgrounds long commands; a hard timeout would defeat it.
		const handlers = withHandlers([{ name: "bash", sourceInfo: { source: "extension" } }]);
		const input: { timeout?: unknown } = {};
		handlers[0]!({ toolName: "bash", input });
		expect(input.timeout).toBeUndefined();
	});

	test("ignores tools that are not shells", () => {
		const handlers = withHandlers([{ name: "bash", sourceInfo: { source: "builtin" } }]);
		const input: { timeout?: unknown } = {};
		handlers[0]!({ toolName: "read", input });
		expect(input.timeout).toBeUndefined();
	});
});

test("pi loads the child guard as an extension without errors", async () => {
	const isolated = await mkdtemp(join(tmpdir(), "pi-wf-guard-"));
	try {
		const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/runner/child-guard.ts");
		const loader = new DefaultResourceLoader({
			cwd: isolated,
			agentDir: isolated,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [entry],
		});
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		expect(result.extensions.find((extension) => extension.path === entry)).toBeDefined();
	} finally {
		await rm(isolated, { recursive: true, force: true });
	}
});

import { agentChildEnv } from "pi-agent-runner";
import { workflowsDisabled } from "../src/pi/index.ts";

/**
 * Fan-out is one level deep.
 *
 * `pi-agent-runner` sets the child environment; this plugin reads the switch.
 * The two halves are composed here rather than asserted separately, so the test
 * fails if either the runner stops setting the flag or this plugin stops
 * honoring it. The env's exact shape is pinned once, in the runner's own test.
 */
test("a workflow child cannot start another workflow", () => {
  expect(workflowsDisabled(agentChildEnv({}))).toBe(true);
});
