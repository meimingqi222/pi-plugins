/**
 * `contract.ts` — the delegation contract's text.
 *
 * The tool description and parameter descriptions are the only prompt surface
 * a subagent gets: neither reference implementation injects delegation
 * guidance into the system prompt, and pi does not either. So the rules that
 * make delegation safe — file ownership, disjoint parallel writers, no
 * polling, the delegation write-spec — live here, bound to the schema they
 * describe, derived from the catalog so the text cannot drift from it.
 */

import { formatAgentGuidance } from "./catalog.ts";

export const SUBAGENT_DESCRIPTION = [
	"Delegate one task to a named subagent running in its own pi process with its own context window.",
	formatAgentGuidance(),
	"User-defined agents in ~/.pi/agent/agents/*.md add names or replace built-ins.",
	"By default the call waits for the answer. Set background=true for independent work; a task ID returns immediately and an unread answer is delivered at a safe parent turn boundary.",
	"Parallel background children must own disjoint files; otherwise serialize them.",
	"Completion arrives automatically at a safe turn boundary; do not poll subagent_tasks in a loop — use its wait action when you need to block on a task.",
	"Returning a settled answer through show, wait, or log consumes its pending notification, not a later reply's answer.",
	"Use it for a self-contained piece of work that would otherwise fill this conversation with material you do not need to keep.",
	"Do not use it for a lookup a grep or read answers, and do not chain many of them by hand — `pi-workflow` is the tool for structured fan-out.",
].join(" ");

export const SUBAGENT_GUIDELINES: string[] = [
	"Use `subagent` for a single self-contained task that benefits from its own context window.",
	"Omit `background` when the next step needs the answer. Set `background=true` when you can continue independent work; use `subagent_tasks` to inspect, wait on, or cancel it.",
	"A subagent starts fresh: include the goal, the relevant paths, and the shape of the answer you want. It cannot see this conversation.",
	"Parallel background children must own disjoint files; give each its file boundary in the task.",
	"Agents are named definitions on disk; an unknown name lists the available ones.",
	"Prefer `explore` or `review` for read-only work; `general` is the only built-in that can modify files.",
];

/** The `task` parameter's write-spec — minimax's delegation spec, shrunk to a line. */
export const TASK_PARAM_DESCRIPTION =
	"Self-contained task. Include the goal, the relevant paths, the ruled-out approaches, the file or directory ownership boundary, the deliverable and its acceptance criteria, and the answer format and length you want.";

export const AGENT_PARAM_DESCRIPTION =
	"Agent name. Built-ins: explore (read-only inspection), review (read-only review plus commands), general (full tools). User definitions may add names or replace built-ins; descriptive forms like general-purpose resolve to general.";

export const ALIAS_PARAM_DESCRIPTION =
	"Optional human-facing name for the task shown in the fleet widget and panel (e.g. \"auth-audit\"). Falls back to a slug derived from the task.";

export const WAIT_TIMEOUT_MAX_SECONDS = 300;
export const WAIT_TIMEOUT_DEFAULT_SECONDS = 30;
