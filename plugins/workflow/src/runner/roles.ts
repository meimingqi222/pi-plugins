/**
 * Role-based tool isolation for workflow agents.
 *
 * A fan-out is only safe if agents cannot fight over the same files. The cheap
 * and effective rule is that write permission is a *role* property, not a path
 * whitelist: a planner and a reviewer never write, so two of them cannot
 * collide, and only a developer does.
 *
 * This is deliberately not path-level access control. A per-path allowlist is
 * far more code and buys protection against a mistake (one agent writing where
 * another is reading) that the role split already prevents in practice. Roles
 * are the 80%.
 *
 * The mapping is enforced by passing the resolved tool list to the child pi
 * process (`--tools`), so a role's restriction is applied by pi itself rather
 * than by trusting the prompt.
 */

/** Tools that only observe. Safe to give every role. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** A role that may edit files and run commands. */
export const DEVELOPER_TOOLS = [...READ_ONLY_TOOLS, "edit", "write", "bash"] as const;

/**
 * Named tool profiles.
 *
 * `planner` and `qa` cannot write: a plan or a verdict that could be edited into
 * the workspace is an agent that can rewrite its own acceptance criteria.
 * `developer` is the single-writer role.
 */
export const ROLE_PROFILES: Readonly<Record<string, readonly string[]>> = {
  planner: [...READ_ONLY_TOOLS],
  qa: [...READ_ONLY_TOOLS, "bash"],
  reviewer: [...READ_ONLY_TOOLS],
  researcher: [...READ_ONLY_TOOLS],
  developer: [...DEVELOPER_TOOLS],
  worker: [...DEVELOPER_TOOLS],
};

/**
 * Resolve a role or explicit tool list into the tools a child may use.
 *
 * `undefined` means "unrestricted", which is what an unset profile returns —
 * passing an empty allowlist to pi would silently produce a tool-less agent,
 * which is a confusing way to fail.
 */
export function resolveToolProfile(profile: string | readonly string[] | undefined): string[] | undefined {
  if (profile === undefined) return undefined;
  if (typeof profile === "string") {
    const normalized = profile.trim();
    if (!normalized || normalized === "*") return undefined;
    const tools = ROLE_PROFILES[normalized];
    if (!tools) {
      throw new Error(`Unknown workflow role "${profile}". Known roles: ${Object.keys(ROLE_PROFILES).join(", ")}`);
    }
    return [...tools];
  }
  return profile.filter((tool) => typeof tool === "string" && tool.trim().length > 0);
}

/**
 * Whether a *declared* role may write.
 *
 * `undefined` is deliberately not a writing role. An agent with no declared
 * profile is unrestricted rather than a writer, and treating it as one would
 * make the single-writer lock serialize every unprofiled agent — silently
 * removing the parallelism from the most common script shape.
 */
export function isWritingRole(profile: string | readonly string[] | undefined): boolean {
  if (profile === undefined) return false;
  const tools = resolveToolProfile(profile);
  return tools !== undefined && (tools.includes("edit") || tools.includes("write"));
}

/**
 * Whether a role's tools *cannot* change anything.
 *
 * Stricter than `canWrite`, and it answers a different question: not "is this
 * role allowed to write?" but "can this call be re-run without duplicating an
 * effect?". `qa` may not edit, but it may run a shell, and a shell can write
 * anything — so only a *named* role whose entire tool list is read-only
 * qualifies. An explicit tool list cannot qualify either: an unknown tool name
 * may well write, and guessing is the wrong side to be wrong on.
 */
export function isReadOnlyRole(profile: string | readonly string[] | undefined): boolean {
  if (typeof profile !== "string") return false;
  const tools = ROLE_PROFILES[profile.trim()];
  return tools !== undefined && tools.every((tool) => (READ_ONLY_TOOLS as readonly string[]).includes(tool));
}

/** Whether a role is allowed to modify the workspace. */
export function canWrite(profile: string | readonly string[] | undefined): boolean {
  const tools = resolveToolProfile(profile);
  return tools === undefined || tools.includes("edit") || tools.includes("write");
}
