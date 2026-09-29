import type { PolicyEnv } from "../src/types.ts";

/**
 * macOS resolves /tmp and /var through /private, so a fixture with an identity
 * `realpath` never sees the paths the runtime really sees — the blind spot that
 * hid the `/private` temp false positive. Model the links by default.
 */
const DARWIN_LINKS: Record<string, string> = { "/tmp": "/private/tmp", "/var": "/private/var" };

/** Default temp dirs on darwin: /tmp plus the per-user TMPDIR root under /var. */
const DARWIN_TEMP_DIRS = ["/private/tmp", "/private/var/folders", "/tmp"];

/**
 * Resolve through the link table longest-key-first, so a link on a directory
 * covers its children the way a real symlink does.
 */
function linkedRealpath(links: Record<string, string>): (p: string) => string {
  const keys = Object.keys(links).sort((a, b) => b.length - a.length);
  return (p: string): string => {
    for (const key of keys) {
      if (p === key) return links[key]!;
      if (p.startsWith(`${key}/`)) return `${links[key]!}${p.slice(key.length)}`;
    }
    return p;
  };
}

/**
 * Hand-built PolicyEnv fixtures. `realpath` resolves through a link table so
 * symlink cases (test 37) work without a filesystem.
 */
export function makeEnv(overrides: Partial<PolicyEnv> & { links?: Record<string, string> } = {}): PolicyEnv {
  const platform = overrides.platform ?? "darwin";
  const links = { ...(platform === "darwin" ? DARWIN_LINKS : {}), ...(overrides.links ?? {}) };
  const env: PolicyEnv = {
    platform,
    home: "/Users/me",
    cwd: "/work/app",
    tempDirs: platform === "darwin" ? [...DARWIN_TEMP_DIRS] : [],
    additionalDirs: [],
    realpath: linkedRealpath(links),
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
