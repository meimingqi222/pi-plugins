import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendProjectAllowRule, mergeConfig, parsePermFile, saveGlobalMode } from "../src/config.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-test-"));
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

describe("parsePermFile", () => {
  test("bad JSON is reported, not thrown", () => {
    expect(parsePermFile("{nope").config).toBeUndefined();
    expect(parsePermFile("[1]").error).toBeDefined();
    expect(parsePermFile("{}").config).toBeDefined();
  });
});

describe("mergeConfig trust rules", () => {
  test("untrusted project: allow ignored, deny applies", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    const project = path.join(dir, "proj", ".pi", "permissions.json");
    write(global, { allow: ["bash(a:*)"] });
    write(project, { allow: ["bash(evil:*)"], deny: ["bash(rm:*)"], additionalDirectories: ["~/x"] });
    const merged = mergeConfig(global, project, false, path.join(dir, "proj"));
    expect(merged.rules.filter((r) => r.kind === "allow").map((r) => r.text)).toEqual(["bash(a:*)"]);
    expect(merged.rules.filter((r) => r.kind === "deny").map((r) => r.text)).toEqual(["bash(rm:*)"]);
    expect(merged.additionalDirectories).toEqual([]);
  });

  test("trusted project: allow and additionalDirectories apply", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    const project = path.join(dir, "proj", ".pi", "permissions.json");
    write(global, {});
    write(project, { allow: ["bash(make:*)"], additionalDirectories: ["~/x"] });
    const merged = mergeConfig(global, project, true, path.join(dir, "proj"));
    expect(merged.rules.some((r) => r.kind === "allow" && r.text === "bash(make:*)")).toBe(true);
    expect(merged.additionalDirectories).toEqual(["~/x"]);
  });

  test("untrusted project mode can tighten but not loosen", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    const project = path.join(dir, "proj", ".pi", "permissions.json");
    write(global, { mode: "ask" });
    write(project, { mode: "yolo" });
    expect(mergeConfig(global, project, false, "x").projectMode).toBeUndefined();
    write(project, { mode: "read-only" });
    expect(mergeConfig(global, project, false, "x").projectMode).toBe("read-only");
    // Trusted: project wins even when looser.
    write(project, { mode: "yolo" });
    expect(mergeConfig(global, project, true, "x").projectMode).toBe("yolo");
  });

  test("bad JSON file is ignored wholesale with a warning", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    const project = path.join(dir, "proj", ".pi", "permissions.json");
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.writeFileSync(project, "{broken");
    const merged = mergeConfig(global, project, true, "x");
    expect(merged.rules).toEqual([]);
    expect(merged.warnings.length).toBe(1);
    expect(merged.warnings[0]).toContain("invalid JSON");
  });

  test("global projects[cwd] rules always merge", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    write(global, { projects: { "/work/app": { allow: ["bash(make build:*)"] } } });
    const merged = mergeConfig(global, path.join(dir, "none"), false, "/work/app");
    expect(merged.rules.some((r) => r.kind === "allow" && r.text === "bash(make build:*)" && r.source === "project-rules")).toBe(true);
  });
});

describe("appendProjectAllowRule / saveGlobalMode", () => {
  test("appends to projects[cwd].allow preserving other fields", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    write(global, { mode: "ask", deny: ["bash(x:*)"], projects: { "/other": { allow: ["bash(y:*)"] } } });
    appendProjectAllowRule(global, "/work/app", "bash(make:*)");
    appendProjectAllowRule(global, "/work/app", "bash(make:*)"); // no dup
    const saved = JSON.parse(fs.readFileSync(global, "utf8"));
    expect(saved.mode).toBe("ask");
    expect(saved.deny).toEqual(["bash(x:*)"]);
    expect(saved.projects["/other"].allow).toEqual(["bash(y:*)"]);
    expect(saved.projects["/work/app"].allow).toEqual(["bash(make:*)"]);
  });

  test("creates the file when missing and keeps it valid JSON", () => {
    const dir = tempDir();
    const global = path.join(dir, "agent", "permissions.json");
    appendProjectAllowRule(global, "/w", "bash(x:*)");
    saveGlobalMode(global, "auto");
    const saved = JSON.parse(fs.readFileSync(global, "utf8"));
    expect(saved.mode).toBe("auto");
    expect(saved.projects["/w"].allow).toEqual(["bash(x:*)"]);
  });
});
