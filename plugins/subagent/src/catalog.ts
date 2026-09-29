/**
 * `catalog.ts` — the agent catalog: built-in definitions, name aliases, and
 * the resolution rule a requested agent name goes through.
 *
 * The built-in set follows the consensus both reference implementations
 * converged on: read access is the default, write access is the explicit
 * exception. `general` is the only built-in that can modify files; `explore`
 * and `review` cannot, and `review` can still run commands because a review
 * that cannot run the test suite is a guess.
 */

import type { SubagentDefinition } from "./agents.ts";

/** Built-ins make the feature useful on a fresh install; a user file with the same name overrides them field by field. */
export const BUILTIN_AGENTS: readonly SubagentDefinition[] = [
	{
		name: "explore",
		description: "Explore a codebase and return concise findings with file references.",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: [
			"You are a codebase exploration agent. Investigate the assigned question using read, grep, find and ls.",
			"Do not edit files or claim to have run commands or tests; your tools only inspect files.",
			"Return the relevant facts with file paths and line numbers where possible.",
			"Keep the answer concise, distinguish evidence from inference, and state what remains uncertain.",
		].join("\n"),
		filePath: "<builtin:explore>",
	},
	{
		name: "review",
		description: "Review code and diffs rigorously; can run commands but not edit files.",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: [
			"You are a review agent. Examine the requested change or code rigorously using read, grep, find, ls and bash.",
			"Do not modify files. Report concrete findings with file paths and line numbers; run commands only to verify, never to change.",
			"Call out correctness issues, regressions, and missing tests. State plainly when you find none.",
		].join("\n"),
		filePath: "<builtin:review>",
	},
	{
		name: "general",
		description: "Implementation and edits; the only built-in with full tool access.",
		systemPrompt: [
			"Work independently on the delegated task and return a concise, verifiable result.",
			"Stay inside the task's stated scope and file ownership; do not touch files outside it.",
			"Verify your work before answering — run the relevant test or check, and say what you ran.",
		].join("\n"),
		filePath: "<builtin:general>",
	},
];

/**
 * Models reach for descriptive forms ("general-purpose") rather than the exact
 * built-in name. Keep those forms as aliases while retaining exact matching
 * for file-defined names.
 */
export const AGENT_ALIASES: ReadonlyMap<string, string> = new Map([
	["general-purpose", "general"],
	["general purpose", "general"],
	["general_purpose", "general"],
]);

/**
 * Resolve a requested name: exact match first, then a compatibility alias.
 * Aliases only ever point at built-ins — a user file named "general_purpose"
 * keeps its own exact name and is not hijacked by the alias map.
 */
export function resolveAgent(
	agents: readonly SubagentDefinition[],
	requestedName: string,
): SubagentDefinition | undefined {
	const exact = agents.find((agent) => agent.name === requestedName);
	if (exact) return exact;
	const canonical = AGENT_ALIASES.get(requestedName.trim().toLowerCase());
	return canonical ? agents.find((agent) => agent.name === canonical) : undefined;
}

/**
 * Built-in guidance for the `subagent` tool description, derived from
 * `BUILTIN_AGENTS` so the text cannot drift from the catalog. The parenthetical
 * is a capability note, never part of the name.
 */
export function formatAgentGuidance(builtins: readonly SubagentDefinition[] = BUILTIN_AGENTS): string {
	const listed = builtins.map((agent) => `"${agent.name}" (${agent.description})`).join(", ");
	return [
		`Built-in agents, by exact name: ${listed}.`,
		'Prefer a read-only agent for review, audit, or exploration work; "general" is the only built-in that can modify files.',
	].join(" ");
}
