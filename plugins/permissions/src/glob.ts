/**
 * Minimal glob matching: `**` (any depth), `*` (within a segment), `?`.
 * Deliberately not minimatch — no braces, no character classes, no dependency.
 */

import { caseInsensitive } from "./paths.ts";
import type { PolicyEnv } from "./types.ts";

export function globToRegExp(glob: string, env: PolicyEnv): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const rest = glob.slice(i);
    if (rest.startsWith("**/")) {
      // Zero or more whole directory segments (leading "/" included).
      re += "(?:.*/)?";
      i += 3;
    } else if (rest === "/**") {
      // Trailing "/**" also matches the bare prefix itself ("~/.ssh").
      re += "(?:/.*)?";
      i = glob.length;
    } else if (rest.startsWith("**")) {
      re += ".*";
      i += 2;
    } else if (rest.startsWith("*")) {
      re += "[^/]*";
      i += 1;
    } else if (rest.startsWith("?")) {
      re += "[^/]";
      i += 1;
    } else {
      re += rest[0]!.replace(/[.*+^${}()|[\]\\]/gu, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive(env) ? "iu" : "u");
}

const cache = new Map<string, RegExp>();

/** Match a normalized absolute path (or already-normalized pattern target). */
export function matchGlob(pattern: string, value: string, env: PolicyEnv): boolean {
  const key = `${env.platform}${pattern}`;
  let re = cache.get(key);
  if (!re) {
    re = globToRegExp(pattern, env);
    if (cache.size > 512) cache.clear();
    cache.set(key, re);
  }
  return re.test(value);
}
