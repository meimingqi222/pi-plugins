/**
 * Production `PolicyEnv` built on real fs calls. The only file that touches
 * `process.platform`, `os` and `fs` besides config.ts/index.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePath } from "./paths.ts";
import type { PolicyEnv } from "./types.ts";

function cleanSlashes(p: string): string {
  let out = p.replace(/\\/gu, "/");
  if (out.startsWith("//?/")) out = out.slice(3); // \\?\C:\x → /C:\x → handled below
  return out;
}

/** Resolve symlinks; fall back to the deepest resolvable ancestor + tail. */
function makeRealpath(platform: NodeJS.Platform): (p: string) => string {
  const impl = platform === "win32" ? path.win32 : path.posix;
  return (p: string): string => {
    try {
      return cleanSlashes(fs.realpathSync.native(p));
    } catch {
      // Walk up to an existing ancestor (bounded) and re-append the tail.
      const tail: string[] = [];
      let cur = p;
      for (let depth = 0; depth < 16; depth += 1) {
        const parent = impl.dirname(cur);
        if (parent === cur) break;
        tail.unshift(impl.basename(cur));
        cur = parent;
        try {
          const base = cleanSlashes(fs.realpathSync.native(cur));
          return [base.replace(/\/+$/u, ""), ...tail].join("/");
        } catch {
          continue;
        }
      }
      return p;
    }
  };
}

export function createPolicyEnv(cwd: string, additionalDirs: string[] = []): PolicyEnv {
  const platform = process.platform;
  const env: PolicyEnv = {
    platform,
    home: "",
    cwd: "",
    tempDirs: [],
    additionalDirs: [],
    realpath: makeRealpath(platform),
  };
  env.home = normalizePath(os.homedir(), env);
  env.cwd = normalizePath(cwd, env);
  const temps = new Set<string>();
  const candidates = [os.tmpdir()];
  if (platform !== "win32") candidates.push("/tmp", "/private/tmp", "/var/tmp", "/private/var/folders");
  for (const candidate of candidates) {
    try {
      temps.add(normalizePath(candidate, env));
    } catch {
      // A candidate that cannot be normalized is skipped, not fatal.
    }
  }
  env.tempDirs = [...temps];
  env.additionalDirs = additionalDirs.map((dir) => normalizePath(dir, env));
  return env;
}
