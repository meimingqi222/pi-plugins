import { describe, expect, test } from "bun:test";
import { canWrite, isReadOnlyRole, isWritingRole, resolveToolProfile, ROLE_PROFILES } from "../src/runner/roles.ts";

describe("resolveToolProfile", () => {
  test("an unset profile is unrestricted, not empty", () => {
    // Passing an empty allowlist to pi would produce a tool-less agent, which is
    // a confusing way to fail; undefined means "do not restrict".
    expect(resolveToolProfile(undefined)).toBeUndefined();
    expect(resolveToolProfile("")).toBeUndefined();
    expect(resolveToolProfile("*")).toBeUndefined();
  });
  test("a named role resolves to its tool list", () => {
    expect(resolveToolProfile("planner")).toEqual([...ROLE_PROFILES.planner]);
    expect(resolveToolProfile("developer")).toContain("edit");
  });
  test("an explicit list is used as given", () => {
    expect(resolveToolProfile(["read"])).toEqual(["read"]);
  });
  test("an unknown role throws and names the known ones", () => {
    expect(() => resolveToolProfile("nope")).toThrow(/Unknown workflow role/);
    expect(() => resolveToolProfile("nope")).toThrow(/planner/);
  });
});

describe("role isolation", () => {  test("non-writing roles cannot write", () => {
    // The property the fan-out depends on: two reviewers cannot collide.
    for (const role of ["planner", "qa", "reviewer", "researcher"]) {
      expect(canWrite(role)).toBe(false);
    }
  });
  test("the developer role can write", () => {
    expect(canWrite("developer")).toBe(true);
    expect(canWrite("worker")).toBe(true);
  });
  test("an unrestricted profile is treated as writable", () => {
    expect(canWrite(undefined)).toBe(true);
  });
  test("only a declared role counts as a writing role", () => {
    // `canWrite(undefined)` is true, but an unprofiled agent is not a *declared*
    // writer: the single-writer lock must not serialize every agent in a script
    // that never opted into role isolation.
    expect(isWritingRole(undefined)).toBe(false);
    expect(isWritingRole([])).toBe(false);
    expect(isWritingRole(["read", "grep"])).toBe(false);
    expect(isWritingRole("planner")).toBe(false);
    expect(isWritingRole("qa")).toBe(false);
    expect(isWritingRole("developer")).toBe(true);
    expect(isWritingRole("worker")).toBe(true);
    expect(isWritingRole(["read", "edit"])).toBe(true);
  });
  test("only one role is a writer, so a panel of readers cannot conflict", () => {
    const writers = Object.keys(ROLE_PROFILES).filter((role) => canWrite(role));
    expect(writers).toEqual(["developer", "worker"]);
  });
});

describe("re-runnability", () => {
  test("only a provably read-only role may be re-run after a failure", () => {
    // The question is not "may this role write?" but "can this call be repeated
    // without duplicating an effect?" — `qa` cannot edit, but it can run a
    // shell, and a shell can write anything.
    expect(isReadOnlyRole("planner")).toBe(true);
    expect(isReadOnlyRole("reviewer")).toBe(true);
    expect(isReadOnlyRole("researcher")).toBe(true);
    expect(isReadOnlyRole("qa")).toBe(false);
    expect(isReadOnlyRole("developer")).toBe(false);
  });

  test("an unresolved profile cannot be proven safe", () => {
    // Unrestricted, an explicit list (an unknown tool may write), and a role that
    // does not exist are all "unknown", and guessing wrong duplicates an effect.
    expect(isReadOnlyRole(undefined)).toBe(false);
    expect(isReadOnlyRole(["read", "grep"])).toBe(false);
    expect(isReadOnlyRole("nobody")).toBe(false);
  });
});
