/**
 * Protected-path policy for read/write intents (design doc §4.2).
 *
 * Two built-in lists: A covers credentials (read AND write are dangerous) and
 * B covers privilege/persistence files (WRITE is dangerous, read is ordinary).
 * User config can append entries but never remove these.
 */

import { matchGlob } from "./glob.ts";
import { isFilesystemRoot, isInside, normalizePath } from "./paths.ts";
import type { PolicyEnv, Tier } from "./types.ts";

export interface PathVerdict {
  tier: Tier;
  reason: string;
  ruleId: string;
}

/** List A: credentials — reading or writing is `dangerous` (ruleId sensitive-path). */
const CREDENTIAL_GLOBS: readonly string[] = [
  "~/.ssh/**",
  "~/.aws/**",
  "~/.gnupg/**",
  "~/.config/gcloud/**",
  "~/.azure/**",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.pi/agent/auth.json",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
];

/** List-A basenames that look sensitive but are documented non-secret examples. */
const CREDENTIAL_EXCEPTIONS: readonly string[] = ["**/.env.example", "**/.env.sample", "**/.env.template"];

/**
 * List B: privilege/persistence — only WRITING is `dangerous`.
 * Editing pi's own permission config counts: the model must not grant itself
 * allowances (this was an actual hole in minimax-code's design).
 */
const PROTECTED_WRITE_GLOBS: readonly string[] = [
  "~/.pi/agent/permissions.json",
  "<cwd>/.pi/permissions.json",
  "~/.pi/agent/settings.json",
  "<cwd>/.pi/settings.json",
  "~/.pi/agent/extensions/**",
  "<cwd>/.pi/extensions/**",
  "~/.pi/agent/trust.json",
  "<cwd>/.git/**",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.profile",
  "~/.zshrc",
  "~/.zprofile",
  "~/.zshenv",
  "~/.config/fish/**",
  "~/Documents/PowerShell/**",
  "~/Documents/WindowsPowerShell/**",
];

/** Directory roots whose contents list A protects; used by the grep rule. */
const CREDENTIAL_DIRS: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube",
  "~/.docker",
];

/** Expand `~` and `<cwd>` placeholders; also normalizes win32 drive slashes. */
export function expandPattern(pattern: string, env: PolicyEnv): string {
  let p = pattern;
  if (p.startsWith("<cwd>")) p = env.cwd + p.slice(5);
  if (p === "~" || p.startsWith("~/") || (env.platform === "win32" && p.startsWith("~\\"))) {
    p = env.home + p.slice(1);
  }
  if (env.platform === "win32") {
    const drive = /^\/([a-zA-Z])(?=\/|$)/u.exec(p);
    if (drive && !p.startsWith("//")) p = `${drive[1]!.toUpperCase()}:/${p.slice(3)}`;
    p = p.replace(/\\/gu, "/");
  }
  return p;
}

export interface PathPolicyConfig {
  /** Extra patterns appended from config; they can only tighten. */
  protectedRead: readonly string[];
  protectedWrite: readonly string[];
  /**
   * `!`-prefixed patterns from the **global** config: a READ matching one of
   * these is not a credential read. Writes are never excluded, and neither is
   * the exfiltration rule, which keeps using {@link isCredentialPath}.
   */
  protectedReadExclude: readonly string[];
}

export const EMPTY_PATH_POLICY: PathPolicyConfig = { protectedRead: [], protectedWrite: [], protectedReadExclude: [] };

/** True when `absPath` hits the credential list (used by rules and the sandbox plan). */
export function isCredentialPath(absPath: string, env: PolicyEnv, config: PathPolicyConfig = EMPTY_PATH_POLICY): boolean {
  for (const pattern of CREDENTIAL_EXCEPTIONS) {
    if (matchGlob(expandPattern(pattern, env), absPath, env)) return false;
  }
  for (const pattern of CREDENTIAL_GLOBS) {
    if (matchGlob(expandPattern(pattern, env), absPath, env)) return true;
  }
  for (const pattern of config.protectedRead) {
    if (matchGlob(expandPattern(pattern, env), absPath, env)) return true;
  }
  return false;
}

/** True when the user excluded this path from the credential list for reads. */
export function isCredentialReadExcluded(
  absPath: string,
  env: PolicyEnv,
  config: PathPolicyConfig = EMPTY_PATH_POLICY,
): boolean {
  return config.protectedReadExclude.some((pattern) => matchGlob(expandPattern(pattern, env), absPath, env));
}

/**
 * Classify a path intent. `absPath` must already be normalized.
 * The order of checks is part of the contract — do not reorder.
 */
export function classifyPath(
  kind: "read" | "write",
  absPath: string,
  tool: string,
  env: PolicyEnv,
  config: PathPolicyConfig = EMPTY_PATH_POLICY,
): PathVerdict {
  // 1. Credentials: read or write. A user exclusion lifts the read side only:
  // writing a credential file stays dangerous, and the exfil rule still sees it.
  const excludedRead = kind === "read" && isCredentialReadExcluded(absPath, env, config);
  if (!excludedRead && isCredentialPath(absPath, env, config)) {
    return { tier: "dangerous", reason: `${kind} hits a credential path (${absPath})`, ruleId: "sensitive-path" };
  }

  // 2. Privilege/persistence files: writes only.
  if (kind === "write") {
    for (const pattern of PROTECTED_WRITE_GLOBS) {
      if (matchGlob(expandPattern(pattern, env), absPath, env)) {
        return { tier: "dangerous", reason: `write hits a protected path (${absPath})`, ruleId: "protected-write" };
      }
    }
    for (const pattern of config.protectedWrite) {
      if (matchGlob(expandPattern(pattern, env), absPath, env)) {
        return { tier: "dangerous", reason: `write hits a configured protected path (${absPath})`, ruleId: "protected-write" };
      }
    }
  }

  // 3. grep over a directory that would surface credential contents.
  if (kind === "read" && ["grep", "rg", "egrep", "fgrep"].includes(tool)) {
    const riskyRoot = absPath === env.home || isFilesystemRoot(absPath);
    const coversSecrets = CREDENTIAL_DIRS.some((dir) => isInside(expandPattern(dir, env), absPath, env));
    if (riskyRoot || coversSecrets) {
      return { tier: "dangerous", reason: `grep over ${absPath} would search credential directories`, ruleId: "sensitive-path" };
    }
  }

  // 4. Reads elsewhere are safe — yolo must feel like plain pi.
  if (kind === "read") {
    return { tier: "safe", reason: "read", ruleId: "path-read" };
  }

  // 5. Writes inside the workspace, extra dirs, or temp dirs are safe.
  const writable = [env.cwd, ...env.additionalDirs, ...env.tempDirs];
  if (writable.some((dir) => isInside(absPath, dir, env))) {
    return { tier: "safe", reason: "write inside the workspace", ruleId: "path-write-inside" };
  }

  // 6. Any other write is grey.
  return { tier: "grey", reason: `write outside the workspace (${absPath})`, ruleId: "path-write-outside" };
}
