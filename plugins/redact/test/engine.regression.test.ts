import { describe, expect, test } from "bun:test";
import { createRedactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";
import * as FX from "./fixtures.ts";

const r = createRedactor(SECRET_PATTERNS);

describe("performance fixes preserve correctness", () => {
  test("multiple case-insensitive secrets in one string are all redacted", () => {
    // Regression guard for the `lowered` reuse optimisation: after a
    // replacement the lowercase snapshot must be invalidated, otherwise the
    // second secret is missed or matched at the wrong offsets.
    const input = [
      `OPENAI_KEY=${FX.OPENAI_KEY}`,
      `GH=${FX.GITHUB_PAT}`,
      `AWS=${FX.AWS_ACCESS_KEY_ID}`,
    ].join("\n");

    const out = r.string(input)!;
    expect(out).not.toContain(FX.OPENAI_KEY);
    expect(out).not.toContain(FX.GITHUB_PAT);
    expect(out).not.toContain(FX.AWS_ACCESS_KEY_ID);
    expect(out.match(/\[REDACTED:/g)?.length).toBe(3);
  });

  test("redacts correctly when the secret differs in case from its keyword", () => {
    // sk-secret is caseInsensitive; github-pat is NOT (pattern is lowercase
    // `ghp_`), so this must use a case-insensitive rule to be meaningful.
    const out = r.string(`token: ${FX.OPENAI_KEY_2}`);
    expect(out).not.toContain(FX.OPENAI_KEY_2);
    expect(out).toContain("[REDACTED:sk-secret]");
  });

  test("case-sensitive rules do not match a different case", () => {
    // Documents existing intent: `ghp_` is lowercase-only.
    const upper = "GHP_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    expect(r.string(upper)).toBe(upper);
  });

  test("mixed-case string with a secret after a replaced secret", () => {
    // Force a case-insensitive replacement to happen *before* a later match,
    // exercising the `lowered = undefined` invalidation path.
    const input =
      `API_KEY=${FX.OPENAI_KEY} then ${FX.OPENAI_KEY_2}`;
    const out = r.string(input)!;
    expect(out).not.toContain(FX.OPENAI_KEY);
    expect(out).not.toContain(FX.OPENAI_KEY_2);
    expect(out.match(/\[REDACTED:/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("repeated redaction of the same large string is stable (cache hit)", () => {
    const text = ("x".repeat(1000) + ` ${FX.GITHUB_PAT}\n`).repeat(300);
    const first = r.string(text)!;
    const second = r.string(text)!;
    expect(second).toBe(first);
    expect(first).toContain("[REDACTED:github-pat]");
  });
  test("large strings (>512KB) are now cached", () => {
    // Previously the engine skipped caching above 512_000 chars, so repeat
    // passes recomputed. Verify the cache actually returns the same object.
    const text = "const x = 1;\n".repeat(50_000); // ~650KB, no secrets
    const first = r.string(text);
    const second = r.string(text);
    expect(second).toBe(first);
  });

  test("cache eviction keeps results correct under pressure", () => {
    // Overflow the byte budget with many distinct strings, then re-check.
    const redactor = createRedactor(SECRET_PATTERNS, { cacheBytes: 64 * 1024 });
    for (let i = 0; i < 500; i++) {
      redactor.string(`unique ${i} `.repeat(200) + FX.GITHUB_PAT);
    }
    const out = redactor.string(FX.GITHUB_PAT);
    expect(out).toBe("[REDACTED:github-pat]");
  });

  test("no false negatives on clean code after the optimisations", () => {
    const code = [
      "function toLowerCaseHelper(value: string): string {",
      "  return value.toLowerCase();",
      "}",
      "const KEYWORD = 'Token';",
      "export { toLowerCaseHelper, KEYWORD };",
    ].join("\n");
    expect(r.string(code)).toBe(code);
  });

  test("cyclic input does not overflow the stack", () => {
    // Regression guard: the deep walk had no recursion stack, so a self-
    // referential object (or a cycle through any two nodes) recursed forever.
    // Real provider payloads can carry cycles, and one crash aborts redaction
    // for the whole request, sending the raw secret to the model.
    const node: Record<string, unknown> = { secret: "[REDACTED:github-pat]" };
    node.self = node;
    node.list = [node];

    let out: Record<string, unknown> | undefined;
    expect(() => {
      out = r.deep(node) as Record<string, unknown>;
    }).not.toThrow();

    // The cycle is truncated, but reachable secrets are still redacted.
    expect(out!.secret).toBe("[REDACTED:github-pat]");
  });

  test("mutual cycles are broken and sibling secrets still redacted", () => {
    const a: Record<string, unknown> = { secret: "[REDACTED:github-pat]" };
    const b: Record<string, unknown> = { a, secret: "[REDACTED:aws-access-key-id]" };
    a.b = b;

    const out = r.deep({ a, b }) as Record<string, any>;
    expect(out.a.secret).toBe("[REDACTED:github-pat]");
    expect(out.b.secret).toBe("[REDACTED:aws-access-key-id]");
  });

  test("a node shared between siblings is redacted in both", () => {
    // The cycle guard must only suppress a node while its own children are
    // being visited; a shared (acyclic) node appearing twice must still be
    // walked twice, or the second reference leaks the raw secret.
    const shared: Record<string, unknown> = { tok: "[REDACTED:github-pat]" };
    const out = r.deep({ left: shared, right: shared }) as Record<string, any>;
    expect(out.left.tok).toBe("[REDACTED:github-pat]");
    expect(out.right.tok).toBe("[REDACTED:github-pat]");
  });

  test("only the capture group is censored, keyword context survives", () => {
    // Regression guard: the old `full.replace(captured, censor)` rewrote the
    // first *textual* occurrence of the secret inside the whole match, which
    // can sit in the keyword prefix, corrupting output and leaving part of
    // the credential in cleartext.
    const secret = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    const out = r.string(`bitbucket_token = "${secret}"`)!;
    expect(out).toContain("bitbucket_token");
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:bitbucket-dc-http-token]");
  });

  test("a secret repeated in the prefix is censored at its own offsets", () => {
    // Group 1 is the secret by convention, but the same text also appears in
    // the leading context. `full.replace(captured, ...)` would censor the first
    // textual occurrence (the context) and leave the real capture in cleartext;
    // the `d` flag's group offsets point at the actual capture.
    const pats = [
      {
        id: "ctx",
        category: "test",
        title: "context repeats the captured secret",
        pattern: String.raw`(?:SECRET)(SECRET)`,
        keywords: ["SECRET"],
      },
    ];
    const redactor = createRedactor(pats as never);
    expect(redactor.string("SECRETSECRET")).toBe("SECRET[REDACTED:ctx]");
  });

  test("an empty or whole-match capture group censors the entire match", () => {
    const pats = [
      {
        id: "whole",
        category: "test",
        title: "optional leading group",
        pattern: String.raw`((?:pre)?[a-z]{3}KEY)`,
        keywords: ["KEY"],
      },
    ];
    const redactor = createRedactor(pats as never);
    expect(redactor.string("x abcKEY y")).toBe("x [REDACTED:whole] y");
    expect(redactor.string("x preKEY y")).toBe("x [REDACTED:whole] y");
  });

  test("a rule that can match the empty string terminates and is inert", () => {
    // Two failure modes meet here. The compile-error fallback used to be
    // /^$/ (a rule that matches the empty string), and the replacement loop
    // had no zero-width guard, so an empty match at a fixed offset looped
    // forever. A rule that matches empty must terminate and change nothing.
    const redactor = createRedactor([
      { id: "empty", category: "test", title: "empty-matching", pattern: String.raw`(x?)`, keywords: [""] } as never,
    ]);
    expect(redactor.string("abc")).toBe("abc");
    expect(redactor.deep({ s: "", t: "ok" })).toEqual({ s: "", t: "ok" });
  });
});
