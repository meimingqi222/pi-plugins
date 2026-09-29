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
 *
 * A file that names a built-in is a **partial** definition: whatever it omits is
 * inherited from that built-in, so retargeting a built-in's model is three lines
 * of frontmatter and no copy of its prompt or tool list. A file that names its
 * own agent must stand alone, because there is no built-in to inherit from.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS } from "./catalog.ts";

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

/**
 * A user file's fields exactly as written, before any inheritance.
 *
 * Every field below `name` is optional so that a file can be an override of a
 * built-in rather than a whole definition. Keeping this distinct from
 * `SubagentDefinition` is what stops a partial file from being mistaken for a
 * complete one: the merge in `discoverAgents` is the only place that decides
 * what a missing field means.
 */
export interface UserAgentFields {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}

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

/**
 * A user file's fields as written, with no inheritance applied.
 *
 * The strictness that stays here is the strictness that must not be relaxed by
 * a merge: a file with no name, or one whose explicit `tools` allowlist is
 * malformed, is unusable no matter what it names.
 */
export function readAgentFields(filePath: string): UserAgentFields | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = readFrontmatter(content);
  if (!frontmatter || typeof frontmatter.name !== "string") return undefined;
  const name = frontmatter.name.trim();
  if (!name) return undefined;
  const tools = parseToolList(frontmatter.tools);
  // A malformed explicit allowlist must never become pi's unrestricted default.
  if (Object.hasOwn(frontmatter, "tools") && !tools) return undefined;
  return {
    name,
    ...(typeof frontmatter.description === "string" && frontmatter.description.trim()
      ? { description: frontmatter.description.trim() }
      : {}),
    tools,
    model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
    systemPrompt: body,
    filePath,
  };
}

/**
 * One markdown file → a complete definition, or `undefined` when it is not one.
 *
 * This is the standalone reading of a file: it needs its own description,
 * because nothing else supplied one — the same rule `resolveUserAgent` applies
 * when it finds no built-in to inherit from, which is why it delegates rather
 * than rebuilding the definition.
 */
export function readAgentFile(filePath: string): SubagentDefinition | undefined {
  const fields = readAgentFields(filePath);
  return fields ? resolveUserAgent(fields, undefined) : undefined;
}

/**
 * Resolve one user file against the built-in it names, if any.
 *
 * Inheritance is field-by-field, and the two halves are not equally safe to get
 * wrong:
 *
 * - `model` (and `description`) inherit only what the file left out, so a
 *   three-line file can retarget a built-in's model without restating anything.
 * - `tools` inherits the **built-in's allowlist**, never pi's default set. `tools:
 *   undefined` means "everything pi ships" everywhere else in this module; if an
 *   `explore.md` that only sets a model fell through to that default, a read-only
 *   agent would silently gain write and shell access. Inheritance is the
 *   fail-closed direction, and it is the reason a partial override is allowed at
 *   all.
 *
 * An empty body leaves the built-in's prompt in place for the same reason; for a
 * name with no built-in, a description is still required, because a definition
 * the model cannot choose between is not a definition.
 */
function resolveUserAgent(fields: UserAgentFields, builtin: SubagentDefinition | undefined): SubagentDefinition | undefined {
  if (!builtin) {
    if (!fields.description) return undefined;
    return {
      name: fields.name,
      description: fields.description,
      tools: fields.tools,
      model: fields.model,
      systemPrompt: fields.systemPrompt,
      filePath: fields.filePath,
    };
  }
  return {
    name: fields.name,
    description: fields.description ?? builtin.description,
    tools: fields.tools ?? builtin.tools,
    model: fields.model ?? builtin.model,
    systemPrompt: fields.systemPrompt.trim() ? fields.systemPrompt : builtin.systemPrompt,
    filePath: fields.filePath,
  };
}

/**
 * The built-in plus every usable user agent in `dir`, sorted by name.
 *
 * A user file naming a built-in overrides it field by field; a user file naming
 * a new agent adds one. Inheritance always comes from the built-in, never from
 * another user file, so two files claiming one name cannot leak fields into each
 * other. A missing directory still leaves the built-ins available.
 */
export function discoverAgents(dir: string = userAgentsDir()): SubagentDefinition[] {
  const builtins = new Map<string, SubagentDefinition>(BUILTIN_AGENTS.map((agent) => [agent.name, agent]));
  const agents = new Map<string, SubagentDefinition>(builtins);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [...agents.values()];
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const fields = readAgentFields(path.join(dir, entry.name));
    if (!fields) continue;
    const agent = resolveUserAgent(fields, builtins.get(fields.name));
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
