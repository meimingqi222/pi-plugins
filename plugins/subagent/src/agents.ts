/**
 * Agent discovery.
 *
 * A subagent is a markdown file with YAML frontmatter, discovered from
 * `~/.pi/agent/agents/*.md` — the same location and shape pi's own bundled
 * `extensions/subagent` example uses, so the two are interchangeable on disk.
 *
 * Only **user scope** is read. A project-local `.pi/agents/*.md` is a
 * repository-controlled system prompt, so loading one turns "review this diff"
 * into "run whatever the repository's author wrote". pi's example gates that
 * behind an explicit `agentScope` and a trust prompt; this first cut does not
 * offer it at all, which is the fail-closed direction. Project scope can be
 * added once there is a trust check to hang it on.
 *
 * Discovery runs on every invocation rather than once at startup, so editing an
 * agent file takes effect without a restart — the behaviour pi's example chose
 * for the same reason.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface SubagentDefinition {
  /** The name the model passes as the tool's `agent` argument. */
  name: string;
  /** One line shown to the model when it lists available agents. */
  description: string;
  /** Tools the child may use; `undefined` means pi's default set. */
  tools?: string[];
  /** Model override; `undefined` inherits the dispatching session's model. */
  model?: string;
  /** The delegated system prompt (the markdown body). */
  systemPrompt: string;
  filePath: string;
}

/** A useful zero-configuration child, limited to Pi's inspection tools. */
const BUILTIN_EXPLORE: SubagentDefinition = {
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
};

/** Raw frontmatter values, unknown because a real YAML parser produced them. */
type AgentFrontmatter = Record<string, unknown>;

/**
 * Normalize a frontmatter `tools` value to a list of names.
 *
 * Both `tools: read, bash` and `tools: [read, bash]` are valid YAML and both are
 * in use, so accept either. Anything else yields no tools rather than throwing:
 * this runs in discovery, where one bad file must not take down the others.
 */
export function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/** The directory user-level agent definitions live in. */
export function userAgentsDir(): string {
  return path.join(getAgentDir(), "agents");
}

/**
 * Parse frontmatter without letting one bad file escape.
 *
 * `parseFrontmatter` runs a real YAML parser, which throws on a syntax error.
 * Discovery walks the whole directory on every tool call, so an unguarded throw
 * here would fail the `subagent` tool outright and hide every other agent — a
 * single stray bracket in a user file taking the feature down. A file without
 * usable frontmatter is skipped instead, which is the same treatment every other
 * unusable file gets.
 */
function readFrontmatter(content: string): { frontmatter?: AgentFrontmatter; body: string } {
  try {
    return parseFrontmatter<AgentFrontmatter>(content);
  } catch {
    return { body: "" };
  }
}

/** One markdown file → a definition, or `undefined` when it is not usable. */
export function readAgentFile(filePath: string): SubagentDefinition | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = readFrontmatter(content);
  if (!frontmatter || typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
  const name = frontmatter.name.trim();
  if (!name) return undefined;
  const tools = parseToolList(frontmatter.tools);
  // A malformed explicit allowlist must never become pi's unrestricted default.
  if (Object.hasOwn(frontmatter, "tools") && !tools) return undefined;
  return {
    name,
    description: frontmatter.description.trim(),
    tools,
    model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
    systemPrompt: body,
    filePath,
  };
}

/**
 * The built-in plus every usable user agent in `dir`, sorted by name.
 *
 * A user definition replaces the built-in when names match. A missing directory
 * still leaves the built-in available.
 */
export function discoverAgents(dir: string = userAgentsDir()): SubagentDefinition[] {
  const agents = new Map<string, SubagentDefinition>([[BUILTIN_EXPLORE.name, BUILTIN_EXPLORE]]);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [...agents.values()];
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const agent = readAgentFile(path.join(dir, entry.name));
    if (agent) agents.set(agent.name, agent);
  }
  return [...agents.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Find one agent by exact name. */
export function findAgent(agents: readonly SubagentDefinition[], name: string): SubagentDefinition | undefined {
  return agents.find((agent) => agent.name === name);
}

/** A comma-separated list for an error message: `"a", "b"`. */
export function formatAgentNames(agents: readonly SubagentDefinition[]): string {
  if (agents.length === 0) return "none";
  return agents.map((agent) => `"${agent.name}"`).join(", ");
}
