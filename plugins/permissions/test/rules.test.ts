import { describe, expect, test } from "bun:test";
import { classifyToolCall } from "../src/classify.ts";
import { decide } from "../src/decide.ts";
import { parseRule, ruleMatches, type UserRule } from "../src/rules.ts";
import { envMac } from "./envs.ts";

const env = envMac();

function classify(command: string) {
  return classifyToolCall("bash", { command }, { env, shellDialect: "bash" });
}

function rule(raw: string, kind: "allow" | "ask" | "deny" = "allow"): UserRule {
  return parseRule(raw, kind, "global");
}

describe("parseRule", () => {
  test("parses bare tool and patterned forms", () => {
    const bare = parseRule("edit", "allow", "global");
    expect(bare.tool).toBe("edit");
    expect(bare.valid).toBe(true);
    expect(bare.pattern).toBeUndefined();
    const shell = parseRule("bash(git push:*)", "allow", "global");
    expect(shell).toMatchObject({ tool: "bash", pattern: "git push", prefix: true, valid: true });
    expect(parseRule("read(**/.env)", "deny", "global")).toMatchObject({ tool: "read", pattern: "**/.env", valid: true });
  });

  test("rejects malformed rules", () => {
    expect(parseRule("bash()", "allow", "global").valid).toBe(false);
    expect(parseRule("edit(src:*)", "allow", "global").valid).toBe(false);
    expect(parseRule("subagent(x)", "allow", "global").valid).toBe(false);
    expect(parseRule("(", "allow", "global").valid).toBe(false);
  });
});

describe("ruleMatches / decide precedence", () => {
  test("bash prefix matches boundary but not longer names", () => {
    const intent = classify("git push origin main").intents.find((i) => i.kind === "exec")!;
    expect(ruleMatches(rule("bash(git push:*)"), intent, env)).toBe(true);
    expect(ruleMatches(rule("bash(git pushx:*)"), intent, env)).toBe(false);
    expect(ruleMatches(rule("bash(git pu:*)"), intent, env)).toBe(false); // "pu " prefix never matches "push"
  });

  test("bash exact match only matches the whole command", () => {
    const one = classify("make").intents.find((i) => i.kind === "exec")!;
    const two = classify("make install").intents.find((i) => i.kind === "exec")!;
    expect(ruleMatches(rule("bash(make)"), one, env)).toBe(true);
    expect(ruleMatches(rule("bash(make)"), two, env)).toBe(false);
    expect(ruleMatches(rule("bash(make:*)"), two, env)).toBe(true);
  });

  test("dynamic args never match allow but can match deny", () => {
    const intent = classify("npm install $PKG").intents.find((i) => i.kind === "exec")!;
    expect(ruleMatches(rule("bash(npm install:*)", "allow"), intent, env)).toBe(false);
    expect(ruleMatches(rule("bash(npm install:*)", "deny"), intent, env)).toBe(true);
  });

  test("compound command: every grey subcommand must be covered for allow", () => {
    const covered = classify("npm test && npm run build");
    const rules = [rule("bash(npm test:*)"), rule("bash(npm run:*)")];
    expect(decide(covered, "ask", rules, env).action).toBe("allow");

    const partial = [rule("bash(npm test:*)")];
    expect(decide(covered, "ask", partial, env).action).toBe("ask");
  });

  test("any deny match on a compound blocks it all", () => {
    const classification = classify("npm test && make install");
    const rules = [rule("bash(make install:*)", "deny")];
    expect(decide(classification, "yolo", rules, env).action).toBe("deny");
  });

  test("ask rule tightens a safe command even in yolo", () => {
    const classification = classify("git status");
    expect(decide(classification, "yolo", [rule("bash(git status:*)", "ask")], env).action).toBe("ask");
  });

  test("path rule matches derived read intents", () => {
    const classification = classify("cat ./src/secret.txt");
    const rules = [rule("read(**/secret.txt)", "deny")];
    expect(decide(classification, "yolo", rules, env).action).toBe("deny");
  });

  test("bare tool rule matches extension tool intents", () => {
    const classification = classifyToolCall("subagent", { task: "x" }, { env, shellDialect: "bash" });
    const rules = [rule("subagent", "deny")];
    expect(decide(classification, "yolo", rules, env).action).toBe("deny");
  });
});
