import type { PolicyEnv } from "../src/types.ts";

/**
 * Hand-built PolicyEnv fixtures. `realpath` resolves through a link table so
 * symlink cases (test 37) work without a filesystem.
 */
export function makeEnv(overrides: Partial<PolicyEnv> & { links?: Record<string, string> } = {}): PolicyEnv {
  const links = overrides.links ?? {};
  const env: PolicyEnv = {
    platform: "darwin",
    home: "/Users/me",
    cwd: "/work/app",
    tempDirs: ["/private/tmp", "/tmp"],
    additionalDirs: [],
    realpath: (p: string) => links[p] ?? p,
    ...overrides,
  };
  delete (env as unknown as Record<string, unknown>).links;
  return env;
}

export const envMac = (): PolicyEnv => makeEnv();

export const envLinux = (): PolicyEnv =>
  makeEnv({ platform: "linux", home: "/home/me", cwd: "/work/app", tempDirs: ["/tmp"] });

export const envWin = (): PolicyEnv =>
  makeEnv({
    platform: "win32",
    home: "C:/Users/me",
    cwd: "C:/work/app",
    tempDirs: ["C:/Users/me/AppData/Local/Temp", "C:/Windows/Temp"],
  });
