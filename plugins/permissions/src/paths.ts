/**
 * Path normalization. All platform-specific path handling goes through
 * `env.platform`, never `process.platform`, so tests on macOS can exercise
 * Windows inputs.
 */

import path from "node:path";
import type { PolicyEnv } from "./types.ts";

/** True for "/" and "C:/" style roots and bare "//server/share" UNC roots. */
export function isFilesystemRoot(p: string): boolean {
  if (p === "/") return true;
  if (/^[a-zA-Z]:\/$/u.test(p)) return true;
  return /^\/\/[^/]+\/[^/]+\/?$/u.test(p);
}

/** Case-insensitive platforms: win32 and darwin default to case-insensitive volumes. */
export function caseInsensitive(env: PolicyEnv): boolean {
  return env.platform === "win32" || env.platform === "darwin";
}

/** child === parent or child is strictly below parent. Both must already be normalized. */
export function isInside(child: string, parent: string, env: PolicyEnv): boolean {
  let c = child;
  let p = parent;
  if (caseInsensitive(env)) {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

function isAbsolutePath(p: string, env: PolicyEnv): boolean {
  if (env.platform === "win32") {
    // After slash conversion: "C:/x" or "//server/share/x" or "/x" (git-bash abs).
    return /^[a-zA-Z]:\//u.test(p) || p.startsWith("/");
  }
  return p.startsWith("/");
}

/**
 * Normalize `input` to an absolute, symlink-resolved, `/`-separated path.
 *
 * Order (per the design doc): trim → `~` expansion → win32 Git-Bash drive
 * translation and `\`→`/` → absolutize against env.cwd → collapse → realpath.
 */
export function normalizePath(input: string, env: PolicyEnv): string {
  let p = input.trim();
  if (!p) p = env.cwd;

  if (p === "~" || p.startsWith("~/") || (env.platform === "win32" && p.startsWith("~\\"))) {
    p = env.home + p.slice(1);
  }

  if (env.platform === "win32") {
    // Git-Bash style "/c/Users/x" → "C:/Users/x" (single-letter drive only).
    const drive = /^\/([a-zA-Z])(?=\/|$)/u.exec(p);
    if (drive && !p.startsWith("//")) {
      p = `${drive[1]!.toUpperCase()}:/${p.slice(3)}`;
    }
    p = p.replace(/\\/gu, "/");
  }

  const impl = env.platform === "win32" ? path.win32 : path.posix;
  if (!isAbsolutePath(p, env)) p = impl.resolve(env.cwd, p);
  // win32.normalize emits backslashes; collapse then convert to "/".
  p = impl.normalize(p).replace(/\\/gu, "/");
  // Strip a trailing slash unless the path is a root ("C:/", "/", "//s/s").
  while (p.length > 1 && p.endsWith("/") && !isFilesystemRoot(p)) p = p.slice(0, -1);

  p = env.realpath(p).replace(/\\/gu, "/");
  while (p.length > 1 && p.endsWith("/") && !isFilesystemRoot(p)) p = p.slice(0, -1);
  return p;
}
