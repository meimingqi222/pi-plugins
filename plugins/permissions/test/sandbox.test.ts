import { describe, expect, test } from "bun:test";
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  detectSandbox,
  resolveSandboxPolicy,
  shQuote,
  wrapSandboxed,
  type SandboxDeps,
} from "../src/sandbox/index.ts";
import type { PolicyEnv, SandboxSettings } from "../src/types.ts";
import { envMac, makeEnv } from "./envs.ts";

const OFF: SandboxSettings = { enabled: true, network: "on", allowWrite: [], denyRead: [] };

const deps = (over: Partial<SandboxDeps> = {}): SandboxDeps => ({
  exists: () => true,
  probe: () => true,
  onPath: () => false,
  ...over,
});

describe("detectSandbox", () => {
  test("darwin: available when sandbox-exec exists", () => {
    expect(detectSandbox(envMac(), deps()).detail).toBe("sandbox-exec");
    expect(detectSandbox(envMac(), deps({ exists: () => false })).available).toBe(false);
  });

  test("linux: needs bwrap on PATH AND a working probe (containers often lack userns)", () => {
    const env = makeEnv({ platform: "linux", home: "/home/me", cwd: "/work/app", tempDirs: ["/tmp"] });
    expect(detectSandbox(env, deps()).available).toBe(false); // onPath false
    expect(detectSandbox(env, deps({ onPath: () => true, probe: () => false })).available).toBe(false);
    expect(detectSandbox(env, deps({ onPath: () => true })).available).toBe(true);
  });

  test("win32: unsupported, policy only", () => {
    const env = makeEnv({ platform: "win32", home: "C:/Users/me", cwd: "C:/work/app", tempDirs: ["C:/Temp"] });
    const availability = detectSandbox(env, deps());
    expect(availability.supported).toBe(false);
    expect(availability.detail).toContain("policy only");
  });
});

describe("resolveSandboxPolicy", () => {
  test("workspace, temp dirs and cache dirs are writable; credential dirs are deny-read", () => {
    const policy = resolveSandboxPolicy(envMac(), OFF, () => true);
    expect(policy.writable).toContain("/work/app");
    expect(policy.writable).toContain("/tmp");
    expect(policy.writable).toContain("/Users/me/.npm");
    expect(policy.denyRead).toContain("/Users/me/.ssh");
    expect(policy.denyRead).toContain("/Users/me/.pi/agent/auth.json");
  });

  test("missing cache dirs are skipped; settings add paths", () => {
    const existing = new Set(["/work/app", "/Users/me/.npm"]);
    const policy = resolveSandboxPolicy(envMac(), { ...OFF, allowWrite: ["~/extra"], denyRead: ["~/secret"] }, (p) => existing.has(p));
    expect(policy.writable).toContain("/Users/me/.npm");
    expect(policy.writable).not.toContain("/Users/me/.cache");
    expect(policy.writable).toContain("/Users/me/extra");
    expect(policy.denyRead).toContain("/Users/me/secret");
  });
});

describe("buildSeatbeltProfile", () => {
  test("write deny exempts every writable path; read deny lists credentials", () => {
    const profile = buildSeatbeltProfile({ writable: ["/work/app"], denyRead: ["/Users/me/.ssh"], network: "on" });
    expect(profile).toContain("(deny file-write*");
    expect(profile).toContain('(require-not (subpath "/work/app"))');
    expect(profile).toContain('(deny file-read* (subpath "/Users/me/.ssh"))');
    expect(profile).not.toContain("network-outbound");
  });

  test("network off adds the outbound deny (verified on macOS 27)", () => {
    const profile = buildSeatbeltProfile({ writable: ["/w"], denyRead: [], network: "off" });
    expect(profile).toContain("(deny network-outbound (remote ip))");
  });
});

describe("bwrap args", () => {
  test("binds only existing writable paths, masks existing deny paths", () => {
    const args = buildBwrapArgs({ writable: ["/work/app", "/gone"], denyRead: ["/home/me/.ssh"], network: "off" }, (p) => p !== "/gone");
    expect(args.slice(0, 4)).toEqual(["bwrap", "--ro-bind", "/", "/"]);
    expect(args.join(" ")).toContain("--bind /work/app /work/app");
    expect(args.join(" ")).not.toContain("/gone");
    expect(args.join(" ")).toContain("--tmpfs /home/me/.ssh");
    expect(args).toContain("--unshare-net");
    expect(args.at(-1)).toBe("--die-with-parent");
  });
});

describe("wrapSandboxed", () => {
  test("darwin wraps with sandbox-exec; single quotes are escaped", () => {
    const wrapped = wrapSandboxed("echo 'hi' > out", envMac(), OFF, { supported: true, available: true, detail: "sandbox-exec" }, deps());
    expect(wrapped).toMatch(/^\/usr\/bin\/sandbox-exec -p '/);
    expect(wrapped).toContain(`/bin/bash -c 'echo '\\''hi'\\'' > out'`);
  });

  test("linux wraps with bwrap and the command after --", () => {
    const env = makeEnv({ platform: "linux", home: "/home/me", cwd: "/work/app", tempDirs: ["/tmp"] });
    const wrapped = wrapSandboxed("ls", env, OFF, { supported: true, available: true, detail: "bwrap" }, deps());
    expect(wrapped).toContain("bwrap");
    expect(wrapped).toContain("-- /bin/bash -c 'ls'");
  });

  test("unavailable or unsupported → no rewrite", () => {
    const env = envMac();
    expect(wrapSandboxed("ls", env, OFF, { supported: true, available: false, detail: "missing" }, deps())).toBeUndefined();
    const win = makeEnv({ platform: "win32", home: "C:/Users/me", cwd: "C:/work/app", tempDirs: [] });
    expect(wrapSandboxed("ls", win, OFF, { supported: false, available: false, detail: "policy only" }, deps())).toBeUndefined();
  });
});
