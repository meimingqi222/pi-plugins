/**
 * Reject credential-shaped literals in the repository's own source.
 *
 * Why this exists: this is a secret-redaction tool, so its tests need strings
 * that *look* like credentials. Writing them as contiguous literals has two
 * costs, both hit in practice:
 *
 *   1. GitHub push protection refuses the push. It blocked the first push of
 *      this repository on the Slack fixture and required a manual unblock.
 *   2. Any scan of the repository reports false positives, which trains people
 *      to ignore the scanner.
 *
 * `test/fixtures.ts` assembles each value from two halves so no contiguous
 * secret exists in the source, while the runtime string is byte-identical.
 * This test is the lock, and it checks both directions:
 *
 *   - no rule matches a contiguous literal anywhere in the source, and
 *   - every assembled fixture value is still recognised by its rule, so the
 *     fixture-based tests cannot silently start asserting on a non-secret.
 *
 * The oracle is the plugin's own `SECRET_PATTERNS`, so the guard is exactly as
 * strict as the shipped redactor and cannot drift from it.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { SECRET_PATTERNS } from "../src/patterns.ts";
import * as FX from "./fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Directories that are not part of the repository's source. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

/**
 * Credential material is a token: letters, digits and a few symbols, never
 * whitespace, quotes or prose punctuation. Several rules deliberately match
 * *config markers* rather than secrets — `gcp-service-account` matches the
 * literal `"type": "service_account"` — and those appear in `patterns.ts` as the
 * rule's own source. Filtering on shape is what separates "a rule's regex is
 * visible in the file that defines it" from "a credential is committed".
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_\-./+=@:]+$/;

interface CompiledRule {
  id: string;
  regex: RegExp;
}

/** Every rule that exposes a capture group, compiled as the engine compiles it. */
function compiledRules(): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const pattern of SECRET_PATTERNS) {
    try {
      out.push({
        id: pattern.id,
        regex: new RegExp(pattern.pattern, pattern.caseInsensitive ? "gi" : "g"),
      });
    } catch {
      // A rule that does not compile is the engine's concern, not this test's.
    }
  }
  return out;
}

/** True when `value` looks like a real credential rather than a config marker. */
function isTokenLike(value: string): boolean {
  return value.length >= 12 && TOKEN_SHAPE.test(value);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|js|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no credential-shaped literals in the repository source", () => {
  const rules = compiledRules();

  test("the rule set is present and compiled", () => {
    expect(rules.length).toBeGreaterThan(50);
  });

  test("every source file is free of contiguous secret-shaped strings", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(REPO_ROOT)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      for (const rule of rules) {
        for (const match of text.matchAll(rule.regex)) {
          const value = match[1] ?? match[0];
          if (!isTokenLike(value)) continue;
          offenders.push(`${rule.id} in ${rel}: ${value.slice(0, 6)}… (${value.length} chars)`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("every fixture value is still recognised by its rule", async () => {
    // Guards the other direction. If a split left a half that no longer
    // assembles into a matching value, the fixture-based tests would keep
    // passing while asserting on something that is not a secret.
    const values = [
      FX.GITHUB_PAT,
      FX.GITLAB_PAT,
      FX.SLACK_TOKEN,
      FX.ANTHROPIC_KEY,
      FX.AWS_ACCESS_KEY_ID,
      FX.JWT,
      FX.OPENAI_KEY,
      FX.OPENAI_KEY_2,
      FX.OPENAI_KEY_3,
      FX.OPENAI_KEY_4,
      FX.PEM_PRIVATE_KEY,
    ];

    const unmatched = values.filter(
      (value) => !rules.some((rule) => new RegExp(rule.regex.source, rule.regex.flags).test(value)),
    );

    expect(unmatched.map((v) => v.slice(0, 6))).toEqual([]);
  });

  test("neither half of a split fixture matches a rule on its own", async () => {
    // This is the property that makes the split meaningful. A half that still
    // matches would be flagged by scanners exactly like the whole value, so the
    // fixture file itself must not contain one.
    const text = readFileSync(join(import.meta.dir, "fixtures.ts"), "utf8");
    const offenders: string[] = [];

    for (const line of text.split("\n")) {
      for (const literal of line.matchAll(/"([^"]*)"/g)) {
        const value = literal[1]!;
        for (const rule of rules) {
          if (new RegExp(rule.regex.source, "i").test(value) && isTokenLike(value)) {
            offenders.push(`${rule.id} matches a fixture half: ${value.slice(0, 6)}…`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("a planted contiguous secret in a temp file would be caught", () => {
    // Proves the detector is not vacuous: the same predicate that walks the
    // repository must reject a real-shaped value.
    const planted = ["xoxb-", "123456789012-", "abcdefghijklmnop"].join("");
    const caught = rules.some((rule) =>
      new RegExp(rule.regex.source, rule.regex.flags).test(planted),
    );
    expect(caught).toBe(true);
    expect(isTokenLike(planted)).toBe(true);
  });
});
