import { describe, expect, test } from "bun:test";
import { createRedactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";

const r = createRedactor(SECRET_PATTERNS);
/**
 * Assembled at runtime rather than written as a literal: this repository's own
 * `no-secrets.test.ts` rejects contiguous credential-shaped values in the
 * source, and a long run of one character is exactly what a scanner flags.
 */
const VALUE = "a".repeat(43);

describe("generic credential assignments", () => {
  // The four catch-all rules this replaces covered `api_key`/`api-token` and
  // `*_secret` only, so the most common names in a real .env never matched.
  test.each([
    ["GITHUB_TOKEN", "env-credential"],
    ["ACCESS_TOKEN", "env-credential"],
    ["AUTH_TOKEN", "env-credential"],
    ["SLACK_TOKEN", "env-credential"],
    ["NPM_TOKEN", "env-credential"],
    ["API_KEY", "env-credential"],
    ["apiKey", "env-credential"],
    ["APIKEY", "env-credential"],
    ["PRIVATE_KEY", "env-credential"],
    ["CLIENT_SECRET", "env-credential"],
    ["DB_PASSWORD", "env-credential"],
    ["PASSWORD", "env-credential"],
    ["ADMIN_PASSWORD", "env-credential"],
    ["ACCOUNT_API_KEY", "env-credential"],
    ["ADMIN_SECRET", "env-credential"],
    ["ACCOUNT_TOKEN", "env-credential"],
  ])("%s is redacted", (name, id) => {
    const line = `${name}=${VALUE}`;
    expect(r.string(line)).toBe(`${name}=[REDACTED:${id}]`);
  });

  // The old lookahead scanned the rest of the line, so a trailing comment
  // containing any of its veto words cancelled the match.
  test.each([
    `API_KEY=${VALUE} # api key for prod`,
    `PASSWORD=${VALUE} # password for prod`,
    `DB_PASSWORD=${VALUE} # token for prod`,
    `SECRET_KEY=${VALUE} # api secret`,
  ])("a trailing comment does not veto: %s", (line) => {
    expect(r.string(line)).toContain("[REDACTED:env-credential]");
  });

  test("quoted and JSON-shaped assignments are redacted", () => {
    expect(r.string(`PASSWORD="${VALUE}"`)).toBe("PASSWORD=[REDACTED:env-credential]");
    expect(r.string(`{"api_key": "${VALUE}"}`)).toBe('{"api_key": [REDACTED:env-credential]}');
  });

  test("a password embedded in a URL is redacted without hiding the URL", () => {
    const line = `DATABASE_URL=postgres://user:${VALUE}@db.internal:5432/prod`;
    expect(r.string(line)).toBe(
      "DATABASE_URL=postgres://user:[REDACTED:url-credential]@db.internal:5432/prod",
    );
  });

  test("placeholders and metric-shaped names are left alone", () => {
    for (const line of [
      "API_KEY=example-placeholder",
      "PASSWORD=changeme",
      "max_tokens=4096",
      "token_count=99",
      "TOKEN = process.env.TOKEN",
      "tokenizer_path=/usr/lib/tokenizer",
      `TOKEN_COUNT=${"9".repeat(8)}`,
      `MAX_TOKENS=${"9".repeat(8)}`,
      `"token_length": "${"9".repeat(8)}"`,
    ]) {
      expect(r.string(line)).toBe(line);
    }
  });

  // The replaced rules used `.*` inside a lookahead evaluated at every start
  // position: a 20k-space value took ~300 ms and a 200k-space value minutes.
  test("a long non-matching value stays linear", () => {
    const line = `api_key=${" ".repeat(40_000)}`;
    const started = performance.now();
    r.string(line);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
