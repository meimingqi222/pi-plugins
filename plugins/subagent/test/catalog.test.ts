import { describe, expect, test } from "bun:test";
import { AGENT_ALIASES, BUILTIN_AGENTS, formatAgentGuidance, resolveAgent } from "../src/catalog.ts";
import { SUBAGENT_DESCRIPTION, SUBAGENT_GUIDELINES, TASK_PARAM_DESCRIPTION } from "../src/contract.ts";
import { deriveAlias } from "../src/background.ts";
import type { SubagentDefinition } from "../src/agents.ts";

function file(name: string): SubagentDefinition {
	return { name, description: `file ${name}`, systemPrompt: "body", filePath: `/u/${name}.md` };
}

describe("the built-in catalog", () => {
	test("read is the default and write is the explicit exception", () => {
		expect(BUILTIN_AGENTS.map((a) => a.name)).toEqual(["explore", "review", "general"]);
		expect(BUILTIN_AGENTS.find((a) => a.name === "general")!.tools).toBeUndefined();
		expect(BUILTIN_AGENTS.find((a) => a.name === "explore")!.tools).toContain("read");
		expect(BUILTIN_AGENTS.find((a) => a.name === "review")!.tools).toContain("bash");
	});

	test("exact names win over aliases; aliases only reach built-ins", () => {
		const agents = [...BUILTIN_AGENTS, file("general_purpose")];
		expect(resolveAgent(agents, "review")!.name).toBe("review");
		for (const alias of AGENT_ALIASES.keys()) {
			expect(resolveAgent(BUILTIN_AGENTS, alias)!.name).toBe("general");
		}
		// A file that owns the exact alias spelling keeps it.
		expect(resolveAgent(agents, "general_purpose")!.filePath).toBe("/u/general_purpose.md");
		expect(resolveAgent(agents, "nope")).toBeUndefined();
	});

	test("the description derives from the catalog so they cannot drift", () => {
		expect(formatAgentGuidance()).toContain('"general"');
		expect(SUBAGENT_DESCRIPTION).toContain('"explore"');
		expect(SUBAGENT_DESCRIPTION).toContain("disjoint files");
		expect(SUBAGENT_DESCRIPTION).toContain("do not poll");
		expect(TASK_PARAM_DESCRIPTION).toContain("ownership");
		expect(SUBAGENT_GUIDELINES.join(" ")).toContain("wait");
	});
});

describe("deriveAlias", () => {
	test("makes a bounded slug from the task's first line", () => {
		expect(deriveAlias("Map the retry path\nwith details")).toBe("Map the retry path");
		// A first line longer than the bound truncates to it.
		expect(deriveAlias("Fix the auth redirect loop\nwith details")).toBe("Fix the auth redirect l…");
		expect(deriveAlias("")).toBe("task");
		expect(deriveAlias("   ")).toBe("task");
		expect(deriveAlias("a".repeat(60)).length).toBeLessThanOrEqual(24);
	});
});
